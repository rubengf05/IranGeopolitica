#!/usr/bin/env node
// scripts/update-data.mjs
//
// Descarga a diario de GDELT DOC 2.0 las series definidas en
// series.config.json y las guarda en data/:
//
//   data/<serie>.tone.json    tono medio diario   (mode=timelinetone)
//   data/<serie>.volraw.json  nº de artículos     (mode=timelinevolraw)
//   data/bundle.js            todo lo anterior + la config, para index.html
//
// Cada fichero es una "unidad" independiente y APPEND-ONLY:
//   - se pide solo una ventana reciente (mín. MIN_WINDOW_DAYS días, para que
//     GDELT responda con resolución diaria) más los huecos recientes;
//   - se fusiona por fecha y nunca se borra un día ya guardado;
//   - los días sin dato quedan en knownGaps con su motivo;
//   - si GDELT falla, esa unidad se marca stale y las demás siguen.
// Si cambias la consulta de una serie en series.config.json, sus ficheros se
// archivan en data/archive/ y se vuelve a descargar desde warStart.
//
// Termina con código 1 (run en rojo) si alguna unidad no valida, si alguna
// lleva más de MAX_STALE_HOURS sin refrescarse o si GDELT no trae días
// recientes. Los fallos puntuales solo dejan un aviso.
//
// Los cálculos (media, SD, % de volumen, descomposición) se hacen en el
// navegador, en index.html.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import {
  ROOT, loadConfig, buildQueries, buildUrl, fetchWithRetries, parseDailyTimeline,
  describeError, sleep, gh, dayKey, addDays, diffDays, toGdeltStamp, maxKey, minKey,
} from "./lib/gdelt.mjs";
import { writeBundle } from "./lib/bundle.mjs";

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const MODES = ["tone", "volraw"];
const GDELT_MODE = { tone: "timelinetone", volraw: "timelinevolraw" };

const MIN_WINDOW_DAYS = 60;
const GAP_RETRY_DAYS = 14;
const MAX_STALE_HOURS = 48;
const MAX_LAST_POINT_AGE_DAYS = 2;
const num = (v, d) => (v === undefined ? d : Number(v));
const REQUEST_GAP_MS = num(process.env.GDELT_REQUEST_GAP_MS, 15000); // GDELT: ≥5 s entre peticiones
const BACKOFF_MS = (process.env.GDELT_BACKOFF_MS || "10000,30000,60000").split(",").map(Number);
const TIME_BUDGET_MS = num(process.env.GDELT_TIME_BUDGET_MS, 20 * 60000);
const MAX_CONSECUTIVE_BLOCKED = 2; // tras 2 unidades seguidas bloqueadas, no se insiste

// ---- Serie de una unidad --------------------------------------------------

const unitPath = (id, mode) => path.join(DATA_DIR, `${id}.${mode}.json`);

