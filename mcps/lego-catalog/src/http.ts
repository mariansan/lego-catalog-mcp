/**
 * HTTP entry point shared by the Vercel function and the local dev runner (one code path).
 *
 * Deployment target: Vercel serverless, Node runtime. The transport is therefore STATELESS:
 * `sessionIdGenerator: undefined` (no in-memory sessions; any instance can answer any request) and
 * `enableJsonResponse: true` (every POST is answered with one JSON body; no SSE stream is held open
 * past the response). A new Server + transport is built per request; only the SQLite handle is reused.
 * GET (standalone SSE stream) and DELETE (session end) are meaningless here and get 405, which the
 * Streamable HTTP spec allows for servers that do not offer an SSE stream.
 *
 * Host header: the SDK only enforces allowedHosts when createMcpExpressApp() (or the deprecated
 * enableDnsRebindingProtection transport option) is used. We use neither, so there is no
 * `403 Invalid Host` on the public domain. For a public, authless, read-only server DNS rebinding
 * has nothing to steal. Decision: no Host allow-list and no CORS headers are added (browser
 * clients are out of scope for a server-to-server connector; the response never sends
 * Access-Control-Allow-*, so browsers cannot read it cross-origin).
 *
 * Guards applied here (not in the dev runner) so Vercel and local share them:
 *  - request body capped at MAX_REQUEST_BODY_BYTES, enforced on the bytes actually read (a lying or
 *    absent Content-Length cannot bypass it) -> 413;
 *  - JSON-RPC batches (a top-level array) are rejected -> 400. One HTTP request must be one unit of
 *    work; a batch of 100-row pages multiplied the response ~50x in testing.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getCatalog, type Catalog } from "./db.js";
import { createLegoServer } from "./server.js";

/** A legitimate MCP request here is well under 1 KiB; 64 KiB leaves ample room. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function rpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

/** Reads at most MAX_REQUEST_BODY_BYTES; returns null when the cap is exceeded. */
async function readCappedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** True when the first non-whitespace byte is `[` (a JSON-RPC batch). */
function isBatch(body: Uint8Array): boolean {
  for (const byte of body) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x5b;
  }
  return false;
}

export async function handleMcpRequest(request: Request, catalog?: Catalog): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless: use POST." }, id: null },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
  const body = await readCappedBody(request);
  if (body === null) return rpcError(413, -32600, "Request body too large.");
  if (isBatch(body)) return rpcError(400, -32600, "JSON-RPC batches are not supported; send one request per POST.");
  const guarded = new Request(request.url, { method: request.method, headers: request.headers, body });
  let resolved: Catalog;
  try {
    resolved = catalog ?? getCatalog();
  } catch (error) {
    // The message carries absolute filesystem paths: keep it in server logs, send a generic error.
    console.error("catalog unavailable", error);
    return rpcError(503, -32603, "Service unavailable: catalog not loaded.");
  }
  const server = createLegoServer(resolved);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(guarded);
  } finally {
    await server.close();
  }
}
