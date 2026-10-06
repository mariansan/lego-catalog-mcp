import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/** A read-only handle on the snapshot plus the facts every response needs. */
export interface Catalog {
  db: DatabaseSync;
  snapshotDate: string;
  path: string;
}

type Param = string | number;

/** All SQL in this package is static text with `?` placeholders; user input only ever travels as `params`. */
export function all<T>(db: DatabaseSync, sql: string, ...params: Param[]): T[] {
  // The row shape is fixed by the DDL in scripts/build_snapshot/ddl.ts (the only writer of this file).
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function first<T>(db: DatabaseSync, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

/**
 * Where to look for the snapshot, in order: LEGO_CATALOG_DB, cwd-relative (what Vercel documents for
 * files bundled with a function: process.cwd()), then relative to this module (local dev / tests).
 * In a deployment the file is bundled with the function (see docs/SELF_HOSTING.md).
 */
export function candidateDbPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths: string[] = [];
  if (env.LEGO_CATALOG_DB) paths.push(resolve(env.LEGO_CATALOG_DB));
  paths.push(resolve(process.cwd(), "mcps/lego-catalog/data/rebrickable.sqlite"));
  paths.push(fileURLToPath(new URL("../data/rebrickable.sqlite", import.meta.url)));
  return paths;
}

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = candidateDbPaths(env);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`SQLite snapshot not found. Looked in: ${candidates.join(", ")}`);
  return found;
}

export function openCatalog(path: string): Catalog {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = first<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", "snapshot_date");
  if (!row) throw new Error(`Snapshot ${path} has no meta.snapshot_date; rebuild it with build:snapshot`);
  return { db, snapshotDate: row.value, path };
}

let cached: Catalog | undefined;

/** Opened once per function instance (module scope survives warm invocations on Fluid compute). */
export function getCatalog(): Catalog {
  cached ??= openCatalog(resolveDbPath());
  return cached;
}
