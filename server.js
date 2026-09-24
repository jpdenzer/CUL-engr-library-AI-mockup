import "./lib/env.js";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG_MCP_URL, callCatalogTool } from "./lib/catalog-mcp.js";
import { assistantInfo, clearConversation, llmAvailable, runAssistantTurn, toCards } from "./lib/assistant.js";
import { keywordCatalogSearch } from "./lib/keyword-search.js";

const PORT = Number(process.env.PORT) || 8000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MAX_MESSAGE_CHARS = 2000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error("Request too large");
  }
  return JSON.parse(raw || "{}");
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

// POST /api/chat — streams one assistant turn as server-sent events.
async function handleChat(req, res) {
  const { conversationId, message } = await readJson(req);
  if (typeof conversationId !== "string" || !conversationId || typeof message !== "string" || !message.trim()) {
    return sendJson(res, 400, { error: "conversationId and message are required" });
  }
  if (!llmAvailable()) return sendJson(res, 503, { error: "AI assistant is not configured" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    await runAssistantTurn(conversationId, message.slice(0, MAX_MESSAGE_CHARS), emit);
  } catch (err) {
    console.error("[chat]", err);
    emit("error", { message: "The assistant ran into a problem. Please try again." });
  }
  res.end();
}

// POST /api/catalog-search — direct catalog lookup, used when no API key is set.
async function handleCatalogSearch(req, res) {
  const { query } = await readJson(req);
  if (typeof query !== "string" || !query.trim()) return sendJson(res, 400, { error: "query is required" });
  let found;
  try {
    found = await keywordCatalogSearch(query.slice(0, 300));
  } catch (err) {
    return sendJson(res, 502, { error: err.message });
  }
  let cards = found.documents ? toCards("search", found.documents) : [];
  if (found.ids.length) {
    const avail = await callCatalogTool("check_availability", { ids: found.ids.slice(0, 10) });
    if (!avail.isError) cards = toCards("check_availability", avail.data);
  }
  sendJson(res, 200, { total: found.total, searched: found.searched, cards });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://x");
    if (req.method === "GET" && pathname === "/api/status") {
      return sendJson(res, 200, { llm: llmAvailable(), ...assistantInfo(), catalogMcp: CATALOG_MCP_URL });
    }
    if (req.method === "POST" && pathname === "/api/chat") return await handleChat(req, res);
    if (req.method === "POST" && pathname === "/api/chat/clear") {
      const { conversationId } = await readJson(req);
      if (typeof conversationId === "string") clearConversation(conversationId);
      return sendJson(res, 200, { cleared: true });
    }
    if (req.method === "POST" && pathname === "/api/catalog-search") return await handleCatalogSearch(req, res);
    if (req.method === "GET") return await serveStatic(req, res);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) sendJson(res, 500, { error: "Server error" });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Engineering Library mockup: http://localhost:${PORT}`);
  console.log(`Catalog MCP server:         ${CATALOG_MCP_URL}`);
  console.log(
    llmAvailable()
      ? `AI assistant:               ${assistantInfo().model} (effort ${assistantInfo().effort})`
      : "AI assistant:               OFF (set ANTHROPIC_API_KEY) — chat falls back to catalog search",
  );
});