function readUnit(id, mode) {
  const p = unitPath(id, mode);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function toMap(series) {
  const m = new Map();
  for (const p of series || []) {
    if (p?.date && Number.isFinite(Number(p.value))) m.set(p.date, p);
  }
  return m;
}
const fromMap = (m) => [...m.keys()].sort().map((k) => m.get(k));

function findMissingRanges(m, warStart) {
  const keys = [...m.keys()].sort();
  if (!keys.length) return [];
  const last = keys[keys.length - 1];
  const out = [];
  let open = null;
  for (let k = warStart; k <= last; k = addDays(k, 1)) {
    if (m.has(k)) { if (open) { out.push(open); open = null; } }
    else if (open) open.to = k;
    else open = { from: k, to: k };
  }
  if (open) out.push(open);
  return out;
}

const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
const isDocumented = (r, gaps) => gaps.some((g) => g.from <= r.from && g.to >= r.to);

function rebuildGaps(m, prevGaps, window, warStart, nowIso) {
  return findMissingRanges(m, warStart).map((r) => {
    const prev = prevGaps.find((g) => overlaps(g, r));
    const inWindow = window && r.from >= window.from && r.to <= window.to;
    return {
      from: r.from,
      to: r.to,
      days: diffDays(r.to, r.from) + 1,
      reason: inWindow ? "gdelt-no-data" : prev?.reason ?? "not-captured",
      detectedAt: prev?.detectedAt ?? nowIso,
      lastCheckedAt: inWindow ? nowIso : prev?.lastCheckedAt ?? null,
      ...(prev?.note ? { note: prev.note } : {}),
    };
  });
}

function windowStart(m, gaps, todayKey, warStart) {
  const keys = [...m.keys()].sort();
  if (!keys.length) return warStart;
  let start = minKey(addDays(keys[keys.length - 1], -3), addDays(todayKey, -MIN_WINDOW_DAYS));
  for (const r of findMissingRanges(m, warStart)) {
    if (!isDocumented(r, gaps) || diffDays(todayKey, r.to) <= GAP_RETRY_DAYS) start = minKey(start, r.from);
  }
  return maxKey(start, warStart);
}

function validate(merged, prevMap, gaps, mode, warStart) {
  const problems = [];
  for (const k of prevMap.keys()) if (!merged.has(k)) problems.push(`se ha perdido el día ${k}`);
  for (const [k, p] of merged) {
    if (k < warStart) problems.push(`día ${k} anterior a warStart`);
    if (mode === "tone" && !(p.value > -30 && p.value < 30)) problems.push(`tono fuera de rango el ${k}: ${p.value}`);
    if (mode === "volraw" && !(p.value >= 0)) problems.push(`volumen negativo el ${k}: ${p.value}`);
  }
  for (const r of findMissingRanges(merged, warStart)) {
    if (!isDocumented(r, gaps)) problems.push(`hueco sin documentar ${r.from} → ${r.to}`);
  }
  return problems;
}

// ---- Principal ------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  const warStart = cfg.warStart;
  const now = new Date();
  const nowIso = now.toISOString();
  const todayKey = dayKey(now);
  const startedAt = Date.now();
  mkdirSync(DATA_DIR, { recursive: true });

  const units = [];
  for (const q of buildQueries(cfg)) for (const mode of MODES) units.push({ ...q, mode });
  // Primero las series nunca descargadas o más antiguas: si GDELT empieza a
  // bloquear al runner a mitad de ejecución, las que se quedan sin turno son
  // las que ya están al día, no siempre las mismas del final de la lista.
  // A igualdad, va antes la que lleva más tiempo sin intentarse.
  const sortKey = (u) => {
    try {
      const d = readUnit(u.id, u.mode);
      return `${d?.lastUpdated || ""}|${d?.lastAttemptAt || ""}`;
    } catch { return "|"; }
  };
  const keys = new Map(units.map((u) => [u, sortKey(u)]));
  units.sort((a, b) => keys.get(a).localeCompare(keys.get(b)));

  let exitCode = 0;
  let blockedStreak = 0;
  let firstRequest = true;
  const rows = [];

  for (const u of units) {
    const label = `${u.id}.${u.mode}`;
    let prev = readUnit(u.id, u.mode);

    if (prev && prev.query !== u.query) {
      const archDir = path.join(DATA_DIR, "archive");
      mkdirSync(archDir, { recursive: true });
      const dest = path.join(archDir, `${u.id}.${u.mode}.${nowIso.replace(/[:.]/g, "-")}.json`);
      renameSync(unitPath(u.id, u.mode), dest);
      gh.warning(`${label}: la consulta ha cambiado; datos anteriores archivados en ${path.relative(ROOT, dest)} y se descarga de nuevo desde ${warStart}.`);
      prev = null;
    }
    prev = prev || { id: u.id, mode: u.mode, query: u.query, series: [], knownGaps: [] };

    const prevMap = toMap(prev.series);
    const prevGaps = Array.isArray(prev.knownGaps) ? prev.knownGaps : [];
    const from = windowStart(prevMap, prevGaps, todayKey, warStart);
    const url = buildUrl({
      query: u.query,
      mode: GDELT_MODE[u.mode],
      startdatetime: toGdeltStamp(from),
      enddatetime: toGdeltStamp(addDays(todayKey, 1)),
    });

    const base = {
      id: u.id, mode: u.mode, label: u.label, query: u.query,
      method: "append-only", warStart,
      source: `GDELT DOC 2.0, mode=${GDELT_MODE[u.mode]}, ventanas incrementales con startdatetime/enddatetime`,
    };
    let payload;
    let status;
    let attempted = false;

    const skip =
      blockedStreak >= MAX_CONSECUTIVE_BLOCKED ? "GDELT está bloqueando al runner; no se insiste en esta ejecución"
      : Date.now() - startedAt > TIME_BUDGET_MS ? "presupuesto de tiempo agotado"
      : null;

    try {
      if (skip) throw Object.assign(new Error(skip), { skipped: true });
      if (!firstRequest) await sleep(REQUEST_GAP_MS);
      firstRequest = false;
      attempted = true;
      console.log(`[update-data] ${label}: ventana ${from} → ${todayKey}`);
      const data = await fetchWithRetries(url, { backoffMs: BACKOFF_MS, label });
      const points = parseDailyTimeline(data);
      if (!points.length) throw new Error("GDELT respondió sin puntos utilizables.");
      blockedStreak = 0;

      const merged = new Map(prevMap);
      let added = 0, revised = 0;
      for (const p of points) {
        if (p.date < warStart || p.date > todayKey) continue;
        const old = merged.get(p.date);
        if (!old) added++;
        else if (old.value !== p.value || old.norm !== p.norm) revised++;
        merged.set(p.date, p);
      }
      const knownGaps = rebuildGaps(merged, prevGaps, { from, to: todayKey }, warStart, nowIso);
      const problems = validate(merged, prevMap, knownGaps, u.mode, warStart);
      if (problems.length) {
        problems.forEach((p) => gh.error(`${label}: ${p}`));
        exitCode = 1;
        rows.push(`| ${label} | ❌ validación | ${problems.length} problemas, no se escribe |`);
        continue; // no se toca el fichero
      }
      payload = {
        ...base,
        series: fromMap(merged),
        lastUpdated: nowIso,
        stale: false,
        lastFetch: { from, to: todayKey, points: points.length, added, revised },
        knownGaps,
      };
      const lastDay = payload.series.at(-1).date;
      if (diffDays(todayKey, lastDay) > MAX_LAST_POINT_AGE_DAYS) {
        gh.error(`${label}: GDELT responde pero el último día disponible es ${lastDay}.`);
        exitCode = 1;
      }
      if (knownGaps.length) {
        gh.warning(`${label}: huecos ${knownGaps.map((g) => `${g.from}→${g.to} (${g.reason})`).join(", ")}`);
      }
      status = `✅ +${added} nuevos, ${revised} revisados`;
      console.log(`[update-data] ${label}: OK (${payload.series.length} días hasta ${lastDay}, +${added}, ~${revised}).`);
    } catch (err) {
      const msg = describeError(err);
      if (err.rateLimited || err.network) blockedStreak++;
      if (err.invalidQuery || err.badResolution) {
        gh.error(`${label}: ${err.invalidQuery ? "consulta rechazada por GDELT" : "resolución no diaria"} — ${msg}`);
        exitCode = 1;
      }
      payload = {
        ...base,
        series: prev.series,
        lastUpdated: prev.lastUpdated ?? null,
        stale: true,
        lastFetch: prev.lastFetch ?? null,
        knownGaps: prevGaps,
        lastError: { message: msg, at: nowIso, window: { from, to: todayKey } },
      };
      const ageH = prev.lastUpdated ? (now - new Date(prev.lastUpdated)) / 3600000 : Infinity;
      if (ageH > MAX_STALE_HOURS) {
        gh.error(`${label}: sin refrescar ${prev.lastUpdated ? `desde hace ${Math.round(ageH)} h` : "nunca"}. Último error: ${msg}`);
        exitCode = 1;
      } else {
        gh.warning(`${label}: GDELT falló, se conservan los datos (stale). ${msg}`);
      }
      status = `⚠️ stale — ${msg.slice(0, 80)}`;
    }

    payload.lastAttemptAt = attempted ? nowIso : prev.lastAttemptAt ?? null;
    writeFileSync(unitPath(u.id, u.mode), JSON.stringify(payload, null, 1) + "\n");
    rows.push(`| ${label} | ${status} | ${payload.series.length} días${payload.series.length ? ` hasta ${payload.series.at(-1).date}` : ""} |`);
  }

  writeBundle(cfg, DATA_DIR);
  gh.summary(`### update-data\n\n| Serie | Estado | Datos |\n|---|---|---|\n${rows.join("\n")}\n`);
  console.log(rows.join("\n"));
  process.exitCode = exitCode;
}

main().catch((err) => {
  gh.error(`Fallo fatal: ${describeError(err)}`);
  console.error(`[update-data] Fallo fatal: ${describeError(err)}`);
  process.exitCode = 1;
});
