// Dashbord — leser stats.json og rendrer en flat oversikt over hele
// datasettet (uten filter, uten interaktivt kart). Lenker til bane.html
// for hver topp-rute.

(function () {
  "use strict";

  // Felles helpers fra helpers.js + chart-wrappers fra charts.js
  // (begge lastes før denne).
  const { fmtNum, fmtDate, infoTip } = window.AppHelpers;
  const { doughnut, bar } = window.AppCharts;

  // Forklaringer for tekniske OSM-termer som dukker opp på dashbordet.
  // Brukes som tooltips (?-knapp) ved siden av kort-titler/notater.
  const TIPS = {
    passenger_lines: "OSM-tag som indikerer antall passasjerspor på en strekning. '1' = enkeltspor, '2' = dobbeltspor. Mangler på ~13% av nettet.",
    service_siding: "OSM service-tagger (siding/yard/spur/crossover) markerer side- og rangeringsspor. Vi ekskluderer disse fra hastighet- og kapasitets-statistikk.",
    operator: "OSM operator-tag for hvem som driver strekningen. Bane NOR eier mest. «Ukjent» = ingen operator-tag i OSM.",
    co2_estimate: "Bevisst grovt anslag for godstog-CO₂ på ikke-elektrifiserte strekninger. Bygger på 10 tog/døgn × 250 t × 0.05 kg CO₂/GTK. Faktisk variasjon stor — bruk det som størrelsesorden, ikke målverdi.",
  };

  function renderHero(stats) {
    document.getElementById("hero-km").textContent = fmtNum(stats.total_km);
    document.getElementById("hero-elec").textContent =
      `${stats.electrified_pct.toLocaleString("nb-NO", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    const within2 = stats.population_coverage?.bands_pct?.["≤2 km"];
    document.getElementById("hero-coverage").textContent =
      within2 != null ? `${within2}%` : "—";
    document.getElementById("hero-stations").textContent = fmtNum(stats.station_count);
    document.getElementById("hero-routes").textContent = (stats.routes?.length || 0).toString();
  }

  // Lead-paragraf som leser hovedtallene høyt. Tre setninger: nasjonalt
  // omfang + elektrifisering, stasjons-dekning, og 2-3 navngitte byer
  // uten togtilbud. Tallene hentes fra eksisterende stats-felt — ingen
  // nye aggregeringer.
  function bold(text) {
    const b = document.createElement("strong");
    b.textContent = text;
    return b;
  }

  // Bygger en kort frase som setter Norges km i kontekst med naboland.
  // F.eks. "omtrent som Sveits, en tredjedel av Sverige".
  function compareNarrative(norwayKm) {
    const benchmarks = window.AppHelpers.BENCHMARKS.countries_km;
    const swiss = benchmarks["Sveits"];
    const sweden = benchmarks["Sverige"];
    const fragments = [];
    if (swiss && Math.abs(norwayKm - swiss) / swiss < 0.15) {
      fragments.push(`omtrent som Sveits`);
    }
    if (sweden) {
      const ratio = norwayKm / sweden;
      if (ratio < 0.45) fragments.push(`en tredjedel av Sverige`);
      else if (ratio < 0.7) fragments.push(`under halvparten av Sverige`);
    }
    if (fragments.length === 0) return null;
    return fragments.join(", ") + " —";
  }

  function renderNarrative(stats) {
    const el = document.getElementById("dash-narrative");
    if (!el) return;
    el.replaceChildren();

    const elecPct = Math.round(stats.electrified_pct);
    const totalKm = fmtNum(stats.total_km);
    const pc = stats.population_coverage;

    const p1 = document.createElement("p");
    p1.className = "dash-lead";
    p1.append(
      document.createTextNode("Norge har "),
      bold(`${totalKm} km jernbane`),
      document.createTextNode(" — "),
    );
    // Inline sammenligning: «omtrent som Sveits, en tredjedel av Sverige»
    const compare = compareNarrative(stats.total_km);
    if (compare) p1.append(document.createTextNode(compare + " "));
    p1.append(
      bold(`${elecPct}%`),
      document.createTextNode(" er elektrifisert."),
    );
    if (pc?.bands_pct) {
      const within2 = pc.bands_pct["≤2 km"];
      const beyond25 = pc.bands_pct[">25 km"];
      const beyond25Pop = pc.bands_population?.[">25 km"] ?? 0;
      p1.append(
        document.createTextNode(" "),
        bold(`${within2}%`),
        document.createTextNode(" av befolkningen bor innen 2 km fra en stasjon — men "),
        bold(`${beyond25}% (~${fmtNum(beyond25Pop / 1000)}k mennesker)`),
        document.createTextNode(" bor mer enn 25 km unna."),
      );
    }
    el.append(p1);

    const cities = pc?.largest_unserved?.slice(0, 3) ?? [];
    if (cities.length >= 2) {
      const p2 = document.createElement("p");
      p2.className = "dash-lead-sub";
      p2.append(document.createTextNode("Blant byene uten togtilbud: "));
      cities.forEach((c, i) => {
        if (i > 0) p2.append(document.createTextNode(i === cities.length - 1 ? " og " : ", "));
        const span = document.createElement("span");
        span.className = "dash-lead-city";
        span.append(
          bold(c.name),
          document.createTextNode(` (${fmtNum(c.population / 1000)}k, ${c.distance_km} km til nærmeste stasjon)`),
        );
        p2.append(span);
      });
      p2.append(document.createTextNode("."));
      el.append(p2);
    }
  }

  function renderElectrification(stats) {
    doughnut("dash-chart-electrification", {
      labels: ["Elektrifisert", "Ikke elektrifisert"],
      data: [stats.electrified_km, stats.total_km - stats.electrified_km],
      colors: ["#2563eb", "#d23f3f"],
      ariaTitle: "Elektrifiseringsfordeling",
    });

    // Voltage list
    const list = document.getElementById("dash-voltage-list");
    list.replaceChildren();
    const rows = Object.entries(stats.voltage_breakdown_km || {}).slice(0, 3);
    for (const [label, km] of rows) {
      const li = document.createElement("li");
      const n = document.createElement("span");
      n.textContent = label;
      const v = document.createElement("span");
      v.className = "km";
      v.textContent = `${fmtNum(km)} km`;
      li.append(n, v);
      list.append(li);
    }
  }

  // Operatør-fordeling. Ligner sammenligningskortet visuelt, men data
  // kommer fra stats.operator_breakdown_km (allerede sortert desc).
  // Bane NOR dominerer (~81%) — det er en konsentrasjons-historie.
  function renderOperators(stats) {
    const note = document.getElementById("dash-operators-note");
    if (note) {
      note.replaceChildren();
      note.append(
        document.createTextNode("«Ukjent» = OSM-segmenter uten operator-tag. "),
        infoTip(TIPS.operator),
      );
    }
    const el = document.getElementById("dash-operators");
    if (!el) return;
    el.replaceChildren();

    const all = Object.entries(stats.operator_breakdown_km || {});
    if (all.length === 0) return;

    // Vis topp 5 + slå sammen resten som "Andre". Beholder rekkefølge.
    const top = all.slice(0, 5);
    const rest = all.slice(5);
    const restKm = rest.reduce((s, [, v]) => s + v, 0);
    const entries = top.slice();
    if (restKm > 0) entries.push([`Andre (${rest.length})`, restKm]);

    const max = Math.max(...entries.map(([, v]) => v));
    const list = document.createElement("div");
    list.className = "compare-list";
    for (const [name, km] of entries) {
      const row = document.createElement("div");
      row.className = "compare-row" + (name === "Bane NOR" ? " is-norway" : "");
      const label = document.createElement("span");
      label.className = "compare-label";
      label.textContent = name;
      const barWrap = document.createElement("span");
      barWrap.className = "compare-bar-wrap";
      const bar = document.createElement("span");
      bar.className = "compare-bar";
      bar.style.width = `${(km / max) * 100}%`;
      barWrap.append(bar);
      const val = document.createElement("span");
      val.className = "compare-val";
      val.textContent = `${fmtNum(km)} km`;
      row.append(label, barWrap, val);
      list.append(row);
    }
    el.append(list);
  }

  // Sammenligningskort — Norge vs naboland som horisontal bar. Norge
  // fremheves med kontrastfarge så brukeren ser sin posisjon umiddelbart.
  function renderComparison(stats) {
    const el = document.getElementById("dash-comparison");
    if (!el) return;
    el.replaceChildren();

    const benchmarks = window.AppHelpers.BENCHMARKS.countries_km;
    const entries = Object.entries(benchmarks).map(([country, km]) => [
      country,
      country === "Norge" ? stats.total_km : km,
    ]);
    entries.sort((a, b) => b[1] - a[1]);

    const max = Math.max(...entries.map(([, v]) => v));
    const list = document.createElement("div");
    list.className = "compare-list";
    for (const [country, km] of entries) {
      const row = document.createElement("div");
      row.className = "compare-row" + (country === "Norge" ? " is-norway" : "");
      const label = document.createElement("span");
      label.className = "compare-label";
      label.textContent = country;
      const barWrap = document.createElement("span");
      barWrap.className = "compare-bar-wrap";
      const bar = document.createElement("span");
      bar.className = "compare-bar";
      bar.style.width = `${(km / max) * 100}%`;
      barWrap.append(bar);
      const val = document.createElement("span");
      val.className = "compare-val";
      val.textContent = `${fmtNum(km)} km`;
      row.append(label, barWrap, val);
      list.append(row);
    }
    el.append(list);
  }

  // Honest acknowledgment of OSM-tagging-hull. Bygger 4 prosentmål fra
  // stats.routes (ingen ny pipeline). Tonen skal være «vi vet ikke alt»,
  // ikke unnskyldning — gir brukeren grunnlag for å vurdere de andre tallene.
  function renderDataQuality(stats) {
    const el = document.getElementById("dash-quality");
    if (!el) return;
    el.replaceChildren();

    const routes = stats.routes || [];
    const total = routes.length;
    if (total === 0) return;

    const withMaxSpeed = routes.filter((r) => r.max_speed_kmh != null).length;
    const withOperator = routes.filter((r) => r.operators?.length > 0).length;
    const withTrackCoverage = routes.filter(
      (r) => (r.track_tag_coverage_pct ?? 0) >= 50
    ).length;

    // Spor-tagging på nett-nivå: spor-bøtter eks. "Ikke tagget"
    const tracks = stats.track_capacity_km || {};
    const trackTotal = Object.values(tracks).reduce((s, v) => s + v, 0);
    const trackTagged = trackTotal - (tracks["Ikke tagget"] || 0);
    const trackTaggedPct = trackTotal > 0 ? Math.round(100 * trackTagged / trackTotal) : 0;

    const rows = [
      ["Spor-kapasitet (km tagget)", `${trackTaggedPct}%`],
      ["Maks-hastighet (av navngitte ruter)", `${Math.round(100 * withMaxSpeed / total)}%`],
      ["Operatør (av navngitte ruter)", `${Math.round(100 * withOperator / total)}%`],
      ["Spor-detaljer ≥50% (av navngitte ruter)", `${Math.round(100 * withTrackCoverage / total)}%`],
    ];
    for (const [label, pct] of rows) {
      const li = document.createElement("li");
      const a = document.createElement("span");
      a.textContent = label;
      const b = document.createElement("span");
      b.className = "km";
      b.textContent = pct;
      li.append(a, b);
      el.append(li);
    }
  }

  // Eget kort — CO₂-tallet er stort nok til å fortjene egen visuell vekt.
  function renderCo2Card(stats) {
    const el = document.getElementById("dash-co2");
    if (!el) return;
    const co2 = stats.diesel_co2_estimate;
    el.replaceChildren();
    if (!co2 || !co2.tonnes_per_year) {
      el.textContent = "Ingen CO₂-data tilgjengelig.";
      return;
    }
    const big = document.createElement("div");
    big.className = "dash-callout-num";
    big.textContent = `~${fmtNum(co2.tonnes_per_year)}`;
    const unit = document.createElement("div");
    unit.className = "dash-callout-unit";
    unit.textContent = "tonn CO₂ per år";
    const ctx = document.createElement("p");
    ctx.className = "dash-callout-ctx";
    ctx.append(
      document.createTextNode("Fra "),
      bold(`${fmtNum(stats.non_electrified_km || 0)} km`),
      document.createTextNode(" jernbane uten elektrifisering — der togene fortsatt går på diesel."),
    );
    const note = document.createElement("p");
    note.className = "estimate-note";
    note.append(
      document.createTextNode(`Anslag: ${co2.assumption_text}. `),
      infoTip(TIPS.co2_estimate),
    );
    el.append(big, unit, ctx, note);
  }

  // Setter takeaway-tekst som forklarer hva chartet betyr. Tallene
  // beregnes fra de samme bøttene som chartet for å unngå drift.
  function setTakeaway(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderTypes(stats) {
    const types = Object.entries(stats.type_breakdown_km || {});
    bar("dash-chart-types", {
      labels: types.map(([k]) => k),
      data: types.map(([, v]) => v),
      color: "#1a3a52",
      ariaTitle: "Banetyper i kilometer",
    });
    const total = types.reduce((s, [, v]) => s + v, 0);
    const railKm = stats.type_breakdown_km?.rail || 0;
    const railPct = total > 0 ? Math.round(100 * railKm / total) : 0;
    const others = total - railKm;
    setTakeaway(
      "dash-types-takeaway",
      `Vanlig jernbane (rail) utgjør ${railPct}% av nettet. Smalspor og museumsbaner til sammen bare ${fmtNum(others)} km — de er marginale, men kulturhistorisk viktige.`,
    );
  }

  function renderSpeed(stats) {
    const sp = Object.entries(stats.speed_distribution_km || {});
    bar("dash-chart-speed", {
      labels: sp.map(([k]) => k),
      data: sp.map(([, v]) => v),
      color: "#3182ce",
      ariaTitle: "Hastighetsfordeling i kilometer",
    });
    const dist = stats.speed_distribution_km || {};
    const total = Object.values(dist).reduce((s, v) => s + v, 0);
    const conv = (dist["80–130"] || 0) + (dist["130–160"] || 0);
    const highSpeed = dist["200+"] || 0;
    const convPct = total > 0 ? Math.round(100 * conv / total) : 0;
    const hsPct = total > 0 ? Math.round(100 * highSpeed / total) : 0;
    setTakeaway(
      "dash-speed-takeaway",
      `${convPct}% av nettet kjører konvensjonell hastighet (80–160 km/t). Bare ${hsPct}% er høyhastighet (200+ km/t) — i hovedsak Gardermobanen.`,
    );
  }

  function renderTracks(stats) {
    const tk = Object.entries(stats.track_capacity_km || {});
    bar("dash-chart-tracks", {
      labels: tk.map(([k]) => k),
      data: tk.map(([, v]) => v),
      color: "#0d9488",
      ariaTitle: "Spor-kapasitet i kilometer",
    });
    const single = stats.track_capacity_km?.["Enkeltspor"] || 0;
    const double = stats.track_capacity_km?.["Dobbeltspor"] || 0;
    const tagged = single + double + (stats.track_capacity_km?.["Multispor (3+)"] || 0);
    const singlePct = tagged > 0 ? Math.round(100 * single / tagged) : 0;
    const el = document.getElementById("dash-tracks-takeaway");
    if (el) {
      el.replaceChildren();
      el.append(
        document.createTextNode(`${singlePct}% av tagget hovedspor er enkeltspor. Det er hovedforklaringen på at norsk jernbane sjelden har høy frekvens — togene må vente på møteplasser. `),
        infoTip(TIPS.passenger_lines),
        document.createTextNode(" "),
        infoTip(TIPS.service_siding),
      );
    }
  }

  function renderPopulation(stats) {
    const pc = stats.population_coverage;
    const root = document.getElementById("dash-population");
    if (!pc) {
      root.textContent = "Mangler befolknings-data.";
      return;
    }

    const headline = document.createElement("p");
    headline.style.margin = "0 0 var(--sp-2) 0";
    const big = document.createElement("strong");
    big.style.fontSize = "var(--fs-xl)";
    big.style.color = "var(--c-primary)";
    big.textContent = `${pc.bands_pct["≤2 km"]}%`;
    headline.append(big, document.createTextNode(" innen 2 km fra stasjon"));
    root.append(headline);

    const profile = window.AppHelpers.buildStackedBar({
      entries: Object.entries(pc.bands_population),
      colors: window.AppHelpers.COVERAGE_COLORS,
      fmtTitle: (band, pop) =>
        `${band}: ${pop.toLocaleString("nb-NO")} (${pc.bands_pct[band]}%)`,
      fmtLegend: (band) => `${band}: ${pc.bands_pct[band]}%`,
    });
    profile.style.marginTop = "var(--sp-2)";
    root.append(profile);

    if (pc.largest_unserved?.length) {
      const sub = document.createElement("p");
      sub.className = "subhead";
      sub.style.marginTop = "var(--sp-3)";
      sub.textContent = "Største befolkning >25 km fra stasjon";
      root.append(sub);
      const ul = document.createElement("ul");
      ul.className = "micro-list";
      for (const u of pc.largest_unserved.slice(0, 5)) {
        const li = document.createElement("li");
        const a = document.createElement("span"); a.textContent = u.name;
        const b = document.createElement("span");
        b.className = "km";
        b.textContent = `${fmtNum(u.population / 1000)}k · ${u.distance_km} km`;
        li.append(a, b);
        ul.append(li);
      }
      root.append(ul);
    }
  }

  // Bygger en accordion-rad: klikkbar header + skjult detalj-pane som
  // ekspanderer inline. Header viser navn + meta. Detail-pane bruker data
  // som allerede finnes i stats.routes (ingen ekstra fetch).
  function routeAccordionRow(route, metaText) {
    const li = document.createElement("li");
    li.className = "dash-route-row";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "dash-route-head";
    head.setAttribute("aria-expanded", "false");
    const name = document.createElement("span");
    name.className = "dash-route-name";
    name.textContent = route.name;
    const meta = document.createElement("span");
    meta.className = "tail";
    meta.textContent = metaText;
    const chev = document.createElement("span");
    chev.className = "dash-route-chev";
    chev.textContent = "▾";
    head.append(name, meta, chev);
    li.append(head);

    const slot = document.createElement("div");
    slot.className = "dash-route-detail";
    slot.hidden = true;
    li.append(slot);

    head.addEventListener("click", () => {
      const isOpen = !slot.hidden;
      if (isOpen) {
        slot.hidden = true;
        head.setAttribute("aria-expanded", "false");
        head.classList.remove("open");
        return;
      }
      if (!slot.dataset.built) {
        slot.append(buildRouteDetail(route));
        slot.dataset.built = "1";
      }
      slot.hidden = false;
      head.setAttribute("aria-expanded", "true");
      head.classList.add("open");
    });

    return li;
  }

  function buildRouteDetail(route) {
    const wrap = document.createElement("div");
    const facts = document.createElement("ul");
    facts.className = "micro-list";
    const rows = [
      ["Total lengde", `${route.total_km.toFixed(1)} km`],
      ["Elektrifisert", `${route.electrified_pct}% (${route.electrified_km.toFixed(1)} km)`],
      ["Maks-hastighet", route.max_speed_kmh ? `${route.max_speed_kmh} km/t` : "—"],
      ["Snitt-hastighet", route.mean_speed_kmh ? `${route.mean_speed_kmh} km/t` : "—"],
    ];
    if (route.double_track_pct != null) {
      rows.push(["Dobbeltspor", `${route.double_track_pct}% (${route.double_track_km.toFixed(1)} km)`]);
    }
    rows.push(["Antall segmenter", String(route.segments)]);
    if (route.operators?.length) {
      rows.push(["Operatører", route.operators.join(", ")]);
    }
    for (const [k, v] of rows) {
      const li = document.createElement("li");
      const a = document.createElement("span"); a.textContent = k;
      const b = document.createElement("span"); b.className = "km"; b.textContent = v;
      li.append(a, b);
      facts.append(li);
    }
    wrap.append(facts);

    if (route.speed_distribution_km) {
      const sub = document.createElement("p");
      sub.className = "subhead";
      sub.style.marginTop = "var(--sp-3)";
      sub.textContent = "Hastighetsprofil";
      wrap.append(sub);
      wrap.append(window.AppHelpers.buildSpeedProfile(route.speed_distribution_km));
    }

    const link = document.createElement("a");
    link.href = `bane.html?navn=${encodeURIComponent(route.name)}`;
    link.className = "btn btn-primary btn-sm";
    link.style.marginTop = "var(--sp-3)";
    link.textContent = "Åpne bane-side →";
    wrap.append(link);

    return wrap;
  }

  function renderFastest(stats) {
    const list = document.getElementById("dash-fastest");
    list.replaceChildren();
    const rows = (stats.routes || [])
      .filter((r) => r.max_speed_kmh != null)
      .sort((a, b) => b.max_speed_kmh - a.max_speed_kmh || b.total_km - a.total_km)
      .slice(0, 10);
    for (const r of rows) {
      list.append(routeAccordionRow(r, ` — ${r.max_speed_kmh} km/t (${r.total_km.toFixed(0)} km)`));
    }
  }

  function renderLargest(stats) {
    const list = document.getElementById("dash-largest");
    list.replaceChildren();
    const rows = (stats.routes || [])
      .slice()
      .sort((a, b) => b.total_km - a.total_km)
      .slice(0, 15);
    for (const r of rows) {
      list.append(routeAccordionRow(r, ` — ${r.total_km.toFixed(0)} km, ${r.electrified_pct}% elek.`));
    }
  }

  async function init() {
    const stats = await fetch("data/stats.json").then((r) => r.json());
    document.getElementById("data-date").textContent = fmtDate(stats.generated_at);
    document.getElementById("footer-date").textContent = fmtDate(stats.generated_at);

    renderHero(stats);
    renderNarrative(stats);
    renderElectrification(stats);
    renderCo2Card(stats);
    renderComparison(stats);
    renderOperators(stats);
    renderDataQuality(stats);
    renderTypes(stats);
    renderSpeed(stats);
    renderTracks(stats);
    renderPopulation(stats);
    renderFastest(stats);
    renderLargest(stats);

    window.__dashboard = { ready: true, stats };
  }

  init().catch((e) => {
    console.error("[dashboard] init feilet:", e);
    const root = document.querySelector(".page-container");
    if (root) {
      const p = document.createElement("p");
      p.style.color = "#c00";
      p.textContent = `Kunne ikke laste dashbord: ${e.message}`;
      root.append(p);
    }
  });
})();
