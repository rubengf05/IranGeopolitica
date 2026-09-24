#!/usr/bin/env node
// scripts/update-data.mjs
//
// Actualiza a diario los datos de tono medio embebidos en index.html,
// dentro del bloque:
//
//   <script type="application/json" id="tone-data-json"> ... </script>
//
// MODELO APPEND-ONLY (desde sept. 2026)
// -------------------------------------
// Antes se pedía a GDELT `timespan=6m` y se sustituía la serie entera en
// cada ejecución. Eso tenía dos problemas: la ventana móvil iba
// comiéndose el inicio de la guerra (28 feb 2026) y cualquier día que
// GDELT no devolviera desaparecía sin dejar rastro.
//
// Ahora la serie embebida ES el histórico persistido:
//   1. Se lee la serie ya guardada en index.html.
//   2. Se pide a GDELT solo una ventana corta con fechas fijas
//      (startdatetime / enddatetime): desde unos días antes del último dato
//      guardado (para refrescar el día parcial y revisiones recientes de
//      GDELT) o desde el primer día sin cubrir que aún no esté
//      documentado como hueco, lo que sea anterior. Nunca antes de
//      WAR_START.
//   3. Se fusiona por fecha: los días devueltos sobrescriben, los demás
//      se conservan. Nunca se borra un día ya guardado.
//   4. Todo día entre WAR_START y el último dato que no tenga valor queda
//      registrado en `knownGaps` con su motivo. No hay huecos silenciosos.
//
// Si GDELT falla, se conservan los datos y se marca stale: true (el sitio
// no se rompe). Si el dato lleva más de MAX_STALE_HOURS sin refrescarse,
// o si algo no cuadra en la validación, el proceso termina con código 1
// para que el run de GitHub Actions salga en rojo.
//
// La media, desviación típica, velocity y el "Automated Assessment" se
// siguen calculando en el navegador (index.html). Este script solo
// guarda la serie diaria.

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH =
  process.env.INDEX_HTML_PATH || path.join(__dirname, "..", "index.html");

// ---- Configuración ------------------------------------------------------

const WAR_START = "2026-02-28"; // inicio de "War Total"; no se pide nada anterior
const OVERLAP_DAYS = 3; // días que se vuelven a pedir por detrás del último dato
const GAP_RETRY_DAYS = 14; // huecos más recientes que esto se reintentan cada día
const MAX_STALE_HOURS = 48; // a partir de aquí, stale => run en rojo
const MAX_LAST_POINT_AGE_DAYS = 2; // último punto más viejo que esto => run en rojo

const GDELT_BASE =
  process.env.GDELT_BASE_URL || "https://api.gdeltproject.org/api/v2/doc/doc";
const GDELT_QUERY = "Iran";

const MAX_ATTEMPTS = 4;
const ATTEMPT_TIMEOUT_MS = 30000;
// GDELT exige como mínimo 5 s entre peticiones; un 429 se reintenta con
// esperas más largas. (Antes el primer reintento era a los 2 s, lo que
// garantizaba otro 429: entre el 6 y el 22 sept 2026, 12 de 17 ejecuciones
// acabaron en stale por 429 o timeout de conexión.)
const BACKOFF_MS = (process.env.GDELT_BACKOFF_MS || "10000,30000,60000")
  .split(",")
  .map(Number);

const FETCH_OPTS = {
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; IranGeopoliticalMonitor/1.0)",
    Accept: "application/json",
  },
};

const DATA_BLOCK_RE =
  /(<script type="application\/json" id="tone-data-json">\n)([\s\S]*?)(\n<\/script>)/;

const DAY_MS = 86400000;

// ---- Utilidades de fecha (todo en UTC, clave "YYYY-MM-DD") ---------------

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (key, n) => dayKey(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS);
const diffDays = (a, b) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
const toGdeltStamp = (key) => key.replace(/-/g, "") + "000000";
const maxKey = (a, b) => (a > b ? a : b);
const minKey = (a, b) => (a < b ? a : b);

