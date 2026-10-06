import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import type { ColumnSpec, FileSpec } from "./spec.ts";

export class SnapshotError extends Error {
  override readonly name: string = "SnapshotError";
}

export type SqlValue = string | number | null;

/** Fail loudly unless the CSV header is exactly the expected columns, in the expected order. */
export function validateHeader(spec: FileSpec, header: readonly string[]): void {
  const expected = spec.columns.map((col) => col.name);
  const same = header.length === expected.length && header.every((name, i) => name === expected[i]);
  if (!same) {
    throw new SnapshotError(
      `${spec.file}.csv: header mismatch.\n  expected: ${expected.join(",")}\n  actual:   ${header.join(",")}`,
    );
  }
}

/** Fail loudly on any *.csv in the cache directory that is not one of the 12 known files. */
export function assertNoUnknownFiles(present: readonly string[], known: readonly string[]): void {
  const unknown = present.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new SnapshotError(`Unknown CSV file(s) in cache dir: ${unknown.map((n) => `${n}.csv`).join(", ")}`);
  }
}

const INTEGER = /^-?\d+$/;

function toInt(raw: string, where: string): number {
  const n = Number(raw);
  if (!INTEGER.test(raw) || !Number.isSafeInteger(n)) {
    throw new SnapshotError(`${where}: expected integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Convert one raw CSV cell. Booleans are the literal strings "True" / "False" (Rebrickable). */
export function convertValue(col: ColumnSpec, raw: string, where: string): SqlValue {
  switch (col.kind) {
    case "text":
      return raw;
    case "textnull":
      return raw === "" ? null : raw;
    case "int":
      return toInt(raw, `${where}.${col.name}`);
    case "intnull":
      return raw === "" ? null : toInt(raw, `${where}.${col.name}`);
    case "bool":
      if (raw === "True") return 1;
      if (raw === "False") return 0;
      throw new SnapshotError(`${where}.${col.name}: expected "True"/"False", got ${JSON.stringify(raw)}`);
    case "drop":
      throw new SnapshotError(`${where}.${col.name}: dropped columns must not be converted`);
  }
}

/** Convert a raw record to the SQL parameters of its stored (non-dropped) columns. */
export function convertRow(spec: FileSpec, record: readonly string[], line: number): SqlValue[] {
  const where = `${spec.file}.csv:${line}`;
  if (record.length !== spec.columns.length) {
    throw new SnapshotError(`${where}: expected ${spec.columns.length} fields, got ${record.length}`);
  }
  const out: SqlValue[] = [];
  spec.columns.forEach((col, i) => {
    if (col.kind !== "drop") out.push(convertValue(col, record[i] ?? "", where));
  });
  return out;
}

/**
 * Stream a CSV: validates the header first, then yields converted rows (img_url etc. dropped).
 * Strict parsing: malformed quoting or ragged rows throw.
 */
export async function* readCsv(path: string, spec: FileSpec): AsyncGenerator<SqlValue[]> {
  const parser = createReadStream(path).pipe(parse({ bom: true, columns: false, skip_empty_lines: false }));
  let line = 0;
  for await (const record of parser as AsyncIterable<string[]>) {
    line += 1;
    if (line === 1) {
      validateHeader(spec, record);
      continue;
    }
    yield convertRow(spec, record, line);
  }
  if (line === 0) throw new SnapshotError(`${spec.file}.csv: empty file (no header)`);
}
