import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIN_ROWS } from "../scripts/build_snapshot/spec.ts";
import { LIMITS } from "../src/config.ts";
import { openCatalog } from "../src/db.ts";
import { createLegoServer } from "../src/server.ts";
import { extractSearchTokens, normalizeSetNum } from "../src/tools.ts";
import { dbPath, isReal } from "./helpers/snapshot.ts";

type Body = Record<string, unknown> & { source?: string; snapshot_date?: string };

// Runs on the real snapshot when one is configured, otherwise on the fixture snapshot built by the real builder
// (tests/helpers/global-setup.ts). Counts are compared with the oracle's own COUNT(*); only the completeness floors
// (MIN_ROWS) are real-data-only and are gated on `isReal`.
describe("MCP server over the snapshot under test (in-memory transport)", () => {
  let client: Client;
  let snapshotDate: string;
  // Independent oracle: its own read-only handle and its own plain SQL, so the expected values come from whatever
  // snapshot is under test rather than from numbers frozen on one day.
  let oracleDb: DatabaseSync;
  let set75192: { versions: number[]; latestVersion: number; latestRows: number };

  beforeAll(async () => {
    oracleDb = new DatabaseSync(dbPath, { readOnly: true });
    const versions = (
      oracleDb.prepare("SELECT version FROM inventories WHERE set_num = '75192-1' ORDER BY version").all() as { version: number }[]
    ).map((r) => r.version);
    const latestVersion = versions[versions.length - 1] as number;
    const latestRows = (
      oracleDb
        .prepare(
          "SELECT COUNT(*) AS n FROM inventory_parts WHERE inventory_id = (SELECT id FROM inventories WHERE set_num = '75192-1' AND version = ?)",
        )
        .get(latestVersion) as { n: number }
    ).n;
    set75192 = { versions, latestVersion, latestRows };
    const catalog = openCatalog(dbPath);
    snapshotDate = catalog.snapshotDate;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createLegoServer(catalog).connect(serverSide);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);
  });
  afterAll(async () => {
    await client.close();
    oracleDb.close();
  });

  // Table names are literals from this file only; never user input.
  const count = (table: "colors" | "parts"): number =>
    (oracleDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const body = result.structuredContent as Body;
    const content = result.content as { type: string; text: string }[];
    // Every response (success or error) carries the envelope, and the text block mirrors the structured payload.
    expect(body.source).toBe("Rebrickable");
    expect(body.snapshot_date).toBe(snapshotDate);
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual(body);
    expect(content[0]?.text.length).toBeLessThan(25_000);
    return { body, isError: result.isError === true };
  }

  it("lists the six tools, all annotated read-only", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_part", "get_set_inventory", "list_colors", "lookup_element", "search_parts", "snapshot_info"].sort(),
    );
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema.type).toBe("object");
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
    expect(byName.get_set_inventory).toMatch(/SET NUMBERS ONLY/);
    expect(byName.get_set_inventory).toMatch(/fig-/);
    for (const name of ["search_parts", "get_part", "lookup_element", "get_set_inventory"]) {
      expect(byName[name]).toMatch(/Rebrickable's part number/);
      expect(byName[name]).toMatch(/design_id/);
      expect(byName[name]).toMatch(/BrickLink/);
    }
  });

  it("search_parts('brick 2 x 4') includes 3001", async () => {
    const { body, isError } = await call("search_parts", { query: "brick 2 x 4" });
    expect(isError).toBe(false);
    const parts = body.parts as { part_num: string }[];
    expect(parts.map((p) => p.part_num)).toContain("3001");
    expect(body.limit).toBe(LIMITS.defaultLimit);
    expect(body.total).toBeGreaterThan(0);
  });

  it("get_part('3001') is Brick 2 x 4 with colors and elements", async () => {
    const { body } = await call("get_part", { part_num: "3001" });
    expect(body.name).toBe("Brick 2 x 4");
    expect((body.colors as unknown[]).length).toBeGreaterThan(5);
    expect((body.elements as unknown[]).length).toBeLessThanOrEqual(LIMITS.maxPartElements);
  });

  it("get_part unknown id -> structured not_found", async () => {
    const { body, isError } = await call("get_part", { part_num: "does-not-exist" });
    expect(isError).toBe(true);
    expect(body.error).toMatchObject({ code: "not_found" });
  });

  it("get_set_inventory('75192-1') paginates the latest inventory and accepts '75192'", async () => {
    expect(set75192.versions.length).toBeGreaterThanOrEqual(2); // the explicit-version test below needs an older version
    expect(set75192.latestRows).toBeGreaterThan(200); // big enough to force pagination at limit=200
    const first = await call("get_set_inventory", { set_num: "75192-1", limit: 200 });
    expect(first.body.total).toBe(set75192.latestRows);
    expect(first.body.has_more).toBe(true);
    expect((first.body.set as { name: string }).name).toContain("Millennium");
    expect(first.body.inventory_version).toBe(set75192.latestVersion);
    const returned = first.body.returned as number;
    expect(returned).toBeGreaterThan(0);
    expect(returned).toBeLessThanOrEqual(200);
    expect(first.body.next_offset).toBe(returned);

    const second = await call("get_set_inventory", { set_num: "75192", limit: 200, offset: first.body.next_offset });
    expect(second.body.offset).toBe(returned);
    const keys = new Set(
      [...(first.body.parts as { part_num: string; color_id: number; is_spare: boolean }[]), ...(second.body.parts as { part_num: string; color_id: number; is_spare: boolean }[])].map(
        (p) => `${p.part_num}/${p.color_id}/${p.is_spare}`,
      ),
    );
    expect(keys.size).toBe(returned + (second.body.returned as number)); // no overlap between pages
  });

  it("get_set_inventory: unknown set, fig-* id and unknown version -> not_found", async () => {
    expect((await call("get_set_inventory", { set_num: "99999999-1" })).body.error).toMatchObject({ code: "not_found" });
    const fig = await call("get_set_inventory", { set_num: "fig-000001" });
    expect(fig.body.error).toMatchObject({ code: "not_found" });
    expect(JSON.stringify(fig.body.error)).toMatch(/inventories are not supported/);
    const version = await call("get_set_inventory", { set_num: "75192-1", version: 99 });
    expect(version.body.error).toMatchObject({ code: "not_found" });
    expect(JSON.stringify(version.body.error)).toMatch(/Available versions/);
  });

  it("explicit inventory version selects that version", async () => {
    const oldest = set75192.versions[0] as number;
    expect(oldest).toBeLessThan(set75192.latestVersion);
    const { body } = await call("get_set_inventory", { set_num: "75192-1", version: oldest, limit: 1 });
    expect(body.inventory_version).toBe(oldest);
  });

  it("list_colors filters and paginates", async () => {
    const all = await call("list_colors", {});
    expect(all.body.total).toBe(count("colors"));
    if (isReal) expect(all.body.total).toBeGreaterThanOrEqual(MIN_ROWS.colors as number); // real-data completeness floor
    const black = await call("list_colors", { name: "black" });
    expect((black.body.colors as { name: string }[]).some((c) => c.name === "Black")).toBe(true);
    const trans = await call("list_colors", { is_trans: true, limit: 5 });
    expect((trans.body.colors as { is_trans: boolean }[]).every((c) => c.is_trans)).toBe(true);
    expect(trans.body.has_more).toBe(true);
  });

  it("lookup_element resolves a known element and reports not_found otherwise", async () => {
    const { body } = await call("lookup_element", { element_id: "300126" });
    expect(body.part).toMatchObject({ part_num: "3001" });
    expect(body.color).toMatchObject({ color_id: 0, name: "Black" });
    expect((await call("lookup_element", { element_id: "999999999999" })).body.error).toMatchObject({ code: "not_found" });
  });

  it("snapshot_info reports the snapshot date and limits", async () => {
    const { body } = await call("snapshot_info");
    expect(body.snapshot_date).toBe(snapshotDate);
    expect((body.row_counts as Record<string, number>).parts).toBe(count("parts"));
    if (isReal) expect((body.row_counts as Record<string, number>).parts).toBeGreaterThanOrEqual(MIN_ROWS.parts as number); // real-data floor
    expect(body.limits).toMatchObject({ max_limit: 100, max_inventory_limit: 200 });
  });

  it("invalid input is a structured invalid_input error (empty query, bad limit, unknown field, wrong type)", async () => {
    for (const args of [
      { query: "   " },
      { query: "brick", limit: 101 },
      { query: "brick", offset: LIMITS.maxOffset + 1 },
      { query: "brick", surprise: true },
      { query: 42 },
      {},
      { query: "!!! ???" },
    ]) {
      const { body, isError } = await call("search_parts", args);
      expect(isError, JSON.stringify(args)).toBe(true);
      expect(body.error, JSON.stringify(args)).toMatchObject({ code: "invalid_input" });
    }
    expect((await call("get_set_inventory", { set_num: "75192-1", limit: 201 })).isError).toBe(true);
    expect((await call("get_set_inventory", { set_num: "a b" })).isError).toBe(true);
  });

  it("unknown tool is a structured error, not a protocol error", async () => {
    const { body, isError } = await call("drop_tables");
    expect(isError).toBe(true);
    expect(body.error).toMatchObject({ code: "unknown_tool" });
  });

  it("FTS operators and quotes in user text are inert", async () => {
    for (const query of ['brick" OR "x', "brick AND NOT 2", "brick* NEAR(2 4)", "'; DROP TABLE parts; --", "name:brick"]) {
      const { isError } = await call("search_parts", { query });
      expect(isError, query).toBe(false);
    }
    expect(extractSearchTokens('brick" OR *')).toEqual(["brick", "OR"]);
    expect((await call("get_part", { part_num: "3001' OR '1'='1" })).body.error).toMatchObject({ code: "not_found" });
  });

  it("size caps hold for the largest allowed pages", async () => {
    const inv = await call("get_set_inventory", { set_num: "75192-1", limit: 200 });
    expect(JSON.stringify(inv.body).length).toBeLessThanOrEqual(LIMITS.payloadBudgetChars + 200);
    const search = await call("search_parts", { query: "brick", limit: 100 });
    expect(JSON.stringify(search.body).length).toBeLessThanOrEqual(LIMITS.payloadBudgetChars + 200);
    const colors = await call("list_colors", { limit: 100 });
    expect(JSON.stringify(colors.body).length).toBeLessThanOrEqual(LIMITS.payloadBudgetChars + 200);
  });
});

describe("pure helpers", () => {
  it("normalizeSetNum adds -1 only when there is no hyphen", () => {
    expect(normalizeSetNum("75192")).toBe("75192-1");
    expect(normalizeSetNum("75192-2")).toBe("75192-2");
  });
});