// GDELT devuelve fechas como "20260820T000000Z". Nos quedamos solo con
// los dígitos antes de trocear, así funciona con ese formato o con
// "YYYYMMDDHHMMSS" pelado.
function parseGdeltDate(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 8) return null;
  const y = digits.slice(0, 4), mo = digits.slice(4, 6), d = digits.slice(6, 8);
  return `${y}-${mo}-${d}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err) {
  const causeMsg = err?.cause?.message || err?.cause?.code;
  return causeMsg ? `${err.message} (causa: ${causeMsg})` : err.message;
}

// Anotaciones visibles en la UI de GitHub Actions (no-op fuera de Actions).
const gh = {
  warning: (msg) => console.log(`::warning title=update-data::${msg}`),
  error: (msg) => console.log(`::error title=update-data::${msg}`),
  summary: (md) => {
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch {}
    }
  },
};

// ---- GDELT --------------------------------------------------------------

function buildUrl(startKey, endKey) {
  const p = new URLSearchParams({
    query: GDELT_QUERY,
    mode: "timelinetone",
    startdatetime: toGdeltStamp(startKey),
    enddatetime: toGdeltStamp(endKey),
    format: "json",
  });
  return `${GDELT_BASE}?${p}`;
}

async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...FETCH_OPTS, signal: controller.signal });
    const rawText = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${rawText.slice(0, 200)}`);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`respuesta no es JSON válido: ${rawText.slice(0, 200)}`);
    }

    const rawSeries = (data.timeline && data.timeline[0] && data.timeline[0].data) || [];
    const points = rawSeries
      .map((p) => ({ day: parseGdeltDate(p.date), tone: Number(p.value) }))
      .filter((p) => p.day !== null && Number.isFinite(p.tone));

    if (!points.length) throw new Error("GDELT respondió sin puntos de datos utilizables.");
    return points;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetries(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (err) {
      lastErr = err;
      console.error(`[update-data] intento ${attempt}/${MAX_ATTEMPTS} falló: ${describeError(err)}`);
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] ?? 60000);
    }
  }
  throw lastErr;
}

// ---- Serie y huecos -----------------------------------------------------

function readPreviousPayload(html) {
  const match = html.match(DATA_BLOCK_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[2]);
  } catch {
    return null;
  }
}

function seriesToMap(series) {
  const m = new Map();
  for (const p of series || []) {
    const k = p?.date ? dayKey(p.date) : null;
    const t = Number(p?.tone);
    if (k && Number.isFinite(t)) m.set(k, t);
  }
  return m;
}

function mapToSeries(m) {
  return [...m.keys()].sort().map((k) => ({ date: `${k}T00:00:00Z`, tone: m.get(k) }));
}

// Días sin dato entre WAR_START y el último día guardado, agrupados en rangos.
function findMissingRanges(m) {
  const keys = [...m.keys()].sort();
  if (!keys.length) return [];
  const last = keys[keys.length - 1];
  const ranges = [];
  let open = null;
  for (let k = WAR_START; k <= last; k = addDays(k, 1)) {
    if (m.has(k)) {
      if (open) { ranges.push(open); open = null; }
    } else if (open) {
      open.to = k;
    } else {
      open = { from: k, to: k };
    }
  }
  if (open) ranges.push(open);
  return ranges;
}

const rangeDays = (r) => diffDays(r.to, r.from) + 1;
const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
const isDocumented = (range, knownGaps) =>
  knownGaps.some((g) => g.from <= range.from && g.to >= range.to);

// Recalcula knownGaps a partir de la serie fusionada. Conserva motivo y
// fecha de detección de los huecos que ya estaban documentados.
function rebuildKnownGaps(m, previousGaps, fetchedWindow, nowIso) {
  return findMissingRanges(m).map((r) => {
    const prev = previousGaps.find((g) => overlaps(g, r));
    const inWindow = fetchedWindow && r.from >= fetchedWindow.from && r.to <= fetchedWindow.to;
    const reason = inWindow
      ? "gdelt-no-data" // se pidió explícitamente ese rango y GDELT no devolvió esos días
      : prev?.reason ?? "not-captured";
    return {
      from: r.from,
      to: r.to,
      days: rangeDays(r),
      reason,
      detectedAt: prev?.detectedAt ?? nowIso,
      lastCheckedAt: inWindow ? nowIso : prev?.lastCheckedAt ?? null,
      ...(prev?.note ? { note: prev.note } : {}),
    };
  });
}

