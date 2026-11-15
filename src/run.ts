// Child processes: git, gh, node. GitHub's API returns the odd 502, so gh
// calls retry on server and network errors. Nothing here throws; callers get
// { ok, out } and decide.

import { spawnSync } from "node:child_process";

export interface RunResult {
  ok: boolean;
  out: string;
}

export interface RunOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export function run(cmd: string, args: string[], opts: RunOpts = {}): RunResult {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, input: opts.input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.error) return { ok: false, out: `${cmd}: ${r.error.message}` };
  return { ok: r.status === 0, out };
}

// The gh binary. Tests point this at a stub, and under node:test the real gh
// is refused outright, so no test can touch a real repository.
export function ghBin(): string {
  if (process.env.SISYPHUS_GH) return process.env.SISYPHUS_GH;
  if (process.env.NODE_TEST_CONTEXT) throw new Error("refusing to run the real gh under node:test. Set SISYPHUS_GH to a stub");
  return "gh";
}

const TRANSIENT = /HTTP 5\d\d|50[234] |Bad Gateway|Service Unavailable|Gateway Timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection reset|i\/o timeout|TLS handshake timeout|secondary rate limit/i;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function gh(args: string[], opts: RunOpts = {}, attempts = 3): RunResult {
  let r: RunResult = { ok: false, out: "" };
  for (let i = 0; i < attempts; i++) {
    r = run(ghBin(), args, opts);
    if (r.ok || !TRANSIENT.test(r.out)) return r;
    if (i < attempts - 1) sleep(Number(process.env.SISYPHUS_GH_BACKOFF_MS ?? 4000) * (i + 1));
  }
  return r;
}

export function git(cwd: string, ...args: string[]): RunResult {
  return run("git", args, { cwd });
}
