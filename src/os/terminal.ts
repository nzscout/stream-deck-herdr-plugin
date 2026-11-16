// src/os/terminal.ts
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type RunFn = (cmd: string, args: string[]) => Promise<string>;

const OSASCRIPT = "/usr/bin/osascript";

// AppleScript application name the host terminal answers to. iTerm2 responds to
// "iTerm". Override via HERDR_DECK_TERMINAL_APP when herdr runs in another
// terminal (e.g. "Terminal", "Ghostty", "WezTerm").
export const DEFAULT_TERMINAL_APP = "iTerm";

// Windows process names, in preference order, used when the terminal hosting
// herdr cannot be found by walking the herdr process' parents (or when
// HERDR_DECK_TERMINAL_APP names one explicitly).
export const DEFAULT_WINDOWS_TERMINAL_APPS = [
  "WindowsTerminal",
  "Orca",
  "wezterm-gui",
  "alacritty",
  "Tabby",
  "Hyper",
  "Code",
  "conhost",
];

// Windows Terminal's top-level window class. A single WindowsTerminal.exe can own
// several windows, so the raise must enumerate them instead of trusting
// MainWindowHandle (which returns one arbitrary window of the process).
const WT_WINDOW_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS";

const RAISE_TIMEOUT_MS = 4000;

export type RaiseHints = {
  // Substring of the terminal window title to raise. Empty = the detected window.
  window?: string;
  // Terminal tab to select after raising (1-9). 0/undefined = leave the tab alone.
  tab?: number;
};

const WIN32_PRELUDE = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class HerdrDeckWindow {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  // Every visible top-level window of one process, optionally only a given class.
  public static IntPtr[] TopLevel(uint processId, string className) {
    var found = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid != processId || !IsWindowVisible(hWnd)) return true;
      if (className != null) {
        var cls = new StringBuilder(256);
        GetClassName(hWnd, cls, 256);
        if (cls.ToString() != className) return true;
      }
      found.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }

  public static string Title(IntPtr hWnd) {
    var text = new StringBuilder(512);
    GetWindowText(hWnd, text, 512);
    return text.ToString();
  }
}
'@

$script:HerdrDeckCached = $null
$script:HerdrDeckDistro = '__HERDR_DECK_DISTRO__'

function Get-HerdrDeckTitle([IntPtr] $Handle) { return [HerdrDeckWindow]::Title($Handle) }

# Every window of a process, preferring real terminal windows over dialogs.
function Get-HerdrDeckProcessWindows([int] $ProcessId) {
  $found = @([HerdrDeckWindow]::TopLevel([uint32]$ProcessId, '${WT_WINDOW_CLASS}'))
  if ($found.Count -eq 0) { $found = @([HerdrDeckWindow]::TopLevel([uint32]$ProcessId, $null)) }
  return $found
}

# The terminal that hosts herdr is the first ancestor of a herdr process that owns
# a window: herdr runs as a TUI inside a shell inside the terminal app, so the
# window belongs to a parent, never to herdr itself. herdr on Windows is
# herdr.exe; herdr inside WSL has no herdr.exe, so the wsl.exe of that distro is
# the seed instead (its parent chain leads to the same terminal).
function Get-HerdrDeckHostProcesses {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $byId = @{}
  foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
  $seeds = @($procs | Where-Object { $_.Name -eq 'herdr.exe' })
  $seeds += @($procs | Where-Object {
    $_.Name -eq 'wsl.exe' -and ($script:HerdrDeckDistro -eq '' -or $_.CommandLine -like "*$script:HerdrDeckDistro*")
  })
  $hosts = New-Object System.Collections.Generic.List[object]
  foreach ($seed in $seeds) {
    $cur = $seed
    for ($i = 0; $i -lt 8 -and $null -ne $cur; $i++) {
      $windows = @(Get-HerdrDeckProcessWindows ([int]$cur.ProcessId))
      if ($windows.Count -gt 0) {
        $hosts.Add([pscustomobject]@{ ProcessId = [int]$cur.ProcessId; Windows = $windows })
        break
      }
      $cur = $byId[[int]$cur.ParentProcessId]
    }
  }
  return $hosts
}

