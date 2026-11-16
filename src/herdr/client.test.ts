// src/herdr/client.test.ts
import { test, expect } from "bun:test";
import path from "node:path";
import { buildPath, createHerdrClient, herdrBinCandidates, mergeTabs, resolveHerdrBin, type RunFn } from "./client";
import fixture from "../../tests/fixtures/agent-list.json";

test("listAgents runs `herdr agent list` and returns the agents array", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return JSON.stringify(fixture);
  };
  const client = createHerdrClient({ run, bin: "herdr" });
  const agents = await client.listAgents();
  expect(agents).toHaveLength(4);
  expect(calls[0]).toEqual(["herdr", "agent", "list"]);
});

test("listAgents throws on malformed shape", async () => {
  const run: RunFn = async () => JSON.stringify({ result: {} });
  const client = createHerdrClient({ run, bin: "herdr" });
  await expect(client.listAgents()).rejects.toThrow();
});

test("focus runs `herdr agent focus <paneId>`", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return "";
  };
  const client = createHerdrClient({ run, bin: "herdr" });
  await client.focus("wJ:p1");
  expect(calls[0]).toEqual(["herdr", "agent", "focus", "wJ:p1"]);
});

test("socketPath getter targets the CLI via HERDR_SOCKET_PATH", async () => {
  const envs: (Record<string, string> | undefined)[] = [];
  const run: RunFn = async (_cmd, _args, extraEnv) => {
    envs.push(extraEnv);
    return "";
  };
  let sock: string | undefined;
  const client = createHerdrClient({ run, bin: "herdr", socketPath: () => sock });
  await client.focus("w1:p1");
  sock = "/tmp/fwd.sock";
  await client.focus("w1:p1");
  expect(envs).toEqual([undefined, { HERDR_SOCKET_PATH: "/tmp/fwd.sock" }]);
});

test("notify runs `herdr notification show` with body + sound", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (cmd, args) => { calls.push([cmd, ...args]); return ""; };
  const client = createHerdrClient({ run, bin: "herdr" });
  await client.notify("proj blocked", { body: "claude", sound: "request" });
  expect(calls[0]).toEqual(["herdr", "notification", "show", "proj blocked", "--body", "claude", "--sound", "request"]);
});

test("PATH is joined with the platform separator", () => {
  // Windows' separator is ';': joining with ':' there produces one unusable
  // entry, so `herdr` is never resolved.
  const win = buildPath("win32", "C:\\bin");
  expect(win).toContain(";C:\\bin");
  expect(win).not.toMatch(/:[A-Za-z]:\\/);
  const mac = buildPath("darwin", "/usr/bin");
  expect(mac.startsWith("/opt/homebrew/bin:")).toBe(true);
  expect(mac).toContain(":/usr/bin");
});

test("win32 binary candidates prefer herdr's own install directories", () => {
  const candidates = herdrBinCandidates("win32");
  expect(candidates[candidates.length - 1]).toBe("herdr.exe");
  expect(candidates.some((c) => c.includes(".herdr") && c.endsWith("herdr.exe"))).toBe(true);
  expect(resolveHerdrBin("win32").length).toBeGreaterThan(0);
  expect(resolveHerdrBin("darwin")).toBe("herdr");
});
test("tab labels are merged onto agents by tab id", () => {
  const agents = [
    { agent: "x", pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
    { agent: "y", pane_id: "w2:p2", tab_id: "w2:t9", workspace_id: "w2" },
  ];
  const merged = mergeTabs(agents, [
    { tab_id: "w2:t1", label: "opencode stream" },
    { tab_id: "w2:t2", label: "other" },
  ]);
  expect(merged[0].tab_label).toBe("opencode stream");
  // An agent whose tab has no label keeps no label (the label falls back later).
  expect(merged[1].tab_label).toBeUndefined();
  expect(agents[0].tab_label).toBeUndefined(); // input not mutated
});

test("listAgents joins `tab list` labels onto the agents", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === "tab") {
      return JSON.stringify({ result: { tabs: [{ tab_id: "w2:t1", label: "opencode stream" }] } });
    }
    return JSON.stringify({
      result: { agents: [{ agent: "x", pane_id: "w2:p1", tab_id: "w2:t1", agent_status: "working" }] },
    });
  };
  const client = createHerdrClient({ run, bin: "herdr" });
  const agents = await client.listAgents();
  expect(agents[0].tab_label).toBe("opencode stream");
  expect(calls.map((c) => c[0]).sort()).toEqual(["agent", "tab"]);
});

test("a missing `tab list` (older herdr) still returns agents", async () => {
  const run: RunFn = async (_cmd, args) => {
    if (args[0] === "tab") throw new Error("unknown subcommand");
    return JSON.stringify({ result: { agents: [{ agent: "x", pane_id: "w2:p1", agent_status: "idle" }] } });
  };
  const client = createHerdrClient({ run, bin: "herdr" });
  const agents = await client.listAgents();
  expect(agents).toHaveLength(1);
  expect(agents[0].tab_label).toBeUndefined();
});

test("tab numbers come from herdr so slot order matches the tab bar", () => {
  const agents = [
    // A window can assign p11 before p2 while the tabs are numbered 1 and 2.
    { agent: "x", pane_id: "w2:p11", tab_id: "w2:t2", workspace_id: "w2" },
    { agent: "y", pane_id: "w2:p2", tab_id: "w2:t1", workspace_id: "w2" },
  ];
  const merged = mergeTabs(agents, [
    { tab_id: "w2:t1", label: "first", number: 1 },
    { tab_id: "w2:t2", label: "second", number: 2 },
  ]);
  expect(merged.map((a) => a.tab_number)).toEqual([2, 1]);
});
