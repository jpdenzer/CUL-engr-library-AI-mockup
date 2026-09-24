// Snapshot the live Engineering Library homepage into public/ so the mockup
// looks identical to the real site, then add the AI assistant entry points.
//
//   npm run snapshot
//
// Loads the page in headless Chromium, saves every stylesheet, font, and
// image it uses into public/site-assets/, strips the site's scripts
// (analytics, WordPress, chat loader), and writes public/index.html.

import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://engineering.library.cornell.edu/";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const ASSET_DIR = "site-assets";
const EXT_BY_TYPE = [
  ["css", ".css"], ["woff2", ".woff2"], ["woff", ".woff"], ["opentype", ".otf"], ["otf", ".otf"],
  ["ttf", ".ttf"], ["svg", ".svg"], ["png", ".png"], ["jpeg", ".jpg"], ["webp", ".webp"], ["gif", ".gif"],
];

// The "Still not finding it?" box, placed under the search in the red header panel.
const CALLOUT_HTML = `
<div class="cula-callout" role="region" aria-label="AI research assistant">
  <p class="cula-callout__title">Still not finding what you’re looking for?</p>
  <p class="cula-callout__text">Try our AI research assistant. Describe your topic in your own words, and it will search the catalog, check what’s on the shelf or online, and suggest databases to try.</p>
  <button type="button" class="cula-callout__button" data-open-assistant><i class="far fa-comment-alt" aria-hidden="true"></i> Try the AI assistant</button>
</div>`;

function assetName(url, contentType) {
  const u = new URL(url);
  let ext = path.extname(u.pathname).toLowerCase();
  if (!/^\.[a-z0-9]{2,5}$/.test(ext)) ext = (EXT_BY_TYPE.find(([k]) => contentType.includes(k)) || [, ".bin"])[1];
  const base = path.basename(u.pathname, path.extname(u.pathname)).replace(/[^\w.-]/g, "_").slice(0, 40) || "asset";
  return `${base}-${crypto.createHash("sha1").update(url).digest("hex").slice(0, 8)}${ext}`;
}

/** Rewrite url(...) and @import references in CSS to local asset names. */
function rewriteCss(css, baseUrl, names, prefix) {
  const local = (ref) => {
    if (/^(data:|#)/.test(ref)) return null;
    try {
      const abs = new URL(ref, baseUrl).href;
      return names.has(abs) ? prefix + names.get(abs) : abs;
    } catch {
      return null;
    }
  };
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => {
      const to = local(ref);
      return to ? `url("${to}")` : m;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, ref) => {
      const to = local(ref);
      return to ? `@import "${to}"` : m;
    });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const captured = new Map(); // url -> { body, contentType, type }
page.on("response", async (res) => {
  const type = res.request().resourceType();
  if (!["stylesheet", "font", "image"].includes(type) || res.status() !== 200) return;
  try {
    captured.set(res.url(), { body: await res.body(), contentType: res.headers()["content-type"] || "", type });
  } catch {
    // Response body unavailable (redirect or aborted request).
  }
});

console.log(`Loading ${SITE} …`);
await page.goto(SITE, { waitUntil: "networkidle", timeout: 90_000 });
// Scroll through the page so lazy-loaded images are fetched too.
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 400) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 100));
  }
  window.scrollTo(0, 0);
});
await page.waitForLoadState("networkidle");

const names = new Map([...captured].map(([url, a]) => [url, assetName(url, a.contentType)]));

// Save assets, rewriting references inside stylesheets.
const assetPath = path.join(PUBLIC, ASSET_DIR);
fs.rmSync(assetPath, { recursive: true, force: true });
fs.mkdirSync(assetPath, { recursive: true });
for (const [url, asset] of captured) {
  let body = asset.body;
  if (asset.type === "stylesheet") body = rewriteCss(body.toString("utf8"), url, names, "");
  fs.writeFileSync(path.join(assetPath, names.get(url)), body);
}

// Rewrite the live DOM, then serialize it.
const html = await page.evaluate(
  ({ names, assetDir, site, callout }) => {
    const map = new Map(names);
    const local = (ref) => {
      try {
        const abs = new URL(ref, document.baseURI).href;
        return map.has(abs) ? `${assetDir}/${map.get(abs)}` : null;
      } catch {
        return null;
      }
    };
    const cssRewrite = (css) =>
      css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => {
        const to = /^data:/.test(ref) ? null : local(ref);
        return to ? `url("${to}")` : m;
      });

    // Scripts, script preloads, and resource hints would load the live site's code.
    document.querySelectorAll("script, noscript, iframe").forEach((el) => el.remove());
    document.querySelectorAll("link").forEach((link) => {
      const rel = (link.getAttribute("rel") || "").toLowerCase();
      if (rel.includes("stylesheet")) {
        const to = local(link.href);
        if (to) link.setAttribute("href", to);
        link.removeAttribute("integrity");
        link.removeAttribute("crossorigin");
      } else if (!rel.includes("icon")) {
        link.remove();
      }
    });
    document.querySelectorAll("style").forEach((s) => (s.textContent = cssRewrite(s.textContent)));
    document.querySelectorAll("[style]").forEach((el) => el.setAttribute("style", cssRewrite(el.getAttribute("style"))));
    document.querySelectorAll("img").forEach((img) => {
      const to = local(img.currentSrc || img.getAttribute("src") || "");
      if (to) img.setAttribute("src", to);
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
      img.removeAttribute("loading");
    });
    // Links and form actions keep pointing at the real site (except the homepage itself).
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (href === "/" || href === site) a.setAttribute("href", "/");
      else if (href.startsWith("/") && !href.startsWith("//")) a.setAttribute("href", new URL(href, site).href);
    });

    // The live-chat tab can't run without its loader; send it to Ask a Librarian instead.
    document.querySelectorAll("[id^=lcs_slide_out_button]").forEach((a) => {
      a.setAttribute("href", "https://www.library.cornell.edu/ask");
      a.setAttribute("target", "_blank");
    });

    // AI assistant entry point under the homepage search.
    document.querySelector("form.home-search")?.insertAdjacentHTML("afterend", callout);

    document.head.insertAdjacentHTML(
      "beforeend",
      '\n<link rel="stylesheet" href="assistant.css">\n<meta name="robots" content="noindex">\n',
    );
    document.body.insertAdjacentHTML(
      "beforeend",
      '\n<div class="cula-mockup-badge" role="note">Design mockup · not the official site</div>' +
        '\n<script src="site.js" defer></script>\n<script src="assistant.js" type="module"></script>\n',
    );
    return "<!DOCTYPE html>\n" + document.documentElement.outerHTML;
  },
  { names: [...names], assetDir: ASSET_DIR, site: SITE, callout: CALLOUT_HTML },
);

fs.writeFileSync(path.join(PUBLIC, "index.html"), html);
await browser.close();
const total = [...captured.values()].reduce((n, a) => n + a.body.length, 0);
console.log(`Wrote public/index.html and ${captured.size} assets (${(total / 1e6).toFixed(1)} MB) to public/${ASSET_DIR}/`);
