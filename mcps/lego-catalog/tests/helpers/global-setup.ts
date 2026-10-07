/**
 * Vitest globalSetup: decides which snapshot the tool/HTTP tests run against and provides it to the workers.
 *
 *  - A real snapshot is found (LEGO_CATALOG_DB, or data/rebrickable.sqlite): use it, kind "real".
 *  - None found (clean clone, CI): build a small fixture snapshot with the REAL builder (scripts/build_snapshot/)
 *    from generated fixture CSVs into a temp dir, kind "fixture". Nothing binary is committed.
 *
 * No network: the fixture cache is complete, so the builder's download step never runs. No child processes.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { buildSnapshot } from "../../scripts/build_snapshot/build.ts";
import { candidateDbPaths } from "../../src/db.ts";
import { serverFixtureRows, writeFixtureCache } from "./fixture-cache.ts";

declare module "vitest" {
  export interface ProvidedContext {
    snapshotPath: string;
    snapshotKind: "real" | "fixture";
  }
}

export default async function setup(project: TestProject): Promise<(() => void) | void> {
  const real = candidateDbPaths().find((p) => existsSync(p));
  if (real) {
    project.provide("snapshotPath", real);
    project.provide("snapshotKind", "real");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "lego-fixture-snapshot-"));
  writeFixtureCache(join(root, "cache"), {}, serverFixtureRows());
  const out = join(root, "fixture.sqlite");
  await buildSnapshot({ cacheDir: join(root, "cache"), outPath: out });
  project.provide("snapshotPath", out);
  project.provide("snapshotKind", "fixture");
  return () => rmSync(root, { recursive: true, force: true });
}
