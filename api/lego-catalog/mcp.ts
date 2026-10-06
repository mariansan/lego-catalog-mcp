/**
 * Thin Vercel adapter (hosting Option A: one project, one function per MCP). All logic lives in
 * mcps/lego-catalog/src. The public URL /lego-catalog/mcp is rewritten to this function by vercel.json.
 * Web Standard `fetch` export on the Node.js runtime (vercel.com/docs/functions/runtimes/node-js).
 */
import { handleMcpRequest } from "../../mcps/lego-catalog/src/http.js";

export default {
  fetch(request: Request): Promise<Response> {
    return handleMcpRequest(request);
  },
};
