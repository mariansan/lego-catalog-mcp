import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LIMITS } from "./config.js";
import { all, first, type Catalog } from "./db.js";
import { fail, ok, paged } from "./results.js";

// ---------------------------------------------------------------------------------------------
// Shared descriptions. The id vocabulary is the single most common source of model mistakes, so
// every tool that touches ids repeats it.
// ---------------------------------------------------------------------------------------------
const ID_NOTES =
  "ID vocabulary: `part_num` is Rebrickable's part number - usually, but not always, the LEGO design number " +
  "(printed/assembled variants such as 6895a or 90462pr0004 have their own part_num). `element_id` identifies " +
  "design + color. `design_id` exists only on element records (the `elements` table) and may be null. " +
  "No BrickLink, LDraw or other external ids are available in this dataset.";

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const MAX_ISSUES_SHOWN = 5;
const MAX_ISSUE_CHARS = 100;
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

const offsetSchema = z
  .number()
  .int()
  .min(0)
  .max(LIMITS.maxOffset)
  .default(0)
  .describe(`Number of results to skip (0-${LIMITS.maxOffset}). Use \`next_offset\` from the previous page.`);

const limitSchema = (def: number, max: number) =>
  z.number().int().min(1).max(max).default(def).describe(`Page size (1-${max}, default ${def}).`);

// ---------------------------------------------------------------------------------------------
// Tool plumbing: a strict Zod schema per tool, validated here (not by the SDK) so that invalid
// input also gets the {source, snapshot_date, error} envelope.
// ---------------------------------------------------------------------------------------------
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  run(catalog: Catalog, rawInput: unknown): CallToolResult;
}

function defineTool<S extends z.ZodObject>(def: {
  name: string;
  description: string;
  schema: S;
  handler: (catalog: Catalog, input: z.output<S>) => CallToolResult;
}): Tool {
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(def.schema, { io: "input", target: "draft-7" }) };
  delete jsonSchema.$schema;
  return {
    name: def.name,
    description: def.description,
    inputSchema: { ...jsonSchema, type: "object" },
    annotations: READ_ONLY,
    run(catalog, rawInput) {
      const parsed = def.schema.safeParse(rawInput ?? {});
      if (!parsed.success) {
        // Zod messages echo attacker-chosen text (e.g. unrecognized key names): bound count and length.
        const message = parsed.error.issues
          .slice(0, MAX_ISSUES_SHOWN)
          .map((i) => `${i.path.length ? i.path.join(".") : "(input)"}: ${truncate(i.message, MAX_ISSUE_CHARS)}`)
          .join("; ");
        return fail(catalog.snapshotDate, "invalid_input", message);
      }
      return def.handler(catalog, parsed.data);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// search_parts
// ---------------------------------------------------------------------------------------------
/**
 * Extracts the searchable words from free text. Only letter/digit runs survive and the caller
 * double-quotes each one (repeats are dropped), so FTS5 operators (AND, OR, NOT, NEAR, *, ^, :, -, parentheses) in user
 * text are literal words and cannot change the structure of the MATCH expression.
 */
export function extractSearchTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue; // FTS5 is case-insensitive and every word must match, so repeats add cost, not precision
    seen.add(key);
    tokens.push(token);
  }
  return tokens;
}

const searchParts = defineTool({
  name: "search_parts",
  description:
    "Full-text search over LEGO part names and part numbers (Rebrickable catalog). Every word in `query` must match " +
    '(e.g. "brick 2 x 4", "plate 1 x 2 trans", "3001"). Results are ranked by relevance. ' +
    "Use this to find the correct `part_num` before calling get_part; never guess part numbers. " +
    ID_NOTES,
  schema: z.strictObject({
    query: z
      .string()
      .trim()
      .min(1, "query must not be empty")
      .max(LIMITS.maxQueryChars)
      .describe("Words from the part name and/or a part number. Punctuation is ignored."),
    limit: limitSchema(LIMITS.defaultLimit, LIMITS.maxLimit),
    offset: offsetSchema,
  }),
  handler(c, input) {
    const tokens = extractSearchTokens(input.query);
    if (tokens.length === 0) {
      return fail(c.snapshotDate, "invalid_input", "query must contain at least one letter or digit");
    }
    if (tokens.length > LIMITS.maxQueryTokens) {
      return fail(c.snapshotDate, "invalid_input", `query has more than ${LIMITS.maxQueryTokens} words`);
    }
    const match = tokens.map((t) => `"${t}"`).join(" ");
    const total =
      first<{ n: number }>(c.db, "SELECT count(*) AS n FROM parts_fts WHERE parts_fts MATCH ?", match)?.n ?? 0;
    const rows = all<{ part_num: string; name: string; category: string | null; material: string }>(
      c.db,
      `SELECT p.part_num, p.name, pc.name AS category, p.part_material AS material
         FROM parts_fts
         JOIN parts p ON p.part_num = parts_fts.part_num
         LEFT JOIN part_categories pc ON pc.id = p.part_cat_id
        WHERE parts_fts MATCH ?
        ORDER BY parts_fts.rank, p.part_num
        LIMIT ? OFFSET ?`,
      match,
      input.limit,
      input.offset,
    );
    return ok(c.snapshotDate, paged(rows, total, input.offset, input.limit, (r) => ({ query: input.query, parts: r })));
  },
});

