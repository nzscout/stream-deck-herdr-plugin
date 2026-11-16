import { test, expect } from "bun:test";
import path from "node:path";
import { createTerminalActivator, DEFAULT_TERMINAL_APP, encodedCommand, windowsRaiseScript, windowsWorkerScript, type RunFn } from "./terminal";

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
  const script = windowsRaiseScript(["Ghostty"]);
  // Alt tap (VK_MENU) first: without it Windows ignores SetForegroundWindow
  // from a process that has not received the last input event.
  expect(script).toContain("keybd_event(0x12, 0, 0");
  expect(script).toContain("SetForegroundWindow");
  expect(script).toContain("ShowWindow($Handle, 9)");
  expect(script).toContain("'Ghostty'");
});

test("windows raise script falls back to the host-terminal probe", () => {
  const script = windowsRaiseScript();
  expect(script).toContain("Get-HerdrDeckWindowFromHost");
  expect(script).toContain("'WindowsTerminal'");
  expect(script).toContain("'Orca'");
});

test("windows raise script seeds the probe with the WSL distro when set", () => {
  const script = windowsRaiseScript([], "Ubuntu");
  expect(script).toContain("$script:HerdrDeckDistro = 'Ubuntu'");
  expect(script).toContain("$_.Name -eq 'wsl.exe'");
  // an empty distro matches any wsl.exe
  expect(windowsRaiseScript()).toContain("$script:HerdrDeckDistro = ''");
  // quotes in the setting cannot break out of the PowerShell string
  expect(windowsRaiseScript([], "it's")).toContain("$script:HerdrDeckDistro = 'it''s'");
});

test("windows worker loop serves one raise per stdin line", () => {
  const script = windowsWorkerScript(["WindowsTerminal"]);
  expect(script).toContain("while ($true)");
  expect(script).toContain("[Console]::In.ReadLine()");
  expect(script).toContain("[Console]::Out.Flush()");
});

test("win32 activate passes the script base64-encoded to powershell", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "ok";
  };
  await createTerminalActivator({ run, app: "Orca", platform: "win32" }).activate();
  const cmd = calls[0][0];
  const args = calls[0].slice(1);
  expect(path.basename(cmd)).toMatch(/^(pwsh|powershell)\.exe$/i);
  expect(args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand"]);
  const decoded = Buffer.from(args[4], "base64").toString("utf16le");
  expect(decoded).toContain("'Orca'");
  expect(decoded).toContain("SetForegroundWindow");
});

test("encodedCommand round-trips UTF-16LE", () => {
  const script = "Write-Output 'ok'";
  expect(Buffer.from(encodedCommand(script), "base64").toString("utf16le")).toBe(script);
});

test("app names accept comma or semicolon lists and drop .exe", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "ok";
  };
  await createTerminalActivator({ run, app: "WindowsTerminal.exe; Orca", platform: "win32" }).activate();
  const decoded = Buffer.from(calls[0][5], "base64").toString("utf16le");
  expect(decoded).toContain("'WindowsTerminal', 'Orca'");
});
test("worker speaks the raise/detect protocol", () => {
  const script = windowsWorkerScript();
  expect(script).toContain("$line -eq 'detect'");
  expect(script).toContain("[Console]::Out.WriteLine('warm')");
  expect(script).toContain("$line -eq 'raise'");
  expect(script).toContain("$line.StartsWith('raise:')");
});
