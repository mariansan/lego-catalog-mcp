/**
 * SEC-L4-dev: the authless local dev server rejects any Host that is not a loopback authority on the bound port
 * (DNS-rebinding guard). Raw node:http / node:net requests, because fetch does not let a caller forge Host.
 */
import { request } from "node:http";
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCatalog } from "../src/db.ts";
import { isAllowedHost, loopbackHosts, MCP_PATH, startDevServer } from "../src/dev-server.ts";
import { dbPath } from "./helpers/snapshot.ts";

type Reply = { status: number; body: string };

const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

/** Request to the dev server with an explicit Host header; `host: null` sends no Host at all. */
function send(port: number, host: string | null, opts: { method?: string; path?: string } = {}): Promise<Reply> {
  const { method = "POST", path = MCP_PATH } = opts;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (host !== null) headers.host = host;
    const req = request({ host: "127.0.0.1", port, method, path, headers, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? TOOLS_LIST : undefined);
  });
}

/** HTTP/1.0 with no Host over a raw socket: Node's own HTTP/1.1 Host requirement does not apply, so our check must. */
function sendHttp10NoHost(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${MCP_PATH} HTTP/1.0\r\n\r\n`));
    let data = "";
    socket.on("data", (c: Buffer) => (data += c.toString("utf8")));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

describe("SEC-L4-dev: dev server Host allowlist (DNS rebinding)", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const started = await startDevServer({ catalog: openCatalog(dbPath) });
    close = started.close;
    port = Number(new URL(started.url).port);
  });
  afterAll(async () => {
    await close();
  });

  it("allowlist matches only loopback authorities on the bound port, case-insensitively", () => {
    const allowed = loopbackHosts(4321);
    expect(isAllowedHost("127.0.0.1:4321", allowed)).toBe(true);
    expect(isAllowedHost("LocalHost:4321", allowed)).toBe(true);
    expect(isAllowedHost("[::1]:4321", allowed)).toBe(true);
    const rejected = [
      undefined,
      "",
      "localhost",
      "127.0.0.1",
      "localhost:4322",
      "evil.example:4321",
      "localhost.evil.example:4321",
      "127.0.0.1:4321.evil.example",
      " localhost:4321",
    ];
    for (const bad of rejected) expect(isAllowedHost(bad, allowed)).toBe(false);
  });

  it("forged Host (rebinding name) is rejected with 421 before routing, without echoing the Host", async () => {
    const forged = `evil.example:${port}`;
    const onMcp = await send(port, forged);
    expect(onMcp.status).toBe(421);
    expect(onMcp.body).toBe("Misdirected request");
    expect(onMcp.body).not.toContain("evil");
    // An unknown path is 404 for a legitimate Host; the Host check runs first.
    expect((await send(port, forged, { method: "GET", path: "/other" })).status).toBe(421);
  });

  it("loopback name on the wrong port, or with no port, is rejected with 421", async () => {
    expect((await send(port, `127.0.0.1:${port + 1}`)).status).toBe(421);
    expect((await send(port, `localhost:${port - 1}`)).status).toBe(421);
    expect((await send(port, "localhost")).status).toBe(421);
  });

  it("missing Host is rejected (HTTP/1.1: Node's own 400 or our 421; HTTP/1.0: our 421)", async () => {
    expect([400, 421]).toContain((await send(port, null)).status);
    expect(await sendHttp10NoHost(port)).toMatch(/^HTTP\/1\.[01] 421 /);
  });

  it.each(["127.0.0.1", "localhost", "LOCALHOST", "[::1]"])("Host %s:<port> gets normal behavior", async (name) => {
    const res = await send(port, `${name}:${port}`);
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { result: { tools: unknown[] } }).result.tools).toHaveLength(6);
    expect((await send(port, `${name}:${port}`, { method: "GET", path: "/other" })).status).toBe(404);
  });
});
