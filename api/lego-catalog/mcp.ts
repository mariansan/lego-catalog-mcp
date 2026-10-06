/**
 * Thin Vercel adapter (hosting Option A: one project, one function per MCP). All logic lives in
 * mcps/lego-catalog/src. The public URL /lego-catalog/mcp is rewritten to this function by vercel.json.
 * Web Standard `fetch` export on the Node.js runtime (vercel.com/docs/functions/runtimes/node-js).
 *
 * The endpoint is private: the bearer gate runs FIRST, before the 405/413/400 guards in
 * handleMcpRequest, so a caller without the token learns nothing about the server. It fails closed
 * (503) when MCP_AUTH_TOKEN is unset. Both URL paths reach this one function, so both are gated.
 */
import { gate } from "../../mcps/lego-catalog/src/auth.js";
import { handleMcpRequest } from "../../mcps/lego-catalog/src/http.js";

export default {
  fetch(request: Request): Promise<Response> {
    const denied = gate(request, process.env.MCP_AUTH_TOKEN);
    return denied ? Promise.resolve(denied) : handleMcpRequest(request);
  },
};
