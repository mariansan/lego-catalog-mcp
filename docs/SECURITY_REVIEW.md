# Security Review: lego-catalog MCP

**Date:** 2026-10-05
**Reviewer:** internal security review. Read-only: no source or test files were edited by the review.
**Scope:** `mcps/lego-catalog/src/*`, `api/lego-catalog/mcp.ts`, `vercel.json`, `package.json` files, `pnpm-lock.yaml`, `.gitignore`, git history.
**Code under review:** commit `0a4d491`, before the first deployment. Line numbers refer to that commit.

> **Status after the review (2026-10-05):** H1, M1, M2, L1 and L3 were fixed with regression tests. L2 (SDK-level validation errors lack the response
> envelope) is an accepted, documented limitation. L4 (no Origin/Host check) is deferred. The server has since been deployed to Vercel; a WAF rate-limit
> rule was created by the repository owner in the Vercel dashboard and cannot be verified from this repository. The platform items below remain
> UNVERIFIED unless noted in `docs/SELF_HOSTING.md`.
**Snapshot used for probes:** a local build of the 2026-10-05 Rebrickable snapshot (57.7 MB), passed via `LEGO_CATALOG_DB`.
**Runtime used for probes:** Node v22.22.2 on Windows, running locally. Nothing ran on Vercel, so no statement below about deploy behaviour is verified.
**Scanners run:** `pnpm audit` (all deps and `--prod`), a git grep for secrets across the working tree and all history, and direct probes of `handleMcpRequest` and SQLite.

## Threat model

