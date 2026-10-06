/** SEC-L3: a missing snapshot must yield a clean JSON-RPC error, never absolute paths. */
import { describe, expect, it, vi } from "vitest";

const SECRET_PATH = "C:\\secret-host\\deploy\\rebrickable.sqlite";

vi.mock("../src/db.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db.ts")>()),
  getCatalog: () => {
    throw new Error(`SQLite snapshot not found. Looked in: ${SECRET_PATH}`);
  },
}));

const { handleMcpRequest } = await import("../src/http.ts");

describe("missing snapshot", () => {
  it("returns 503 JSON-RPC -32603 with no paths and logs the detail server-side", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handleMcpRequest(
      new Request("http://localhost/lego-catalog/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ jsonrpc: "2.0", error: { code: -32603 }, id: null });
    expect(text).not.toMatch(/secret-host|sqlite|snapshot not found|Looked in|:\\/i);
    const loggedError = logged.mock.calls[0]?.[1] as Error;
    expect(loggedError.message).toContain("secret-host"); // detail is kept for operators
    logged.mockRestore();
  });
});