// ---------------------------------------------------------------------------------------------
// get_part
// ---------------------------------------------------------------------------------------------
const getPart = defineTool({
  name: "get_part",
  description:
    'Look up one part by its Rebrickable `part_num` (e.g. "3001" -> "Brick 2 x 4"). Returns the name, category, ' +
    `material, the colors the part is known to exist in (up to ${LIMITS.maxPartColors}, most-used first) and up to ` +
    `${LIMITS.maxPartElements} known element records (element_id + color_id + design_id). ` +
    "Returns a `not_found` error for unknown ids - use search_parts to find the right one. " +
    ID_NOTES,
  schema: z.strictObject({
    part_num: z.string().trim().min(1).max(64).describe('Rebrickable part number, e.g. "3001" or "3626bpr0001".'),
  }),
  handler(c, input) {
    const part = first<{
      part_num: string;
      name: string;
      part_material: string;
      part_cat_id: number;
      category: string | null;
    }>(
      c.db,
      `SELECT p.part_num, p.name, p.part_material, p.part_cat_id, pc.name AS category
         FROM parts p LEFT JOIN part_categories pc ON pc.id = p.part_cat_id
        WHERE p.part_num = ?`,
      input.part_num,
    );
    if (!part) {
      return fail(
        c.snapshotDate,
        "not_found",
        `No part with part_num "${input.part_num}".`,
        "part_num is Rebrickable's number and is case-sensitive. Use search_parts to find it by name.",
      );
    }
    const colorsTotal =
      first<{ n: number }>(c.db, "SELECT count(*) AS n FROM part_colors WHERE part_num = ?", part.part_num)?.n ?? 0;
    const colors = all<{
      color_id: number;
      name: string | null;
      rgb: string | null;
      is_trans: number | null;
      num_inventories: number;
      in_elements: number;
    }>(
      c.db,
      `SELECT pc.color_id, c.name, c.rgb, c.is_trans, pc.num_inventories, pc.in_elements
         FROM part_colors pc LEFT JOIN colors c ON c.id = pc.color_id
        WHERE pc.part_num = ?
        ORDER BY pc.num_inventories DESC, pc.color_id
        LIMIT ?`,
      part.part_num,
      LIMITS.maxPartColors,
    );
    const elementsTotal =
      first<{ n: number }>(c.db, "SELECT count(*) AS n FROM elements WHERE part_num = ?", part.part_num)?.n ?? 0;
    const elements = all<{ element_id: string; color_id: number; design_id: string | null }>(
      c.db,
      "SELECT element_id, color_id, design_id FROM elements WHERE part_num = ? ORDER BY element_id LIMIT ?",
      part.part_num,
      LIMITS.maxPartElements,
    );
    return ok(c.snapshotDate, {
      part_num: part.part_num,
      name: part.name,
      category: part.category ? { id: part.part_cat_id, name: part.category } : null,
      material: part.part_material,
      colors_total: colorsTotal,
      colors: colors.map((r) => ({
        color_id: r.color_id,
        name: r.name,
        rgb: r.rgb,
        is_trans: r.is_trans === null ? null : r.is_trans === 1,
        num_inventories: r.num_inventories,
        in_elements: r.in_elements === 1,
      })),
      colors_truncated: colorsTotal > colors.length,
      elements_total: elementsTotal,
      elements,
      elements_truncated: elementsTotal > elements.length,
    });
  },
});

