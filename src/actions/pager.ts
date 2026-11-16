// src/actions/pager.ts
import streamDeck, {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
} from "@elgato/streamdeck";
import type { HerdrRuntime, RuntimeHub } from "../core/runtime";
import { sourceKey, sourceSpec, type SourceSettings } from "../core/sources";
import { pageCount, attentionAgents, worstAttention, PAGE_SIZE } from "../core/pagination";
import { renderPagerSvg, renderAttentionSvg } from "../core/render";

// One key, two modes. When any agent on that key's source is blocked or done it
// acts as "jump to the next agent needing attention" (focus + cycle on repeat
// presses); otherwise it pages through that source's agent grid. The rendered
// icon shows which mode is active, so a single key covers both jobs on the 6-key
// Mini.
type PagerSettings = SourceSettings & {
  // Windows: which terminal window/tab shows the agent. Empty = detected window.
  termWindow?: string;
  termTab?: number | string;
};

@action({ UUID: "dev.timvdhoorn.herdr-agents.pager" })
export class PagerAction extends SingletonAction<PagerSettings> {
  // paneId we last jumped to per key, so repeated presses cycle through attention
  // agents.
  readonly #cursor = new Map<string, string>();
  readonly #sources = new Map<string, { key: string; runtime: HerdrRuntime; off: () => void }>();

  constructor(private readonly hub: RuntimeHub) {
    super();
  }

  override onWillAppear(ev: WillAppearEvent<PagerSettings>): void {
    this.#apply(ev.action.id, ev.payload.settings);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<PagerSettings>): void {
    this.#apply(ev.action.id, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<PagerSettings>): void {
    this.#sources.get(ev.action.id)?.off();
    this.#sources.delete(ev.action.id);
    this.#cursor.delete(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<PagerSettings>): Promise<void> {
    const entry = this.#sources.get(ev.action.id);
    if (!entry) return;
    const { store, client, terminal } = entry.runtime;
    const list = attentionAgents(store.getState().agents);
    if (list.length === 0) {
      store.nextPage();
      return;
    }
    const cursor = this.#cursor.get(ev.action.id);
    const at = list.findIndex((a) => a.paneId === cursor);
    const next = list[(at + 1) % list.length]; // at === -1 starts at 0
    this.#cursor.set(ev.action.id, next.paneId);
    try {
      await client.focus(next.paneId);
    } catch (e) {
      streamDeck.logger.error(`attention focus failed: ${String(e)}`);
    }
    // Bring the host terminal forward too (no-op if already frontmost).
    try {
      await terminal.activate({
        window: ev.payload.settings.termWindow,
        tab: Number(ev.payload.settings.termTab ?? 0) || 0,
      });
    } catch (e) {
      streamDeck.logger.error(`raise terminal failed: ${String(e)}`);
    }
  }

  #apply(actionId: string, settings: SourceSettings): void {
    const spec = sourceSpec(settings);
    const key = sourceKey(spec);
    const current = this.#sources.get(actionId);
    if (current?.key === key) {
      this.renderAll();
      return;
    }
    current?.off();
    const runtime = this.hub.get(spec);
    const off = this.hub.subscribe(spec, () => this.renderAll());
    this.#sources.set(actionId, { key, runtime, off });
    this.renderAll();
  }

  renderAll(): void {
    this.actions.forEach((a) => {
      if (!a.isKey()) return;
      const entry = this.#sources.get(a.id);
      if (!entry) return;
      const { agents, page } = entry.runtime.store.getState();
      const attention = attentionAgents(agents);
      const svg =
        attention.length > 0
          ? renderAttentionSvg({ count: attention.length, attention: worstAttention(agents) })
          : renderPagerSvg({
              page,
              total: pageCount(agents.length, PAGE_SIZE),
              attention: null,
              count: 0,
            });
      void a.setImage(svg);
    });
  }
}
