import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { candidateDbPaths } from "../src/db.ts";
import { assertFts5Available, buildSnapshot } from "../scripts/build_snapshot/build.ts";
import {
  assertNoUnknownFiles,
  convertRow,
  convertValue,
  SnapshotError,
  validateHeader,
} from "../scripts/build_snapshot/csv.ts";
import {
  DownloadRefusedError,
  ensureCache,
  parseDownloadedAt,
} from "../scripts/build_snapshot/download.ts";
import { FILE_SPECS, MIN_ROWS, type FileSpec } from "../scripts/build_snapshot/spec.ts";

const spec = (file: string): FileSpec => {
  const found = FILE_SPECS.find((s) => s.file === file);
  if (!found) throw new Error(`no spec ${file}`);
  return found;
};

describe("header validation", () => {
  it("accepts the exact expected header", () => {
    expect(() => validateHeader(spec("parts"), ["part_num", "name", "part_cat_id", "part_material"])).not.toThrow();
  });
  it("rejects a renamed, reordered, missing or extra column", () => {
    const parts = spec("parts");
    expect(() => validateHeader(parts, ["part_num", "title", "part_cat_id", "part_material"])).toThrow(SnapshotError);
    expect(() => validateHeader(parts, ["name", "part_num", "part_cat_id", "part_material"])).toThrow(/header mismatch/);
    expect(() => validateHeader(parts, ["part_num", "name", "part_cat_id"])).toThrow(SnapshotError);
    expect(() => validateHeader(parts, ["part_num", "name", "part_cat_id", "part_material", "img_url"])).toThrow(
      SnapshotError,
    );
  });
  it("rejects unknown csv files", () => {
    const known = FILE_SPECS.map((s) => s.file);
    expect(() => assertNoUnknownFiles(["parts", "colors"], known)).not.toThrow();
    expect(() => assertNoUnknownFiles(["parts", "mystery"], known)).toThrow(/mystery\.csv/);
  });
});

describe("value conversion", () => {
  const col = (file: string, name: string) => {
    const found = spec(file).columns.find((c) => c.name === name);
    if (!found) throw new Error("no col");
    return found;
  };
  it("maps the literal strings True/False and rejects anything else", () => {
    expect(convertValue(col("colors", "is_trans"), "True", "t")).toBe(1);
    expect(convertValue(col("colors", "is_trans"), "False", "t")).toBe(0);
    expect(() => convertValue(col("colors", "is_trans"), "true", "t")).toThrow(SnapshotError);
    expect(() => convertValue(col("colors", "is_trans"), "1", "t")).toThrow(SnapshotError);
  });
  it("parses strict integers and nullable fields", () => {
    expect(convertValue(col("colors", "id"), "-1", "t")).toBe(-1);
    expect(() => convertValue(col("colors", "id"), "12x", "t")).toThrow(SnapshotError);
    expect(() => convertValue(col("colors", "id"), "", "t")).toThrow(SnapshotError);
    expect(convertValue(col("themes", "parent_id"), "", "t")).toBeNull();
    expect(convertValue(col("elements", "design_id"), "", "t")).toBeNull();
    expect(convertValue(col("elements", "design_id"), "3001", "t")).toBe("3001");
  });
  it("drops img_url and rejects ragged rows", () => {
    expect(convertRow(spec("sets"), ["75192-1", "Falcon", "2017", "171", "7541", "https://x/y.jpg"], 2)).toEqual([
      "75192-1",
      "Falcon",
      2017,
      171,
      7541,
    ]);
    expect(() => convertRow(spec("sets"), ["a", "b"], 3)).toThrow(/expected 6 fields/);
  });
});