// ---------------------------------------------------------------------------------------------
// list_colors
// ---------------------------------------------------------------------------------------------
const listColors = defineTool({
  name: "list_colors",
  description:
    "List Rebrickable LEGO colors (id, name, RGB hex, transparency, usage counts, first/last year seen). " +
    "There are ~275 colors; filter by name substring or transparency to narrow. `color_id` is Rebrickable's color id " +
    "(not BrickLink's or LDraw's; none are provided). Ordered by color_id.",
  schema: z.strictObject({
    name: z.string().trim().min(1).max(64).optional().describe('Case-insensitive substring of the color name, e.g. "blue".'),
    is_trans: z.boolean().optional().describe("true = only transparent colors, false = only opaque ones."),
    limit: limitSchema(LIMITS.maxLimit, LIMITS.maxLimit),
    offset: offsetSchema,
  }),
  handler(c, input) {
    // Only these static fragments are ever concatenated; values go through `?` params.
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (input.name !== undefined) {
      where.push("instr(lower(name), lower(?)) > 0");
      params.push(input.name);
    }
    if (input.is_trans !== undefined) {
      where.push("is_trans = ?");
      params.push(input.is_trans ? 1 : 0);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = first<{ n: number }>(c.db, `SELECT count(*) AS n FROM colors ${clause}`, ...params)?.n ?? 0;
    const rows = all<{
      id: number;
      name: string;
      rgb: string;
      is_trans: number;
      num_parts: number;
      num_sets: number;
      y1: number | null;
      y2: number | null;
    }>(
      c.db,
      `SELECT id, name, rgb, is_trans, num_parts, num_sets, y1, y2 FROM colors ${clause} ORDER BY id LIMIT ? OFFSET ?`,
      ...params,
      input.limit,
      input.offset,
    );
    return ok(
      c.snapshotDate,
      paged(rows, total, input.offset, input.limit, (r) => ({
        colors: r.map((x) => ({
          color_id: x.id,
          name: x.name,
          rgb: x.rgb,
          is_trans: x.is_trans === 1,
          num_parts: x.num_parts,
          num_sets: x.num_sets,
          first_year: x.y1,
          last_year: x.y2,
        })),
      })),
    );
  },
});

// ---------------------------------------------------------------------------------------------
// get_set_inventory
// ---------------------------------------------------------------------------------------------
/** "75192" -> "75192-1"; anything already containing a hyphen is left alone. */
export function normalizeSetNum(raw: string): string {
  return raw.includes("-") ? raw : `${raw}-1`;
}

const getSetInventory = defineTool({
  name: "get_set_inventory",
  description:
    'Part list (inventory) of a LEGO set, from Rebrickable. SET NUMBERS ONLY: pass "75192-1" or just "75192" ' +
    '(a missing "-version" suffix is read as "-1"). Minifigure ids ("fig-...") are NOT supported and return `not_found`. ' +
    "Uses the highest inventory `version` unless `version` is given; the response lists `available_versions`. " +
    `Rows are ordered by part_num, color_id and paginated (page size up to ${LIMITS.maxInventoryLimit}); ` +
    "`is_spare` rows are spare parts not part of the built model. `total_quantity` counts non-spare pieces. " +
    ID_NOTES,
  schema: z.strictObject({
    set_num: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]{1,32}$/, "set_num may only contain letters, digits, '.', '_' and '-' (max 32)")
      .describe('Set number, e.g. "75192-1" or "75192".'),
    version: z.number().int().min(1).max(1000).optional().describe("Inventory version; default = highest available."),
    limit: limitSchema(LIMITS.defaultLimit, LIMITS.maxInventoryLimit),
    offset: offsetSchema,
  }),
  handler(c, input) {
    if (/^fig-/i.test(input.set_num)) {
      return fail(
        c.snapshotDate,
        "not_found",
        `"${input.set_num}" is a minifigure id.`,
        'Minifigure inventories are not supported; pass a set number such as "75192-1".',
      );
    }
    const setNum = normalizeSetNum(input.set_num);
    const set = first<{ set_num: string; name: string; year: number; num_parts: number; theme: string | null }>(
      c.db,
      `SELECT s.set_num, s.name, s.year, s.num_parts, t.name AS theme
         FROM sets s LEFT JOIN themes t ON t.id = s.theme_id WHERE s.set_num = ?`,
      setNum,
    );
    if (!set) {
      return fail(c.snapshotDate, "not_found", `No set "${setNum}".`, 'Set numbers look like "75192-1" (number-version).');
    }
    const versions = all<{ id: number; version: number }>(
      c.db,
      "SELECT id, version FROM inventories WHERE set_num = ? AND is_minifig = 0 ORDER BY version DESC",
      set.set_num,
    );
    const available = versions.map((v) => v.version);
    const chosen = input.version === undefined ? versions[0] : versions.find((v) => v.version === input.version);
    if (!chosen) {
      return fail(
        c.snapshotDate,
        "not_found",
        input.version === undefined
          ? `Set "${set.set_num}" has no inventory in this snapshot.`
          : `Set "${set.set_num}" has no inventory version ${input.version}.`,
        available.length ? `Available versions: ${available.join(", ")}.` : undefined,
      );
    }
    const totals = first<{ n: number; qty: number | null }>(
      c.db,
      "SELECT count(*) AS n, sum(CASE WHEN is_spare = 0 THEN quantity ELSE 0 END) AS qty FROM inventory_parts WHERE inventory_id = ?",
      chosen.id,
    );
    const rows = all<{
      part_num: string;
      part_name: string | null;
      color_id: number;
      color_name: string | null;
      quantity: number;
      is_spare: number;
    }>(
      c.db,
      `SELECT ip.part_num, p.name AS part_name, ip.color_id, c.name AS color_name, ip.quantity, ip.is_spare
         FROM inventory_parts ip
         LEFT JOIN parts p ON p.part_num = ip.part_num
         LEFT JOIN colors c ON c.id = ip.color_id
        WHERE ip.inventory_id = ?
        ORDER BY ip.part_num, ip.color_id, ip.is_spare
        LIMIT ? OFFSET ?`,
      chosen.id,
      input.limit,
      input.offset,
    );
    return ok(
      c.snapshotDate,
      paged(rows, totals?.n ?? 0, input.offset, input.limit, (r) => ({
        set: { set_num: set.set_num, name: set.name, year: set.year, theme: set.theme, num_parts: set.num_parts },
        inventory_version: chosen.version,
        available_versions: available,
        total_quantity: totals?.qty ?? 0,
        parts: r.map((x) => ({
          part_num: x.part_num,
          part_name: x.part_name,
          color_id: x.color_id,
          color_name: x.color_name,
          quantity: x.quantity,
          is_spare: x.is_spare === 1,
        })),
      })),
    );
  },
});

