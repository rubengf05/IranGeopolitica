#!/usr/bin/env node
// scripts/backfill-from-git-history.mjs
//
// Uso puntual (no forma parte del cron diario):
//
//   node scripts/backfill-from-git-history.mjs          # solo informa
//   node scripts/backfill-from-git-history.mjs --write  # rellena index.html
//
// Recorre todas las versiones de index.html en el historial de git y
// recupera, del bloque tone-data-json de cada una, los días que falten en
// la serie actual (p. ej. 28 feb – 28 mar 2026, que la antigua ventana
// móvil `timespan=6m` fue descartando). Nunca sobrescribe un día que ya
// exista en la serie actual. Útil si GDELT ya no devuelve esas fechas.
//
// Requiere el historial completo (en Actions: actions/checkout con
// fetch-depth: 0).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "index.html";
const WAR_START = "2026-02-28";
const RE = /(<script type="application\/json" id="tone-data-json">\n)([\s\S]*?)(\n<\/script>)/;
const write = process.argv.includes("--write");

const git = (...a) =>
  execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
const parse = (html) => { try { return JSON.parse(html.match(RE)[2]); } catch { return null; } };
const key = (d) => new Date(d).toISOString().slice(0, 10);

const html = readFileSync(FILE, "utf8");
const current = parse(html);
if (!current) throw new Error("No se pudo leer el bloque de datos de index.html");
const have = new Map(current.series.map((p) => [key(p.date), p.tone]));

// Commits del más reciente al más antiguo: para cada día recuperado se
// queda el valor del commit más reciente que lo contenía.
const commits = git("log", "--format=%H %cI", "--", FILE).trim().split("\n").filter(Boolean);
const recovered = new Map();
for (const line of commits) {
  const [sha, when] = line.split(" ");
  let old;
  try { old = parse(git("show", `${sha}:${FILE}`)); } catch { continue; }
  for (const p of old?.series ?? []) {
    const k = key(p.date);
    const t = Number(p.tone);
    if (k < WAR_START || have.has(k) || recovered.has(k) || !Number.isFinite(t)) continue;
    recovered.set(k, { tone: t, sha: sha.slice(0, 7), when });
  }
}

const days = [...recovered.keys()].sort();
console.log(`Commits revisados: ${commits.length}. Días recuperables: ${days.length}.`);
for (const k of days) console.log(`  ${k}  ${recovered.get(k).tone}  (commit ${recovered.get(k).sha}, ${recovered.get(k).when})`);

if (write && days.length) {
  for (const k of days) have.set(k, recovered.get(k).tone);
  const series = [...have.keys()].sort().map((k) => ({ date: `${k}T00:00:00Z`, tone: have.get(k) }));
  // Los huecos se recalculan en la próxima ejecución de update-data.mjs.
  const payload = {
    ...current,
    series,
    backfill: { fromGitHistory: days.length, range: [days[0], days.at(-1)], at: new Date().toISOString() },
  };
  writeFileSync(FILE, html.replace(RE, (_, a, _b, c) => a + JSON.stringify(payload, null, 2) + c));
  console.log(`index.html actualizado con ${days.length} días recuperados. Ejecuta después update-data.mjs.`);
} else if (!write && days.length) {
  console.log("Ejecuta con --write para aplicarlos.");
}
