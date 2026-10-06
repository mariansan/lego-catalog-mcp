import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import type { Catalog } from "./db.js";
import { fail } from "./results.js";
import { TOOLS } from "./tools.js";

const INSTRUCTIONS =
  "Read-only LEGO catalog (Rebrickable data). Verify part numbers, colors and set inventories with these tools " +
  "instead of guessing. Every result carries `source` and `snapshot_date`. Data: Rebrickable (https://rebrickable.com/downloads/); " +
  "LEGO is a trademark of the LEGO Group, which is not affiliated with this server.";

/**
 * Builds a fresh MCP server. Cheap: it only registers two handlers. The expensive part (the open
 * SQLite handle) lives in `catalog` and is shared. Called once per HTTP request (stateless transport).
 *
 * Uses the SDK's low-level Server instead of McpServer.registerTool on purpose: McpServer validates
 * input itself and reports failures as bare text, so invalid input would not carry the
 * {source, snapshot_date} envelope that every response must have.
 */
export function createLegoServer(catalog: Catalog): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { ...t.inputSchema, type: "object" as const },
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      // The name is attacker-controlled: bound what we reflect so it cannot inflate the response.
      const shown = request.params.name.length > 64 ? `${request.params.name.slice(0, 64)}...` : request.params.name;
      return fail(catalog.snapshotDate, "unknown_tool", `Unknown tool "${shown}".`);
    }
    try {
      return tool.run(catalog, request.params.arguments);
    } catch (error) {
      console.error(`tool ${tool.name} failed`, error); // details stay in server logs, never in the response
      return fail(catalog.snapshotDate, "internal_error", "Internal error while reading the catalog.");
    }
  });

  return server;
}
