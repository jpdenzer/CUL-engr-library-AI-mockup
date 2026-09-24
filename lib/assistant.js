// Claude-powered library assistant: a streaming tool-use loop whose tools are
// the catalog MCP server's tools, executed by this server.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { callCatalogTool, getClaudeTools, getServerInstructions } from "./catalog-mcp.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const EFFORT = process.env.CLAUDE_EFFORT || "medium";
// Server-side refusal fallbacks (beta). Set CLAUDE_FALLBACKS=off to disable.
const FALLBACKS = process.env.CLAUDE_FALLBACKS !== "off";
const MAX_TOOL_ROUNDS = 8;
const MAX_CONVERSATIONS = 500;

let client = null;

/** True when Anthropic credentials are configured (API key, token, or `ant auth login` profile). */
export function llmAvailable() {
  if (client) return true;
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const hasCredentials =
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.ANTHROPIC_PROFILE ||
    process.env.ANTHROPIC_FEDERATION_RULE_ID ||
    fs.existsSync(path.join(configDir, "anthropic"));
  if (!hasCredentials) return false;
  client = new Anthropic();
  return true;
}

const SYSTEM_PROMPT = `You are the virtual research assistant on the Cornell University Engineering Library website. You help students, faculty, and staff find books, e-books, journals, theses, standards, and other materials in the Cornell University Library catalog, using the catalog tools you have been given.

About the Engineering Library:
- Located in Carpenter Hall, Ithaca, NY 14853. Open 24 hours to the Cornell community (full hours on the library website).
- Reference help: engrref@cornell.edu. The nearest book drop is outside Sage Hall.
- Most of the engineering print collection has moved to other locations, especially the Library Annex (items are requested for delivery), Uris Library, Olin Library, and the Mathematics Library. The catalog has no "Engineering Library" location value, so do not filter on one. Much of the collection is online (e-books, e-journals, standards).
- Key databases: IEEE Xplore, AccessEngineering, ASTM Standards, Knovel Handbooks & Materials Data, Web of Science, Engineering Village (Compendex/Inspec). Recommend these for journal-article and standards searching, which the catalog covers only at the title level.

How to help:
- Search the catalog before recommending specific items, and never invent titles, call numbers, or availability. When you name an item, link its title to the "url" from the tool result.
- When someone asks whether they can get something, or before you say an item is on the shelf, call check_availability. Report online access, the holding library, the call number, and how many copies are available.
- Prefer recent editions and engineering-relevant results. Narrow noisy searches with filters (use describe_search_options or facet_values to get exact facet spellings) or advanced_search, instead of listing everything.
- Keep answers short and scannable: a sentence or two of framing, then a short list of the best 3-6 matches. The page shows result cards for the items you looked up, so don't repeat every field.
- For in-depth research help, systematic reviews, or anything the catalog can't answer (accounts, fines, room bookings, policies you are unsure of), point the person to engrref@cornell.edu or the Ask a Librarian service rather than guessing.
- Stay on library and research topics.`;

// In-memory conversation store: id -> Anthropic message history (append-only).
const conversations = new Map();

function getHistory(conversationId) {
  if (!conversations.has(conversationId)) {
    if (conversations.size >= MAX_CONVERSATIONS) {
      conversations.delete(conversations.keys().next().value);
    }
    conversations.set(conversationId, []);
  }
  return conversations.get(conversationId);
}

let systemBlocksPromise = null;
function getSystemBlocks() {
  if (!systemBlocksPromise) {
    systemBlocksPromise = getServerInstructions()
      .catch(() => "")
      .then((instructions) => [
        {
          type: "text",
          text: instructions
            ? `${SYSTEM_PROMPT}\n\nNotes from the catalog service on using its tools:\n${instructions}`
            : SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ]);
  }
  return systemBlocksPromise;
}

/** Reduce a tool result to what the UI needs to draw result cards. */
export function toCards(toolName, data) {
  if (!data || typeof data !== "object") return [];
  if ((toolName === "search" || toolName === "advanced_search") && Array.isArray(data.documents)) {
    return data.documents.map((d) => ({
      kind: "record",
      id: d.id,
      title: d.title,
      author: d.author,
      format: d.format,
      year: d.publication_year,
      url: d.url,
    }));
  }
  if (toolName === "check_availability" && Array.isArray(data.records)) {
    return data.records.map((r) => ({
      kind: "availability",
      id: r.id,
      title: r.title,
      author: r.author,
      format: r.format,
      year: r.publication_year,
      url: r.url,
      online: r.online,
      onlineLinks: (r.online_access || []).slice(0, 2).map((l) => ({ url: l.url, label: l.description })),
      availableNow: r.available_now,
      summary: r.summary,
      copies: (r.copies || []).map((c) => ({
        library: c.location || c.library,
        callNumber: c.call_number,
        available: c.available_items,
        total: c.total_items,
        status: c.status,
      })),
    }));
  }
  return [];
}

/**
 * Run one user turn. `emit(event, payload)` receives:
 *   text {delta} · tool {id, name, input} · tool_result {id, name, ok, cards}
 *   done {stopReason} · error {message}
 */
export async function runAssistantTurn(conversationId, userText, emit) {
  if (!llmAvailable()) throw new Error("No Anthropic credentials configured.");
  const history = getHistory(conversationId);
  const [tools, system] = await Promise.all([getClaudeTools(), getSystemBlocks()]);

  // Work on a copy so a failed turn leaves the stored history untouched.
  const messages = [...history, { role: "user", content: userText }];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const params = {
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      system,
      tools,
      messages,
    };
    if (FALLBACKS) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    const stream = client.beta.messages.stream(params);
    stream.on("text", (delta) => emit("text", { delta }));
    const response = await stream.finalMessage();

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;

    if (response.stop_reason === "refusal") {
      // Not saved to history, so the next question starts clean.
      emit("text", {
        delta:
          "\n\nI can't help with that one. For research questions, the Engineering Library reference team is at engrref@cornell.edu.",
      });
      emit("done", { stopReason: "refusal" });
      return;
    }

    if (response.stop_reason !== "tool_use") {
      if (response.stop_reason === "max_tokens") emit("text", { delta: "\n\n_(Response truncated.)_" });
      history.splice(0, history.length, ...messages);
      emit("done", { stopReason: response.stop_reason });
      return;
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const results = await Promise.all(
      toolUses.map(async (tu) => {
        emit("tool", { id: tu.id, name: tu.name, input: tu.input });
        try {
          const { text, data, isError } = await callCatalogTool(tu.name, tu.input);
          emit("tool_result", { id: tu.id, name: tu.name, ok: !isError, cards: isError ? [] : toCards(tu.name, data) });
          return { type: "tool_result", tool_use_id: tu.id, content: text || "(no content)", is_error: isError };
        } catch (err) {
          emit("tool_result", { id: tu.id, name: tu.name, ok: false, cards: [] });
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Catalog service error: ${err.message}`,
            is_error: true,
          };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }

  // Tool-round limit reached: close the turn with an assistant message so the
  // stored transcript still alternates correctly.
  const note = "I ran out of search steps on that one. Try narrowing the question.";
  emit("text", { delta: `\n\n${note}` });
  messages.push({ role: "assistant", content: note });
  history.splice(0, history.length, ...messages);
  emit("done", { stopReason: "tool_limit" });
}

/** Forget a conversation's history. */
export function clearConversation(conversationId) {
  conversations.delete(conversationId);
}

export function assistantInfo() {
  return { model: MODEL, effort: EFFORT };
}
