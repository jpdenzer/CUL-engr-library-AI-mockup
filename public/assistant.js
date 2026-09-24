// Engineering Library research assistant widget.
// Self-contained embed: builds its own launcher and chat panel, and opens from
// any element with [data-open-assistant] (or [data-ask="question"]).
// Talks to this site's server, which runs Claude against the CUL catalog MCP server.

const SUGGESTIONS = [
  "Find a recent textbook on finite element analysis I can read online",
  "Is Fluid Mechanics by Frank White available, and where?",
  "What's on the shelf near call number TA357?",
  "Theses on battery thermal management",
];
const CARDS_SHOWN = 4;

let mode = "ai"; // "ai" = Claude + MCP tools, "catalog" = keyword search fallback (no API key)
let busy = false;
let conversationId = loadConversationId();

// ── DOM helpers ────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}
const ICONS = {
  chat: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm3 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm5 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm5 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/></svg>',
  reset: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="m6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4Z"/></svg>',
  send: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 20.5 21 12 3 3.5v6.6L15 12 3 13.9Z"/></svg>',
};

// ── Build the widget ───────────────────────────────────────────────────
const launcher = el("button", {
  class: "cula-launcher", type: "button", "aria-controls": "cula-assistant", "aria-expanded": "false", html: ICONS.chat,
}, el("span", {}, "AI Research Assistant"));

const modeBadge = el("span", { class: "cula-badge" }, "Connecting…");
const log = el("div", { class: "cula-log", "aria-live": "polite" });
const input = el("textarea", {
  id: "cula-input", rows: "1", maxlength: "2000", placeholder: "Ask about books, availability, databases…",
});
const sendBtn = el("button", { type: "submit", class: "cula-send", "aria-label": "Send", html: ICONS.send });
const clearBtn = el("button", {
  type: "button", class: "cula-clear", title: "Clear this conversation and start over", html: ICONS.reset, onclick: clearConversation,
}, el("span", {}, "Clear"));
const form = el("form", { class: "cula-composer" },
  el("label", { class: "cula-sr-only", for: "cula-input" }, "Message"), input, sendBtn);

const panel = el("section", { class: "cula-assistant", id: "cula-assistant", "aria-label": "AI research assistant", hidden: true },
  el("header", { class: "cula-header" },
    el("div", {},
      el("h2", { class: "cula-title" }, "AI Research Assistant"),
      el("p", { class: "cula-sub" }, modeBadge, " Searches the Cornell University Library catalog")),
    el("div", { class: "cula-actions" },
      clearBtn,
      el("button", { type: "button", title: "Close", "aria-label": "Close assistant", html: ICONS.close, onclick: closeAssistant }))),
  log,
  form,
  el("p", {
    class: "cula-disclaimer",
    html: 'AI answers can be wrong. Confirm details in the <a href="https://catalog.library.cornell.edu/" target="_blank" rel="noopener">catalog</a>, or <a href="https://www.library.cornell.edu/ask" target="_blank" rel="noopener">ask a librarian</a>.',
  }));

document.body.append(launcher, panel);

// ── Storage (best effort) ──────────────────────────────────────────────
function loadConversationId() {
  try {
    const id = sessionStorage.getItem("cul-assistant-conversation");
    if (id) return id;
  } catch {}
  return newConversationId();
}
function newConversationId() {
  const id = crypto.randomUUID();
  try { sessionStorage.setItem("cul-assistant-conversation", id); } catch {}
  return id;
}

// ── Open / close ───────────────────────────────────────────────────────
function openAssistant(prefill) {
  panel.hidden = false;
  launcher.setAttribute("aria-expanded", "true");
  if (!log.childElementCount) renderWelcome();
  if (prefill) send(prefill);
  else input.focus();
}
function closeAssistant() {
  panel.hidden = true;
  launcher.setAttribute("aria-expanded", "false");
  launcher.focus();
}
function clearConversation() {
  if (busy) return;
  // Drop the server-side history too, then start fresh.
  fetch("/api/chat/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId }),
  }).catch(() => {});
  conversationId = newConversationId();
  log.replaceChildren();
  input.value = "";
  autosize();
  renderWelcome();
  input.focus();
}
launcher.addEventListener("click", () => openAssistant());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !panel.hidden) closeAssistant();
});
document.addEventListener("click", (e) => {
  const trigger = e.target.closest("[data-open-assistant], [data-ask]");
  if (!trigger) return;
  e.preventDefault();
  openAssistant(trigger.dataset.ask);
});

