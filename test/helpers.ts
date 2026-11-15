import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchResult } from "../src/fetch.js";

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wiftax");

// No test talks to GitHub: gh is the stub, and the upstream is a repo that does not exist.
process.env.SISYPHUS_GH ??= fileURLToPath(new URL("./gh-stub.mjs", import.meta.url));
process.env.SISYPHUS_UPSTREAM ??= "sisyphus-test/does-not-exist";
process.env.GH_STUB_LOG ??= join(mkdtempSync(join(tmpdir(), "sisyphus-gh-")), "gh.log");

// A copy of the fixture checkout with PORT replaced, so tests can edit it freely.
export function fixtureCopy(port: number | string = 9): string {
  const dir = mkdtempSync(join(tmpdir(), "sisyphus-test-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const products = join(dir, "data", "products");
  for (const f of readdirSync(products)) {
    const p = join(products, f);
    writeFileSync(p, readFileSync(p, "utf8").replaceAll("PORT", String(port)));
  }
  return dir;
}

export function page(url: string, text: string, ok = true, status = 200): FetchResult {
  return {
    url,
    finalUrl: url,
    status: ok ? status : status,
    ok,
    failure: ok ? undefined : status === 403 ? "blocked" : status === 404 ? "gone" : "network",
    contentType: "text/html",
    text: ok ? text : "",
    data: "",
    error: ok ? undefined : `HTTP ${status}`,
    fetchedAt: "2026-11-16T09:00:00.000Z",
  };
}

// A local docs host. Each path maps to [status, html].
export async function docsServer(routes: Record<string, [number, string]>): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const r = routes[req.url ?? ""] ?? [404, "not here"];
    res.writeHead(r[0], { "content-type": "text/html" });
    res.end(r[1]);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr ? addr.port : 0 };
}
