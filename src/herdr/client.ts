// src/herdr/client.ts
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RawAgent } from "../core/agents";

export type RunFn = (cmd: string, args: string[], extraEnv?: Record<string, string>) => Promise<string>;

// Stream Deck launches the plugin with a minimal PATH; make the usual install
// locations reachable. Prepending (not appending) prefers the known-good binary
// and avoids a leading separator when PATH is empty, which would otherwise put
// CWD first and let a malicious `herdr` in the working directory run ahead of
// the real one.
const POSIX_PATH_EXTRA = ["/opt/homebrew/bin", "/usr/local/bin"];

// herdr's own installer keeps versioned binaries under ~/.herdr and relies on a
// PATH entry that a Stream Deck started earlier may not have inherited. Find
// those directories explicitly instead of trusting the environment.
export function windowsHerdrReleaseDirs(home: string = os.homedir()): string[] {
  const releases = path.join(home, ".herdr", "packages", "standalone", "releases");
  let entries: string[];
  try {
    entries = fs.readdirSync(releases);
  } catch {
    return [];
  }
  // Newest first: release dirs are named `<version>-<target>`.
  const rank = (name: string): number[] =>
    (name.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n));
  entries.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < 3; i += 1) {
      const diff = (y[i] ?? -1) - (x[i] ?? -1);
      if (diff !== 0) return diff;
    }
    return b.localeCompare(a);
  });
  return entries.map((name) => path.join(releases, name)).filter((dir) => {
    try {
      return fs.statSync(path.join(dir, "herdr.exe")).isFile();
    } catch {
      return false;
    }
  });
}

export function extraPathDirs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? windowsHerdrReleaseDirs() : POSIX_PATH_EXTRA;
}

// PATH is `;`-separated on Windows and `:`-separated elsewhere; joining with the
// wrong one hands the child a single unusable entry (and on Windows a path
// containing colons), so `herdr` is never found.
export function buildPath(
  platform: NodeJS.Platform = process.platform,
  base: string = process.env.PATH ?? "",
): string {
  const sep = platform === "win32" ? ";" : ":";
  return [...extraPathDirs(platform), base].filter((p) => p.length > 0).join(sep);
}

// Absolute candidates for the herdr binary, best first. The Stream Deck plugin
// host runs with the app's environment, not the user's shell, so on Windows the
// installed binary is located by path rather than assumed to be on PATH.
export function herdrBinCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return ["herdr"];
  const local = process.env.LOCALAPPDATA ?? "";
  return [
    ...windowsHerdrReleaseDirs().map((dir) => path.join(dir, "herdr.exe")),
    local ? path.join(local, "Programs", "herdr", "herdr.exe") : "",
    "herdr.exe",
  ].filter((p) => p.length > 0);
}

export function resolveHerdrBin(platform: NodeJS.Platform = process.platform): string {
  const candidates = herdrBinCandidates(platform);
  return candidates.find((c) => c.includes(path.sep) && fs.existsSync(c)) ?? candidates[candidates.length - 1];
}

// Shared promisified execFile (also used by the ssh tunnel): no shell, stderr
// folded into the rejection message.
export function execText(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 4000, maxBuffer: 1024 * 1024, env: opts.env, signal: opts.signal },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
        else resolve(stdout);
      },
    );
  });
}

const defaultRun: RunFn = (cmd, args, extraEnv) =>
  execText(cmd, args, {
    env: { ...process.env, PATH: buildPath(), ...extraEnv },
  });

export type NotifyOpts = { body?: string; sound?: "none" | "done" | "request" };

export type RawTab = { tab_id?: string; label?: string; number?: number };

export function parseAgentList(stdout: string): RawAgent[] {
  const parsed: unknown = JSON.parse(stdout);
  const agents = (parsed as { result?: { agents?: unknown } })?.result?.agents;
  if (!Array.isArray(agents)) throw new Error("unexpected `herdr agent list` shape");
  return agents as RawAgent[];
}

// Tabs carry the label herdr shows in its own tab bar ("opencode stream"), which
// is what the deck should mirror; the terminal title is a different thing.
export function parseTabList(stdout: string): RawTab[] {
  const parsed: unknown = JSON.parse(stdout);
  const tabs = (parsed as { result?: { tabs?: unknown } })?.result?.tabs;
  return Array.isArray(tabs) ? (tabs as RawTab[]) : [];
}

function safeTabs(stdout: string): RawTab[] {
  try {
    return parseTabList(stdout);
  } catch {
    return [];
  }
}

// Join labels onto the agents by tab id. Agents whose tab has no label keep
// their terminal title as the fallback.
export function mergeTabLabels(agents: RawAgent[], tabs: RawTab[]): RawAgent[] {
  const byTab = new Map<string, string>();
  for (const tab of tabs) {
    if (typeof tab.tab_id === "string" && typeof tab.label === "string") byTab.set(tab.tab_id, tab.label);
  }
  return agents.map((agent) => {
    const label = typeof agent.tab_id === "string" ? byTab.get(agent.tab_id) : undefined;
    return label === undefined ? agent : { ...agent, tab_label: label };
  });
}

export type HerdrClient = {
  listAgents(): Promise<RawAgent[]>;
  focus(paneId: string): Promise<void>;
  notify(title: string, opts?: NotifyOpts): Promise<void>;
};

// `socketPath` (when it returns a path) targets the CLI at that herdr server
// socket via HERDR_SOCKET_PATH - this is how remote mode points the local
// `herdr` binary at the SSH-forwarded socket. A getter rather than a value so
// the client tracks settings changes without being rebuilt.
export function createHerdrClient(
  opts: { run?: RunFn; bin?: string; socketPath?: () => string | undefined } = {},
): HerdrClient {
  const baseRun = opts.run ?? defaultRun;
  const bin = opts.bin ?? resolveHerdrBin();
  const run: (cmd: string, args: string[]) => Promise<string> = (cmd, args) => {
    const sock = opts.socketPath?.();
    return baseRun(cmd, args, sock !== undefined ? { HERDR_SOCKET_PATH: sock } : undefined);
  };
  return {
    async listAgents() {
      // Tab labels are a separate call, and the tab bar is what the deck mirrors.
      // A herdr too old to know `tab list` still works: labels just stay empty and
      // the label falls back to the terminal title.
      const [agentsOut, tabsOut] = await Promise.allSettled([
        run(bin, ["agent", "list"]),
        run(bin, ["tab", "list"]),
      ]);
      if (agentsOut.status === "rejected") throw agentsOut.reason;
      const agents = parseAgentList(agentsOut.value);
      const tabs = tabsOut.status === "fulfilled" ? safeTabs(tabsOut.value) : [];
      return mergeTabLabels(agents, tabs);
    },
    async focus(paneId) {
      await run(bin, ["agent", "focus", paneId]);
    },
    async notify(title, opts = {}) {
      const args = ["notification", "show", title];
      if (opts.body !== undefined) args.push("--body", opts.body);
      if (opts.sound !== undefined) args.push("--sound", opts.sound);
      await run(bin, args);
    },
  };
}
