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

const RAISE_TIMEOUT_MS = 4000;

const WIN32_PRELUDE = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class HerdrDeckWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@

$script:HerdrDeckCached = $null

# The terminal that hosts herdr is the first ancestor of a herdr.exe process
# that owns a top-level window: herdr runs as a TUI inside a shell inside the
# terminal app, so the window belongs to a parent, never to herdr itself.
function Get-HerdrDeckWindowFromHerdr {
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $byId = @{}
  foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
  foreach ($h in @($procs | Where-Object { $_.Name -eq 'herdr.exe' })) {
    $cur = $h
    for ($i = 0; $i -lt 8 -and $null -ne $cur; $i++) {
      $owner = Get-Process -Id $cur.ProcessId -ErrorAction SilentlyContinue
      if ($owner -and $owner.MainWindowHandle -ne 0) { return $owner }
      $cur = $byId[[int]$cur.ParentProcessId]
    }
  }
  return $null
}

function Get-HerdrDeckWindowByName([string[]] $Names) {
  foreach ($name in $Names) {
    $p = Get-Process -Name $name -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Select-Object -First 1
    if ($p) { return $p }
  }
  return $null
}

# Scanning every process costs most of a second, and the terminal that hosts
# herdr does not move while it is open, so remember the window and only look
# again once it is gone (terminal closed or restarted).
function Test-HerdrDeckCached {
  if ($null -eq $script:HerdrDeckCached) { return $false }
  $p = Get-Process -Id $script:HerdrDeckCached.Pid -ErrorAction SilentlyContinue
  return ($null -ne $p -and $p.MainWindowHandle -ne 0 -and $p.MainWindowHandle -eq $script:HerdrDeckCached.Handle)
}

function Find-HerdrDeckHandle([string[]] $Names) {
  if ($Names.Count -eq 0 -and (Test-HerdrDeckCached)) { return [IntPtr]$script:HerdrDeckCached.Handle }
  $target = $null
  if ($Names.Count -eq 0) {
    $target = Get-HerdrDeckWindowFromHerdr
    if ($null -eq $target) { $target = Get-HerdrDeckWindowByName @(__HERDR_DECK_FALLBACK__) }
  } else {
    $target = Get-HerdrDeckWindowByName $Names
  }
  if ($null -eq $target) { throw 'no terminal window found' }
  if ($Names.Count -eq 0) {
    $script:HerdrDeckCached = [pscustomobject]@{ Pid = $target.Id; Handle = $target.MainWindowHandle }
  }
  return [IntPtr]$target.MainWindowHandle
}

# Windows refuses SetForegroundWindow from a process that did not receive the
# last input event. Tapping Alt first makes this process the last-input owner,
# which is what buys the right to raise the window.
function Show-HerdrDeckWindow([IntPtr] $Handle) {
  [HerdrDeckWindow]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [HerdrDeckWindow]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [void][HerdrDeckWindow]::ShowWindow($Handle, 9)
  [void][HerdrDeckWindow]::BringWindowToTop($Handle)
  [void][HerdrDeckWindow]::SetForegroundWindow($Handle)
}

function Invoke-HerdrDeckRaise([string[]] $Names) {
  $handle = Find-HerdrDeckHandle $Names
  Show-HerdrDeckWindow -Handle $handle
}`;

function psStringList(names: string[]): string {
  return `@(${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(", ")})`;
}

// One-shot variant: raise, print "ok", exit.
export function windowsRaiseScript(names: string[] = []): string {
  const fallback = names.length > 0 ? names : DEFAULT_WINDOWS_TERMINAL_APPS;
  const prelude = WIN32_PRELUDE.replace("__HERDR_DECK_FALLBACK__", psStringList(fallback));
  const requested = names.length > 0 ? psStringList(names) : psStringList([]);
  return `${prelude}

try {
  Invoke-HerdrDeckRaise ${requested}
  Write-Output 'ok'
} catch {
  Write-Output ('err:' + $_.Exception.Message)
}`;
}

// Long-lived variant: compile the Win32 helper once, then serve one command per
// stdin line: "detect" populates the window cache without raising anything (used
// to pre-warm), "raise" / "raise:<names>" raises. Each command answers one
// stdout line: "warm", "ok" or "err:<message>". Spawning PowerShell per key press
// costs about 750 ms (process start plus Add-Type); the worker makes every press
// after the first effectively instant.
export function windowsWorkerScript(names: string[] = []): string {
  const fallback = names.length > 0 ? names : DEFAULT_WINDOWS_TERMINAL_APPS;
  const prelude = WIN32_PRELUDE.replace("__HERDR_DECK_FALLBACK__", psStringList(fallback));
  return `${prelude}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    if ($line -eq 'detect') {
      [void](Find-HerdrDeckHandle @())
      [Console]::Out.WriteLine('warm')
    } elseif ($line -eq 'raise' -or $line.StartsWith('raise:')) {
      $names = @()
      if ($line.Length -gt 6) {
        $names = @($line.Substring(6) -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      }
      Invoke-HerdrDeckRaise $names
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

export type TerminalActivator = {
  activate(): Promise<void>;
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
    warm() {},
    dispose() {},
  };
}

// Persistent PowerShell worker: first activate() pays the ~750 ms start-up, every
// later press is one stdin line. A crashed worker is respawned on the next
// press; a press that never gets an answer fails instead of hanging.
function windowsWorkerActivator(names: string[]): TerminalActivator {
  const script = windowsWorkerScript(names);
  const args = ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encodedCommand(script)];
  let child: ChildProcessWithoutNullStreams | null = null;
  let buffer = "";
  let waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  const failAll = (err: Error): void => {
    const pending = waiters;
    waiters = [];
    for (const w of pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  };

  const onLine = (line: string): void => {
    // Pre-warm answers ("warm") carry no press with them.
    if (line.trim() === "warm") return;
    const waiter = waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (line.startsWith("err:")) waiter.reject(new Error(line.slice(4).trim() || "raise failed"));
    else waiter.resolve();
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

  return {
    activate() {
      return new Promise<void>((resolve, reject) => {
        let proc: ChildProcessWithoutNullStreams;
        try {
          proc = ensureChild();
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w.timer !== timer);
          reject(new Error("raise terminal timed out"));
        }, RAISE_TIMEOUT_MS);
        waiters.push({ resolve, reject, timer });
        proc.stdin.write(names.length > 0 ? `raise:${names.join(",")}\n` : "raise\n");
      });
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
  opts: { run?: RunFn; app?: string; platform?: NodeJS.Platform } = {},
): TerminalActivator {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    const names = parseApps(opts.app);
    if (opts.run) {
      // Injected run (tests / callers that manage the process themselves): pay
      // the one-shot cost instead of owning a worker.
      return {
        async activate() {
          await opts.run?.(resolvePowershell(), [
            "-NoProfile",
            "-NonInteractive",
            "-NoLogo",
            "-EncodedCommand",
            encodedCommand(windowsRaiseScript(names)),
          ]);
        },
        warm() {},
        dispose() {},
      };
    }
    const activator = windowsWorkerActivator(names);
    activator.warm();
    return activator;
  }
  return macActivator(opts.app ?? DEFAULT_TERMINAL_APP, opts.run ?? defaultRun);
}