# Pick one window. A title hint matches against the windows of the known terminal
# apps directly (fast, no process-tree scan); without a hint the host is found by
# walking up from herdr.exe / wsl.exe and then cached, because that scan costs most
# of a second.
function Find-HerdrDeckHandle([string] $WindowHint) {
  if ($script:HerdrDeckCached -and $script:HerdrDeckCached.Hint -eq $WindowHint) {
    if ([HerdrDeckWindow]::IsWindow([IntPtr]$script:HerdrDeckCached.Handle)) { return [IntPtr]$script:HerdrDeckCached.Handle }
    $script:HerdrDeckCached = $null
  }

  $candidates = @()
  if ($WindowHint) {
    # Every window of the known terminal apps, so a hint can pick one of several.
    foreach ($name in __HERDR_DECK_FALLBACK__) {
      foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        foreach ($w in @(Get-HerdrDeckProcessWindows ([int]$p.Id))) {
          $candidates += [pscustomobject]@{ ProcessId = [int]$p.Id; Handle = $w }
        }
      }
    }
  } else {
    $hosts = @(Get-HerdrDeckHostProcesses)
    if ($hosts.Count -eq 0) {
      foreach ($name in __HERDR_DECK_FALLBACK__) {
        $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p) { $hosts += [pscustomobject]@{ ProcessId = [int]$p.Id; Windows = @(Get-HerdrDeckProcessWindows ([int]$p.Id)) } }
      }
    }
    foreach ($hostProc in $hosts) {
      foreach ($w in $hostProc.Windows) {
        $candidates += [pscustomobject]@{ ProcessId = $hostProc.ProcessId; Handle = $w }
      }
    }
  }
  if ($candidates.Count -eq 0) { throw 'no terminal window found' }

  $chosen = $null
  if ($WindowHint) {
    $chosen = $candidates | Where-Object { (Get-HerdrDeckTitle $_.Handle).IndexOf($WindowHint, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
    # A title hint can go stale (the title follows the active tab), so a miss falls
    # back to the detected host window instead of failing the press. The candidate
    # list is every window of every known terminal app; its first entry is not the
    # herdr host, and raising it would also send Ctrl+Alt+<n> into that window.
    if ($null -eq $chosen) {
      foreach ($hostProc in @(Get-HerdrDeckHostProcesses)) {
        foreach ($w in @($hostProc.Windows)) {
          $chosen = [pscustomobject]@{ ProcessId = $hostProc.ProcessId; Handle = $w }
          break
        }
        if ($null -ne $chosen) { break }
      }
      if ($null -eq $chosen) { $chosen = $candidates | Select-Object -First 1 }
    }
  } else {
    $chosen = $candidates | Select-Object -First 1
  }
  $script:HerdrDeckCached = [pscustomobject]@{ Pid = $chosen.ProcessId; Handle = $chosen.Handle; Hint = $WindowHint }
  return [IntPtr]$chosen.Handle
}

# Windows refuses SetForegroundWindow from a process that did not receive the
# last input event. Tapping Alt first makes this process the last-input owner,
# which is what buys the right to raise the window.
function Show-HerdrDeckWindow([IntPtr] $Handle) {
  [HerdrDeckWindow]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [HerdrDeckWindow]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  # SW_RESTORE also undoes a maximized window, which would resize the user window
  # on every press, so it is only used for a minimized one.
  if ([HerdrDeckWindow]::IsIconic($Handle)) { [void][HerdrDeckWindow]::ShowWindow($Handle, 9) }
  [void][HerdrDeckWindow]::BringWindowToTop($Handle)
  [void][HerdrDeckWindow]::SetForegroundWindow($Handle)
}

# Windows Terminal switches tabs on Ctrl+Alt+<1..9>; herdr runs in one tab of the
# window, so selecting that tab is what actually puts the pane on screen.
function Select-HerdrDeckTab([int] $Tab) {
  if ($Tab -lt 1 -or $Tab -gt 9) { return }
  $vk = [byte](0x30 + $Tab)
  [HerdrDeckWindow]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  [HerdrDeckWindow]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [HerdrDeckWindow]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  [HerdrDeckWindow]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
  [HerdrDeckWindow]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [HerdrDeckWindow]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
}

# Windows a picker can offer: every window of the known terminal apps, so the
# Property Inspector can list them instead of asking the user to type a title.
function Get-HerdrDeckWindowList {
  $list = New-Object System.Collections.Generic.List[object]
  $seen = @{}
  foreach ($name in __HERDR_DECK_FALLBACK__) {
    foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      foreach ($w in @(Get-HerdrDeckProcessWindows ([int]$p.Id))) {
        $title = Get-HerdrDeckTitle $w
        if (-not $title) { continue }
        $key = [string]$w
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $list.Add([pscustomobject]@{ title = $title; handle = $key; pid = [int]$p.Id })
      }
    }
  }
  return $list
}