// Primer día que hay que pedir a GDELT en esta ejecución.
function computeWindowStart(m, knownGaps, todayKey) {
  const keys = [...m.keys()].sort();
  if (!keys.length) return WAR_START;
  let start = addDays(keys[keys.length - 1], -OVERLAP_DAYS);
  for (const r of findMissingRanges(m)) {
    const undocumented = !isDocumented(r, knownGaps);
    const recent = diffDays(todayKey, r.to) <= GAP_RETRY_DAYS;
    if (undocumented || recent) start = minKey(start, r.from);
  }
  return maxKey(start, WAR_START);
}

function validate(merged, previousMap, knownGaps) {
  const problems = [];
  for (const k of previousMap.keys()) {
    if (!merged.has(k)) problems.push(`se ha perdido el día ${k}, que ya estaba guardado`);
  }
  for (const [k, t] of merged) {
    if (k < WAR_START) problems.push(`día ${k} anterior a WAR_START`);
    if (!(t > -30 && t < 30)) problems.push(`tono fuera de rango el ${k}: ${t}`);
  }
  for (const r of findMissingRanges(merged)) {
    if (!isDocumented(r, knownGaps)) problems.push(`hueco sin documentar ${r.from} → ${r.to}`);
  }
  return problems;
}

// ---- Principal ----------------------------------------------------------

