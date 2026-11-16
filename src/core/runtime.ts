// src/core/runtime.ts
import type { Agent } from "./agents";
import type { AgentStore, StoreState } from "./store";
import type { HerdrClient } from "../herdr/client";
import type { TerminalActivator } from "../os/terminal";
import { detectFlips } from "./transitions";
import { labelFor } from "./agents";
import { describeSource, sourceKey, type SourceSpec } from "./sources";

// One source of agents: its poller, its window raiser, and its store. Keys on the
// same source share this; keys on different sources never see each other's agents.
export type HerdrRuntime = {
  key: string;
  spec: SourceSpec;
  store: AgentStore;
  client: HerdrClient;
  terminal: TerminalActivator;
  dispose(): void;
};

export type RuntimeFactory = (spec: SourceSpec) => HerdrRuntime;

export type RuntimeListener = (state: StoreState, flips: Agent[]) => void;

export type RuntimeHub = {
  get(spec: SourceSpec): HerdrRuntime;
  subscribe(spec: SourceSpec, fn: RuntimeListener): () => void;
  disposeAll(): void;
};

// Builds runtimes on demand, one per source, and turns each store's snapshots
// into three effects: re-render, herdr notification for blocked/done flips, and a
// per-key flash callback (subscribers get the flips).
export function createRuntimeHub(
  factory: RuntimeFactory,
  onLog: { info(msg: string): void; error(msg: string): void } = console,
): RuntimeHub {
  const runtimes = new Map<string, HerdrRuntime>();
  const listeners = new Map<string, Set<RuntimeListener>>();

  const emit = (key: string, state: StoreState, flips: Agent[]): void => {
    const subs = listeners.get(key);
    if (!subs) return;
    for (const fn of [...subs]) fn(state, flips);
  };

  const get = (spec: SourceSpec): HerdrRuntime => {
    const key = sourceKey(spec);
    const existing = runtimes.get(key);
    if (existing) return existing;

    onLog.info(`herdr source: ${describeSource(spec)}`);
    const runtime = factory(spec);
    runtimes.set(key, runtime);

    let prev: Agent[] | null = null;
    runtime.store.subscribe((state) => {
      // Unhealthy snapshots (startup, connection down) must not become the
      // notification baseline: a wiped list diffed against the first real
      // snapshot would alert for every agent that was already blocked/done.
      if (!state.healthy) {
        prev = null;
        emit(key, state, []);
        return;
      }
      if (prev === null) {
        prev = state.agents;
        emit(key, state, []);
        return;
      }
      const flips = detectFlips(prev, state.agents);
      prev = state.agents;
      emit(key, state, flips);
      for (const a of flips) {
        const sound = a.status === "blocked" ? "request" : "done";
        void runtime.client.notify(`${labelFor(a, state.agents)} ${a.status}`, {
          body: a.name,
          sound,
        });
      }
    });

    return runtime;
  };

  return {
    get,
    subscribe(spec, fn) {
      const key = sourceKey(spec);
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(fn);
      return () => {
        set?.delete(fn);
        if (set && set.size === 0) listeners.delete(key);
      };
    },
    disposeAll() {
      for (const runtime of runtimes.values()) runtime.dispose();
      runtimes.clear();
      listeners.clear();
    },
  };
}
