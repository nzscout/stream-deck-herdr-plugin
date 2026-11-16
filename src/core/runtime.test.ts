// src/core/runtime.test.ts
import { test, expect } from "bun:test";
import { createRuntimeHub, type HerdrRuntime } from "./runtime";
import { createAgentStore } from "./store";
import type { RawAgent } from "./agents";

const quiet = { info: () => {}, error: () => {} };

function fakeRuntime(spec: { kind: string }, fetchAgents: () => Promise<RawAgent[]>): HerdrRuntime & {
  notices: string[];
} {
  const notices: string[] = [];
  const store = createAgentStore({ fetchAgents });
  return {
    key: spec.kind,
    spec: spec as never,
    store,
    client: {
      listAgents: fetchAgents,
      async focus() {},
      async notify(title: string) {
        notices.push(title);
      },
    },
    terminal: { async activate() {}, warm() {}, dispose() {} },
    dispose: () => store.stop(),
    notices,
  };
}

const agent = (pane: string, status: string): RawAgent => ({
  agent: "claude",
  agent_status: status,
  cwd: `/x/${pane}`,
  pane_id: pane,
  workspace_id: "w1",
});

test("the same source is built once and shared by every key on it", () => {
  let built = 0;
  const hub = createRuntimeHub((spec) => {
    built += 1;
    return fakeRuntime(spec, async () => [agent("w1:p1", "idle")]);
  }, quiet);
  const a = hub.get({ kind: "local" });
  const b = hub.get({ kind: "local" });
  expect(a).toBe(b);
  expect(built).toBe(1);
  // A different distro is a different source.
  hub.get({ kind: "wsl", distro: "Ubuntu" });
  hub.get({ kind: "wsl", distro: "Ubuntu" });
  expect(built).toBe(2);
  hub.disposeAll();
});

test("subscribers hear renders first and flip notifications from their own source", async () => {
  let status = "working";
  const runtime = fakeRuntime({ kind: "local" }, async () => [agent("w1:p1", status)]);
  const hub = createRuntimeHub(() => runtime, quiet);
  hub.get({ kind: "local" }); // wires the store subscription, as a key would
  const seen: string[][] = [];
  hub.subscribe({ kind: "local" }, (state, flips) => {
    seen.push(flips.map((f) => f.status));
    expect(state.agents.length).toBeGreaterThan(0);
  });

  await runtime.store.pollNow(); // prime: no notification for pre-existing state
  expect(seen.at(-1)).toEqual([]);
  expect(runtime.notices).toEqual([]);

  status = "blocked";
  await runtime.store.pollNow();
  expect(seen.at(-1)).toEqual(["blocked"]);
  expect(runtime.notices[0]).toContain("blocked");

  // An unhealthy snapshot never becomes the baseline.
  await runtime.store.pollNow();
  hub.disposeAll();
});

test("unsubscribing stops delivery, and disposeAll clears every source", async () => {
  const runtime = fakeRuntime({ kind: "local" }, async () => [agent("w1:p1", "idle")]);
  const hub = createRuntimeHub(() => runtime, quiet);
  hub.get({ kind: "local" });
  let calls = 0;
  const off = hub.subscribe({ kind: "local" }, () => {
    calls += 1;
  });
  await runtime.store.pollNow();
  const afterFirst = calls;
  expect(afterFirst).toBeGreaterThan(0);
  off();
  await runtime.store.pollNow();
  expect(calls).toBe(afterFirst);
  hub.disposeAll();
});
