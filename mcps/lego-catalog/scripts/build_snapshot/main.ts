import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildSnapshot } from "./build.ts";

const { values } = parseArgs({
  options: {
    "cache-dir": { type: "string" },
    out: { type: "string" },
  },
});

const PKG = resolve(import.meta.dirname, "../..");
const cacheDir = resolve(values["cache-dir"] ?? process.env.REBRICKABLE_CACHE_DIR ?? resolve(PKG, ".cache/rebrickable"));
const outPath = resolve(values.out ?? resolve(PKG, "data/rebrickable.sqlite"));

console.log(`cache dir: ${cacheDir}`);
console.log(`output:    ${outPath}`);

try {
  const result = await buildSnapshot({ cacheDir, outPath });
  for (const [table, stat] of Object.entries(result.tables)) {
    console.log(`  ${table.padEnd(16)} csv=${stat.csvRows} sqlite=${stat.dbRows}`);
  }
  for (const w of result.warnings) console.warn(`WARNING: ${w}`);
  console.log(`snapshot_date: ${result.snapshotDate}`);
  console.log(`size:  ${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`build: ${(result.buildMs / 1000).toFixed(1)} s`);
} catch (err) {
  console.error(`BUILD FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
