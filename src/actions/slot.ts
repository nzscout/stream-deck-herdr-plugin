// src/actions/slot.ts
import streamDeck, {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type KeyUpEvent,
} from "@elgato/streamdeck";
import type { HerdrRuntime, RuntimeHub } from "../core/runtime";
import { sourceKey, sourceSpec, type SourceSettings } from "../core/sources";
import { pageSlice, PAGE_SIZE } from "../core/pagination";
import { labelFor, type DisplayMode } from "../core/agents";
import { renderKeySvg } from "../core/render";

type SlotSettings = SourceSettings & {
  slotIndex?: number;
  display?: DisplayMode;
  // Windows: which terminal window/tab shows the agent. Empty = detected window,
  // and the tab that happens to be active.
  termWindow?: string;
  termTab?: number | string;
};

// Press-length threshold: below this a key press focuses the agent, at/above it
// the press toggles a pin.
const LONG_PRESS_MS = 400;

@action({ UUID: "dev.timvdhoorn.herdr-agents.slot" })
export class AgentSlotAction extends SingletonAction<SlotSettings> {
  readonly #slots = new Map<string, number>(); // action instance id -> slot index
  readonly #displays = new Map<string, DisplayMode>(); // action instance id -> display mode
  readonly #pressStart = new Map<string, number>(); // action instance id -> keydown timestamp
  // Per key: which source it reads, and the unsubscribe for that source's updates.
  readonly #sources = new Map<string, { key: string; runtime: HerdrRuntime; off: () => void }>();

  constructor(private readonly hub: RuntimeHub) {
    super();
  }

  override onWillAppear(ev: WillAppearEvent<SlotSettings>): void {
    this.#apply(ev.action.id, ev.payload.settings);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): void {
    this.#apply(ev.action.id, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<SlotSettings>): void {
    this.#sources.get(ev.action.id)?.off();
    this.#sources.delete(ev.action.id);
    this.#slots.delete(ev.action.id);
    this.#displays.delete(ev.action.id);
  }

  override onKeyDown(ev: KeyDownEvent<SlotSettings>): void {
    this.#pressStart.set(ev.action.id, Date.now());
  }

  override onKeyUp(ev: KeyUpEvent<SlotSettings>): void {
    const start = this.#pressStart.get(ev.action.id);
    this.#pressStart.delete(ev.action.id);
    const entry = this.#sources.get(ev.action.id);
    if (!entry) return;
    const index = this.#slots.get(ev.action.id) ?? 0;
    const { agents, page } = entry.runtime.store.getState();
    const agent = pageSlice(agents, page, PAGE_SIZE)[index];
    if (!agent) return;
    const longPress = start !== undefined && Date.now() - start >= LONG_PRESS_MS;
    if (longPress) {
      // Long-press pins: the agent jumps to slot 1 (next pin beside it) and
      // stays visible even when idle. The store emit re-renders all keys.
      entry.runtime.store.togglePin(agent.paneId);
    } else {
      void this.#focus(entry.runtime, agent.paneId, ev.payload.settings);
    }
  }

  async #focus(runtime: HerdrRuntime, paneId: string, settings: SlotSettings): Promise<void> {
    try {
      await runtime.client.focus(paneId);
    } catch (e) {
      streamDeck.logger.error(`focus failed: ${String(e)}`);
    }
    // Raise the host terminal so the focused pane is actually on screen even when
    // the terminal was in the background. Independent of focus so a raise failure
    // never masks a successful pane switch.
    try {
      await runtime.terminal.activate({
        window: settings.termWindow,
        tab: Number(settings.termTab ?? 0) || 0,
      });
    } catch (e) {
      streamDeck.logger.error(`raise terminal failed: ${String(e)}`);
    }
  }

  // Point one key at the source its settings ask for, swapping the subscription
  // when the key moves to another source.
  #apply(actionId: string, settings: SlotSettings): void {
    this.#slots.set(actionId, Number(settings.slotIndex ?? 0));
    this.#displays.set(actionId, settings.display ?? "project");
    const spec = sourceSpec(settings);
    const key = sourceKey(spec);
    const current = this.#sources.get(actionId);
    if (current?.key === key) {
      this.renderAll();
      return;
    }
    current?.off();
    const runtime = this.hub.get(spec);
    const off = this.hub.subscribe(spec, (_state, flips) => {
      for (const a of flips) this.flash(a.paneId);
      this.renderAll();
    });
    this.#sources.set(actionId, { key, runtime, off });
    this.renderAll();
  }

  // Flash the key currently showing this agent, on whichever source that key is
  // pointed at.
  flash(paneId: string): void {
    this.actions.forEach((a) => {
      if (!a.isKey()) return;
      const entry = this.#sources.get(a.id);
      if (!entry) return;
      const { agents, page } = entry.runtime.store.getState();
      const index = this.#slots.get(a.id) ?? 0;
      if (pageSlice(agents, page, PAGE_SIZE)[index]?.paneId === paneId) void a.showAlert();
    });
  }

  renderAll(): void {
    this.actions.forEach((a) => {
      if (!a.isKey()) return;
      const entry = this.#sources.get(a.id);
      if (!entry) return;
      const { agents, page } = entry.runtime.store.getState();
      const index = this.#slots.get(a.id) ?? 0;
      const display = this.#displays.get(a.id) ?? "project";
      const agent = pageSlice(agents, page, PAGE_SIZE)[index];
      void a.setTitle("");
      void a.setImage(
        renderKeySvg(
          agent
            ? {
                label: labelFor(agent, agents, display),
                status: agent.status,
                agent: agent.name,
                pinned: entry.runtime.store.isPinned(agent.paneId),
              }
            : null,
        ),
      );
    });
  }
}