// ── Composer ───────────────────────────────────────────────────────────
form.addEventListener("submit", (e) => {
  e.preventDefault();
  send(input.value);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(input.value);
  }
});
input.addEventListener("input", autosize);
function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}
function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  clearBtn.disabled = value;
  log.setAttribute("aria-busy", String(value));
}

// ── Status ─────────────────────────────────────────────────────────────
fetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    mode = s.llm ? "ai" : "catalog";
    modeBadge.textContent = s.llm ? "AI · Claude" : "Catalog search";
    modeBadge.title = s.llm ? `Model: ${s.model}` : "No API key configured: keyword catalog search";
  })
  .catch(() => { modeBadge.textContent = "Offline"; });

// ── Rendering ──────────────────────────────────────────────────────────
function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
}

function renderWelcome() {
  const bot = addBotMessage();
  bot.bubble.innerHTML = renderMarkdown(
    "Hi! I can search the **Cornell University Library catalog** for engineering books, e-books, theses, and journals, and check whether they're on the shelf or online.\n\nWhat are you looking for?",
  );
  bot.root.append(
    el("div", { class: "cula-suggestions" },
      SUGGESTIONS.map((s) => el("button", { type: "button", onclick: () => send(s) }, s))),
  );
}

function addUserMessage(text) {
  log.append(el("div", { class: "cula-msg cula-msg--user" }, text));
  scrollToEnd();
}

function addBotMessage() {
  const steps = el("ul", { class: "cula-steps", hidden: true });
  const bubble = el("div", { class: "cula-bubble" });
  const cards = el("div", { class: "cula-cards", hidden: true });
  const root = el("div", { class: "cula-msg cula-msg--bot" }, steps, bubble, cards);
  log.append(root);
  scrollToEnd();
  return { root, steps, bubble, cards, cardMap: new Map() };
}

const STEP_LABELS = {
  search: (i) => `Searching the catalog for “${i.query || "…"}”`,
  advanced_search: () => "Running an advanced catalog search",
  check_availability: (i) => `Checking availability of ${(i.ids || []).length || ""} item${(i.ids || []).length === 1 ? "" : "s"}`,
  get_record: () => "Reading a catalog record",
  fetch: () => "Reading a catalog record",
  browse_call_numbers: (i) => `Browsing the shelf near ${i.call_number || "a call number"}`,
  describe_search_options: () => "Checking the catalog's search options",
  facet_values: (i) => `Looking up ${i.field || "facet"} values`,
  keyword_search: () => "Searching the catalog",
};
function addStep(bot, id, name, inputArgs) {
  const label = (STEP_LABELS[name] || (() => `Using ${name}`))(inputArgs || {});
  bot.steps.hidden = false;
  bot.steps.append(el("li", { "data-step": id, "data-state": "running" }, el("span", { class: "cula-step-icon", "aria-hidden": "true" }), label));
  scrollToEnd();
}
function finishStep(bot, id, ok) {
  const li = bot.steps.querySelector(`[data-step="${CSS.escape(id)}"]`);
  if (li) li.dataset.state = ok ? "done" : "error";
}

