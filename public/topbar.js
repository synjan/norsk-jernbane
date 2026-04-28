// Felles topbar-funksjoner: aktiv-side-markering + bane-velger-dropdown.
// Topbar-HTML-en ligger i hver enkelt side så vi slipper en build-step
// for komponentinkludering. Denne fila fyller bare inn dynamikken.

(function () {
  "use strict";

  function setActivePage() {
    // Finn nav-lenke som matcher gjeldende side; sett aria-current.
    const path = location.pathname.split("/").pop() || "index.html";
    document.querySelectorAll(".topnav a[data-page]").forEach((a) => {
      if (a.dataset.page === path) {
        a.setAttribute("aria-current", "page");
      } else {
        a.removeAttribute("aria-current");
      }
    });
  }

  async function loadRouteIndex() {
    try {
      const stats = await fetch("data/stats.json").then((r) => r.json());
      return stats.routes || [];
    } catch (e) {
      console.warn("[topbar] kunne ikke laste rute-index:", e);
      return [];
    }
  }

  function renderRouteList(panel, routes, query) {
    const list = panel.querySelector(".bane-list");
    list.replaceChildren();
    const q = (query || "").toLowerCase().trim();
    const filtered = q
      ? routes.filter((r) => r.name.toLowerCase().includes(q))
      : routes;
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bane-empty";
      empty.textContent = "Ingen treff";
      list.append(empty);
      return;
    }
    for (const r of filtered.slice(0, 50)) {
      const a = document.createElement("a");
      a.href = `bane.html?navn=${encodeURIComponent(r.name)}`;
      a.className = "bane-row";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = r.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      const km = `${r.total_km.toFixed(0)} km`;
      const speed = r.max_speed_kmh ? ` · ${r.max_speed_kmh} km/t` : "";
      meta.textContent = `${km}${speed}`;
      a.append(name, meta);
      list.append(a);
    }
  }

  function setupBaneDropdown() {
    const trigger = document.querySelector(".nav-baner-toggle");
    const panel = document.querySelector(".bane-dropdown");
    if (!trigger || !panel) return;

    let routes = null;

    function open() {
      panel.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      const search = panel.querySelector(".bane-search");
      if (search) {
        search.value = "";
        search.focus();
      }
      if (routes) renderRouteList(panel, routes, "");
    }
    function close() {
      panel.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
    }

    trigger.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (panel.classList.contains("open")) {
        close();
      } else {
        open();
        if (!routes) {
          routes = await loadRouteIndex();
          renderRouteList(panel, routes, "");
        }
      }
    });

    document.addEventListener("click", (e) => {
      if (!panel.contains(e.target) && e.target !== trigger) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panel.classList.contains("open")) close();
    });

    const search = panel.querySelector(".bane-search");
    if (search) {
      search.addEventListener("input", () => {
        if (routes) renderRouteList(panel, routes, search.value);
      });
    }

    // Tastaturnavigasjon: pil opp/ned flytter fokus mellom rader.
    // Enter på en fokusert <a class="bane-row"> følger lenken naturlig.
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const rows = Array.from(panel.querySelectorAll(".bane-row"));
      if (rows.length === 0) return;
      const active = document.activeElement;
      const idx = rows.indexOf(active);
      let next;
      if (e.key === "ArrowDown") {
        next = idx === -1 ? 0 : (idx + 1) % rows.length;
      } else {
        if (idx <= 0) {
          // Pil opp fra første rad (eller fra søkefelt) → tilbake til søk.
          if (search && active !== search) { e.preventDefault(); search.focus(); }
          return;
        }
        next = idx - 1;
      }
      e.preventDefault();
      rows[next].focus();
    });
  }

  function setupMobileNav() {
    const topbar = document.querySelector(".topbar");
    const topnav = document.querySelector(".topbar .topnav");
    if (!topbar || !topnav) return;

    // Sett inn hamburger-knapp før topnav. CSS skjuler den på desktop.
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "topnav-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Meny");
    toggle.textContent = "☰";
    topnav.parentNode.insertBefore(toggle, topnav);

    function close() {
      topnav.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
    function open() {
      topnav.classList.add("open");
      toggle.setAttribute("aria-expanded", "true");
    }

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      topnav.classList.contains("open") ? close() : open();
    });
    document.addEventListener("click", (e) => {
      if (!topnav.classList.contains("open")) return;
      if (e.target === toggle || topnav.contains(e.target)) return;
      close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && topnav.classList.contains("open")) close();
    });
  }

  function init() {
    setActivePage();
    setupMobileNav();
    setupBaneDropdown();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