async function main() {
  const html = readFileSync(INDEX_HTML_PATH, "utf8");
  if (!DATA_BLOCK_RE.test(html)) {
    throw new Error(
      'No se encontró el bloque <script type="application/json" id="tone-data-json"> en index.html — ¿se ha movido o renombrado?'
    );
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const todayKey = dayKey(now);

  const previous = readPreviousPayload(html) || {};
  const previousMap = seriesToMap(previous.series);
  const previousGaps = Array.isArray(previous.knownGaps) ? previous.knownGaps : [];

  const windowStart = computeWindowStart(previousMap, previousGaps, todayKey);
  const windowEnd = addDays(todayKey, 1); // enddatetime exclusivo en la práctica
  const url = buildUrl(windowStart, windowEnd);
  console.log(`[update-data] Ventana pedida a GDELT: ${windowStart} → ${todayKey}`);

  const base = {
    method: "append-only",
    warStart: WAR_START,
    source:
      `GDELT DOC 2.0 (query=${GDELT_QUERY}, mode=timelinetone). Acumulado incremental: ` +
      `cada ejecución diaria pide solo una ventana corta con startdatetime/enddatetime ` +
      `y la fusiona por fecha con la serie ya guardada; nunca se reescribe el histórico entero.`,
  };

  let payload;
  let exitCode = 0;

  try {
    let points;
    let fetchedFrom = windowStart;
    let backfillError = null;
    try {
      points = await fetchWithRetries(url);
    } catch (err) {
      // Si la ventana larga (backfill de huecos) falla, se intenta al menos
      // la ventana corta normal para no dejar el día de hoy sin actualizar.
      const keys = [...previousMap.keys()].sort();
      const shortStart = keys.length
        ? maxKey(addDays(keys[keys.length - 1], -OVERLAP_DAYS), WAR_START)
        : null;
      // Un 429 no depende de la ventana: repetir con otra solo empeora el bloqueo.
      if (!shortStart || shortStart <= windowStart || /HTTP 429/.test(err.message)) throw err;
      backfillError = describeError(err);
      gh.warning(`Backfill ${windowStart}→${shortStart} falló (${backfillError}); se reintenta solo la ventana corta.`);
      await sleep(BACKOFF_MS[0] ?? 10000);
      fetchedFrom = shortStart;
      points = await fetchWithRetries(buildUrl(shortStart, windowEnd));
    }
    const merged = new Map(previousMap);
    let added = 0, revised = 0;
    for (const { day, tone } of points) {
      if (day < WAR_START || day > todayKey) continue;
      if (!merged.has(day)) added++;
      else if (merged.get(day) !== tone) revised++;
      merged.set(day, tone);
    }

    let knownGaps = rebuildKnownGaps(merged, previousGaps, { from: fetchedFrom, to: todayKey }, nowIso);
    if (backfillError) {
      // Los huecos que no se pudieron pedir quedan documentados para no
      // reintentarlos a ciegas cada día (bórralos de knownGaps para forzar
      // un nuevo intento).
      knownGaps = knownGaps.map((g) =>
        g.reason === "not-captured" && g.to < fetchedFrom
          ? { ...g, reason: "backfill-failed", note: backfillError.slice(0, 200), lastCheckedAt: nowIso }
          : g
      );
    }
    const problems = validate(merged, previousMap, knownGaps);
    if (problems.length) {
      // No se escribe nada: mejor no tocar el histórico que corromperlo.
      problems.forEach((p) => gh.error(p));
      throw Object.assign(new Error(`validación fallida (${problems.length} problemas)`), { fatal: true });
    }

    payload = {
      series: mapToSeries(merged),
      lastUpdated: nowIso,
      stale: false,
      ...base,
      lastFetch: { from: fetchedFrom, to: todayKey, points: points.length, added, revised },
      knownGaps,
    };

    const lastDay = payload.series[payload.series.length - 1].date.slice(0, 10);
    console.log(
      `[update-data] OK — ${points.length} puntos recibidos, ${added} días nuevos, ${revised} revisados. ` +
      `Serie: ${payload.series.length} días (${payload.series[0].date.slice(0, 10)} → ${lastDay}).`
    );
    if (knownGaps.length) {
      const txt = knownGaps.map((g) => `${g.from}→${g.to} (${g.days}d, ${g.reason})`).join(", ");
      gh.warning(`Huecos documentados en la serie: ${txt}`);
    }
    if (diffDays(todayKey, lastDay) > MAX_LAST_POINT_AGE_DAYS) {
      gh.error(`GDELT responde pero el último día disponible es ${lastDay}.`);
      exitCode = 1;
    }
    gh.summary(
      `### update-data\n- Ventana: ${windowStart} → ${todayKey}\n- Nuevos: ${added} · revisados: ${revised}\n` +
      `- Serie: ${payload.series.length} días hasta ${lastDay}\n- Huecos documentados: ${knownGaps.length}`
    );
  } catch (err) {
    if (err.fatal) throw err;
    const msg = describeError(err);
    console.error(`[update-data] GDELT falló tras ${MAX_ATTEMPTS} intentos: ${msg}`);
    payload = {
      series: mapToSeries(previousMap),
      lastUpdated: previous.lastUpdated ?? null,
      stale: true,
      ...base,
      lastFetch: previous.lastFetch ?? null,
      knownGaps: previousGaps,
      lastError: { message: msg, at: nowIso, window: { from: windowStart, to: todayKey } },
    };
    const ageH = previous.lastUpdated ? (now - new Date(previous.lastUpdated)) / 3600000 : Infinity;
    if (ageH > MAX_STALE_HOURS) {
      gh.error(`Datos sin refrescar desde hace ${Math.round(ageH)} h (límite ${MAX_STALE_HOURS} h). Último error: ${msg}`);
      exitCode = 1;
    } else {
      gh.warning(`GDELT falló; se conservan los datos (stale: true). Error: ${msg}`);
    }
  }

  const json = JSON.stringify(payload, null, 2);
  const newHtml = html.replace(DATA_BLOCK_RE, () => `${html.match(DATA_BLOCK_RE)[1]}${json}\n</script>`);
  const check = readPreviousPayload(newHtml);
  if (!check || check.stale !== payload.stale || check.series.length !== payload.series.length) {
    throw new Error("No se pudo sustituir el bloque de datos correctamente.");
  }
  writeFileSync(INDEX_HTML_PATH, newHtml, "utf8");
  console.log(`[update-data] index.html actualizado (stale: ${payload.stale}).`);
  process.exitCode = exitCode;
}

main().catch((err) => {
  gh.error(`Fallo fatal: ${describeError(err)}`);
  console.error(`[update-data] Fallo fatal: ${describeError(err)}`);
  process.exitCode = 1;
});
