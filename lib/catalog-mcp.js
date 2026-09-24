// Thin wrapper around the Cornell University Library catalog MCP server.
//
// The server rejects browser requests (it validates the Origin header), so all
// MCP traffic goes through this Node process rather than the front end.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const CATALOG_MCP_URL =
  process.env.CATALOG_MCP_URL || "https://catalog-int.library.cornell.edu/mcp";

let clientPromise = null;
let toolsPromise = null;

async function connect() {
  const client = new Client({ name: "cul-engr-library-mockup", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(CATALOG_MCP_URL));
  client.onclose = () => {
    clientPromise = null;
  };
  await client.connect(transport);
  return client;
}

function getClient() {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** Server-provided usage notes (returned from `initialize`). */
export async function getServerInstructions() {
  const client = await getClient();
  return client.getInstructions() || "";
}

/** The catalog's tools, converted to Claude tool definitions. Cached. */
export function getClaudeTools() {
  if (!toolsPromise) {
    toolsPromise = (async () => {
      const client = await getClient();
      const { tools } = await client.listTools();
      return tools.map((t) => {
        const { $schema, ...inputSchema } = t.inputSchema;
        return { name: t.name, description: t.description || "", input_schema: inputSchema };
      });
    })().catch((err) => {
      toolsPromise = null;
      throw err;
    });
  }
  return toolsPromise;
}

/**
 * Call a catalog tool. Returns { text, data, isError } where `data` is the
 * parsed JSON payload when the tool returned JSON text.
 */
export async function callCatalogTool(name, args) {
  let result;
  try {
    const client = await getClient();
    result = await client.callTool({ name, arguments: args });
  } catch (err) {
    // A dropped session is the usual cause; reconnect once and retry.
    clientPromise = null;
    const client = await getClient();
    result = await client.callTool({ name, arguments: args });
  }
  const text = (result.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  let data = result.structuredContent ?? null;
  if (!data) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { text, data, isError: Boolean(result.isError) };
}
