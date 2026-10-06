import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertNoUnknownFiles, readCsv, SnapshotError } from "./csv.ts";
import { CREATE_INDEXES_AND_FTS, CREATE_PART_COLORS, CREATE_TABLES } from "./ddl.ts";
import { ensureCache, readDownloadedAt } from "./download.ts";
import {
  FILE_SPECS,
  MIN_ROWS,
  SCHEMA_VERSION,
  SOURCE_URL,
  storedColumns,
  type FileSpec,
} from "./spec.ts";

export interface TableStat {
  csvRows: number;
  dbRows: number;
}

export interface BuildResult {
  outPath: string;
  snapshotDate: string;
  sizeBytes: number;
  buildMs: number;
  tables: Record<string, TableStat>;
  warnings: string[];
}

const IDENT = /^[a-z][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT.test(name)) throw new SnapshotError(`Unsafe identifier in spec: ${name}`);
  return name;
}

/** FTS5 must be compiled into the SQLite behind node:sqlite; otherwise the whole design fails. */
export function assertFts5Available(): void {
  const probe = new DatabaseSync(":memory:");
  try {
    probe.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
  } catch (err) {
    throw new SnapshotError(`FTS5 is not available in this SQLite build: ${String(err)}`);
  } finally {
    probe.close();
  }
}

async function importTable(db: DatabaseSync, cacheDir: string, spec: FileSpec): Promise<number> {
  const path = join(cacheDir, `${spec.file}.csv`);
  const cols = storedColumns(spec);
  const sql = `INSERT INTO ${ident(spec.table ?? "")} (${cols.map((c) => ident(c.name)).join(", ")}) VALUES (${cols
    .map(() => "?")
    .join(", ")})`;
  const insert = db.prepare(sql);
  let rows = 0;
  db.exec("BEGIN");
  try {
    for await (const values of readCsv(path, spec)) {
      insert.run(...values); // plain INSERT: a duplicate key aborts the build instead of dropping rows
      rows += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows;
}

/** Validate the header of a CSV that is not imported (only its first record is read). */
async function validateOnly(cacheDir: string, spec: FileSpec): Promise<void> {
  const iterator = readCsv(join(cacheDir, `${spec.file}.csv`), spec);
  try {
    await iterator.next(); // header is validated before the first row is yielded
  } finally {
    await iterator.return(undefined);
  }
}

export function snapshotDateFrom(downloadedAt: Date | null): string {
  if (!downloadedAt) {
    throw new SnapshotError("DOWNLOADED_AT.txt missing or malformed: cannot determine snapshot_date");
  }
  return downloadedAt.toISOString().slice(0, 10);
}

export async function buildSnapshot(opts: { cacheDir: string; outPath: string }): Promise<BuildResult> {
  const started = performance.now();
  assertFts5Available();
  await ensureCache(opts.cacheDir);

  const csvNames = readdirSync(opts.cacheDir)
    .filter((f) => f.endsWith(".csv"))
    .map((f) => f.slice(0, -".csv".length));
  assertNoUnknownFiles(
    csvNames,
    FILE_SPECS.map((s) => s.file),
  );

  const downloadedAt = readDownloadedAt(opts.cacheDir);
  const snapshotDate = snapshotDateFrom(downloadedAt);

  mkdirSync(dirname(opts.outPath), { recursive: true });
  const tmpPath = `${opts.outPath}.tmp`;
  rmSync(tmpPath, { force: true });

  const db = new DatabaseSync(tmpPath);
  const tables: Record<string, TableStat> = {};
  const warnings: string[] = [];
  try {
    db.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;");
    db.exec(CREATE_TABLES);

    for (const spec of FILE_SPECS) {
      if (spec.table === null) {
        await validateOnly(opts.cacheDir, spec);
      } else {
        const csvRows = await importTable(db, opts.cacheDir, spec);
        tables[spec.table] = { csvRows, dbRows: -1 };
      }
    }

    db.exec("UPDATE inventories SET is_minifig = 1 WHERE set_num LIKE 'fig-%'");
    db.exec(CREATE_PART_COLORS);
    db.exec(CREATE_INDEXES_AND_FTS);

    // Seam check: every imported table must hold exactly as many rows as its CSV.
    for (const [table, stat] of Object.entries(tables)) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${ident(table)}`).get() as { n: number };
      stat.dbRows = row.n;
      if (stat.dbRows !== stat.csvRows) {
        throw new SnapshotError(`${table}: ${stat.csvRows} CSV rows but ${stat.dbRows} rows in SQLite`);
      }
      const floor = MIN_ROWS[table];
      if (floor !== undefined && stat.csvRows < floor) {
        warnings.push(`${table}: ${stat.csvRows} rows is below the completeness floor of ${floor} (truncated source?)`);
      }
    }

    const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    const meta: [string, string][] = [
      ["schema_version", String(SCHEMA_VERSION)],
      ["snapshot_date", snapshotDate],
      ["snapshot_downloaded_at", downloadedAt?.toISOString() ?? ""],
      ["source", "Rebrickable"],
      ["source_url", SOURCE_URL],
      ["built_at", new Date().toISOString()],
      ["inventory_version_rule", "highest inventories.version per set_num"],
      ["attribution", "Data: Rebrickable (https://rebrickable.com/downloads/). LEGO is a trademark of the LEGO Group."],
    ];
    for (const [table, stat] of Object.entries(tables)) meta.push([`rows.${table}`, String(stat.dbRows)]);
    const partColors = db.prepare("SELECT COUNT(*) AS n FROM part_colors").get() as { n: number };
    meta.push(["rows.part_colors", String(partColors.n)]);
    for (const [key, value] of meta) setMeta.run(key, value);

    db.exec("ANALYZE");
    db.exec("VACUUM");
  } catch (err) {
    db.close();
    rmSync(tmpPath, { force: true });
    throw err;
  }
  db.close();
  rmSync(opts.outPath, { force: true });
  renameSync(tmpPath, opts.outPath);

  return {
    outPath: opts.outPath,
    snapshotDate,
    sizeBytes: statSync(opts.outPath).size,
    buildMs: Math.round(performance.now() - started),
    tables,
    warnings,
  };
}
