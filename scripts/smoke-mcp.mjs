#!/usr/bin/env node
/* global fetch, AbortSignal, setTimeout */
/**
 * Post-deploy smoke test for the lego-catalog MCP endpoint. Run it by hand:
 *   node scripts/smoke-mcp.mjs https://<your-project>.vercel.app/lego-catalog/mcp
 *   (or set MCP_URL). The URL must be the PUBLIC production URL: a unique per-deployment URL may sit
 *   behind Vercel Deployment Protection and answer 401 (docs/SELF_HOSTING.md).
 *
 * Checks (stateless server, so each request stands alone): initialize, tools/list contains
 * `search_parts`, and a real tools/call for "brick 2 x 4" returns part 3001 with a snapshot_date -
 * the last one proves the bundled .sqlite and node:sqlite/FTS5 work on the deployed runtime.
 * Retries the whole sequence a few times because a fresh production alias can lag the deploy.
 * Exit 0 = pass, 1 = fail.
 */
const url = process.argv[2] ?? process.env.MCP_URL;
if (!url || !/^https?:\/\//.test(url)) {
  console.error("usage: node scripts/smoke-mcp.mjs <https://host/lego-catalog/mcp>   (or set MCP_URL)");
  process.exit(1);
}
const ATTEMPTS = Number(process.env.SMOKE_ATTEMPTS ?? 6);
const DELAY_MS = Number(process.env.SMOKE_DELAY_MS ?? 10_000);

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  // enableJsonResponse => application/json; tolerate an SSE-framed reply as well.
  const body = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).at(-1) ?? ""
    : text;
  const msg = JSON.parse(body);
  if (msg.error) throw new Error(`${method}: JSON-RPC error ${msg.error.code} ${String(msg.error.message).slice(0, 200)}`);
  return msg.result;
}

async function smoke() {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-mcp", version: "0.1.0" },
  });
  if (!init?.serverInfo?.name) throw new Error("initialize: no serverInfo in result");

  const list = await rpc("tools/list", {});
  const names = (list?.tools ?? []).map((t) => t.name);
  if (!names.includes("search_parts")) throw new Error(`tools/list: search_parts missing (got ${names.join(", ")})`);

  const call = await rpc("tools/call", { name: "search_parts", arguments: { query: "brick 2 x 4", limit: 5 } });
  const sc = call?.structuredContent;
  if (call?.isError || !sc) throw new Error(`search_parts returned an error: ${JSON.stringify(call).slice(0, 300)}`);
  if (!sc.snapshot_date) throw new Error("search_parts: response has no snapshot_date");
  if (!(sc.parts ?? []).some((p) => p.part_num === "3001")) throw new Error("search_parts: part 3001 not in results");
  console.log(`OK ${url}: ${names.length} tools, snapshot_date=${sc.snapshot_date}`);
}

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  try {
    await smoke();
    process.exit(0);
  } catch (err) {
    console.error(`attempt ${attempt}/${ATTEMPTS} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, DELAY_MS));
  }
}
console.error("SMOKE FAILED");
process.exit(1);
