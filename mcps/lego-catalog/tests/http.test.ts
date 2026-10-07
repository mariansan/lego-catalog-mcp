import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCatalog } from "../src/db.ts";
import { startDevServer } from "../src/dev-server.ts";
import { dbPath } from "./helpers/snapshot.ts";

describe("dev runner over real HTTP (Streamable HTTP, stateless)", () => {
  let url: string;
  let close: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    ({ url, close } = await startDevServer({ catalog: openCatalog(dbPath) }));
    client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  });
  afterAll(async () => {
    await client.close();
    await close();
  });

  it("initialize negotiated and advertises tools only", () => {
    expect(client.getServerVersion()?.name).toBe("lego-catalog");
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
  });

  it("tools/list returns annotated tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations.destructiveHint === false)).toBe(true);
  });

  it("tools/call returns structured content with the envelope", async () => {
    const result = await client.callTool({ name: "get_part", arguments: { part_num: "3001" } });
    expect(result.structuredContent).toMatchObject({ source: "Rebrickable", name: "Brick 2 x 4" });
    expect((result.structuredContent as { snapshot_date: string }).snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is stateless: no session id is issued, and raw POST works without initialize", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(6);
  });

  it("GET and DELETE are 405; other paths are 404", async () => {
    expect((await fetch(url, { method: "GET" })).status).toBe(405);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
    expect((await fetch(new URL("/other", url))).status).toBe(404);
  });
});
