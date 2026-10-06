import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gate } from "../src/auth.ts";

// Obviously fake values; the real token never appears in the repo.
const TOKEN = "fake-test-token-0123456789-abcdefghijklmnop";
const url = "https://example.invalid/lego-catalog/mcp";

function req(headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

describe("auth gate", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("fails closed with 503 when the expected token is unset, empty, too short or has whitespace", async () => {
    for (const expected of [undefined, "", "short", `${TOKEN}\n`, ` ${TOKEN}`]) {
      const res = gate(req({ authorization: `Bearer ${TOKEN}` }), expected);
      expect(res?.status).toBe(503);
      expect(await res?.json()).toMatchObject({ error: { code: -32603 } });
    }
    expect(error).toHaveBeenCalled();
  });

  it("401 with WWW-Authenticate when there is no Authorization header", async () => {
    const res = gate(req(), TOKEN);
    expect(res?.status).toBe(401);
    expect(res?.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(await res?.json()).toMatchObject({ error: { code: -32001, message: "Unauthorized" } });
  });

  it("401 for a non-Bearer scheme", () => {
    const res = gate(req({ authorization: `Basic ${TOKEN}` }), TOKEN);
    expect(res?.status).toBe(401);
    expect(res?.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("401 for a wrong token of the same length", () => {
    const wrong = `${TOKEN.slice(0, -1)}X`;
    expect(wrong).toHaveLength(TOKEN.length);
    expect(gate(req({ authorization: `Bearer ${wrong}` }), TOKEN)?.status).toBe(401);
  });

  it("401 for a token of a different length, without throwing", () => {
    expect(gate(req({ authorization: `Bearer ${TOKEN}x` }), TOKEN)?.status).toBe(401);
    expect(gate(req({ authorization: "Bearer a" }), TOKEN)?.status).toBe(401);
    expect(gate(req({ authorization: "Bearer " }), TOKEN)?.status).toBe(401);
  });

  it("accepts the correct token (scheme is case-insensitive)", () => {
    expect(gate(req({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBeNull();
    expect(gate(req({ authorization: `bearer ${TOKEN}` }), TOKEN)).toBeNull();
  });

  it("never logs the header value or the token", () => {
    gate(req({ authorization: `Bearer ${TOKEN}x` }), TOKEN);
    gate(req({ authorization: `Basic ${TOKEN}` }), TOKEN);
    gate(req({ authorization: `Bearer ${TOKEN}` }), "short");
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("Bearer");
  });
});
