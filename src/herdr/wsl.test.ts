// src/herdr/wsl.test.ts
import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { isPaneId, parseSnapshot, streamCommand, wslShellArgs, createWslHerdrClient } from "./wsl";

const FIXTURE = {
  id: "cli:agent:list",
  result: {
    agents: [
      { agent: "claude", agent_status: "idle", cwd: "/home/me/app", pane_id: "w2:p1", workspace_id: "w2" },
      { agent: "opencode", agent_status: "blocked", cwd: "/home/me", pane_id: "w2:p2", workspace_id: "w2" },
    ],
  },
};

test("every call goes through a login shell so herdr is on PATH", () => {
  expect(wslShellArgs(undefined, "herdr agent list")).toEqual(["-e", "sh", "-lc", "herdr agent list"]);
  expect(wslShellArgs("Ubuntu", "herdr agent list")).toEqual(["-d", "Ubuntu", "-e", "sh", "-lc", "herdr agent list"]);
  // a blank distro means the WSL default
  expect(wslShellArgs("  ", "x")).toEqual(["-e", "sh", "-lc", "x"]);
});

test("the stream asks herdr once per interval, not once per poll", () => {
  expect(streamCommand(1000)).toBe("while :; do herdr agent list; sleep 1; done");
  expect(streamCommand(500)).toBe("while :; do herdr agent list; sleep 1; done");
});

test("parseSnapshot accepts a herdr list line and ignores noise", () => {
  const agents = parseSnapshot(JSON.stringify(FIXTURE));
  expect(agents?.map((a) => a.pane_id)).toEqual(["w2:p1", "w2:p2"]);
  expect(parseSnapshot("Welcome to Ubuntu")).toBeNull();
  expect(parseSnapshot('{"id":"x"}')).toBeNull();
  expect(parseSnapshot('{"result":{"agents":')).toBeNull();
});

test("pane ids are validated before they reach a shell", () => {
  expect(isPaneId("w2:p11")).toBe(true);
  expect(isPaneId("w2:p1; rm -rf ~")).toBe(false);
  expect(isPaneId("$(touch /tmp/x)")).toBe(false);
});

test("the client serves the latest streamed snapshot and focuses through wsl.exe", async () => {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    kill: () => void;
  };
  proc.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  proc.kill = () => {};
  const spawned: string[][] = [];
  const ran: string[][] = [];
  const client = createWslHerdrClient({
    distro: "Ubuntu",
    spawnFn: ((cmd: string, args: string[]) => {
      spawned.push([cmd, ...args]);
      return proc;
    }) as never,
    run: async (cmd, args) => {
      ran.push([cmd, ...args]);
      return "";
    },
  });

  client.start();
  expect(spawned[0][0]).toBe("wsl.exe");
  expect(spawned[0].slice(1, 4)).toEqual(["-d", "Ubuntu", "-e"]);

  // Before any snapshot the fetch fails (store treats it as unhealthy), and does
  // not hang forever: the first-snapshot wait times out.
  const cold = createWslHerdrClient({ run: async () => "", firstSnapshotTimeoutMs: 50 });
  await expect(cold.listAgents()).rejects.toThrow();

  proc.stdout.emit("data", `${JSON.stringify(FIXTURE)}\n`);
  const agents = await client.listAgents();
  expect(agents.map((a) => a.agent_status)).toEqual(["idle", "blocked"]);

  // A split line is stitched back together instead of being dropped.
  const half = JSON.stringify(FIXTURE);
  proc.stdout.emit("data", half.slice(0, 20));
  proc.stdout.emit("data", `${half.slice(20)}\n`);
  expect((await client.listAgents()).length).toBe(2);

  await client.focus("w2:p2");
  expect(ran[0]).toEqual(["wsl.exe", "-d", "Ubuntu", "-e", "sh", "-lc", "herdr agent focus w2:p2"]);
  await expect(client.focus("w2:p1 && calc")).rejects.toThrow();

  client.stop();
}, 20000);
