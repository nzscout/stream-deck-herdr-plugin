// src/plugin.ts
import streamDeck from "@elgato/streamdeck";
import { createHerdrClient, type HerdrClient } from "./herdr/client";
import { createTerminalActivator, type TerminalActivator } from "./os/terminal";
import { createAgentStore } from "./core/store";
import { AgentSlotAction } from "./actions/slot";
import { PagerAction } from "./actions/pager";
import { createHerdrEvents, type EventsClient } from "./herdr/events";
import { createSshTunnel } from "./herdr/tunnel";
import { createWslHerdrClient } from "./herdr/wsl";
import { createRuntimeHub, type HerdrRuntime } from "./core/runtime";
import { sourceKey, type SourceSpec } from "./core/sources";

// Node's `net` module cannot open herdr's AF_UNIX socket on Windows (it treats
// the path as a named pipe and fails with ENOTSOCK), so there is no push channel
// there and the poll runs at full speed instead. Remote mode forwards that same
// socket over ssh, which is POSIX-only, so it is unavailable on Windows too.
const PUSH_EVENTS = process.platform !== "win32";

streamDeck.logger.setLevel("info");

const log = {
  info: (msg: string) => streamDeck.logger.info(msg),
  error: (msg: string) => streamDeck.logger.error(msg),
};

// One runtime per source, created on first use. Keys choose their source
// individually, so this PC, one or more WSL distros, and (POSIX) remote boxes can
// share the same deck.
function buildRuntime(spec: SourceSpec): HerdrRuntime {
  const terminal = createTerminalActivator({
    app: process.env.HERDR_DECK_TERMINAL_APP,
    distro: spec.kind === "wsl" ? spec.distro : undefined,
  });
  terminal.warm();

  const disposers: Array<() => void> = [];
  let client: HerdrClient = createHerdrClient();
  let pollMs = PUSH_EVENTS ? 3000 : 1000;

  if (spec.kind === "wsl") {
    // Streaming client: one long-lived wsl.exe shell, one snapshot per second.
    const wsl = createWslHerdrClient({ distro: spec.distro || undefined, intervalMs: 1000 });
    wsl.start();
    client = wsl;
    pollMs = 1000;
    disposers.push(() => wsl.stop());
  }

  const store = createAgentStore({ fetchAgents: () => client.listAgents() });

  // Debounce refreshes so a burst of socket events causes at most one poll.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const refresh = (): void => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      void store.pollNow();
    }, 150);
  };

  if (spec.kind === "ssh" && PUSH_EVENTS) {
    let events: EventsClient | null = null;
    const tunnel = createSshTunnel({
      target: spec.target,
      remoteSocketPath: spec.socket || undefined,
      onUp: () => {
        events?.stop();
        events?.start();
        refresh();
      },
      onError: (m) => log.error(`tunnel: ${m}`),
    });
    const ev = createHerdrEvents({ onChange: refresh, socketPath: tunnel.localSocket });
    events = ev;
    tunnel.start();
    ev.start();
    client = createHerdrClient({ socketPath: () => tunnel.localSocket });
    pollMs = 3000;
    disposers.push(() => {
      ev.stop();
      tunnel.stop();
    });
  } else if (spec.kind === "local" && PUSH_EVENTS) {
    const events = createHerdrEvents({ onChange: refresh });
    events.start();
    disposers.push(() => events.stop());
  } else if (spec.kind === "ssh") {
    // Windows cannot forward a Unix socket, so an ssh key there stays on this PC.
    log.error("remote herdr needs a POSIX ssh socket forward; this key will read local herdr");
  }

  store.start(pollMs);

  return {
    key: sourceKey(spec),
    spec,
    store,
    client,
    terminal,
    dispose() {
      store.stop();
      if (pending) clearTimeout(pending);
      for (const fn of disposers) fn();
      terminal.dispose();
    },
  };
}

const hub = createRuntimeHub(buildRuntime, log);

const slot = new AgentSlotAction(hub);
const pager = new PagerAction(hub);

// The Property Inspector asks for the terminal windows that exist right now, so the
// "Window title" field is a picker instead of a text box. One probe helper owns the
// enumeration; it is created on first use and reused afterwards.
let probe: TerminalActivator | null = null;
streamDeck.ui.onSendToPlugin(async (ev) => {
  const payload = ev.payload as { event?: string } | undefined;
  if (payload?.event !== "terminalWindows") return;
  probe ??= createTerminalActivator({ app: process.env.HERDR_DECK_TERMINAL_APP });
  const windows = await probe.listWindows();
  await streamDeck.ui.sendToPropertyInspector({
    event: "terminalWindows",
    items: [
      { label: "Auto (detected)", value: "" },
      ...windows.map((w) => ({ label: w.title, value: w.title })),
    ],
  });
});

// Stream Deck stops the plugin by terminating the process; without this the ssh
// forwards and WSL shells would outlive us.
process.on("exit", () => hub.disposeAll());
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => process.exit(0)); // run the exit handler
}

streamDeck.actions.registerAction(slot);
streamDeck.actions.registerAction(pager);

await streamDeck.connect();