function Invoke-HerdrDeckRaise([string] $WindowHint, [int] $Tab) {
  $handle = Find-HerdrDeckHandle $WindowHint
  Show-HerdrDeckWindow -Handle $handle
  if ($Tab -gt 0) {
    Start-Sleep -Milliseconds 80
    Select-HerdrDeckTab $Tab
  }
}`;

// The distro is matched against wsl.exe command lines, so it is spliced into a
// single-quoted PowerShell string (quotes doubled) and never evaluated.
function psStringList(names: string[]): string {
  return `@(${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ")})`;
}

function fillPrelude(distro: string, apps: string[] = []): string {
  // WT_WINDOW_CLASS is interpolated when WIN32_PRELUDE is built. The fallback list
  // appears in more than one function, so every occurrence must be replaced.
  const fallback = apps.length > 0 ? apps : DEFAULT_WINDOWS_TERMINAL_APPS;
  return WIN32_PRELUDE.replaceAll("__HERDR_DECK_DISTRO__", distro.replace(/'/g, "''")).replaceAll(
    "__HERDR_DECK_FALLBACK__",
    psStringList(fallback),
  );
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// One-shot variant: raise, print "ok", exit.
export function windowsRaiseScript(hints: RaiseHints = {}, distro = "", apps: string[] = []): string {
  const prelude = fillPrelude(distro, apps);
  return `${prelude}

try {
  Invoke-HerdrDeckRaise -WindowHint ${psQuote(hints.window ?? "")} -Tab ${Number(hints.tab ?? 0)}
  Write-Output 'ok'
} catch {
  Write-Output ('err:' + $_.Exception.Message)
}`;
}

// Long-lived variant: compile the Win32 helper once, then serve one command per
// stdin line: "detect" populates the window cache without raising anything (used
// to pre-warm), "raise" raises the detected window, "raise {json}" raises the
// window matching "window" and then selects tab "tab". Each command answers one
// stdout line: "warm", "ok" or "err:<message>". Spawning PowerShell per key press
// costs about 750 ms (process start plus Add-Type); the worker makes every press
// after the first effectively instant.
export function windowsWorkerScript(distro = "", apps: string[] = []): string {
  const prelude = fillPrelude(distro, apps);
  return `${prelude}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    if ($line -eq 'detect') {
      [void](Find-HerdrDeckHandle '')
      [Console]::Out.WriteLine('warm')
    } elseif ($line -eq 'windows') {
      # JSON on its own line; the plugin turns it into a picker list.
      $windows = @(Get-HerdrDeckWindowList)
      [Console]::Out.WriteLine((ConvertTo-Json -InputObject $windows -Compress -Depth 3))
    } elseif ($line.StartsWith('raise')) {
      $windowHint = ''
      $tab = 0
      $rest = $line.Substring(5).Trim()
      if ($rest.Length -gt 0) {
        $opts = $rest | ConvertFrom-Json
        if ($null -ne $opts.window) { $windowHint = [string]$opts.window }
        if ($null -ne $opts.tab) { $tab = [int]$opts.tab }
      }
      Invoke-HerdrDeckRaise -WindowHint $windowHint -Tab $tab
      [Console]::Out.WriteLine('ok')
    } else {
      [Console]::Out.WriteLine('err:unknown command')
    }
  } catch {
    [Console]::Out.WriteLine('err:' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}`;
}

// Absolute PowerShell paths so the call survives Stream Deck's minimal launch
// PATH. PowerShell 7 first, then the in-box Windows PowerShell.
export function powershellCandidates(): string[] {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  return [
    path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
    localAppData ? path.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe") : "",
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ].filter((p) => p.length > 0);
}

export function resolvePowershell(): string {
  return powershellCandidates().find((p) => fs.existsSync(p)) ?? "powershell.exe";
}

// -EncodedCommand takes base64 of UTF-16LE, which keeps quoting out of the
// command line entirely.
export function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function parseApps(app: string | undefined): string[] {
  if (!app) return [];
  return app
    .split(/[,;]/)
    .map((s) => s.trim().replace(/\.exe$/i, ""))
    .filter((s) => s.length > 0);
}

export type TerminalWindow = { title: string; handle: string; pid?: number };

// The picker list is JSON from the helper; anything else means "no windows".
export function parseWindowList(raw: string): TerminalWindow[] {
  try {
    const parsed: unknown = JSON.parse(raw.trim() || "[]");
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .map((item): TerminalWindow | null => {
        const w = item as Partial<TerminalWindow>;
        return typeof w?.title === "string" && w.title.length > 0
          ? { title: w.title, handle: String(w.handle ?? ""), pid: typeof w.pid === "number" ? w.pid : undefined }
          : null;
      })
      .filter((w): w is TerminalWindow => w !== null);
  } catch {
    return [];
  }
}

export type TerminalActivator = {
  activate(hints?: RaiseHints): Promise<void>;
  // Terminal windows that can host herdr, for the Property Inspector picker.
  listWindows(): Promise<TerminalWindow[]>;
  // Pay one-time start-up cost ahead of the first press (no-op where cheap).
  warm(): void;
  dispose(): void;
};

const defaultRun: RunFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: RAISE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });

function macActivator(app: string, run: RunFn): TerminalActivator {
  return {
    // Bring the host terminal app to the foreground. `activate` is idempotent: if
    // the app is already frontmost it is a no-op, so this can be called on every
    // focus without a separate "is it focused?" check. Focusing a herdr pane only
    // switches the pane *inside* herdr; raising the GUI app is what puts it on
    // screen when the terminal was in the background.
    async activate() {
      await run(OSASCRIPT, ["-e", `tell application "${app}" to activate`]);
    },
    async listWindows() {
      return [];
    },
    warm() {},
    dispose() {},
  };
}

// Persistent PowerShell worker: first activate() pays the ~750 ms start-up, every
// later press is one stdin line. A crashed worker is respawned on the next
// press; a press that never gets an answer fails instead of hanging.
function windowsWorkerActivator(distro: string, apps: string[]): TerminalActivator {
  const script = windowsWorkerScript(distro, apps);
  const args = ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encodedCommand(script)];
  let child: ChildProcessWithoutNullStreams | null = null;
  let buffer = "";
  let waiters: Array<{ resolve: (value: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  const failAll = (err: Error): void => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  };

  const onLine = (line: string): void => {
    // Pre-warm answers ("warm") carry no request with them.
    if (line.trim() === "warm") return;
    const waiter = waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (line.startsWith("err:")) waiter.reject(new Error(line.slice(4).trim() || "raise failed"));
    else waiter.resolve(line);
  };

  const ensureChild = (): ChildProcessWithoutNullStreams => {
    if (child) return child;
    const proc = spawn(resolvePowershell(), args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.filter((l) => l.trim().length > 0).forEach(onLine);
    });
    proc.on("exit", () => {
      if (child === proc) child = null;
      failAll(new Error("powershell helper exited"));
    });
    proc.on("error", (err) => {
      if (child === proc) child = null;
      failAll(err instanceof Error ? err : new Error(String(err)));
    });
    child = proc;
    // Pay the PowerShell start-up, Add-Type compile and first window scan now so
    // the first key press feels like the second: stdin queues commands until the
    // helper is listening, so ordering is safe.
    proc.stdin.write("detect\n");
    return proc;
  };

  const command = (hints: RaiseHints): string => {
    const payload: { window?: string; tab?: number } = {};
    if (hints.window) payload.window = hints.window;
    if (hints.tab) payload.tab = hints.tab;
    return Object.keys(payload).length > 0 ? `raise ${JSON.stringify(payload)}` : "raise";
  };

  const send = (text: string, timeoutMessage: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = ensureChild();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w.timer !== timer);
        reject(new Error(timeoutMessage));
      }, RAISE_TIMEOUT_MS);
      waiters.push({ resolve, reject, timer });
      proc.stdin.write(`${text}\n`);
    });

  return {
    activate(hints = {}) {
      return send(command(hints), "raise terminal timed out").then(() => undefined);
    },
    async listWindows() {
      try {
        return parseWindowList(await send("windows", "terminal window list timed out"));
      } catch {
        return [];
      }
    },
    warm() {
      // Spawn (and pre-detect) now so the first press does not pay for it.
      try {
        ensureChild();
      } catch {
        // Left to the next press, which reports the failure to the caller.
      }
    },
    dispose() {
      const proc = child;
      child = null;
      failAll(new Error("terminal activator disposed"));
      proc?.stdin.end();
      proc?.kill();
    },
  };
}

export function createTerminalActivator(
  // `distro` names the WSL distro hosting herdr, so the raise walks up from that
  // distro's wsl.exe instead of from herdr.exe.
  opts: { run?: RunFn; app?: string; platform?: NodeJS.Platform; distro?: string } = {},
): TerminalActivator {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    // `app` is a fallback list of process names when the process walk finds
    // nothing; the per-press hints name a window title instead.
    const apps = parseApps(opts.app);
    if (opts.run) {
      // Injected run (tests / callers that manage the process themselves): pay
      // the one-shot cost instead of owning a worker.
      return {
        async activate(hints = {}) {
          await opts.run?.(resolvePowershell(), [
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-EncodedCommand",
            encodedCommand(windowsRaiseScript(hints, opts.distro ?? "", apps)),
          ]);
        },
        async listWindows() {
          return [];
        },
        warm() {},
        dispose() {},
      };
    }
    const activator = windowsWorkerActivator(opts.distro ?? "", apps);
    activator.warm();
    return activator;
  }
  return macActivator(opts.app ?? DEFAULT_TERMINAL_APP, opts.run ?? defaultRun);
}