// ---------------------------------------------------------------------------------------------
// snapshot_info
// ---------------------------------------------------------------------------------------------
const snapshotInfo = defineTool({
  name: "snapshot_info",
  description:
    "Describes the dataset behind every answer: snapshot date, source and attribution, row counts, the inventory " +
    "version rule and this server's result limits. Call it to tell the user how fresh the data is.",
  schema: z.strictObject({}),
  handler(c) {
    const meta = Object.fromEntries(
      all<{ key: string; value: string }>(c.db, "SELECT key, value FROM meta ORDER BY key").map((r) => [r.key, r.value]),
    );
    const rowCounts: Record<string, number> = {};
    for (const [k, v] of Object.entries(meta)) if (k.startsWith("rows.")) rowCounts[k.slice(5)] = Number(v);
    return ok(c.snapshotDate, {
      source_url: meta.source_url ?? null,
      attribution: meta.attribution ?? null,
      built_at: meta.built_at ?? null,
      snapshot_downloaded_at: meta.snapshot_downloaded_at ?? null,
      schema_version: meta.schema_version ?? null,
      inventory_version_rule: meta.inventory_version_rule ?? null,
      row_counts: rowCounts,
      limits: {
        default_limit: LIMITS.defaultLimit,
        max_limit: LIMITS.maxLimit,
        max_inventory_limit: LIMITS.maxInventoryLimit,
        max_offset: LIMITS.maxOffset,
      },
      notes: ID_NOTES,
    });
  },
});

// ---------------------------------------------------------------------------------------------
// lookup_element
// ---------------------------------------------------------------------------------------------
const lookupElement = defineTool({
  name: "lookup_element",
  description:
    "Resolve a LEGO element id (one design in one color, as printed on packaging / used in Pick a Brick) " +
    "to its part and color. Returns part_num, part name, color_id, color name, RGB and `design_id` (may be null, " +
    "and may differ from part_num). Unknown element ids return `not_found`. " +
    ID_NOTES,
  schema: z.strictObject({
    element_id: z
      .string()
      .trim()
      .regex(/^\d{1,12}$/, "element_id must be 1-12 digits")
      .describe('Numeric element id, e.g. "300126".'),
  }),
  handler(c, input) {
    const row = first<{
      element_id: string;
      part_num: string;
      part_name: string | null;
      color_id: number;
      color_name: string | null;
      rgb: string | null;
      design_id: string | null;
    }>(
      c.db,
      `SELECT e.element_id, e.part_num, p.name AS part_name, e.color_id, c.name AS color_name, c.rgb, e.design_id
         FROM elements e
         LEFT JOIN parts p ON p.part_num = e.part_num
         LEFT JOIN colors c ON c.id = e.color_id
        WHERE e.element_id = ?`,
      input.element_id,
    );
    if (!row) {
      return fail(c.snapshotDate, "not_found", `No element "${input.element_id}" in this snapshot.`);
    }
    return ok(c.snapshotDate, {
      element_id: row.element_id,
      part: { part_num: row.part_num, name: row.part_name },
      color: { color_id: row.color_id, name: row.color_name, rgb: row.rgb },
      design_id: row.design_id,
    });
  },
});

export const TOOLS: readonly Tool[] = [searchParts, getPart, listColors, getSetInventory, snapshotInfo, lookupElement];
