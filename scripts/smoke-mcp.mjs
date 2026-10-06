#!/usr/bin/env node
/* global fetch, AbortSignal, setTimeout, URL */
/**
 * Post-deploy smoke test for the lego-catalog MCP endpoint. Run it by hand:
 *   $env:MCP_AUTH_TOKEN = Get-Clipboard
 *   node scripts/smoke-mcp.mjs https://<your-project>.vercel.app/lego-catalog/mcp [<another-url> ...]
 *   (or set MCP_URL for a single URL). The URL must be the PUBLIC production URL: a unique
 *   per-deployment URL may sit behind Vercel Deployment Protection and answer 401 (docs/SELF_HOSTING.md).
 *
 * Token: read ONLY from the MCP_AUTH_TOKEN env var, never from argv (argv shows in process lists and
 * logs). Every URL must also pass the negative probes: no Authorization header -> 401, and a wrong
 * token -> 401. The token and request headers are never printed. A missing/empty MCP_AUTH_TOKEN is a
 * hard error (exit 1): the auth probes are never skipped silently.
 *
 * Local dev server (authless, 127.0.0.1): pass `--no-auth`, which skips the 401 probes and sends no
 * Authorization header:
 *   node scripts/smoke-mcp.mjs --no-auth http://127.0.0.1:3000/lego-catalog/mcp
 * `--no-auth` is refused for any host other than 127.0.0.1 / localhost / [::1], so it can never weaken
 * a production check.
 *
 * Checks per URL (stateless server, so each request stands alone): initialize, tools/list contains
 * `search_parts`, and a real tools/call for "brick 2 x 4" returns part 3001 with a snapshot_date -
 * the last one proves the bundled .sqlite and node:sqlite/FTS5 work on the deployed runtime.
 * Retries the whole sequence (auth probes included) a few times because a fresh production alias can lag
 * the deploy, and an older deployment answers 200 without a header. Exit 0 = pass, 1 = fail.
 */
const args = process.argv.slice(2);
const noAuth = args.includes("--no-auth");
const positional = args.filter((a) => a !== "--no-auth");
const urls = positional.length > 0 ? positional : process.env.MCP_URL ? [process.env.MCP_URL] : [];
if (urls.length === 0 || !urls.every((u) => /^https?:\/\//.test(u))) {
  console.error("usage: MCP_AUTH_TOKEN=... node scripts/smoke-mcp.mjs <https://host/lego-catalog/mcp> [<url> ...]   (or set MCP_URL)");
  console.error("       node scripts/smoke-mcp.mjs --no-auth http://127.0.0.1:3000/lego-catalog/mcp   (local authless dev server only)");
  process.exit(1);
}
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (noAuth) {
  const remote = urls.filter((u) => !LOCAL_HOSTS.has(new URL(u).hostname));
  if (remote.length > 0) {
    console.error("--no-auth is only allowed for 127.0.0.1, localhost or [::1]; refusing for a non-local URL.");
    process.exit(1);
  }
}
// With --no-auth the token is ignored on purpose: no Authorization header is sent and no probe runs.
const token = noAuth ? "" : process.env.MCP_AUTH_TOKEN || "";
if (!noAuth && !token) {
  console.error("MCP_AUTH_TOKEN is not set (or empty). Set it in the environment, or pass --no-auth for a local dev server.");
  process.exit(1);
}
// Never send the token in cleartext: plain http:// is allowed only for a local host.
if (token) {
  const cleartext = urls.filter((u) => new URL(u).protocol !== "https:" && !LOCAL_HOSTS.has(new URL(u).hostname));
  if (cleartext.length > 0) {
    console.error("Refusing to send MCP_AUTH_TOKEN over plain http:// to a non-local host; use the https:// URL.");
    process.exit(1);
  }
}
const ATTEMPTS = Number(process.env.SMOKE_ATTEMPTS ?? 6);
const DELAY_MS = Number(process.env.SMOKE_DELAY_MS ?? 10_000);

let nextId = 1;

/** POST one JSON-RPC request; `authorization` is the full header value, or undefined to send none. */
function post(url, method, params, authorization) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (authorization !== undefined) headers.authorization = authorization;
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    // The MCP paths are rewrites, never redirects: fail on any redirect so the token is never re-sent elsewhere.
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
}

async function rpc(url, method, params) {
  const res = await post(url, method, params, token ? `Bearer ${token}` : undefined);
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

const initParams = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke-mcp", version: "0.1.0" },
};

async function expectDenied(url, label, authorization) {
  const res = await post(url, "initialize", initParams, authorization);
  await res.text();
  if (res.status !== 401) throw new Error(`auth probe (${label}): expected HTTP 401, got ${res.status}`);
}

async function smokeOne(url) {
  if (token) {
    await expectDenied(url, "no header", undefined);
    await expectDenied(url, "wrong token", `Bearer ${token}x`);
  }

  const init = await rpc(url, "initialize", initParams);
  if (!init?.serverInfo?.name) throw new Error("initialize: no serverInfo in result");

  const list = await rpc(url, "tools/list", {});
  const names = (list?.tools ?? []).map((t) => t.name);
  if (!names.includes("search_parts")) throw new Error(`tools/list: search_parts missing (got ${names.join(", ")})`);

  const call = await rpc(url, "tools/call", { name: "search_parts", arguments: { query: "brick 2 x 4", limit: 5 } });
  const sc = call?.structuredContent;
  if (call?.isError || !sc) throw new Error(`search_parts returned an error: ${JSON.stringify(call).slice(0, 300)}`);
  if (!sc.snapshot_date) throw new Error("search_parts: response has no snapshot_date");
  if (!(sc.parts ?? []).some((p) => p.part_num === "3001")) throw new Error("search_parts: part 3001 not in results");
  console.log(`OK ${url}: ${names.length} tools, snapshot_date=${sc.snapshot_date}${token ? ", auth enforced" : ", auth not checked (--no-auth)"}`);
}

async function smoke() {
  for (const url of urls) {
    try {
      await smokeOne(url);
    } catch (err) {
      throw new Error(`${url}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
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