describe("download guard (never executed in tests)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "snap-dl-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("parses DOWNLOADED_AT.txt", () => {
    expect(parseDownloadedAt("downloaded_utc=2026-10-05T15:40:52Z\n")?.toISOString()).toBe("2026-10-05T15:40:52.000Z");
    expect(parseDownloadedAt("garbage")).toBeNull();
  });
  it("refuses to download when the last download is under 24 h old, without calling fetch", async () => {
    writeFileSync(join(dir, "DOWNLOADED_AT.txt"), "downloaded_utc=2026-10-05T15:40:52Z\n");
    const fetchImpl = vi.fn();
    await expect(ensureCache(dir, { now: new Date("2026-10-06T10:00:00Z"), fetchImpl })).rejects.toBeInstanceOf(
      DownloadRefusedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/** Writes a tiny but complete 12-file cache. */
function writeFixtureCache(dir: string, overrides: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  const rows: Record<string, string[]> = {
    colors: ["0,Black,05131D,False,100,200,1957,2025", "-1,[Unknown],0033B2,False,0,0,,"],
    part_categories: ["11,Bricks"],
    parts: ["3001,Brick 2 x 4,11,Plastic", '3002,"Brick 2 x 3, special",11,Plastic'],
    elements: ["300126,3001,5,3001", "9999999,3002,5,"],
    sets: ["75192-1,Millennium Falcon,2017,171,7541,https://img/1.jpg"],
    themes: ["171,Star Wars,"],
    inventories: ["1,1,75192-1", "2,2,75192-1", "3,1,fig-000001"],
    inventory_parts: ["1,3001,5,2,False,https://img/a.jpg", "2,3001,5,3,False,https://img/a.jpg", "2,3002,5,1,True,"],
  };
  for (const s of FILE_SPECS) {
    const header = s.columns.map((c) => c.name).join(",");
    const body = rows[s.file] ?? [];
    writeFileSync(join(dir, `${s.file}.csv`), overrides[s.file] ?? [header, ...body].join("\n") + "\n");
  }
  writeFileSync(join(dir, "DOWNLOADED_AT.txt"), "downloaded_utc=2026-10-05T15:40:52Z\n");
}

describe("--download-only (never touches the network in tests)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "snap-do-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("with a complete cache makes no network call and builds no sqlite", () => {
    const cache = join(root, "cache");
    const out = join(root, "out.sqlite");
    writeFixtureCache(cache);
    const stampBefore = readFileSync(join(cache, "DOWNLOADED_AT.txt"), "utf8");
    const pkg = join(import.meta.dirname, "..");
    // The preload poisons fetch: any network attempt makes ensureCache throw, which fails the run (exit 1).
    const poison = "data:text/javascript,globalThis.fetch=()=>{throw new Error('NETWORK CALL ATTEMPTED')}";
    const res = spawnSync(
      process.execPath,
      ["--import", poison, "--import", "tsx", "scripts/build_snapshot/main.ts", "--download-only", "--cache-dir", cache, "--out", out],
      { cwd: pkg, encoding: "utf8", timeout: 60_000 },
    );
    expect(res.stderr).not.toMatch(/NETWORK CALL ATTEMPTED/);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("csv cache ready:");
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.tmp`)).toBe(false);
    expect(readFileSync(join(cache, "DOWNLOADED_AT.txt"), "utf8")).toBe(stampBefore); // no download => stamp untouched
  });
});

describe("build pipeline on a fixture", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "snap-fx-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("FTS5 is available in node:sqlite", () => {
    expect(() => assertFts5Available()).not.toThrow();
  });

  it("builds, keeps row counts, flags minifig inventories, drops img_url, computes part_colors and meta", async () => {
    writeFixtureCache(join(root, "ok"));
    const out = join(root, "ok.sqlite");
    const result = await buildSnapshot({ cacheDir: join(root, "ok"), outPath: out });
    expect(result.snapshotDate).toBe("2026-10-05");
    expect(result.tables.inventory_parts).toEqual({ csvRows: 3, dbRows: 3 });

    const db = new DatabaseSync(out, { readOnly: true });
    const one = (sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as Record<string, unknown>;
    expect(one("SELECT is_minifig AS v FROM inventories WHERE id = ?", 3).v).toBe(1);
    expect(one("SELECT is_minifig AS v FROM inventories WHERE id = ?", 1).v).toBe(0);
    expect(one("SELECT design_id AS v FROM elements WHERE element_id = ?", "9999999").v).toBeNull();
    expect(one("SELECT name AS v FROM parts WHERE part_num = ?", "3002").v).toBe("Brick 2 x 3, special");
    expect(one("SELECT COUNT(*) AS v FROM pragma_table_info('inventory_parts') WHERE name = 'img_url'").v).toBe(0);
    expect(one("SELECT COUNT(*) AS v FROM pragma_table_info('sets') WHERE name = 'img_url'").v).toBe(0);
    expect(one("SELECT value AS v FROM meta WHERE key = ?", "snapshot_date").v).toBe("2026-10-05");
    expect(one("SELECT num_inventories AS v FROM part_colors WHERE part_num = ? AND color_id = ?", "3001", 5).v).toBe(2);
    // FTS: hostile input is bound as a parameter, never concatenated into SQL.
    expect(db.prepare("SELECT part_num FROM parts_fts WHERE parts_fts MATCH ?").all('"brick 2 x 4"')).toEqual([
      { part_num: "3001" },
    ]);
    db.close();
  });

  it("fails loudly on a header mismatch, an unknown file, and a bad boolean", async () => {
    writeFixtureCache(join(root, "badhdr"), { parts: "part_num,title,part_cat_id,part_material\n" });
    await expect(buildSnapshot({ cacheDir: join(root, "badhdr"), outPath: join(root, "a.sqlite") })).rejects.toThrow(
      /header mismatch/,
    );

    writeFixtureCache(join(root, "unknown"));
    writeFileSync(join(root, "unknown", "extra.csv"), "a,b\n");
    await expect(buildSnapshot({ cacheDir: join(root, "unknown"), outPath: join(root, "b.sqlite") })).rejects.toThrow(
      /extra\.csv/,
    );

    writeFixtureCache(join(root, "badbool"), {
      colors: "id,name,rgb,is_trans,num_parts,num_sets,y1,y2\n0,Black,05131D,yes,1,1,,\n",
    });
    await expect(buildSnapshot({ cacheDir: join(root, "badbool"), outPath: join(root, "c.sqlite") })).rejects.toThrow(
      /True/,
    );
    expect(existsSync(join(root, "c.sqlite.tmp"))).toBe(false); // failed builds leave no half-written file
  });

  it("aborts on duplicate keys instead of silently dropping rows", async () => {
    writeFixtureCache(join(root, "dup"), {
      part_categories: "id,name\n11,Bricks\n11,Bricks again\n",
    });
    await expect(buildSnapshot({ cacheDir: join(root, "dup"), outPath: join(root, "d.sqlite") })).rejects.toThrow();
  });
});

/** Acceptance probes against the real snapshot. Skipped when data/rebrickable.sqlite has not been built. */
const REAL = candidateDbPaths().find((p) => existsSync(p));
describe.skipIf(!REAL)("acceptance probes (real snapshot)", () => {
  // Opened in beforeAll: vitest still runs a skipped describe's body, so opening here would throw when the file is absent.
  let db: DatabaseSync;
  beforeAll(() => {
    db = new DatabaseSync(REAL as string, { readOnly: true });
  });
  afterAll(() => db.close());

  // Invariants, not history: a fresh Rebrickable download changes every count, so no test may pin one.
  it("every table meets its completeness floor and meta agrees with the real row count", () => {
    for (const [table, floor] of Object.entries(MIN_ROWS)) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n, `${table} row count`).toBeGreaterThanOrEqual(floor);
      const meta = db.prepare("SELECT value FROM meta WHERE key = ?").get(`rows.${table}`) as { value: string };
      expect(Number(meta.value), `meta rows.${table}`).toBe(row.n);
    }
    const pc = db.prepare("SELECT COUNT(*) AS n FROM part_colors").get() as { n: number };
    const pcMeta = db.prepare("SELECT value FROM meta WHERE key = 'rows.part_colors'").get() as { value: string };
    expect(pc.n).toBeGreaterThan(0);
    expect(Number(pcMeta.value)).toBe(pc.n);
  });

  it("3001 is named 'Brick 2 x 4'", () => {
    const row = db.prepare("SELECT name FROM parts WHERE part_num = ?").get("3001") as { name: string };
    expect(row.name).toBe("Brick 2 x 4");
  });

  it.each(["brick 2 x 4", '"brick 2 x 4"'])("FTS query %s returns 3001 as the top hit", (query) => {
    const hits = db
      .prepare("SELECT part_num, name FROM parts_fts WHERE parts_fts MATCH ? ORDER BY rank LIMIT 5")
      .all(query) as { part_num: string; name: string }[];
    expect(hits[0]?.part_num).toBe("3001");
  });

  it("75192-1 latest inventory version matches an independent count, fast", () => {
    const stmt = db.prepare(
      `SELECT ip.part_num, ip.color_id, ip.quantity, ip.is_spare
         FROM inventory_parts ip
         JOIN inventories i ON i.id = ip.inventory_id
        WHERE i.set_num = ?1 AND i.version = (SELECT MAX(version) FROM inventories WHERE set_num = ?1)`,
    );
    const t0 = performance.now();
    const rows = stmt.all("75192-1");
    const ms = performance.now() - t0;
    console.log(`75192-1 latest-version inventory: ${rows.length} rows in ${ms.toFixed(1)} ms`);
    // Oracle: a deliberately different formulation (ORDER BY ... LIMIT 1 instead of MAX, scalar subquery instead of JOIN).
    const oracle = db
      .prepare(
        `SELECT COUNT(*) AS n FROM inventory_parts
          WHERE inventory_id = (SELECT id FROM inventories WHERE set_num = ?1 ORDER BY version DESC LIMIT 1)`,
      )
      .get("75192-1") as { n: number };
    expect(oracle.n).toBeGreaterThan(0);
    expect(rows).toHaveLength(oracle.n);
    expect(ms).toBeLessThan(1000);
  });

  it("flags minifig inventories and meta carries snapshot_date + schema_version", () => {
    const fig = db.prepare("SELECT COUNT(*) AS n FROM inventories WHERE is_minifig = 1").get() as { n: number };
    // Oracle: count by the naming rule itself, independent of the is_minifig flag the builder set.
    const oracle = db.prepare("SELECT COUNT(*) AS n FROM inventories WHERE substr(set_num, 1, 4) = 'fig-'").get() as {
      n: number;
    };
    expect(oracle.n).toBeGreaterThan(0);
    expect(fig.n).toBe(oracle.n);
    const date = db.prepare("SELECT value FROM meta WHERE key = 'snapshot_date'").get() as { value: string };
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(readFileSync(join(process.cwd(), "package.json"), "utf8")).toContain("build:snapshot");
  });
});
