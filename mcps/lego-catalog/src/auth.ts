/**
 * Bearer-token gate for the Vercel adapter (api/lego-catalog/mcp.ts). The endpoint is private: every
 * request must carry `Authorization: Bearer <MCP_AUTH_TOKEN>`.
 *
 * - Fail closed: an unset, too-short or whitespace-containing expected token answers 503 to everyone, never "open".
 * - Constant time: both sides are hashed with SHA-256 first, so the compared buffers are always 32 bytes
 *   (timingSafeEqual throws on a length mismatch, and hashing hides the token length).
 * - Never logs header values; only a coarse rejection reason.
 *
 * `handleMcpRequest` and the local dev server stay authless on purpose: the dev server binds 127.0.0.1
 * and the gate lives only on the deployed adapter (docs/ARCHITECT_REVIEW.md, addendum 2026-10-06).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { rpcError } from "./http.js";

/** Shorter tokens are treated as a misconfiguration (generated tokens are 43 chars). */
export const MIN_TOKEN_LENGTH = 32;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function unauthorized(reason: "missing" | "scheme" | "mismatch"): Response {
  console.warn("auth: rejected", { reason });
  const response = rpcError(401, -32001, "Unauthorized");
  response.headers.set("WWW-Authenticate", 'Bearer realm="lego-catalog"');
  return response;
}

/** Returns null when the request may proceed, otherwise the Response to send back. */
export function gate(request: Request, expected: string | undefined): Response | null {
  // Whitespace (e.g. a trailing newline pasted into the dashboard) could never match the \S+ capture
  // below, so it would lock everyone out with a misleading 401; treat it as misconfiguration instead.
  if (!expected || expected.length < MIN_TOKEN_LENGTH || /\s/.test(expected)) {
    console.error("auth: MCP_AUTH_TOKEN is unset, too short or contains whitespace; refusing all requests");
    return rpcError(503, -32603, "Service unavailable: server not configured.");
  }
  const header = request.headers.get("authorization");
  if (!header) return unauthorized("missing");
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  if (!match) return unauthorized("scheme");
  const presented = match[1] as string;
  return timingSafeEqual(sha256(presented), sha256(expected)) ? null : unauthorized("mismatch");
}
