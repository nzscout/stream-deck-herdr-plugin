// src/core/sources.ts

// Where a key reads agents from. Each key carries its own source, so a deck can
// mix this PC, one or more WSL distros, and (POSIX) remote boxes side by side:
// two herdr servers are separate worlds with their own pane ids, so mixing them in
// one list would collide.
export type SourceSpec =
  | { kind: "local" }
  | { kind: "wsl"; distro: string } // "" = the default distro
  | { kind: "ssh"; target: string; socket: string };

export type SourceSettings = {
  source?: string;
  wslDistro?: string;
  sshTarget?: string;
  remoteSocketPath?: string;
};

// Settings -> spec. Anything unrecognised falls back to this PC, which keeps a
// key working (rather than blank) after an older settings payload.
export function sourceSpec(settings: SourceSettings = {}): SourceSpec {
  const target = settings.sshTarget?.trim() ?? "";
  if (settings.source === "wsl") return { kind: "wsl", distro: settings.wslDistro?.trim() ?? "" };
  if (settings.source === "ssh" && target !== "") {
    return { kind: "ssh", target, socket: settings.remoteSocketPath?.trim() ?? "" };
  }
  return { kind: "local" };
}

// Stable identity used to share one poller/terminal between keys on the same
// source, and to notice when a key moved to a different one.
export function sourceKey(spec: SourceSpec): string {
  if (spec.kind === "wsl") return `wsl:${spec.distro}`;
  if (spec.kind === "ssh") return `ssh:${spec.target}|${spec.socket}`;
  return "local";
}

export function describeSource(spec: SourceSpec): string {
  if (spec.kind === "wsl") return `wsl ${spec.distro || "(default distro)"}`;
  if (spec.kind === "ssh") return `ssh ${spec.target}`;
  return "local";
}
