#!/usr/bin/env node
/**
 * Sanity gate for the Rebrickable SQLite snapshot. Run it between `build:snapshot` and the
 * deploy:   node scripts/check-snapshot.mjs [path-to-sqlite]
 * Path resolution: argv[2], then $LEGO_CATALOG_DB, then mcps/lego-catalog/data/rebrickable.sqlite.
 * Exit 0 = snapshot looks sane; exit 1 = do not deploy it.
 *
 * The row floors live in mcps/lego-catalog/scripts/build_snapshot/floors.json, the single
 * definition of "complete" shared with the snapshot builder and the tests. They are ~75-80% of
 * the 2026-10-05 row counts: they catch a truncated or empty download, not normal catalog
 * growth. Raise them deliberately if the catalog ever shrinks.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIN_ROWS = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../mcps/lego-catalog/scripts/build_snapshot/floors.json"), "utf8"),
);
const MAX_AGE_DAYS = 2;

const path = resolve(process.argv[2] ?? process.env.LEGO_CATALOG_DB ?? "mcps/lego-catalog/data/rebrickable.sqlite");
const failures = [];
const fail = (msg) => failures.push(msg);

if (!existsSync(path)) {
  console.error(`FAIL: snapshot not found at ${path}`);
  process.exit(1);
}

const db = new DatabaseSync(path, { readOnly: true });
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const metaRows = db.prepare("SELECT key, value FROM meta").all();
const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));

for (const [table, min] of Object.entries(MIN_ROWS)) {
  const n = count(table);
  console.log(`  ${table.padEnd(16)} ${String(n).padStart(9)} (min ${min})`);
  if (n < min) fail(`${table} has ${n} rows, expected at least ${min}`);
  const recorded = Number(meta[`rows.${table}`]);
  if (recorded !== n) fail(`meta rows.${table}=${meta[`rows.${table}`]} but table has ${n}`);
}

const date = meta.snapshot_date;
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
  fail(`meta.snapshot_date missing or malformed: ${JSON.stringify(date)}`);
} else {
  const ageDays = (Date.now() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000;
  console.log(`  snapshot_date    ${date} (${ageDays.toFixed(1)} days old, max ${MAX_AGE_DAYS})`);
  if (ageDays > MAX_AGE_DAYS) fail(`snapshot_date ${date} is older than ${MAX_AGE_DAYS} days`);
}

// The seam the MCP tools actually depend on: FTS5 works and finds the well-known part.
const hit = db
  .prepare("SELECT part_num, name FROM parts_fts WHERE parts_fts MATCH ? ORDER BY rank LIMIT 20")
  .all('"brick" "2" "x" "4"');
if (!hit.some((r) => r.part_num === "3001")) fail('FTS5 query "brick 2 x 4" did not return part 3001');
const part = db.prepare("SELECT name FROM parts WHERE part_num = ?").get("3001");
if (part?.name !== "Brick 2 x 4") fail(`parts.3001 name is ${JSON.stringify(part?.name)}, expected "Brick 2 x 4"`);
const inv = db.prepare("SELECT COUNT(*) AS n FROM inventories WHERE set_num = ?").get("75192-1");
if (inv.n < 1) fail("set 75192-1 has no inventory row");

const quick = db.prepare("PRAGMA quick_check").get();
if (quick.quick_check !== "ok") fail(`PRAGMA quick_check returned ${JSON.stringify(quick.quick_check)}`);

db.close();
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("snapshot OK");
