// Behaviour of the real site's theme scripts (culu/js/navigation.js and
// culu/js/search.js), rewritten without jQuery for the static snapshot.

(function () {
  const SITE = "https://engineering.library.cornell.edu/";
  const CATALOG = "https://catalog.library.cornell.edu/search";

  // ── Main navigation: mobile toggle and keyboard/touch access to submenus ──
  const container = document.getElementById("site-navigation");
  const button = container?.querySelector("button");
  const menu = container?.querySelector("ul");
  if (container && button && menu) {
    if (!menu.classList.contains("nav-menu")) menu.classList.add("nav-menu");
    button.addEventListener("click", () => {
      const open = container.classList.toggle("toggled");
      button.setAttribute("aria-expanded", String(open));
    });

    const toggleFocus = (e) => {
      let el = e.target;
      while (el && !el.classList.contains("nav-menu")) {
        if (el.tagName === "LI") el.classList.toggle("focus");
        el = el.parentElement;
      }
    };
    menu.querySelectorAll("a").forEach((a) => {
      a.addEventListener("focus", toggleFocus, true);
      a.addEventListener("blur", toggleFocus, true);
    });

    if ("ontouchstart" in window) {
      container.querySelectorAll(".menu-item-has-children > a").forEach((a) =>
        a.addEventListener("touchstart", (e) => {
          const item = a.parentNode;
          if (!item.classList.contains("focus")) {
            e.preventDefault();
            [...item.parentNode.children].forEach((sib) => sib !== item && sib.classList.remove("focus"));
            item.classList.add("focus");
          } else {
            item.classList.remove("focus");
          }
        }),
      );
    }
  }

  // ── Search overlay from the magnifier icon ──
  const overlay = document.querySelector("form.user-tool-search");
  document.querySelector(".icon-search")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (overlay) overlay.style.display = "grid";
    overlay?.querySelector("input[type=text]")?.focus();
  });
  document.querySelector(".btn-close-search")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (overlay) overlay.style.display = "none";
  });

  // ── Search forms: "Library Resources" goes to the catalog, "This site" to the site search ──
  function wireSearch(form, radioName) {
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = form.querySelector("input[type=text]")?.value.trim() || "";
      const scope = form.querySelector(`input[name="${radioName}"]:checked`)?.value;
      window.location.href =
        scope === "site" ? `${SITE}?s=${encodeURIComponent(q)}` : `${CATALOG}?q=${encodeURIComponent(q)}`;
    });
  }
  wireSearch(overlay, "search-type");
  wireSearch(document.querySelector("form.home-search"), "search-type-home");
})();
