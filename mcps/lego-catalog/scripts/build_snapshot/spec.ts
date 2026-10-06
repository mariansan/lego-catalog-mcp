import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Expected Rebrickable CSV layout (verified against the 2026-10-05 download) and the SQLite tables built
 * from it.
 *
 * Column kinds:
 *   text     - kept as-is (empty string stays "")
 *   textnull - empty string -> NULL
 *   int      - strict base-10 integer, empty is an error
 *   intnull  - strict integer, empty -> NULL
 *   bool     - literal "True" | "False" -> 1 | 0
 *   drop     - validated in the header but NOT stored (img_url: we never serve images)
 */
export type ColumnKind = "text" | "textnull" | "int" | "intnull" | "bool" | "drop";

export interface ColumnSpec {
  readonly name: string;
  readonly kind: ColumnKind;
}

export interface FileSpec {
  readonly file: string; // CSV base name, without extension
  /** SQLite table the rows are imported into, or null when only the header is validated. */
  readonly table: string | null;
  readonly columns: readonly ColumnSpec[];
}

const c = (name: string, kind: ColumnKind): ColumnSpec => ({ name, kind });

export const FILE_SPECS: readonly FileSpec[] = [
  {
    file: "colors",
    table: "colors",
    columns: [
      c("id", "int"),
      c("name", "text"),
      c("rgb", "text"),
      c("is_trans", "bool"),
      c("num_parts", "int"),
      c("num_sets", "int"),
      c("y1", "intnull"),
      c("y2", "intnull"),
    ],
  },
  { file: "part_categories", table: "part_categories", columns: [c("id", "int"), c("name", "text")] },
  {
    file: "parts",
    table: "parts",
    columns: [c("part_num", "text"), c("name", "text"), c("part_cat_id", "int"), c("part_material", "text")],
  },
  {
    file: "elements",
    table: "elements",
    columns: [c("element_id", "text"), c("part_num", "text"), c("color_id", "int"), c("design_id", "textnull")],
  },
  {
    file: "sets",
    table: "sets",
    columns: [
      c("set_num", "text"),
      c("name", "text"),
      c("year", "int"),
      c("theme_id", "int"),
      c("num_parts", "int"),
      c("img_url", "drop"),
    ],
  },
  { file: "themes", table: "themes", columns: [c("id", "int"), c("name", "text"), c("parent_id", "intnull")] },
  {
    file: "inventories",
    table: "inventories",
    columns: [c("id", "int"), c("version", "int"), c("set_num", "text")],
  },
  {
    file: "inventory_parts",
    table: "inventory_parts",
    columns: [
      c("inventory_id", "int"),
      c("part_num", "text"),
      c("color_id", "int"),
      c("quantity", "int"),
      c("is_spare", "bool"),
      c("img_url", "drop"),
    ],
  },
  // Header-validated only: not needed by any tool.
  {
    file: "inventory_sets",
    table: null,
    columns: [c("inventory_id", "int"), c("set_num", "text"), c("quantity", "int")],
  },
  {
    file: "inventory_minifigs",
    table: null,
    columns: [c("inventory_id", "int"), c("fig_num", "text"), c("quantity", "int")],
  },
  {
    file: "minifigs",
    table: null,
    columns: [c("fig_num", "text"), c("name", "text"), c("num_parts", "int"), c("img_url", "drop")],
  },
  {
    file: "part_relationships",
    table: null,
    columns: [c("rel_type", "text"), c("child_part_num", "text"), c("parent_part_num", "text")],
  },
];

/**
 * The single definition of "this snapshot is complete": a minimum row count per table (about 75-80% of the
 * 2026-10-05 counts). The numbers live in floors.json because scripts/check-snapshot.mjs (plain Node, outside this
 * TypeScript project) reads the same file. The builder warns below a floor, the deploy gate fails below it and the
 * tests assert against it. A floor catches a truncated or empty download, never normal catalog growth; raise one
 * deliberately if the catalog ever shrinks.
 */
export const MIN_ROWS: Readonly<Record<string, number>> = JSON.parse(
  readFileSync(join(import.meta.dirname, "floors.json"), "utf8"),
) as Record<string, number>;

export const SCHEMA_VERSION = 1;
export const SOURCE_URL = "https://rebrickable.com/downloads/";
/**
 * CDN location of the gzipped CSVs. Download from GitHub Actions worked on 2026-10-05; the Rebrickable
 * downloads page itself returned 403 to a generic fetch tool. Rebrickable allows one automated download per day.
 */
export const DOWNLOAD_BASE_URL = "https://cdn.rebrickable.com/media/downloads";

export function storedColumns(spec: FileSpec): readonly ColumnSpec[] {
  return spec.columns.filter((col) => col.kind !== "drop");
}
