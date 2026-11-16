// src/plugin.ts
import streamDeck from "@elgato/streamdeck";
import { createHerdrClient, type HerdrClient } from "./herdr/client";
import { createTerminalActivator, type TerminalActivator } from "./os/terminal";
import { createAgentStore } from "./core/store";
import { AgentSlotAction } from "./actions/slot";
import { PagerAction } from "./actions/pager";
import { createHerdrEvents, type EventsClient } from "./herdr/events";
import { createSshTunnel, type Tunnel } from "./herdr/tunnel";
import { createWslHerdrClient, type WslHerdrClient } from "./herdr/wsl";
import { detectFlips } from "./core/transitions";
import { labelFor } from "./core/agents";
import type { Agent } from "./core/agents";

// Plugin-wide connection settings (set from any Agent Slot property inspector).
// "local" talks to the herdr server on this machine (the default); "wsl" talks to
// herdr inside a WSL distro; sshTarget (POSIX only) tunnels to a remote box.
type GlobalSettings = {
  source?: "local" | "wsl";
  wslDistro?: string;
  sshTarget?: string;
  remoteSocketPath?: string;
};

// Node's `net` module cannot open herdr's AF_UNIX socket on Windows (it treats
// the path as a named pipe and fails with ENOTSOCK), so there is no push channel
// there and the poll runs at full speed instead. Remote mode forwards that same
// socket over ssh, which is POSIX-only, so it is unavailable on Windows too.
const PUSH_EVENTS = process.platform !== "win32";
const POLL_MS = PUSH_EVENTS ? 3000 : 1000;

streamDeck.logger.setLevel("info");

let tunnel: Tunnel | null = null;
let wsl: WslHerdrClient | null = null;

// Swapped by applyConnection() when the source changes; the store fetches through
// this binding, so a replacement takes effect on the next poll.
let herdr: HerdrClient & { start?: () => void; stop?: () => void } = createHerdrClient({
  socketPath: () => tunnel?.localSocket,
});

// undefined app → default: iTerm on macOS, herdr's host terminal on Windows.
// Set HERDR_DECK_TERMINAL_APP to override either.
let terminal: TerminalActivator = createTerminalActivator({
  app: process.env.HERDR_DECK_TERMINAL_APP,
});
let terminalDistro: string | undefined;

const store = createAgentStore({ fetchAgents: () => herdr.listAgents() });

const slot = new AgentSlotAction(store, herdr, terminal);
const pager = new PagerAction(store, herdr, terminal);

let prevAgents: Agent[] | null = null;

store.subscribe((s) => {
  slot.renderAll();
  pager.renderAll();

  // Unhealthy snapshots (startup, connection down) must not become the
  // notification baseline: a wiped list diffed against the first real snapshot
  // would alert for every agent that was already blocked/done. Keep the
  // baseline suppressed until the connection actually delivers.
  if (!s.healthy) { prevAgents = null; return; }
  if (prevAgents === null) { prevAgents = s.agents; return; } // prime, no alert on first snapshot
  const flips = detectFlips(prevAgents, s.agents);
  prevAgents = s.agents;
  for (const a of flips) {
    const sound = a.status === "blocked" ? "request" : "done";
    void herdr.notify(`${labelFor(a, s.agents)} ${a.status}`, { body: a.name, sound });
    slot.flash(a.paneId);
  }
});

// Debounce refreshes so a burst of socket events causes at most one poll.
let pending: ReturnType<typeof setTimeout> | null = null;
const refresh = (): void => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    void store.pollNow();
  }, 150);
};

let events: EventsClient | null = null;
let appliedKey: string | null = null;

// The Windows raise looks for the window that hosts herdr by walking up from
// herdr.exe. In WSL mode there is no herdr.exe, so it walks up from the wsl.exe
// of that distro instead; the activator is rebuilt when the distro changes.
const applyTerminal = (distro: string | undefined): void => {
  if (distro === terminalDistro) return;
  terminalDistro = distro;
  terminal.dispose();
  terminal = createTerminalActivator({ app: process.env.HERDR_DECK_TERMINAL_APP, distro });
  slot.terminal = terminal;
  pager.terminal = terminal;
  terminal.warm();
};

// Tear down and rebuild the herdr connection for the given settings.
const applyConnection = (gs: GlobalSettings): void => {
  const source = gs.source === "wsl" ? "wsl" : "local";
  const distro = gs.wslDistro?.trim() ?? "";
  const target = gs.sshTarget?.trim() ?? "";
  const remoteSock = gs.remoteSocketPath?.trim() ?? "";
  const key = `${source}\n${distro}\n${target}\n${remoteSock}`;
  if (key === appliedKey) return;
  appliedKey = key;

  events?.stop();
  events = null;
  tunnel?.stop();
  tunnel = null;
  wsl?.stop();
  wsl = null;
  applyTerminal(source === "wsl" ? distro : undefined);
  // The next snapshot comes from a different server (or a rebuilt connection):
  // prime on it instead of diffing across servers, which would fire a
  // notification for every already-blocked/done agent over there. Resetting the
  // store (not just the baseline) keeps an in-flight fetch or a pin/page
  // re-render from priming the baseline with the old server's list.
  store.reset();

  if (source === "wsl") {
    streamDeck.logger.info(`herdr connection: wsl ${distro || "(default distro)"}`);
    const client = createWslHerdrClient({ distro: distro || undefined, intervalMs: 1000 });
    client.start();
    wsl = client;
    herdr = client;
    refresh();
    return;
  }

  herdr = createHerdrClient({ socketPath: () => tunnel?.localSocket });

  if (target === "" || !PUSH_EVENTS) {
    if (target !== "") {
      streamDeck.logger.warn("remote herdr needs a POSIX ssh socket forward; ignoring it on this platform");
    }
    streamDeck.logger.info("herdr connection: local");
    if (PUSH_EVENTS) {
      const ev = createHerdrEvents({ onChange: refresh });
      events = ev;
      ev.start();
    }
  } else {
    streamDeck.logger.info(`herdr connection: remote via ssh ${target}`);
    const t = createSshTunnel({
      target,
      remoteSocketPath: remoteSock === "" ? undefined : remoteSock,
      onUp: () => {
        ev.stop();
        ev.start();
        refresh();
      },
      onError: (m) => streamDeck.logger.error(`tunnel: ${m}`),
    });
    const ev = createHerdrEvents({ onChange: refresh, socketPath: t.localSocket });
    tunnel = t;
    events = ev;
    t.start();
  }
  refresh();
};

// Stream Deck stops the plugin by terminating the process; without this the
// ssh forward and wsl stream children would outlive us.
process.on("exit", () => {
  tunnel?.stop();
  wsl?.stop();
  terminal.dispose();
});
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => process.exit(0)); // run the exit handler
}

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => applyConnection(ev.settings));

streamDeck.actions.registerAction(slot);
streamDeck.actions.registerAction(pager);

await streamDeck.connect();
applyConnection(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
store.start(POLL_MS); // socket events drive the fast path where the platform has them
