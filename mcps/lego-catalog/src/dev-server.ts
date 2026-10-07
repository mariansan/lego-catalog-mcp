/**
 * Local dev runner: plain node:http around handleMcpRequest, so the endpoint can be exercised over
 * real HTTP without Vercel. Same public path as production: /lego-catalog/mcp.
 *   pnpm --filter @mcps/lego-catalog dev        (PORT env, default 3000)
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { getCatalog, type Catalog } from "./db.js";
import { handleMcpRequest } from "./http.js";

export const MCP_PATH = "/lego-catalog/mcp";
const MAX_BODY_BYTES = 1_048_576;

/**
 * SEC-L4-dev: DNS-rebinding guard. This server is authless and binds 127.0.0.1, so a page on an attacker's domain that
 * rebinds its name to 127.0.0.1 could otherwise reach it; the browser would still send the attacker's name in `Host`.
 * Only loopback authorities on the bound port are accepted (case-insensitive). Missing Host is rejected too.
 */
export function loopbackHosts(port: number): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function isAllowedHost(host: string | undefined, allowed: ReadonlySet<string>): host is string {
  return host !== undefined && allowed.has(host.toLowerCase());
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function startDevServer(
  options: { port?: number; catalog?: Catalog } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const catalog = options.catalog ?? getCatalog();
  // Filled in once the port is bound; until then every request is rejected.
  let allowedHosts: ReadonlySet<string> = new Set();
  const server: Server = createServer((req, res) => {
    // Before any routing or body read. 421 Misdirected Request: this server does not serve that authority.
    // The received Host is not echoed back.
    const host = req.headers.host;
    if (!isAllowedHost(host, allowedHosts)) {
      res.writeHead(421, { "content-type": "text/plain", connection: "close" }).end("Misdirected request");
      return;
    }
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname !== MCP_PATH) {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
        return;
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
      if (body === null) {
        res.writeHead(413, { "content-type": "text/plain" }).end("Payload too large");
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const response = await handleMcpRequest(new Request(url, { method: req.method, headers, body }), catalog);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      console.error("dev server error", error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal error");
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  allowedHosts = loopbackHosts(port);
  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startDevServer({ port: Number(process.env.PORT ?? 3000) });
  console.log(`lego-catalog MCP listening on ${url}`);
}