// Merge cards by record id; availability data replaces plain search data.
function addCards(bot, cards) {
  for (const c of cards) {
    const prev = bot.cardMap.get(c.id);
    if (!prev || c.kind === "availability") bot.cardMap.set(c.id, { ...prev, ...c });
  }
  drawCards(bot);
}
function drawCards(bot, showAll = false) {
  const all = [...bot.cardMap.values()];
  // Items whose availability was checked are what the answer is about; list them first.
  all.sort((a, b) => (b.kind === "availability") - (a.kind === "availability"));
  const shown = showAll ? all : all.slice(0, CARDS_SHOWN);
  bot.cards.hidden = all.length === 0;
  bot.cards.replaceChildren(...shown.map(renderCard));
  if (all.length > shown.length) {
    bot.cards.append(el("button", { type: "button", class: "cula-more", onclick: () => drawCards(bot, true) },
      `Show ${all.length - shown.length} more result${all.length - shown.length === 1 ? "" : "s"}`));
  }
}
function renderCard(c) {
  const meta = [c.author, c.format, c.year].filter(Boolean).join(" · ");
  const card = el("article", { class: "cula-card" },
    el("a", { class: "cula-card__title", href: c.url, target: "_blank", rel: "noopener" }, c.title || "Untitled"),
    meta && el("div", { class: "cula-card__meta" }, meta));
  if (c.kind !== "availability") return card;

  card.dataset.avail = c.availableNow ? "yes" : "no";
  const status = el("div", { class: "cula-card__status" });
  if (c.online) status.append(el("span", { class: "cula-pill cula-pill--ok" }, "Online"));
  const shelf = (c.copies || []).filter((cp) => cp.available > 0);
  if (shelf.length) status.append(el("span", { class: "cula-pill cula-pill--ok" }, "On shelf"));
  else if ((c.copies || []).length) status.append(el("span", { class: "cula-pill cula-pill--warn" }, "All copies out"));
  (c.onlineLinks || []).slice(0, 1).forEach((l) =>
    status.append(el("a", { href: l.url, target: "_blank", rel: "noopener" }, "Access online →")));
  card.append(status);
  if ((c.copies || []).length) {
    card.append(el("ul", { class: "cula-card__copies" },
      c.copies.slice(0, 3).map((cp) => el("li", {},
        `${cp.library}: `, el("code", {}, cp.callNumber || "—"), ` · ${cp.available ?? 0}/${cp.total ?? 0} available`))));
  }
  return card;
}

// Minimal, safe markdown: escapes HTML first, then allows links, emphasis, code, lists, headings.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
}
function renderMarkdown(md) {
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
      closeList();
      out.push(`<h3>${inline(m[1])}</h3>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}

// ── Sending ────────────────────────────────────────────────────────────
async function send(text) {
  text = (text || "").trim();
  if (!text || busy) return;
  input.value = "";
  autosize();
  addUserMessage(text);
  setBusy(true);
  const bot = addBotMessage();
  try {
    if (mode === "ai") await sendToAssistant(text, bot);
    else await sendToCatalog(text, bot);
  } catch (err) {
    bot.bubble.classList.add("is-error");
    bot.bubble.textContent = err.message || "Something went wrong. Please try again.";
  } finally {
    bot.bubble.classList.remove("cula-cursor");
    setBusy(false);
    scrollToEnd();
    input.focus();
  }
}

async function sendToAssistant(text, bot) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, message: text }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `The assistant is unavailable (HTTP ${res.status}).`);
  }

  let answer = "";
  let usedToolSinceText = false;
  bot.bubble.classList.add("cula-cursor");
  const handlers = {
    text: ({ delta }) => {
      // Text written before and after a tool call belongs in separate paragraphs.
      if (usedToolSinceText && answer.trim()) answer += "\n\n";
      usedToolSinceText = false;
      answer += delta;
      bot.bubble.innerHTML = renderMarkdown(answer);
      bot.bubble.classList.add("cula-cursor");
    },
    tool: ({ id, name, input: args }) => {
      usedToolSinceText = true;
      addStep(bot, id, name, args);
    },
    tool_result: ({ id, ok, cards }) => {
      finishStep(bot, id, ok);
      if (cards?.length) addCards(bot, cards);
    },
    error: ({ message }) => { throw new Error(message); },
    done: () => {},
  };

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = frame.match(/^event: (.*)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (event && data && handlers[event]) handlers[event](JSON.parse(data));
    }
    scrollToEnd();
  }
  if (!answer.trim()) bot.bubble.innerHTML = renderMarkdown("_No answer was returned. Try rephrasing your question._");
}

async function sendToCatalog(text, bot) {
  addStep(bot, "s1", "keyword_search", {});
  const res = await fetch("/api/catalog-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: text }),
  });
  const body = await res.json().catch(() => ({}));
  finishStep(bot, "s1", res.ok);
  if (!res.ok) throw new Error(body.error || "Catalog search failed.");
  bot.bubble.innerHTML = renderMarkdown(
    body.cards.length
      ? `Searched the catalog for ${body.searched}: **${body.total.toLocaleString()}** results. Top matches with current availability are below.\n\n_AI answers are off (no Anthropic API key), so this is a keyword search._`
      : "No catalog results matched. Try different keywords, or email [engrref@cornell.edu](mailto:engrref@cornell.edu).",
  );
  addCards(bot, body.cards);
}
