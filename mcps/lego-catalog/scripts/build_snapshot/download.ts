import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { SnapshotError } from "./csv.ts";
import { DOWNLOAD_BASE_URL, FILE_SPECS } from "./spec.ts";

export const DOWNLOADED_AT_FILE = "DOWNLOADED_AT.txt";
/** Rebrickable allows automated downloads at most once per day; we refuse inside that window. */
export const MIN_DOWNLOAD_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class DownloadRefusedError extends SnapshotError {
  override readonly name = "DownloadRefusedError";
}

/** Parse the `downloaded_utc=<ISO-8601>` line of DOWNLOADED_AT.txt. Returns null if absent/malformed. */
export function parseDownloadedAt(text: string): Date | null {
  const match = /^downloaded_utc=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*$/m.exec(text);
  if (!match?.[1]) return null;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function readDownloadedAt(cacheDir: string): Date | null {
  const path = join(cacheDir, DOWNLOADED_AT_FILE);
  return existsSync(path) ? parseDownloadedAt(readFileSync(path, "utf8")) : null;
}

export function missingCsvFiles(cacheDir: string): string[] {
  return FILE_SPECS.map((s) => s.file).filter((name) => !existsSync(join(cacheDir, `${name}.csv`)));
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Ensure every expected CSV exists in `cacheDir`. If all are present this is a no-op (the normal
 * path). If some are missing it downloads the gzipped
 * files, BUT refuses when DOWNLOADED_AT.txt is under 24 h old (Rebrickable's once-per-day rule).
 */
export async function ensureCache(
  cacheDir: string,
  opts: { now?: Date; fetchImpl?: FetchLike } = {},
): Promise<void> {
  const missing = missingCsvFiles(cacheDir);
  if (missing.length === 0) return;

  const now = opts.now ?? new Date();
  const last = readDownloadedAt(cacheDir);
  if (last && now.getTime() - last.getTime() < MIN_DOWNLOAD_INTERVAL_MS) {
    throw new DownloadRefusedError(
      `Missing ${missing.map((m) => `${m}.csv`).join(", ")} in ${cacheDir}, but ${DOWNLOADED_AT_FILE} says the last ` +
        `download was ${last.toISOString()} (< 24 h ago). Rebrickable allows one automated download per day; ` +
        `restore the files from the earlier download instead.`,
    );
  }

  const fetchImpl = opts.fetchImpl ?? ((url: string) => fetch(url));
  await mkdir(cacheDir, { recursive: true });
  for (const name of missing) {
    const url = `${DOWNLOAD_BASE_URL}/${name}.csv.gz`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new SnapshotError(`Download failed (${res.status}) for ${url}`);
    const csv = gunzipSync(Buffer.from(await res.arrayBuffer()));
    await writeFile(join(cacheDir, `${name}.csv`), csv);
  }
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  await writeFile(join(cacheDir, DOWNLOADED_AT_FILE), `downloaded_utc=${stamp}\n`);
}
