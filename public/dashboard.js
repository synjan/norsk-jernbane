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
      colors: ["#2563eb", "#9b2c2c"],
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

    const km = window.AppHelpers.BENCHMARKS.countries_km;
    // Fallback til tom dict hvis helpers.js er cachet uten dette feltet.
    const pct = window.AppHelpers.BENCHMARKS.countries_electrified_pct || {};
    const entries = Object.entries(km).map(([country, kmVal]) => ({
      country,
      km: country === "Norge" ? stats.total_km : kmVal,
      pct: country === "Norge" ? stats.electrified_pct : pct[country],
    }));
    entries.sort((a, b) => b.km - a.km);

    const maxKm = Math.max(...entries.map((e) => e.km));
    const list = document.createElement("div");
    list.className = "compare-list compare-list-dual";
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "compare-row" + (e.country === "Norge" ? " is-norway" : "");
      const label = document.createElement("span");
      label.className = "compare-label";
      label.textContent = e.country;
      const barWrap = document.createElement("span");
      barWrap.className = "compare-bar-wrap";
      const bar = document.createElement("span");
      bar.className = "compare-bar";
      bar.style.width = `${(e.km / maxKm) * 100}%`;
      barWrap.append(bar);
      const val = document.createElement("span");
      val.className = "compare-val";
      val.textContent = `${fmtNum(e.km)} km`;
      const pctEl = document.createElement("span");
      pctEl.className = "compare-pct";
      pctEl.textContent = e.pct != null ? `${Math.round(e.pct)}% elek` : "—";
      row.append(label, barWrap, val, pctEl);
      list.append(row);
    }
    el.append(list);
  }

  // Topp ikke-elektrifiserte baner med lengde > 50 km — kandidater hvis Norge
  // skal kutte tog-CO₂. Beregner besparelse med samme antagelse som
  // diesel_co2_estimate i process.py (10 tog/d × 250 t × 0.05 kg/GTK).
  function renderElecCandidates(stats) {
    const list = document.getElementById("dash-elec-candidates");
    const note = document.getElementById("dash-elec-candidates-note");
    if (!list) return;
    list.replaceChildren();

    const candidates = (stats.routes || [])
      .filter((r) => r.total_km >= 50 && r.electrified_pct < 50)
      .sort((a, b) => {
        const aNonElec = a.total_km * (1 - a.electrified_pct / 100);
        const bNonElec = b.total_km * (1 - b.electrified_pct / 100);
        return bNonElec - aNonElec;
      })
      .slice(0, 5);

    if (candidates.length === 0) {
      list.textContent = "Alle baner over 50 km er elektrifisert.";
      return;
    }

    // CO2 per km — speiler co2_estimate_tonnes_per_year fra process.py.
    // (10 × 250 × 0.05 / 1000) tonn/km/dag × 365 dager
    const CO2_PER_KM_YEAR = 10 * 250 * 0.05 * 365 / 1000;

    let totalNonElec = 0;
    for (const r of candidates) {
      const nonElecKm = r.total_km * (1 - r.electrified_pct / 100);
      totalNonElec += nonElecKm;
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "dash-route-link";
      a.href = `bane.html?navn=${encodeURIComponent(r.name)}`;
      a.textContent = r.name;
      li.append(a);
      const tail = document.createElement("span");
      tail.className = "tail";
      const co2 = Math.round(nonElecKm * CO2_PER_KM_YEAR);
      tail.textContent = ` — ${Math.round(nonElecKm)} km diesel (${r.electrified_pct}% elek), ~${fmtNum(co2)} tonn CO₂/år`;
      li.append(tail);
      list.append(li);
    }

    if (note) {
      const totalCo2 = Math.round(totalNonElec * CO2_PER_KM_YEAR);
      note.textContent = `Total CO₂-besparelse hvis disse fem elektrifiseres: ~${fmtNum(totalCo2)} tonn/år. Tommelfingerregel — faktisk kost-nytte avhenger av trafikkvolum og kraft-kilde.`;
    }
  }

  // Elektrifiseringsrate per operatør — hvem ligger etter?
  // Aggregerer fra routes (ikke segment-nivå) siden operator-feltet er
  // best tagget der.
  function renderOperatorElectrification(stats) {
    const el = document.getElementById("dash-operator-elec");
    if (!el) return;
    el.replaceChildren();

    const byOp = new Map();
    for (const r of (stats.routes || [])) {
      for (const op of (r.operators || [])) {
        const entry = byOp.get(op) || { totalKm: 0, elecKm: 0 };
        entry.totalKm += r.total_km / r.operators.length;
        entry.elecKm += r.electrified_km / r.operators.length;
        byOp.set(op, entry);
      }
    }

    const entries = [...byOp.entries()]
      .filter(([, v]) => v.totalKm >= 50)
      .map(([op, v]) => ({
        op,
        totalKm: v.totalKm,
        pct: v.totalKm > 0 ? (v.elecKm / v.totalKm) * 100 : 0,
      }))
      .sort((a, b) => b.totalKm - a.totalKm);

    if (entries.length < 2) return;

    const heading = document.createElement("p");
    heading.className = "subhead";
    heading.style.margin = "0 0 var(--sp-2) 0";
    heading.textContent = "Elektrifisering per operatør";
    el.append(heading);

    const list = document.createElement("div");
    list.className = "compare-list";
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "compare-row" + (e.op === "Bane NOR" ? " is-norway" : "");
      const label = document.createElement("span");
      label.className = "compare-label";
      label.textContent = e.op;
      const barWrap = document.createElement("span");
      barWrap.className = "compare-bar-wrap";
      const bar = document.createElement("span");
      bar.className = "compare-bar";
      bar.style.width = `${e.pct}%`;
      barWrap.append(bar);
      const val = document.createElement("span");
      val.className = "compare-val";
      val.textContent = `${Math.round(e.pct)}%`;
      row.append(label, barWrap, val);
      list.append(row);
    }
    el.append(list);
  }

  // Reiseopplevelse per topp-bane: tunnel-% + hastighets-gap (maks vs snitt).
  // Stort gap = infrastrukturen utnyttes ikke fullt ut, eller topografi tvinger
  // tog under makskapasitet på lange strekninger.
  function renderExperience(stats) {
    const el = document.getElementById("dash-experience");
    if (!el) return;
    el.replaceChildren();

    const candidates = (stats.routes || [])
      .filter((r) => r.total_km >= 100 && r.max_speed_kmh != null && r.mean_speed_kmh != null)
      .sort((a, b) => b.total_km - a.total_km)
      .slice(0, 6);

    for (const r of candidates) {
      const row = document.createElement("div");
      row.className = "dash-experience-row";

      const name = document.createElement("a");
      name.className = "dash-experience-name";
      name.href = `bane.html?navn=${encodeURIComponent(r.name)}`;
      name.textContent = r.name;
      row.append(name);

      const stats_ = document.createElement("div");
      stats_.className = "dash-experience-stats";

      const tunnelPct = r.total_km > 0 ? Math.round(100 * r.tunnel_km / r.total_km) : 0;
      const speedRatio = r.max_speed_kmh > 0 ? Math.round(100 * r.mean_speed_kmh / r.max_speed_kmh) : 0;

      const tu = document.createElement("span");
      tu.className = "dash-experience-stat";
      const tuLbl = document.createElement("span"); tuLbl.className = "lbl"; tuLbl.textContent = "Tunnel";
      const tuVal = document.createElement("span"); tuVal.className = "val"; tuVal.textContent = `${tunnelPct}%`;
      tu.append(tuLbl, tuVal);

      const sp = document.createElement("span");
      sp.className = "dash-experience-stat";
      const spLbl = document.createElement("span"); spLbl.className = "lbl"; spLbl.textContent = "Snitt / Maks";
      const spVal = document.createElement("span"); spVal.className = "val"; spVal.textContent = `${Math.round(r.mean_speed_kmh)} / ${Math.round(r.max_speed_kmh)} km/t`;
      sp.append(spLbl, spVal);

      const gap = document.createElement("span");
      gap.className = "dash-experience-stat";
      const gapLbl = document.createElement("span"); gapLbl.className = "lbl"; gapLbl.textContent = "Utnyttelse";
      const gapVal = document.createElement("span");
      gapVal.className = "val" + (speedRatio < 60 ? " warn" : "");
      gapVal.textContent = `${speedRatio}%`;
      gap.append(gapLbl, gapVal);

      stats_.append(tu, sp, gap);
      row.append(stats_);
      el.append(row);
    }
  }

  // Signal/sporveksel-statistikk fra OSM-noder. Sporveksel-tellingen er
  // forholdsvis komplett; signal-tellingen er sterkt under-tagget i OSM,
  // så den vises mer som kuriositet enn fakta.
  function renderInfrastructure(stats) {
    const kpis = document.getElementById("dash-infra-kpis");
    const list = document.getElementById("dash-signal-types");
    if (!kpis) return;
    kpis.replaceChildren();

    const sig = stats.signals || { total: 0, per_100km: 0, by_type: {} };
    const swi = stats.switches || { total: 0, per_100km: 0 };

    kpis.append(
      miniKpi(`${fmtNum(swi.total)}`, "Sporveksler"),
      miniKpi(`${swi.per_100km}`, "Per 100 km bane"),
      miniKpi(`${fmtNum(sig.total)}`, "Signaler"),
    );

    if (!list) return;
    list.replaceChildren();
    const labels = {
      main: "Hovedsignal",
      distant: "Forsignal",
      combined: "Kombinert signal",
      speed_limit: "Hastighetssignal",
      form: "Semafor (form)",
      shunting: "Skiftesignal",
      catenary_mast: "Kontaktledningsmast",
      whistle: "Pipesignal",
      main_repeated: "Gjentatt hovedsignal",
      slope: "Stigningssignal",
    };
    const entries = Object.entries(sig.by_type || {}).sort((a, b) => b[1] - a[1]);
    for (const [type, count] of entries) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = labels[type] || type;
      const num = document.createElement("span");
      num.className = "km";
      num.textContent = String(count);
      li.append(name, num);
      list.append(li);
    }
  }

  // Dobbeltspor-gap: topp-baner sortert etter total lengde, vist som bars
  // med dobbeltspor-andel. 0%-baner som Nordlandsbanen er åpenbare kandidater
  // for kapasitetsutvidelse.
  function renderDoubleTrackGap(stats) {
    const el = document.getElementById("dash-double-track-gap");
    if (!el) return;
    el.replaceChildren();

    const top = (stats.routes || [])
      .filter((r) => r.total_km >= 100 && r.double_track_pct != null)
      .sort((a, b) => b.total_km - a.total_km)
      .slice(0, 10);

    const list = document.createElement("div");
    list.className = "compare-list";
    for (const r of top) {
      const row = document.createElement("div");
      row.className = "compare-row";
      const label = document.createElement("a");
      label.className = "compare-label dash-route-link";
      label.href = `bane.html?navn=${encodeURIComponent(r.name)}`;
      label.textContent = r.name;
      const barWrap = document.createElement("span");
      barWrap.className = "compare-bar-wrap";
      const bar = document.createElement("span");
      bar.className = "compare-bar";
      bar.style.width = `${r.double_track_pct}%`;
      if (r.double_track_pct < 10) bar.style.background = "var(--c-danger, #dc2626)";
      else if (r.double_track_pct < 50) bar.style.background = "var(--c-warning, #f59e0b)";
      barWrap.append(bar);
      const val = document.createElement("span");
      val.className = "compare-val";
      val.textContent = `${r.double_track_pct}%`;
      row.append(label, barWrap, val);
      list.append(row);
    }
    el.append(list);
  }

  // Rekorder — kompakt "fakta-liste" med ekstremene i datasettet.
  function renderRecords(stats) {
    const el = document.getElementById("dash-records");
    if (!el) return;
    el.replaceChildren();

    const routes = stats.routes || [];
    const fastest = stats.fastest_sections?.[0];
    const longest = [...routes].sort((a, b) => b.total_km - a.total_km)[0];
    const longestUnelectrified = [...routes]
      .filter((r) => r.electrified_pct < 50)
      .sort((a, b) => b.total_km - a.total_km)[0];
    const mostTunnel = [...routes]
      .filter((r) => r.total_km >= 100)
      .map((r) => ({ ...r, tunnelPct: r.total_km > 0 ? r.tunnel_km / r.total_km : 0 }))
      .sort((a, b) => b.tunnelPct - a.tunnelPct)[0];
    const mostDoubleTrack = [...routes]
      .filter((r) => r.total_km >= 50)
      .sort((a, b) => (b.double_track_pct || 0) - (a.double_track_pct || 0))[0];
    const oldestStation = stats.history?.oldest;

    const records = [];
    if (longest) {
      records.push({
        label: "Lengste bane",
        value: `${longest.name} — ${fmtNum(longest.total_km)} km`,
        href: `bane.html?navn=${encodeURIComponent(longest.name)}`,
      });
    }
    if (fastest) {
      records.push({
        label: "Høyeste maks-hastighet",
        value: `${fastest.name} — ${fastest.maxspeed_kmh} km/t`,
        href: fastest.name && fastest.name !== "(uten navn)"
          ? `bane.html?navn=${encodeURIComponent(fastest.name)}` : null,
      });
    }
    if (longestUnelectrified) {
      records.push({
        label: "Lengste uten elektrifisering",
        value: `${longestUnelectrified.name} — ${fmtNum(longestUnelectrified.total_km)} km`,
        href: `bane.html?navn=${encodeURIComponent(longestUnelectrified.name)}`,
      });
    }
    if (mostTunnel) {
      const pct = Math.round(mostTunnel.tunnelPct * 100);
      records.push({
        label: "Mest tunnel (≥100 km)",
        value: `${mostTunnel.name} — ${pct}% i tunnel`,
        href: `bane.html?navn=${encodeURIComponent(mostTunnel.name)}`,
      });
    }
    if (mostDoubleTrack && mostDoubleTrack.double_track_pct > 0) {
      records.push({
        label: "Mest dobbeltspor",
        value: `${mostDoubleTrack.name} — ${mostDoubleTrack.double_track_pct}%`,
        href: `bane.html?navn=${encodeURIComponent(mostDoubleTrack.name)}`,
      });
    }
    if (stats.topography?.longest_tunnel_segment_km) {
      records.push({
        label: "Lengste tunnel-segment",
        value: `${stats.topography.longest_tunnel_segment_km} km`,
        href: null,
      });
    }
    if (oldestStation?.year && oldestStation?.name) {
      records.push({
        label: "Eldste stasjon",
        value: `${oldestStation.name} — ${oldestStation.year}`,
        href: `stasjon.html?navn=${encodeURIComponent(oldestStation.name)}`,
      });
    }

    for (const r of records) {
      const li = document.createElement("li");
      const lbl = document.createElement("span");
      lbl.className = "dash-record-label";
      lbl.textContent = r.label;
      const val = r.href
        ? Object.assign(document.createElement("a"), {
            href: r.href, className: "dash-record-value dash-route-link", textContent: r.value,
          })
        : Object.assign(document.createElement("span"), {
            className: "dash-record-value", textContent: r.value,
          });
      li.append(lbl, val);
      el.append(li);
    }
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
      color: "#334155",
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
      color: "#2563eb",
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

  // Bygger en mini-KPI-celle ($num + $desc) til .dash-mini-kpis-griden.
  function miniKpi(num, desc) {
    const wrap = document.createElement("div");
    wrap.className = "dash-mini-kpi";
    const n = document.createElement("span");
    n.className = "num";
    n.textContent = num;
    const d = document.createElement("span");
    d.className = "desc";
    d.textContent = desc;
    wrap.append(n, d);
    return wrap;
  }

  // Bygger en klikkbar lenke i .dash-link-list-format. Bruker for topp-tunnel-
  // ruter (→ bane.html) og knutepunkt-stasjoner (→ stasjon.html).
  function linkRow(href, name, tail) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.className = "dash-route-link";
    a.href = href;
    a.textContent = name;
    li.append(a);
    if (tail) {
      const t = document.createElement("span");
      t.className = "tail";
      t.textContent = ` — ${tail}`;
      li.append(t);
    }
    return li;
  }

  function renderTopography(stats) {
    const topo = stats.topography;
    const kpis = document.getElementById("dash-topography-kpis");
    const list = document.getElementById("dash-top-tunnel-routes");
    if (!topo || !kpis || !list) return;

    const sumKm = topo.tunnel_km + topo.bridge_km + topo.surface_km;
    const tunnelPct = sumKm > 0 ? Math.round(100 * topo.tunnel_km / sumKm) : 0;
    const bridgePct = sumKm > 0 ? Math.round(100 * topo.bridge_km / sumKm) : 0;

    kpis.replaceChildren(
      miniKpi(`${fmtNum(topo.tunnel_km)} km`, `Tunnel (${tunnelPct}%)`),
      miniKpi(`${fmtNum(topo.bridge_km)} km`, `Bro (${bridgePct}%)`),
      miniKpi(`${topo.longest_tunnel_segment_km} km`, "Lengste tunnel-segment"),
    );

    bar("dash-chart-topography", {
      labels: ["Åpen mark", "Tunnel", "Bro"],
      data: [topo.surface_km, topo.tunnel_km, topo.bridge_km],
      color: "#334155",
      ariaTitle: "Topografi-fordeling i kilometer",
    });

    list.replaceChildren();
    for (const r of topo.top_tunnel_routes || []) {
      list.append(linkRow(
        `bane.html?navn=${encodeURIComponent(r.name)}`,
        r.name,
        `${r.tunnel_pct}% i tunnel (${r.tunnel_km} av ${r.total_km} km)`,
      ));
    }
  }

  function renderHistory(stats) {
    const h = stats.history;
    const kpis = document.getElementById("dash-history-kpis");
    const archList = document.getElementById("dash-architects");
    const note = document.getElementById("dash-history-note");
    if (!h || !kpis || !archList) {
      if (kpis) kpis.textContent = "Ingen historiske data tilgjengelig.";
      return;
    }

    kpis.replaceChildren(
      miniKpi(String(h.oldest?.year ?? "—"), `Eldste: ${h.oldest?.name ?? "—"}`),
      miniKpi(String(h.newest?.year ?? "—"), `Nyeste: ${h.newest?.name ?? "—"}`),
      miniKpi(String(h.heritage_count ?? 0), "Fredede stasjoner"),
      miniKpi(String(h.stations_with_year ?? 0), "Stasjoner med åpningsår"),
    );

    const decades = h.by_decade || [];
    bar("dash-chart-history", {
      labels: decades.map((d) => d.label),
      data: decades.map((d) => d.count),
      color: "#0d9488",
      ariaTitle: "Antall stasjoner åpnet per tiår",
      unit: " stasjoner",
    });

    archList.replaceChildren();
    for (const a of h.top_architects || []) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = a.name;
      const cnt = document.createElement("span");
      cnt.className = "km";
      cnt.textContent = `${a.count} stasjoner`;
      li.append(name, cnt);
      archList.append(li);
    }

    if (note && h.note) note.textContent = h.note;
  }

  function renderHubs(stats) {
    const network = stats.network;
    const list = document.getElementById("dash-hubs-list");
    const note = document.getElementById("dash-hubs-note");
    if (!network?.hubs?.length || !list) {
      if (list) list.textContent = "Ingen knutepunkt-data tilgjengelig.";
      return;
    }

    const top = network.hubs.slice(0, 10);
    bar("dash-chart-hubs", {
      labels: top.map((h) => h.name),
      data: top.map((h) => h.route_count),
      color: "#2563eb",
      ariaTitle: "Antall ruter per knutepunkt",
      unit: " ruter",
    });

    list.replaceChildren();
    for (const h of network.hubs) {
      list.append(linkRow(
        `stasjon.html?navn=${encodeURIComponent(h.name)}`,
        h.name,
        `${h.route_count} ruter`,
      ));
    }

    if (note && network.note) note.textContent = network.note;
  }

  function renderPotential(stats) {
    const kpis = document.getElementById("dash-potential-kpis");
    const list = document.getElementById("dash-unserved-list");
    const note = document.getElementById("dash-potential-note");
    const pc = stats.population_coverage;
    if (!kpis || !list) return;
    if (!pc) {
      kpis.textContent = "Mangler befolknings-data.";
      return;
    }

    const beyond25Pop = pc.bands_population?.[">25 km"] ?? 0;
    const unserved = pc.largest_unserved || [];
    const top = unserved[0];
    const topHub = stats.network?.hubs?.[0];

    kpis.replaceChildren(
      miniKpi(
        top ? `${fmtNum(top.population / 1000)}k` : "—",
        top ? `${top.name} — ${top.distance_km} km til tog` : "Største ubetjente by",
      ),
      miniKpi(`${unserved.length}`, "Tettsteder >5k uten togtilbud"),
      miniKpi(`${fmtNum(beyond25Pop / 1000)}k`, "Innbyggere >25 km fra tog"),
      miniKpi(
        topHub ? String(topHub.route_count) : "—",
        topHub ? `Ruter via ${topHub.name}` : "Største knutepunkt",
      ),
    );

    list.replaceChildren();
    for (const u of unserved.slice(0, 10)) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "dash-route-name";
      name.style.fontWeight = "600";
      name.textContent = u.name;
      const tail = document.createElement("span");
      tail.className = "tail";
      tail.textContent = ` — ${fmtNum(u.population / 1000)}k innbyggere, ${u.distance_km} km til nærmeste stasjon`;
      li.append(name, tail);
      list.append(li);
    }

    if (note) {
      // Størrelsesorden-illustrasjon: hvis halvparten av folk >25 km tar tog
      // i stedet for bil, hvor mye CO2 spares? Bilsnitt ~120 g/km, antar
      // 10 000 km/år, halvparten — gir ren tommelfingerregel for skalering.
      const halfBeyondPop = beyond25Pop / 2;
      const tonnesSaved = Math.round(halfBeyondPop * 10000 * 0.12 / 1000);
      note.textContent = `Hvis halvparten av de ${fmtNum(beyond25Pop / 1000)}k innbyggerne >25 km fra tog kjørte 10 000 km mindre bil per år, ville det spart ~${fmtNum(tonnesSaved)} tonn CO₂. Tommelfingerregel — krever ny infrastruktur eller buss-mater til eksisterende stasjoner.`;
    }
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
    renderElecCandidates(stats);
    renderComparison(stats);
    renderOperators(stats);
    renderOperatorElectrification(stats);
    renderDataQuality(stats);
    renderTypes(stats);
    renderSpeed(stats);
    renderExperience(stats);
    renderTracks(stats);
    renderInfrastructure(stats);
    renderDoubleTrackGap(stats);
    renderPopulation(stats);
    renderTopography(stats);
    renderHistory(stats);
    renderHubs(stats);
    renderPotential(stats);
    renderFastest(stats);
    renderLargest(stats);
    renderRecords(stats);

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
