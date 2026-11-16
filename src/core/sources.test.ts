// src/core/sources.test.ts
import { test, expect } from "bun:test";
import { describeSource, sourceKey, sourceSpec } from "./sources";

test("defaults to this PC when no source is set", () => {
  expect(sourceSpec({})).toEqual({ kind: "local" });
  expect(sourceSpec({ source: "wsl" })).toEqual({ kind: "wsl", distro: "" });
  expect(sourceSpec({ source: "nonsense" })).toEqual({ kind: "local" });
});

test("WSL keys carry their distro, blank meaning the default distro", () => {
  expect(sourceSpec({ source: "wsl", wslDistro: " Ubuntu " })).toEqual({ kind: "wsl", distro: "Ubuntu" });
  expect(sourceKey(sourceSpec({ source: "wsl", wslDistro: "Ubuntu" }))).toBe("wsl:Ubuntu");
  // Two WSL distros are different sources, so their keys never share a poller.
  expect(sourceKey(sourceSpec({ source: "wsl", wslDistro: "Ubuntu" }))).not.toBe(
    sourceKey(sourceSpec({ source: "wsl", wslDistro: "Debian" })),
  );
});

test("ssh needs a target, otherwise the key stays local", () => {
  expect(sourceSpec({ source: "ssh" })).toEqual({ kind: "local" });
  expect(sourceSpec({ source: "ssh", sshTarget: " me@box ", remoteSocketPath: "/x/herdr.sock" })).toEqual({
    kind: "ssh",
    target: "me@box",
    socket: "/x/herdr.sock",
  });
  expect(sourceKey(sourceSpec({ source: "ssh", sshTarget: "me@box" }))).toBe("ssh:me@box|");
});

test("keys are stable for the same source and distinct across sources", () => {
  expect(sourceKey(sourceSpec({}))).toBe("local");
  expect(sourceKey(sourceSpec({ source: "wsl" }))).toBe("wsl:");
  expect(describeSource(sourceSpec({ source: "wsl" }))).toContain("default distro");
  expect(describeSource(sourceSpec({}))).toBe("local");
});