| Asset | Threat actor | Vector | Impact |
|-------|-------------|--------|--------|
| Function CPU/duration (owner's Vercel bill and quota) | Anyone on the internet. The endpoint is public and authless. | Requests that are cheap to send and expensive to answer (JSON-RPC batches, worst-case FTS queries, big bodies) | Cost, quota exhaustion, slow or unavailable service for real clients |
| Availability of a warm instance | Same | Synchronous `node:sqlite` blocks the event loop, so with Fluid concurrency other requests on that instance wait | Latency spikes or timeouts for co-located requests |
| Snapshot integrity | Same | SQL/FTS injection, write path | None found: the DB is read-only and all SQL is parameterized (verified) |
| Server internals (paths, stack traces) | Same | Error messages | Minor: the SDK dumps validation details. No paths or stacks reach clients on the tool path |
| User data / auth | n/a | n/a | No user data, no auth, no secrets in the project |
| Supply chain | Compromised dependency | npm packages | The production tree has no known vulnerabilities. Dev-only advisories are listed under Advisory |

## Findings (ranked)

| ID | Severity | Location | Title | Confidence |
|----|----------|----------|-------|------------|
| SEC-H1 | **High** | `mcps/lego-catalog/src/http.ts:28-31` | JSON-RPC batch of up to 100 `tools/call` per HTTP request: 14.7 s of synchronous CPU and up to 4.2 MB response from one ~13 KB request | Confirmed (measured) |
| SEC-M1 | Medium | `mcps/lego-catalog/src/http.ts:28` | Request body cap is the SDK default of 4 MiB, but no valid request needs more than ~2 KB | Confirmed (SDK source) |
| SEC-M2 | Medium | `mcps/lego-catalog/src/server.ts:39`, `tools.ts:63-66` | Unbounded reflection of attacker input in error messages gets around the response size cap (1 MB tool name returns a 2 MB response) | Confirmed (measured) |
| SEC-L1 | Low | `mcps/lego-catalog/src/tools.ts:103-110` | Duplicate FTS tokens are not deduplicated, so the worst-case query costs twice as much | Confirmed (measured) |
| SEC-L2 | Low | SDK `CallToolRequestSchema` validation (before our handler) | Non-object `arguments` gives JSON-RPC `-32603` with a raw Zod issue dump and no `source`/`snapshot_date` envelope | Confirmed (measured) |
| SEC-L3 | Low | `mcps/lego-catalog/src/http.ts:27`, `db.ts:41` | `getCatalog()` runs outside any try. A missing snapshot throws a message with absolute filesystem paths into the platform handler | Probable. The client-visible effect on Vercel is unverified |
| SEC-L4 | Low | `mcps/lego-catalog/src/http.ts:11-14` | No Origin/Host validation (DNS rebinding) | Confirmed (by design) |
| SEC-A1 | Advisory | `pnpm-lock.yaml` | 5 dev-only advisories (brace-expansion 5.0.8 via minimatch, nanoid 3.3.16 via postcss). `--prod` is clean | Confirmed (pnpm audit). Not NVD-cross-checked |
| SEC-A2 | Advisory | `mcps/lego-catalog/package.json:15` | `csv-parse` is in `dependencies` but only the build script uses it | Confirmed |
| SEC-A3 | Advisory | SDK `webStandardStreamableHttp.js:710` | SDK catch-all returns `String(error)` in `error.data` | Confirmed (SDK source). Not reached in any probe |
| SEC-A4 | Advisory | `mcps/lego-catalog/src/results.ts:24` | The hard cap measures `structuredContent` only. The text-block copy plus JSON escaping make the wire size about 2.2x | Confirmed |

---

### SEC-H1 (High): JSON-RPC batch amplification

**What:** `WebStandardStreamableHTTPServerTransport` (SDK 1.32.1) accepts a JSON array of up to `MAX_BATCH_SIZE = 100` messages (`sdk/dist/esm/server/requestBody.js:4`, `webStandardStreamableHttp.js:504-512`). A stateless request needs no `initialize` first: `tools/list` alone returned 200 in the probe. All 100 calls run on the synchronous `node:sqlite` handle in the same invocation. The per-result caps (`payloadHardMaxChars`) apply to each result, not to the HTTP response.

**Measured locally** against the real snapshot via `handleMcpRequest`:
| Request | Status | Time | Response size |
|---------|--------|------|---------------|
| 1 x `search_parts {query:"x x ... x" (20 tokens), limit:100, offset:10000}` | 200 | 198 ms | 26,116 chars |
| 100 x the same, in one batch (~13 KB body) | 200 | **14,688 ms** | 2,611,791 chars |
| 100 x `get_set_inventory {set_num:"75192-1", limit:200}` | 200 | 231 ms | **4,203,391 chars** |

**Exploit scenario:** an anonymous client loops a single `curl -X POST https://<domain>/lego-catalog/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data @batch100.json`. Each request burns about 15 s of CPU, close to `maxDuration: 30`. Because the work is synchronous, it also blocks every other request sharing that Fluid instance. A per-IP or per-request platform rate limit is weakened 100x, because it counts HTTP requests, not tool calls.

**Recommended fix** (`src/http.ts`):
1. Read the body yourself with a small cap (see M1), `JSON.parse` it, and **reject arrays** with HTTP 400 and JSON-RPC `-32600` "Batch requests are not supported". Then hand the parsed object to `transport.handleRequest(request, { parsedBody })`. The SDK honours `options.parsedBody` at `webStandardStreamableHttp.js:486`. As far as I know, JSON-RPC batching was removed from the MCP spec in protocol revision 2025-06-18, but I did not re-check that this session, so verify it before relying on it. If some client turns out to need batches, cap them at 2-5 instead.
2. Negative tests: a 100-element batch returns 400 and runs no tool, and a single call still works.

### SEC-M1 (Medium): request body cap far above need

**What:** the transport is built without `maxRequestBodySize` (`http.ts:28`), so the SDK default of 4 MiB applies (`requestBody.js:2`). The largest legitimate body is a `tools/call` whose longest string argument is 200 chars. That is well under 2 KB.
**Exploit:** feeds M2 (a 4 MiB reflected name gives an ~8 MB response) and adds parse and trim cost on every request.
**Fix:** pass `maxRequestBodySize: 65_536` (or 16 KiB) to the transport, or enforce it in the custom body read from H1. Test: a 70 KB body returns 413.

### SEC-M2 (Medium): reflected input bypasses the response size cap

**What:** `server.ts:39` interpolates `request.params.name` into the `unknown_tool` message without truncating it. `fail()` (`results.ts:17`) has no size cap, and the message is sent twice (`structuredContent` and the text block). Zod `strictObject` "Unrecognized key(s)" messages (`tools.ts:63-66`) also echo key names of any length. The `not_found` messages are already bounded (64 or 32 chars, or digits only).
**Measured:** a tool name of 1,000,000 `A`s returned **2,000,363 chars**. With the 4 MiB default body, this is about an 8 MB response from a 4 MB request.
**Exploit:** bandwidth and egress amplification. It also puts attacker-controlled text in the response, but a caller can only inject into its own model context, so this is not cross-user.
**Fix:** truncate every reflected value to about 64 chars plus an ellipsis in `unknown_tool` and in the Zod message builder (for example, list at most 5 unknown keys, each truncated). Optionally apply `payloadHardMaxChars` inside `fail()` too. Test: a 10 KB tool name gives a response under 1 KB.

### SEC-L1 (Low): duplicate FTS tokens

`extractSearchTokens` keeps duplicates. A query of 20 copies of `x` took 107 ms (ranked, offset 10000) against 52 ms for a single `"x"`, at the SQLite level. Every token must match, so deduplicating (`[...new Set(tokens)]`) does not change the result set or ranking order in any way that matters, and it halves the worst case. Test: `"x x x"` and `"x"` return the same `total`.

### SEC-L2 (Low): SDK-level validation error dump

`{"name":"get_part","arguments":["3001"]}` makes the SDK reject the request before our handler runs. It returns `{"error":{"code":-32603,"message":"[\n {\n \"expected\": \"record\", ... \"path\": [\"params\", ...` with no `source`/`snapshot_date`. It leaks no paths or stack, only schema internals, and it breaks the "every error has the envelope" contract for this case. **Fix (optional):** in the custom body pre-parse from H1, check that `params.arguments` is a plain object when `method === "tools/call"`. If it is not, return a tool-result `invalid_input` envelope. Otherwise document it as a known protocol-level exception.

### SEC-L3 (Low): snapshot-missing error carries absolute paths

`http.ts:27` calls `getCatalog()` outside the `try`. `resolveDbPath` throws `SQLite snapshot not found. Looked in: <absolute paths>` (`db.ts:41`). On the dev server it is caught and returns `Internal error`. On Vercel the throw escapes the `fetch` export. I have **not verified** whether Vercel shows the message to the client. **Fix:** wrap it in a try/catch in `handleMcpRequest`, `console.error` the detail, and return a JSON-RPC `-32603` "Service unavailable: catalog not loaded" with no path.

### SEC-L4 (Low): no Origin/Host check (DNS rebinding)

This is a deliberate choice (`http.ts:11-14`). The data is public and read-only with no auth, so a rebinding attack has nothing to steal. The production impact is the same as a direct anonymous request. The local dev server (`127.0.0.1`) could be reached by a rebinding page, but it only exposes the same public data plus CPU. **Recommendation:** add a cheap check that does not break server-side clients. If an `Origin` header **is present** and is not on an allowlist, return 403. If `Origin` is absent, allow the request. I believe the MCP Streamable HTTP spec asks servers to validate `Origin`, but I did not re-check it this session. Whether Claude's connector sends `Origin` is **unverified**, so test against the real client before deploying (do not add auth-like gates untested).

**CORS decision:** keep it as it is. The server sends no CORS headers and `OPTIONS` gets 405, so browsers cannot read responses cross-origin. Claude connects server-side. The only cost is that the browser-based MCP Inspector cannot connect, which is a known limitation of this setup.

### Advisory

- **SEC-A1:** `pnpm audit` reports 4 high and 1 moderate. They are brace-expansion 5.0.8 (GHSA-rgw5-rvv9-x895 / CVE-2026-69152, GHSA-qhr7-859c-m2p7 / CVE-2026-102278, GHSA-6j4f-fj2g-mc7p / CVE-2026-102276, GHSA-q2hr-2g5m-vwhr / CVE-2026-102277) and nanoid 3.3.16 (GHSA-2v37-7h3g-55p8 / CVE-2026-67213). They come in through `minimatch@10.2.5` (eslint toolchain) and `postcss@8.5.23` (vite/vitest). **`pnpm audit --prod`: "No known vulnerabilities found".** None of these ship in the function, and none take attacker input at runtime. I did **not** cross-check the severities in NVD because no web tool was used this session. Fix: `pnpm update` or `pnpm.overrides` (`brace-expansion >=5.0.12`, `nanoid >=3.3.18`) in a separate dependency PR.
- **SEC-A2:** move `csv-parse` to `devDependencies`. It is imported only by `scripts/build_snapshot/`, so this keeps it out of the function's dependency tree. Confirm that the deploy build still installs it.
- **SEC-A3:** the SDK's last-resort catch returns `{code:-32700, data: String(error)}`. That is the message only, with no stack. It was not triggered by any probe. Watch it in the deployment logs.
- **SEC-A4:** `payloadHardMaxChars` (24,000) is measured on `structuredContent`. The actual wire size per result is about 2.2x that (a 20-token search returned 26 KB on the wire). That is fine against the ~150k connector cap, but the comment in `config.ts:15-18` slightly understates it.

## Checklist results (verified, no finding)

| Check | Evidence |
|-------|----------|
| SQL is parameterized everywhere | Every query in `tools.ts` and `db.ts` is static text with `?`. `LIMIT ? OFFSET ?` are bound (`tools.ts:121,255,361`). `ORDER BY` is static. The only concatenation is `list_colors` `clause`, built from two static fragments (`tools.ts:232-242`). |
| FTS5 MATCH building | Tokens are limited to `[\p{L}\p{N}]+` (`tools.ts:82`) and each one is double-quoted (`tools.ts:110`), so no quote, `*`, `^`, `:`, `-` or parenthesis can reach FTS. `"NEAR" "AND" "OR" "NOT"` gave 0 rows and no error (probe). `'; DROP TABLE parts;--` on `get_part` gave `not_found` (probe). |
| Input bounds | query ≤200 chars and ≤20 tokens. part_num ≤64. color name ≤64. set_num matches `^[A-Za-z0-9._-]{1,32}$`. element_id is 1-12 digits. version 1-1000. limit 1-100 (inventory 1-200). offset 0-10,000. All objects are `strictObject`. No regex is ReDoS-prone (all anchored or simple classes). |
| Expensive-query guards | Worst single call measured: 198 ms end to end (20 tokens of `x`, offset 10,000, about 21k FTS matches ranked). Largest inventory (1,566 rows) uses a PK index search and takes 0.5 ms. Single calls are fine. The risk is multiplying them (H1). `node:sqlite` `DatabaseSync` runs synchronously, and this review did **not** find any per-query interrupt or timeout API, so the only backstop is `maxDuration: 30`. |
| DB read-only, no write path | `new DatabaseSync(path, { readOnly: true })` (`db.ts:46`). Probe: `DELETE FROM meta` gave "attempt to write a readonly database". `loadExtension` gave "extension loading is not allowed". All 6 tools are reads with `readOnlyHint: true`. There is no ATTACH or PRAGMA reachable from input. |
| HTTP method handling | GET gives 405 with `Allow: POST` (probe). `text/plain` gives 415. An invalid JSON-RPC message gives 400 `-32700`. No stack traces in any response. |
| Tool exceptions | `server.ts:40-45` catches, logs server-side, and returns a generic `internal_error` envelope. |
| `LEGO_CATALOG_DB` | Read only from the operator's environment (`db.ts:32`). Clients have no way to influence the path. It is opened read-only. Acceptable. |
| Secrets | A working-tree grep found no credential-shaped strings in code or config. A history scan (`git log --all -p`) found 0 matches for sk-/ghp_/github_pat_/AKIA/xox/PRIVATE KEY. `.gitignore` covers `.env`, `.env.*` and `!.env.example`. There are no `.env*` files and no CI workflow files. |
| Lockfile | `pnpm-lock.yaml` is committed. `@modelcontextprotocol/sdk` is pinned exactly at `1.32.1`. |

## Needs platform configuration (UNVERIFIED until checked on a real deployment)

1. **Rate limiting:** add a Vercel WAF rate-limit rule (per IP) on `/lego-catalog/mcp`. This cannot be done meaningfully in code on stateless serverless (no shared store, and the project has no Redis). It only works well once H1 is fixed, because otherwise one request is 100 calls.
2. **Spend protection:** turn on Vercel Spend Management or usage alerts. An authless endpoint can always be flooded with valid single calls, and only the platform can cap the bill.
3. **Platform request/response limits:** I believe the Vercel function body limit is about 4.5 MB, but I have not checked it. If so, the 4.2 MB batch response above is just under it. Confirm after the fixes.
4. **Event-loop blocking under Fluid concurrency:** measure p95 latency under parallel load once deployed. If co-located requests stall, consider capping per-instance concurrency or moving to an async SQLite driver.
5. **What a thrown error looks like on Vercel (L3):** confirm that an uncaught throw shows no message text.
6. **Origin header from Claude's connector (L4):** confirm before adding any Origin check.
7. **Response headers:** consider `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` via `vercel.json` `headers`. HTTPS is enforced by Vercel (platform default, not verified here). Browser-page headers (CSP, frame-ancestors) do not apply to a JSON-only API.

## Suggested regression tests

Each of these should start as a failing test, then get its fix:
- **H1:** a 100-element batch returns 400 and no tool runs.
- **M1:** a body over 64 KiB returns 413.
- **M2:** a 10 KB tool name, and 50 long unknown keys, each return a response under 1 KB.
- **L1:** `"x x x"` and `"x"` return the same `total`.
- **L2** (optional): an array `arguments` returns an `invalid_input` envelope.
- **L3:** a missing snapshot returns a response that contains no path.

H1, M1, M2 and L3 touch `src/http.ts`/`src/server.ts`, which are under `src/`. `api/` does not need to change.
