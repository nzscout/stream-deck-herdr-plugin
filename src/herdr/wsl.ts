// src/herdr/wsl.ts
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { RawAgent } from "../core/agents";
import { mergeTabLabels, type HerdrClient, type NotifyOpts, type RawTab } from "./client";

// herdr running inside WSL is reached through `wsl.exe`. Two details matter:
//   - `~/.local/bin` is on PATH only for a login shell, so every call goes
//     through `sh -lc` (a bare `wsl.exe -e herdr` fails with ENOENT);
//   - starting wsl.exe costs ~200 ms, so the agent list is not fetched per poll.
//     One long-lived shell prints a snapshot every interval and the client serves
//     the latest one, which keeps updates at 1 s without process churn.

export const WSL_BIN = "wsl.exe";

export function wslPrefix(distro: string | undefined): string[] {
  const name = distro?.trim();
  return name ? ["-d", name] : [];
}

export function wslShellArgs(distro: string | undefined, command: string): string[] {
  return [...wslPrefix(distro), "-e", "sh", "-lc", command];
}

// Pane ids are opaque handles like `w2:p11`; anything else is refused before it
// can reach a shell command line.
const PANE_ID = /^[A-Za-z0-9:._-]+$/;

export function isPaneId(value: string): boolean {
  return PANE_ID.test(value);
}

// One `herdr agent list` line -> agents. Returns null for anything unparseable
// so a stray shell banner or a half-written line cannot poison the snapshot.
export function parseTabs(line: string): RawTab[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const tabs = (parsed as { result?: { tabs?: unknown } })?.result?.tabs;
    return Array.isArray(tabs) ? (tabs as RawTab[]) : null;
  } catch {
    return null;
  }
}

export function parseSnapshot(line: string): RawAgent[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const agents = (parsed as { result?: { agents?: unknown } })?.result?.agents;
    return Array.isArray(agents) ? (agents as RawAgent[]) : null;
  } catch {
    return null;
  }
}

// Both lists per cycle: agents give status, tabs give the label herdr shows in
// its tab bar. One long-lived shell keeps the cost to one wsl.exe.
export function streamCommand(intervalMs: number): string {
  const seconds = Math.max(1, Math.round(intervalMs / 1000));
  return `while :; do herdr agent list; herdr tab list; sleep ${seconds}; done`;
}

const STALE_AFTER_MS = 15000;
const FIRST_SNAPSHOT_TIMEOUT_MS = 12000;
const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30000;

export type WslHerdrClient = HerdrClient & { start(): void; stop(): void };

export function createWslHerdrClient(
  opts: {
    distro?: string;
    intervalMs?: number;
    // Injected for tests; defaults spawn wsl.exe for real.
    spawnFn?: typeof spawn;
    run?: (cmd: string, args: string[]) => Promise<string>;
    firstSnapshotTimeoutMs?: number;
    staleAfterMs?: number;
  } = {},
): WslHerdrClient {
  const intervalMs = opts.intervalMs ?? 1000;
  const spawnFn = opts.spawnFn ?? spawn;
  const run = opts.run ?? defaultRun;
  const firstTimeoutMs = opts.firstSnapshotTimeoutMs ?? FIRST_SNAPSHOT_TIMEOUT_MS;
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;

  let child: ChildProcess | null = null;
  let buffer = "";
  let stopped = true;
  let backoff = RESTART_MIN_MS;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let latest: { raw: RawAgent[]; at: number } | null = null;
  let latestAgents: RawAgent[] | null = null;
  let latestTabs: RawTab[] = [];
  let waiters: Array<() => void> = [];

  const waitForSnapshot = (timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        waiters = waiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      waiters.push(done);
    });

  const publish = (): void => {
    if (!latestAgents) return;
    latest = { raw: mergeTabLabels(latestAgents, latestTabs), at: Date.now() };
    backoff = RESTART_MIN_MS;
    const pending = waiters;
    waiters = [];
    pending.forEach((fn) => fn());
  };

  const onLine = (line: string): void => {
    const tabs = parseTabs(line);
    if (tabs) {
      latestTabs = tabs;
      publish();
      return;
    }
    const agents = parseSnapshot(line);
    if (!agents) return;
    latestAgents = agents;
    publish();
  };

  const scheduleRestart = (): void => {
    if (stopped || restartTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, RESTART_MAX_MS);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, wait);
  };

  const start = (): void => {
    if (!stopped && child) return;
    stopped = false;
    try {
      const proc = spawnFn(WSL_BIN, wslShellArgs(opts.distro, streamCommand(intervalMs)), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        lines.forEach(onLine);
      });
      proc.on("exit", () => {
        if (child === proc) child = null;
        scheduleRestart();
      });
      proc.on("error", () => {
        if (child === proc) child = null;
        scheduleRestart();
      });
      child = proc;
    } catch {
      scheduleRestart();
    }
  };

  const stop = (): void => {
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const proc = child;
    child = null;
    proc?.kill();
  };

  const fresh = (): RawAgent[] | null =>
    latest && Date.now() - latest.at <= staleAfterMs ? latest.raw : null;

  return {
    start,
    stop,
    async listAgents() {
      const current = fresh();
      if (current) return current;
      // Cold start (Windows boot, distro waking): give the stream a moment
      // instead of flashing an unhealthy snapshot on the first poll.
      await waitForSnapshot(latest ? 2000 : firstTimeoutMs);
      const afterWait = fresh();
      if (afterWait) return afterWait;
      throw new Error("wsl herdr: no fresh agent list");
    },
    async focus(paneId) {
      if (!isPaneId(paneId)) throw new Error(`invalid pane id: ${paneId}`);
      await run(WSL_BIN, wslShellArgs(opts.distro, `herdr agent focus ${paneId}`));
    },
    // WSL-side notifications never reach Windows, so flips stay on the keys
    // (flash) instead of pretending to notify.
    async notify(_title: string, _opts?: NotifyOpts) {},
  };
}

function defaultRun(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
        else resolve(stdout);
      },
    );
  });
}
