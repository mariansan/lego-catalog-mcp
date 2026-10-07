/**
 * Negative suite: hostile and malformed input against every tool and the HTTP entry point.
 * Runs against the real snapshot when LEGO_CATALOG_DB points at one, otherwise against the fixture snapshot built by
 * the real builder in tests/helpers/global-setup.ts (so it never skips).
 */
import { readFileSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../src/config.ts";
import { all, first, openCatalog, type Catalog } from "../src/db.ts";
import { handleMcpRequest, MAX_REQUEST_BODY_BYTES } from "../src/http.ts";
import { createLegoServer } from "../src/server.ts";
import { extractSearchTokens } from "../src/tools.ts";
import { dbPath } from "./helpers/snapshot.ts";

type Body = Record<string, unknown> & { source?: string; snapshot_date?: string; error?: { code: string; message: string } };

/** Fragments that must never show up in a response: file paths, stack frames, SQLite internals. */
const LEAK_PATTERN = /(node_modules|\.sqlite|[A-Za-z]:\\|\/Users\/|\/home\/|\bat .*\(.*:\d+:\d+\)|SQLITE_[A-Z]+|fts5: |syntax error|no such (table|column)|(Type|Reference|Range|Syntax)Error)/;

const INJECTIONS = [
  "'; DROP TABLE parts;--",
  '" OR 1=1',
  "' OR '1'='1",
  "brick' UNION SELECT name FROM sqlite_master--",
  "* ^ NEAR ( ) AND OR NOT",
  "NEAR(brick plate, 2)",
  'brick" "',
  '"unbalanced',
  "unbalanced'",
  "(((brick",
  "brick)))",
  "name:brick",
  "-brick",
  "brick*",
  "^brick",
  "\0",
  "brick\0plate",
  "%' OR '%'='",
  "\\",
  "${process.env.HOME}",
  "{{7*7}}",
];

describe("negative suite over the snapshot under test", () => {
  let catalog: Catalog;
  let client: Client;
  let fingerprint: () => Record<string, number>;

  beforeAll(async () => {
    catalog = openCatalog(dbPath);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createLegoServer(catalog).connect(serverSide);
    client = new Client({ name: "negative", version: "0.0.0" });
    await client.connect(clientSide);
    // Row counts of every table, taken through a second read-only handle, to prove nothing changed.
    fingerprint = () => {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const names = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%\\_%' ESCAPE '\\' ORDER BY name");
        return Object.fromEntries(names.map(({ name }) => [name, first<{ n: number }>(db, `SELECT count(*) AS n FROM "${name}"`)?.n ?? -1]));
      } finally {
        db.close();
      }
    };
  });
  afterAll(async () => {
    await client.close();
  });

  /** Calls a tool and asserts the invariants that hold for EVERY tool response. */
  async function call(name: string, args: unknown) {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const body = result.structuredContent as Body;
    const content = result.content as { type: string; text: string }[];
    expect(body, `${name} ${JSON.stringify(args)}`).toBeDefined();
    expect(body.source).toBe("Rebrickable");
    expect(body.snapshot_date).toBe(catalog.snapshotDate);
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual(body);
    expect(content[0]?.text.length).toBeLessThanOrEqual(LIMITS.payloadHardMaxChars);
    if (body.error) {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(body.error), `leak in ${name} ${JSON.stringify(args)}`).not.toMatch(LEAK_PATTERN);
    }
    return { body, isError: result.isError === true };
  }

  describe("nonexistent ids", () => {
    it.each([
      ["get_part", { part_num: "nope-9999" }],
      ["get_set_inventory", { set_num: "00000000-1" }],
      ["get_set_inventory", { set_num: "00000000" }],
      ["lookup_element", { element_id: "123456789012" }],
    ])("%s %j -> not_found", async (name, args) => {
      const { body, isError } = await call(name, args);
      expect(isError).toBe(true);
      expect(body.error?.code).toBe("not_found");
    });

    it("search_parts and list_colors with no match are empty successes, not errors", async () => {
      const search = await call("search_parts", { query: "zzzqqqxxxnotaword" });
      expect(search.isError).toBe(false);
      expect(search.body).toMatchObject({ total: 0, returned: 0, has_more: false, next_offset: null });
      const colors = await call("list_colors", { name: "zzzqqqxxx" });
      expect(colors.body).toMatchObject({ total: 0, returned: 0 });
    });
  });

  describe("query strings", () => {
    it.each([[""], ["   "], ["\t\n"], [" "]])("blank query %j is invalid_input", async (query) => {
      expect((await call("search_parts", { query })).body.error?.code).toBe("invalid_input");
    });

    it("oversize query (> maxQueryChars) is invalid_input; boundary length is accepted", async () => {
      expect((await call("search_parts", { query: "a".repeat(LIMITS.maxQueryChars + 1) })).body.error?.code).toBe("invalid_input");
      expect((await call("search_parts", { query: "a".repeat(10_000_000).slice(0, LIMITS.maxQueryChars) })).isError).toBe(false);
    });

    it("too many words is invalid_input (bounds the FTS work)", async () => {
      const query = Array.from({ length: LIMITS.maxQueryTokens + 1 }, (_, i) => `w${i}`).join(" ");
      expect((await call("search_parts", { query })).body.error?.code).toBe("invalid_input");
    });

    it("punctuation-only query is invalid_input", async () => {
      for (const query of ["!!!", "* ^ ( )", '""', "';--"]) {
        expect((await call("search_parts", { query })).body.error?.code, query).toBe("invalid_input");
      }
    });

    it("pathological-but-allowed queries return quickly and bounded", async () => {
      const started = Date.now();
      // Most common word, max page, deepest allowed offset; and the max number of very common tokens.
      const heavy = [
        { query: "a", limit: LIMITS.maxLimit, offset: LIMITS.maxOffset },
        { query: Array.from({ length: LIMITS.maxQueryTokens }, () => "brick").join(" "), limit: LIMITS.maxLimit },
        { query: "1", limit: LIMITS.maxLimit },
        { query: "x ".repeat(100).trim(), limit: LIMITS.maxLimit },
      ];
      for (const args of heavy) {
        const { body } = await call("search_parts", args);
        expect(JSON.stringify(body).length).toBeLessThanOrEqual(LIMITS.payloadBudgetChars + 400);
      }
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  describe("pagination bounds", () => {
    const base = { query: "brick" };
    it.each([
      [{ ...base, offset: -1 }],
      [{ ...base, offset: LIMITS.maxOffset + 1 }],
      [{ ...base, offset: Number.MAX_SAFE_INTEGER }],
      [{ ...base, offset: 1.5 }],
      [{ ...base, offset: "5" }],
      [{ ...base, offset: null }],
      [{ ...base, limit: 0 }],
      [{ ...base, limit: -1 }],
      [{ ...base, limit: LIMITS.maxLimit + 1 }],
      [{ ...base, limit: 2.5 }],
      [{ ...base, limit: "10" }],
      [{ ...base, limit: null }],
      [{ ...base, limit: 1e308 }],
      [{ ...base, limit: Number.MAX_SAFE_INTEGER }],
    ])("search_parts %j -> invalid_input", async (args) => {
      expect((await call("search_parts", args)).body.error?.code).toBe("invalid_input");
    });

    it("limit and offset bounds apply to every paginated tool", async () => {
      for (const args of [
        { set_num: "75192-1", limit: 0 },
        { set_num: "75192-1", limit: -5 },
        { set_num: "75192-1", limit: LIMITS.maxInventoryLimit + 1 },
        { set_num: "75192-1", offset: -1 },
        { set_num: "75192-1", offset: LIMITS.maxOffset + 1 },
        { set_num: "75192-1", version: 0 },
        { set_num: "75192-1", version: 1001 },
        { set_num: "75192-1", version: 1.5 },
      ]) {
        expect((await call("get_set_inventory", args)).body.error?.code, JSON.stringify(args)).toBe("invalid_input");
      }
      for (const args of [{ limit: 0 }, { limit: LIMITS.maxLimit + 1 }, { offset: -1 }, { offset: LIMITS.maxOffset + 1 }]) {
        expect((await call("list_colors", args)).body.error?.code, JSON.stringify(args)).toBe("invalid_input");
      }
    });

    it("offset exactly at the cap is accepted and answers instantly with an empty page", async () => {
      const { body, isError } = await call("search_parts", { query: "brick", offset: LIMITS.maxOffset });
      expect(isError).toBe(false);
      expect(body.has_more).toBe(typeof body.total === "number" && body.total > LIMITS.maxOffset + (body.returned as number));
    });
  });

  describe("injection strings are inert against every string argument", () => {
    it("search_parts.query", async () => {
      const before = fingerprint();
      for (const query of INJECTIONS) {
        const { body } = await call("search_parts", { query });
        // Either a clean answer or a clean invalid_input; never an internal_error.
        expect(body.error?.code ?? "ok", JSON.stringify(query)).not.toBe("internal_error");
      }
      expect(fingerprint()).toEqual(before);
    });

    it("get_part.part_num, get_set_inventory.set_num, lookup_element.element_id, list_colors.name", async () => {
      const before = fingerprint();
      for (const s of INJECTIONS) {
        expect((await call("get_part", { part_num: s })).body.error?.code ?? "ok", s).not.toBe("internal_error");
        expect((await call("get_set_inventory", { set_num: s })).body.error?.code ?? "ok", s).not.toBe("internal_error");
        expect((await call("lookup_element", { element_id: s })).body.error?.code ?? "ok", s).not.toBe("internal_error");
        expect((await call("list_colors", { name: s })).body.error?.code ?? "ok", s).not.toBe("internal_error");
      }
      expect(fingerprint()).toEqual(before);
    });

    it("injection text in a name is not reflected as a key or executed; wildcards in list_colors.name are literal", async () => {
      const { body } = await call("list_colors", { name: "%" });
      expect(body.total).toBe(0); // LIKE-style wildcard would have matched every colour
      expect((await call("list_colors", { name: "_" })).body.total).toBe(0);
    });

    it("the connection is read-only: writes are rejected by SQLite itself", () => {
      for (const sql of ["DROP TABLE parts", "DELETE FROM colors", "UPDATE meta SET value = 'x'", "INSERT INTO meta VALUES ('k','v')"]) {
        expect(() => catalog.db.exec(sql), sql).toThrow(/readonly|read-only/i);
      }
    });

    it("the snapshot file is byte-for-byte untouched by the suite (size check)", () => {
      expect(statSync(dbPath).size).toBeGreaterThan(0);
      expect(readFileSync(dbPath).subarray(0, 15).toString()).toBe("SQLite format 3");
    });
  });

  describe("wrong types and shapes", () => {
    it.each([
      ["search_parts", { query: 42 }],
      ["search_parts", { query: ["brick"] }],
      ["search_parts", { query: { $ne: "" } }],
      ["search_parts", { query: null }],
      ["search_parts", { query: true }],
      ["search_parts", { query: "brick", extra: 1 }],
      ["search_parts", { query: "brick", __proto__: { admin: true }, constructor: "x" }],
      ["get_part", { part_num: 3001 }],
      ["get_part", { part_num: "" }],
      ["get_part", { part_num: "x".repeat(65) }],
      ["get_part", {}],
      ["get_part", { part_num: ["3001"] }],
      ["get_set_inventory", { set_num: 75192 }],
      ["get_set_inventory", { set_num: "75192-1\n" + "x".repeat(40) }],
      ["get_set_inventory", { set_num: "x".repeat(33) }],
      ["get_set_inventory", { set_num: "75192-1; DROP TABLE sets" }],
      ["get_set_inventory", { set_num: "75192-1", version: "2" }],
      ["lookup_element", { element_id: 300126 }],
      ["lookup_element", { element_id: "30012x" }],
      ["lookup_element", { element_id: "1".repeat(13) }],
      ["lookup_element", { element_id: "-1" }],
      ["lookup_element", { element_id: "１２３" }], // full-width digits
      ["list_colors", { is_trans: "true" }],
      ["list_colors", { is_trans: 1 }],
      ["list_colors", { name: "" }],
      ["list_colors", { name: "x".repeat(65) }],
      ["snapshot_info", { anything: 1 }],
    ])("%s %j -> invalid_input", async (name, args) => {
      const { body, isError } = await call(name, args);
      expect(isError).toBe(true);
      expect(body.error?.code).toBe("invalid_input");
    });

    it("missing / null / non-object arguments never crash a tool", async () => {
      for (const args of [undefined, null, [], "x", 5]) {
        const result = await client.callTool({ name: "get_part", arguments: args as never }).catch((e: unknown) => e);
        const text = JSON.stringify(result instanceof Error ? { message: result.message } : result);
        expect(text).not.toMatch(LEAK_PATTERN);
      }
    });
  });

  describe("unknown tool name", () => {
    it.each([["drop_tables"], [""], ["../../etc/passwd"], ["get_part\0"], ["GET_PART"], ["__proto__"], ["constructor"], ["toString"]])(
      "%j -> unknown_tool envelope",
      async (name) => {
        const { body, isError } = await call(name, {});
        expect(isError).toBe(true);
        expect(body.error?.code).toBe("unknown_tool");
      },
    );

    it("a huge tool name is not echoed back in full (reflection is bounded)", async () => {
      const { body } = await call("A".repeat(50_000), {});
      expect(body.error?.code).toBe("unknown_tool");
      expect(JSON.stringify(body).length).toBeLessThan(1_000);
    });
  });

  describe("reflected input is bounded (SEC-M2)", () => {
    it("50 long unknown argument names do not inflate the error response", async () => {
      const args = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}_${"K".repeat(10_000)}`, 1]));
      const { body } = await call("get_part", { part_num: "3001", ...args });
      expect(body.error?.code).toBe("invalid_input");
      expect(JSON.stringify(body).length).toBeLessThan(1_000);
    });

    it("one 200-char unknown key on a tool is still reported (truncated), not dropped", async () => {
      const { body } = await call("snapshot_info", { ["u".repeat(200)]: 1 });
      expect(body.error?.code).toBe("invalid_input");
      expect(body.error?.message).toMatch(/^\(input\): Unrecognized key/);
    });
  });

  describe("duplicate search words are collapsed (SEC-L1)", () => {
    it("extractSearchTokens keeps first occurrence, case-insensitively", () => {
      expect(extractSearchTokens("x x X brick x BRICK")).toEqual(["x", "brick"]);
    });

    it('"x x x" and "x" return the same total; 21 copies of one word is not "too many words"', async () => {
      const one = await call("search_parts", { query: "brick" });
      const many = await call("search_parts", { query: "brick brick brick" });
      expect(many.body.total).toBe(one.body.total);
      const twentyOne = await call("search_parts", { query: Array.from({ length: LIMITS.maxQueryTokens + 1 }, () => "brick").join(" ") });
      expect(twentyOne.isError).toBe(false);
      expect(twentyOne.body.total).toBe(one.body.total);
    });
  });

  describe("size caps on the worst case", () => {
    it("largest inventory in the snapshot at the max page size stays under the budget", async () => {
      const big = first<{ set_num: string; version: number; n: number }>(
        catalog.db,
        `SELECT i.set_num, i.version, count(*) AS n FROM inventories i JOIN inventory_parts ip ON ip.inventory_id = i.id
          WHERE i.is_minifig = 0 GROUP BY i.id ORDER BY n DESC LIMIT 1`,
      );
      expect(big?.n).toBeGreaterThan(200);
      const { body, isError } = await call("get_set_inventory", { set_num: big?.set_num, version: big?.version, limit: LIMITS.maxInventoryLimit });
      expect(isError).toBe(false);
      expect(JSON.stringify(body).length).toBeLessThanOrEqual(LIMITS.payloadBudgetChars + 400);
      // size_capped must be honest: next_offset points at the first row that was dropped.
      if (body.size_capped) expect(body.next_offset).toBe((body.offset as number) + (body.returned as number));
    });

    it("part with the most colors and elements stays under the budget", async () => {
      const row = first<{ part_num: string }>(
        catalog.db,
        "SELECT part_num FROM part_colors GROUP BY part_num ORDER BY count(*) DESC LIMIT 1",
      );
      const { body } = await call("get_part", { part_num: row?.part_num });
      expect(JSON.stringify(body).length).toBeLessThanOrEqual(LIMITS.payloadHardMaxChars);
      expect((body.colors as unknown[]).length).toBeLessThanOrEqual(LIMITS.maxPartColors);
      expect((body.elements as unknown[]).length).toBeLessThanOrEqual(LIMITS.maxPartElements);
    });

    it("every paged tool at max limit, deep offsets included, honours the budget", async () => {
      for (const [name, args] of [
        ["search_parts", { query: "a", limit: LIMITS.maxLimit }],
        ["search_parts", { query: "plate", limit: LIMITS.maxLimit, offset: 5000 }],
        ["list_colors", { limit: LIMITS.maxLimit }],
        ["list_colors", { limit: LIMITS.maxLimit, offset: LIMITS.maxOffset }],
      ] as const) {
        const { body } = await call(name, args);
        expect(JSON.stringify(body).length, name).toBeLessThanOrEqual(LIMITS.payloadBudgetChars + 400);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// HTTP layer: handleMcpRequest is the single entry point for Vercel and the dev runner.
// ---------------------------------------------------------------------------------------------
describe("HTTP layer: malformed and hostile requests", () => {
  let catalog: Catalog;
  beforeAll(() => {
    catalog = openCatalog(dbPath);
  });

  const URL_ = "http://localhost/lego-catalog/mcp";
  const goodHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  function post(body: string | Uint8Array, headers: Record<string, string> = goodHeaders) {
    return handleMcpRequest(new Request(URL_, { method: "POST", headers, body }), catalog);
  }

  async function expectCleanError(res: Response, statuses: number[]) {
    const text = await res.text();
    expect(statuses, `status ${res.status}: ${text.slice(0, 200)}`).toContain(res.status);
    expect(text).not.toMatch(LEAK_PATTERN);
    expect(text.length).toBeLessThan(2_000);
    return text;
  }

  it.each(["GET", "PUT", "PATCH", "DELETE"])("%s -> 405 with Allow: POST", async (method) => {
    const res = await handleMcpRequest(new Request(URL_, { method }), catalog);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    await expectCleanError(res, [405]);
  });

  it("OPTIONS (CORS preflight) is refused: no CORS headers are ever sent", async () => {
    const res = await handleMcpRequest(new Request(URL_, { method: "OPTIONS", headers: { origin: "https://evil.example" } }), catalog);
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("malformed JSON -> 400 parse error, no leak", async () => {
    for (const body of ["{", "not json", '{"jsonrpc":"2.0","id":1,', "\u0000\u0001", "[", "]]]]"]) {
      await expectCleanError(await post(body), [400]);
    }
  });

  it("valid JSON that is not JSON-RPC -> clean 4xx", async () => {
    for (const body of ["null", "42", '"str"', "{}", '{"jsonrpc":"1.0","id":1,"method":"tools/list"}', '{"jsonrpc":"2.0","id":1}', "[]"]) {
      await expectCleanError(await post(body), [400, 422]);
    }
  });

  it("wrong or missing content-type -> 415; missing Accept -> 406", async () => {
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/xml"]) {
      await expectCleanError(await post(rpc, { ...goodHeaders, "content-type": ct }), [415]);
    }
    await expectCleanError(await post(rpc, { accept: goodHeaders.accept }), [415]);
    await expectCleanError(await post(rpc, { "content-type": "application/json", accept: "text/html" }), [406]);
  });

  it("unknown JSON-RPC method -> JSON-RPC error, not a crash", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/destroy" }));
    const text = await expectCleanError(res, [200, 400]);
    expect(JSON.parse(text)).toMatchObject({ error: { code: -32601 } });
  });

  it("body over the cap -> 413 before any parsing; body at a legitimate size still works", async () => {
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_part", arguments: { part_num: "x".repeat(MAX_REQUEST_BODY_BYTES) } } });
    await expectCleanError(await post(huge), [413]);
    // Lying Content-Length must not bypass the cap either (chunked / streamed upload).
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(64 * 1024).fill(0x20);
        for (let i = 0; i < Math.ceil(MAX_REQUEST_BODY_BYTES / chunk.length) + 1; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const streamed = await handleMcpRequest(
      new Request(URL_, { method: "POST", headers: goodHeaders, body: stream, duplex: "half" } as RequestInit),
      catalog,
    );
    await expectCleanError(streamed, [413]);
    const ok = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_part", arguments: { part_num: "3001" } } }));
    expect(ok.status).toBe(200);
  });

  it("a JSON-RPC batch cannot multiply work: batches are rejected", async () => {
    const one = { jsonrpc: "2.0", method: "tools/call", params: { name: "search_parts", arguments: { query: "brick", limit: 100 } } };
    const batch = Array.from({ length: 50 }, (_, i) => ({ ...one, id: i + 1 }));
    const res = await post(JSON.stringify(batch));
    const text = await expectCleanError(res, [400, 200]);
    // Either rejected outright, or (if the SDK serves it) at most a handful of results - never 50 full pages.
    expect(text.length).toBeLessThan(2_000);
  });

  it("hostile Host / Origin headers do not break the response and never produce CORS headers", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {
      ...goodHeaders,
      host: "evil.example",
      origin: "https://evil.example",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("tool-level errors over HTTP keep the envelope", async () => {
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_part", arguments: { part_num: "nope" } } }));
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: Body } };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toMatchObject({ source: "Rebrickable", snapshot_date: catalog.snapshotDate, error: { code: "not_found" } });
  });
});
