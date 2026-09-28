#!/usr/bin/env node
// scripts/probe-queries.mjs
//
// Comprueba las consultas de series.config.json SIN tocar data/:
//   - que GDELT las acepta (sintaxis, palabras demasiado cortas o comunes…);
//   - qué parte del volumen de "Iran" se lleva cada grupo en los últimos días;
//   - titulares de ejemplo de cada grupo, para ver a ojo si clasifican bien.
//
// Uso:  node scripts/probe-queries.mjs [días=14]
// En GitHub: pestaña Actions → "Probar consultas GDELT" → Run workflow.
// El resultado sale en el resumen del run.

import {
  loadConfig, buildQueries, buildUrl, fetchWithRetries, parseDailyTimeline,
  describeError, sleep, gh,
} from "./lib/gdelt.mjs";

const DAYS = Number(process.argv[2] || 14);
const GAP_MS = Number(process.env.GDELT_REQUEST_GAP_MS ?? 15000);
const BACKOFF = [10000, 30000];
let first = true;

async function call(params, label) {
  if (!first) await sleep(GAP_MS);
  first = false;
  return fetchWithRetries(buildUrl(params), { backoffMs: BACKOFF, label });
}

const cfg = loadConfig();
const queries = buildQueries(cfg);
const md = [`### Prueba de consultas GDELT (últimos ${DAYS} días)\n`];
const volumes = {};
let failures = 0;

for (const q of queries) {
  md.push(`#### ${q.id} — ${q.label}\n\n\`${q.query}\`\n`);
  try {
    const vol = parseDailyTimeline(await call({ query: q.query, mode: "timelinevolraw", timespan: `${DAYS}d` }, `${q.id}.volraw`));
    const tone = parseDailyTimeline(await call({ query: q.query, mode: "timelinetone", timespan: `${DAYS}d` }, `${q.id}.tone`));
    const articles = vol.reduce((a, p) => a + p.value, 0);
    const wTone = tone.reduce((a, p) => {
      const v = vol.find((x) => x.date === p.date)?.value ?? 0;
      return { s: a.s + p.value * v, n: a.n + v };
    }, { s: 0, n: 0 });
    volumes[q.id] = articles;
    md.push(`- Artículos: **${articles.toLocaleString("es-ES")}** en ${vol.length} días`);
    md.push(`- Tono medio ponderado: **${wTone.n ? (wTone.s / wTone.n).toFixed(2) : "—"}**`);
    if (q.kind === "group" && volumes[cfg.total.id]) {
      md.push(`- Peso sobre "${cfg.total.base}": **${((100 * articles) / volumes[cfg.total.id]).toFixed(1)} %**`);
    }
    const list = await call({ query: q.query, mode: "artlist", maxrecords: "10", sort: "hybridrel", timespan: "3d" }, `${q.id}.artlist`);
    const arts = (list.articles || []).slice(0, 10);
    md.push(`- Titulares de ejemplo:`);
    for (const a of arts) md.push(`  - ${String(a.title || "").replace(/\s+/g, " ").slice(0, 140)} _(${a.domain})_`);
    md.push("");
  } catch (err) {
    failures++;
    md.push(`- ❌ **Error:** ${describeError(err)}\n`);
  }
}

const total = volumes[cfg.total.id];
if (total) {
  const sumGroups = cfg.groups.reduce((a, g) => a + (volumes[g.id] || 0), 0);
  md.push(`#### Resumen\n`);
  md.push(`- Grupos: ${((100 * sumGroups) / total).toFixed(1)} % del volumen · resto (derivado): ${((100 * (total - sumGroups)) / total).toFixed(1)} %`);
  if (sumGroups > total) md.push(`- ⚠️ Los grupos suman más que el total: revisa que sean disjuntos.`);
}

const text = md.join("\n");
console.log(text);
gh.summary(text);
if (failures) process.exitCode = 1;
