import { test, expect } from "bun:test";
import path from "node:path";
import {
  createTerminalActivator,
  DEFAULT_TERMINAL_APP,
  DEFAULT_WINDOWS_TERMINAL_APPS,
  encodedCommand,
  parseWindowList,
  windowsRaiseScript,
  windowsWorkerScript,
  type RunFn,
} from "./terminal";

test("activate runs osascript to activate the configured app", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  await createTerminalActivator({ run, app: "Ghostty", platform: "darwin" }).activate();
  expect(calls[0]).toEqual(["/usr/bin/osascript", "-e", 'tell application "Ghostty" to activate']);
});

test("defaults to iTerm", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  await createTerminalActivator({ run, platform: "darwin" }).activate();
  expect(calls[0][2]).toBe(`tell application "${DEFAULT_TERMINAL_APP}" to activate`);
  expect(DEFAULT_TERMINAL_APP).toBe("iTerm");
});

test("windows raise script claims the foreground right before raising", () => {
  const script = windowsRaiseScript();
  // Alt tap (VK_MENU) first: without it Windows ignores SetForegroundWindow
  // from a process that has not received the last input event.
  expect(script).toContain("keybd_event(0x12, 0, 0");
  expect(script).toContain("SetForegroundWindow");
  expect(script).toContain("BringWindowToTop");
});

test("raise restores a minimized window only, never un-maximizes one", () => {
  for (const script of [windowsRaiseScript(), windowsWorkerScript()]) {
    // SW_RESTORE undoes maximize as well, so it must sit behind an IsIconic guard.
    expect(script).toContain("if ([HerdrDeckWindow]::IsIconic($Handle)) { [void][HerdrDeckWindow]::ShowWindow($Handle, 9) }");
    expect(script.indexOf("ShowWindow($Handle, 9)")).toBeGreaterThan(script.indexOf("IsIconic($Handle)"));
  }
});

test("windows enumerate every window of the host, not just MainWindowHandle", () => {
  const script = windowsRaiseScript();
  // One WindowsTerminal.exe can own several windows; the plugin must look at all
  // of them and prefer real terminal windows over dialogs.
  expect(script).toContain("public static IntPtr[] TopLevel(uint processId, string className)");
  expect(script).toContain("EnumWindows");
  expect(script).toContain("CASCADIA_HOSTING_WINDOW_CLASS");
  expect(script).toContain("Get-HerdrDeckProcessWindows");
  // MainWindowHandle was the bug: it silently picks one window.
  expect(script).not.toContain(".MainWindowHandle");
});

test("windows raise script seeds the probe with the WSL distro when set", () => {
  const script = windowsRaiseScript({}, "Ubuntu");
  expect(script).toContain("$script:HerdrDeckDistro = 'Ubuntu'");
  expect(script).toContain("$_.Name -eq 'wsl.exe'");
  expect(windowsRaiseScript()).toContain("$script:HerdrDeckDistro = ''");
  // quotes in the setting cannot break out of the PowerShell string
  expect(windowsRaiseScript({}, "it's")).toContain("$script:HerdrDeckDistro = 'it''s'");
});

test("a window hint is passed through as a PowerShell string literal", () => {
  const script = windowsRaiseScript({ window: "pwsh in igore" });
  expect(script).toContain("-WindowHint 'pwsh in igore'");
  expect(windowsRaiseScript({ window: "it's" })).toContain("-WindowHint 'it''s'");
});

test("tab selection uses Windows Terminal's Ctrl+Alt+<n>", () => {
  const script = windowsRaiseScript({ tab: 3 });
  expect(script).toContain("-Tab 3");
  expect(script).toContain("Select-HerdrDeckTab");
  expect(script).toContain("0x11, 0, 0"); // Ctrl down
  expect(script).toContain("0x12, 0, 0"); // Alt down
  expect(script).toContain("[byte](0x30 + $Tab)");
});

test("worker speaks the raise/detect protocol with hints", () => {
  const script = windowsWorkerScript();
  expect(script).toContain("$line -eq 'detect'");
  expect(script).toContain("[Console]::Out.WriteLine('warm')");
  expect(script).toContain("$line.StartsWith('raise')");
  expect(script).toContain("ConvertFrom-Json");
  expect(script).toContain("$opts.window");
  expect(script).toContain("$opts.tab");
});

test("win32 activate passes the script base64-encoded to powershell", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "ok";
  };
  await createTerminalActivator({ run, app: "Orca", platform: "win32" }).activate({
    window: "pwsh in igore",
    tab: 2,
  });
  const cmd = calls[0][0];
  const args = calls[0].slice(1);
  expect(path.basename(cmd)).toMatch(/^(pwsh|powershell)\.exe$/i);
  expect(args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand"]);
  const decoded = Buffer.from(args[4], "base64").toString("utf16le");
  expect(decoded).toContain("SetForegroundWindow");
  expect(decoded).toContain("-WindowHint 'pwsh in igore'");
  expect(decoded).toContain("-Tab 2");
});

test("the default Windows terminal preference list still covers common hosts", () => {
  expect(DEFAULT_WINDOWS_TERMINAL_APPS).toContain("WindowsTerminal");
  expect(windowsRaiseScript()).toContain("'WindowsTerminal'");
});

test("encodedCommand round-trips UTF-16LE", () => {
  const script = "Write-Output 'ok'";
  expect(Buffer.from(encodedCommand(script), "base64").toString("utf16le")).toBe(script);
});

test("the window list comes from the helper as JSON", () => {
  expect(parseWindowList('[{"title":"pwsh in igore","handle":"123","pid":42}]')).toEqual([
    { title: "pwsh in igore", handle: "123", pid: 42 },
  ]);
  // A single object (PowerShell renders a one-element array either way) still works.
  expect(parseWindowList('{"title":"solo","handle":"1","pid":7}').map((w) => w.title)).toEqual(["solo"]);
  // Titles are the only required field; junk is dropped, never thrown.
  expect(parseWindowList("not json")).toEqual([]);
  expect(parseWindowList("[]")).toEqual([]);
  expect(parseWindowList('[{"handle":"1"}]')).toEqual([]);
});

test("the helper can enumerate windows for the picker", () => {
  const script = windowsWorkerScript();
  expect(script).toContain("$line -eq 'windows'");
  expect(script).toContain("Get-HerdrDeckWindowList");
  expect(script).toContain("ConvertTo-Json");
});
