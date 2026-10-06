import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LIMITS, SOURCE } from "./config.js";

export type ErrorCode = "not_found" | "invalid_input" | "unknown_tool" | "response_too_large" | "internal_error";

function build(snapshotDate: string, body: Record<string, unknown>, isError: boolean): CallToolResult {
  const structuredContent = { source: SOURCE, snapshot_date: snapshotDate, ...body };
  const result: CallToolResult = {
    // The MCP spec recommends mirroring structuredContent as serialized JSON in a text block.
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
  if (isError) result.isError = true;
  return result;
}

export function fail(snapshotDate: string, code: ErrorCode, message: string, hint?: string): CallToolResult {
  return build(snapshotDate, { error: { code, message, ...(hint ? { hint } : {}) } }, true);
}

/** Success envelope; refuses (as a structured error) to emit an oversized payload. */
export function ok(snapshotDate: string, data: Record<string, unknown>): CallToolResult {
  const result = build(snapshotDate, data, false);
  const size = JSON.stringify(result.structuredContent).length;
  if (size > LIMITS.payloadHardMaxChars) {
    return fail(snapshotDate, "response_too_large", `Result would be ${size} characters; narrow the request.`);
  }
  return result;
}

/**
 * Shapes one page of rows. `rows` is what SQLite returned for the requested limit; if the serialized
 * payload exceeds the budget we drop trailing rows and say so (`size_capped`), and `next_offset`
 * then points at the first row that was left out, so no data is skipped.
 */
export function paged<T>(
  rows: T[],
  total: number,
  offset: number,
  requestedLimit: number,
  build: (rows: T[]) => Record<string, unknown>,
): Record<string, unknown> {
  const make = (count: number): Record<string, unknown> => {
    const slice = rows.slice(0, count);
    const end = offset + slice.length;
    const hasMore = end < total;
    return {
      ...build(slice),
      total,
      offset,
      limit: requestedLimit,
      returned: slice.length,
      has_more: hasMore,
      next_offset: hasMore ? end : null,
      size_capped: count < rows.length,
    };
  };
  let count = rows.length;
  let data = make(count);
  while (count > 1 && JSON.stringify(data).length > LIMITS.payloadBudgetChars) {
    count = Math.max(1, count - Math.max(1, Math.floor(count * 0.1)));
    data = make(count);
  }
  return data;
}
