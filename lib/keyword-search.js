// Catalog search without an LLM: turns a plain-language question into catalog
// tool arguments. Used only when no Anthropic key is configured. The catalog
// ANDs every keyword, so a full sentence ("Find a recent textbook on ...")
// matches nothing unless the filler words are removed.

import { callCatalogTool } from "./catalog-mcp.js";

const THIS_YEAR = new Date().getFullYear();
const RECENT_YEARS = 6;

const STOPWORDS = new Set(
  `a about after all also an and any anything are around as at available availability be book books by can
   copy copies could do does e e-book e-books ebook ebooks find for from get good have help how i i'm im in intro introduction
   introductory is it its it's latest library look looking me more most my need new newer on or out please print
   published read recent recently recommend recommended show since some something study the there these this
   to textbook textbooks theses thesis dissertation dissertations what what's whats where which who with would
   you your journal journals video videos online electronic shelf any-one`.split(/\s+/),
);

/** Parse a question into { query, args, notes } for the catalog `search` tool. */
export function parseQuestion(question) {
  let text = question.toLowerCase();
  const args = {};
  const notes = [];

  // Access: online vs. physical copies.
  if (/\b(e-?books?|online|electronic|read (it )?online|full[- ]text)\b/.test(text)) {
    args.filters = { Access: ["Online"] };
    notes.push("online only");
  } else if (/\b(on the shelf|in print|print cop(y|ies)|physical)\b/.test(text)) {
    args.filters = { Access: ["At the Library"] };
    notes.push("physical copies");
  }

  // Format.
  if (/\b(theses|thesis|dissertations?)\b/.test(text)) args.formats = ["Thesis"];
  else if (/\bvideos?\b/.test(text)) args.formats = ["Video"];
  else if (/\bjournals?\b/.test(text)) args.formats = ["Journal/Periodical"];
  if (args.formats) notes.push(args.formats[0].toLowerCase());

  // Publication years.
  const since = text.match(/\b(?:since|after|from)\s+((?:19|20)\d\d)\b/);
  const between = text.match(/\b((?:19|20)\d\d)\s*(?:-|–|to)\s*((?:19|20)\d\d)\b/);
  if (between) {
    args.date_range = { begin: Number(between[1]), end: Number(between[2]) };
  } else if (since) {
    args.date_range = { begin: Number(since[1]), end: THIS_YEAR };
  } else if (/\b(recent|recently|latest|newest|new)\b/.test(text)) {
    args.date_range = { begin: THIS_YEAR - RECENT_YEARS, end: THIS_YEAR };
  }
  if (args.date_range) notes.push(`${args.date_range.begin}–${args.date_range.end}`);
  text = text.replace(/\b(19|20)\d\d\b/g, " ");

  const keywords = text
    .replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w && !STOPWORDS.has(w));

  return { query: keywords.join(" "), keywords, args, notes };
}

/** Match "call number TA357" / "near QA76.73 .P98" style requests. */
function parseCallNumber(question) {
  const m = question.match(/\bcall\s*(?:number|no\.?|#)\s*:?\s*([A-Z]{1,3}\s?\d+(?:\.\d+)?(?:\s*\.[A-Z]\d+)?)/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Run a best-effort catalog lookup. Returns { total, ids, searched } where
 * `searched` describes what was actually sent, for display.
 */
export async function keywordCatalogSearch(question) {
  const callNumber = parseCallNumber(question);
  if (callNumber) {
    const browse = await callCatalogTool("browse_call_numbers", { call_number: callNumber, limit: 8 });
    if (browse.isError || !browse.data) throw new Error(browse.text || "Shelf browse failed");
    const ids = (browse.data.entries || []).map((e) => e.id).filter(Boolean);
    return { total: ids.length, ids, searched: `the shelf starting at call number ${callNumber}` };
  }

  const { query, keywords, args, notes } = parseQuestion(question);
  // Relax step by step until something matches: all filters, no filters, fewer keywords.
  const attempts = [{ query, args, notes }];
  if (Object.keys(args).length) attempts.push({ query, args: {}, notes: [] });
  if (keywords.length > 3) attempts.push({ query: keywords.slice(0, 3).join(" "), args: {}, notes: [] });

  let last = null;
  for (const attempt of attempts) {
    if (!attempt.query && !Object.keys(attempt.args).length) continue;
    const result = await callCatalogTool("search", { query: attempt.query, per_page: 6, ...attempt.args });
    if (result.isError || !result.data) throw new Error(result.text || "Catalog search failed");
    last = { result: result.data, attempt };
    if (result.data.total > 0) break;
  }
  if (!last) return { total: 0, ids: [], searched: "" };

  const { result, attempt } = last;
  const label = `“${attempt.query}”${attempt.notes.length ? ` (${attempt.notes.join(", ")})` : ""}`;
  return { total: result.total, ids: (result.documents || []).map((d) => d.id), searched: label, documents: result };
}
