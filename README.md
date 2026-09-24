# Engineering Library AI assistant — working mockup

A pixel-faithful copy of the [Cornell Engineering Library homepage](https://engineering.library.cornell.edu/) with a research-assistant chatbot added. The chatbot answers questions with Claude, using the [Cornell University Library catalog MCP server](https://catalog-int.library.cornell.edu/mcp) as its tools.

## Run it

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY
npm start                 # http://localhost:8000
```

Without an API key, the site still runs: the chat widget falls back to a direct catalog search with live availability (badge reads **Catalog search** instead of **AI · Claude**).

## How it works

```
Browser (public/)            Node server (server.js)                    External
─────────────────            ───────────────────────                    ────────
chat widget ──POST /api/chat──▶ lib/assistant.js ──Messages API──────────▶ Claude
   ▲                             │   tool-use loop (streaming)
   └──── SSE: text, tool, ───────┤
         tool_result, done       └─▶ lib/catalog-mcp.js ──MCP (HTTP)──▶ catalog-int.library.cornell.edu/mcp
```

- **Why a server-side proxy:** the catalog MCP server rejects browser requests (`Forbidden: Invalid Origin header`), and the Anthropic key must stay off the client. The Node server holds both connections.
- **Tools:** the server discovers the MCP server's tools at startup (`search`, `advanced_search`, `check_availability`, `get_record`, `fetch`, `browse_call_numbers`, `facet_values`, `describe_search_options`) and passes them to Claude unchanged. The system prompt adds the server's own usage instructions.
- **Streaming UI:** the browser receives Claude's text as it streams, a status line for each catalog call ("Searching the catalog for …", "Checking availability of 3 items"), and result cards built from the tool results. The cards show on-shelf or online status, the holding library, and the call number.
- **Conversation memory:** kept in server memory per browser tab (`sessionStorage` id), so follow-ups like "is the second one available?" work. It resets when the server restarts. The ↻ button starts a new conversation.

## The page

`public/index.html` is a snapshot of the live homepage: the rendered HTML plus its stylesheets, fonts, and images, saved locally in `public/site-assets/`. The site's own scripts (analytics, WordPress, and the LibChat loader) are removed. `public/site.js` restores the dropdown menus and search forms without jQuery. The "Chat with Us" tab links to Ask a Librarian.

Two things are added on top:
- A **"Still not finding what you're looking for?"** box under the search in the red header, which opens the assistant
- A floating **AI Research Assistant** button and chat panel (`public/assistant.js` + `assistant.css`), a self-contained embed. Any element with `data-open-assistant` or `data-ask="question"` opens it.

To re-sync with the live site, run `npm run snapshot`. It overwrites `public/index.html` and `public/site-assets/`. The callout box is defined in `tools/snapshot-site.mjs`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Required for AI mode |
| `CLAUDE_MODEL` | `claude-opus-5` | e.g. `claude-sonnet-5` for lower cost |
| `CLAUDE_EFFORT` | `medium` | `low` is faster and cheaper for simple lookups |
| `CLAUDE_FALLBACKS` | on | Server-side refusal fallback (beta). Set `off` to disable |
| `CATALOG_MCP_URL` | `https://catalog-int.library.cornell.edu/mcp` | |
| `PORT` | `8000` | |

## Files

- `server.js`: static files plus `/api/status`, `/api/chat` (SSE), and `/api/catalog-search` (no-key fallback)
- `lib/assistant.js`: system prompt, Claude tool-use loop, and conversion of tool results into cards
- `lib/catalog-mcp.js`: MCP client (official `@modelcontextprotocol/sdk`, Streamable HTTP)
- `lib/keyword-search.js`: no-key fallback that turns a question into catalog keywords and filters
- `public/index.html` + `public/site-assets/`: generated snapshot of the live homepage
- `public/site.js`: the site's menu and search behaviour
- `public/assistant.js`, `public/assistant.css`: the chat widget
- `tools/snapshot-site.mjs`: regenerates the snapshot (`npm run snapshot`, uses Playwright)

## Before production

This is a mockup. A real deployment needs:
- Rate limiting and abuse protection on `/api/chat`, since every message costs API usage.
- A persistent conversation store instead of process memory.
- The production catalog MCP endpoint, where this uses `catalog-int`.
- Accessibility review of the widget (screen-reader announcements for streaming text).
- Usage analytics and a feedback control (thumbs up/down) for tuning the prompt.
