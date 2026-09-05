#!/usr/bin/env node
// scripts/update-data.mjs
//
// Actualiza a diario los datos de tono medio embebidos en index.html.
// Llama a GDELT DOC 2.0 server-side (query=Iran, mode=timelinetone,
// timespan=6m — la misma consulta que usaba la antigua Netlify
// Scheduled Function, ahora retirada) y sustituye, dentro de
// index.html, el contenido del bloque:
//
//   <script type="application/json" id="tone-data-json"> ... </script>
//
// por un JSON fresco { series, lastUpdated, stale, source }. El resto
// de index.html (lógica de render, botones, benchmarks) no se toca.
//
// index.html guarda una única serie diaria de 6 meses; las pestañas
// "7 Days" / "1 Month" / "War Total" la recortan en el propio
// navegador (ver la función updateView en index.html) — así ha
// funcionado siempre este proyecto, no se ha cambiado ese criterio.
//
// Si GDELT falla tras los reintentos, conserva los datos embebidos
// del día anterior y marca stale: true, en vez de romper el sitio.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, "..", "index.html");

const GDELT_URL =
  "https://api.gdeltproject.org/api/v2/doc/doc?query=Iran&mode=timelinetone&timespan=6m&format=json";

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 25000;
const BACKOFF_MS = [2000, 5000]; // espera entre intento 1→2 y 2→3

const FETCH_OPTS = {
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; IranGeopoliticalMonitor/1.0)",
    Accept: "application/json",
  },
};

const DATA_BLOCK_RE =
  /(<script type="application\/json" id="tone-data-json">\n)([\s\S]*?)(\n<\/script>)/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GDELT devuelve fechas como "20260820T000000Z". Nos quedamos solo con
// los dígitos antes de trocear, así funciona con ese formato o con
// "YYYYMMDDHHMMSS" pelado. (Misma lógica que la función retirada.)
function parseGdeltDate(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 8) return null;
  const y = digits.slice(0, 4), mo = digits.slice(4, 6), d = digits.slice(6, 8);
  const hh = digits.slice(8, 10) || "00", mm = digits.slice(10, 12) || "00", ss = digits.slice(12, 14) || "00";
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`;
}

function describeError(err) {
  const causeMsg = err?.cause?.message || err?.cause?.code;
  return causeMsg ? `${err.message} (causa: ${causeMsg})` : err.message;
}

async function fetchOnce() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const resp = await fetch(GDELT_URL, { ...FETCH_OPTS, signal: controller.signal });
    const rawText = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${rawText.slice(0, 200)}`);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`respuesta no es JSON válido: ${rawText.slice(0, 200)}`);
    }

    const rawSeries = (data.timeline && data.timeline[0] && data.timeline[0].data) || [];
    const series = rawSeries
      .map((p) => ({ date: parseGdeltDate(p.date), tone: Number(p.value) }))
      .filter((p) => p.date !== null && !Number.isNaN(p.tone));

    if (!series.length) throw new Error("GDELT respondió sin puntos de datos utilizables.");
    return series;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetries() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchOnce();
    } catch (err) {
      lastErr = err;
      console.error(`[update-data] intento ${attempt}/${MAX_ATTEMPTS} falló: ${describeError(err)}`);
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] ?? 5000);
    }
  }
  throw lastErr;
}

function readPreviousPayload(html) {
  const match = html.match(DATA_BLOCK_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[2]);
  } catch {
    return null;
  }
}

async function main() {
  const html = readFileSync(INDEX_HTML_PATH, "utf8");

  if (!DATA_BLOCK_RE.test(html)) {
    throw new Error(
      'No se encontró el bloque <script type="application/json" id="tone-data-json"> en index.html — ¿se ha movido o renombrado?'
    );
  }

  const previous = readPreviousPayload(html);
  let payload;

  try {
    const series = await fetchWithRetries();
    payload = {
      series,
      lastUpdated: new Date().toISOString(),
      stale: false,
      source: GDELT_URL,
    };
    console.log(`[update-data] OK — ${series.length} puntos actualizados.`);
  } catch (err) {
    console.error(`[update-data] GDELT falló tras ${MAX_ATTEMPTS} intentos: ${describeError(err)}`);
    payload = {
      series: previous?.series ?? [],
      lastUpdated: previous?.lastUpdated ?? null,
      stale: true,
      lastError: { message: describeError(err), at: new Date().toISOString() },
      source: GDELT_URL,
    };
    console.warn("[update-data] Se conservan los datos del día anterior (stale: true).");
  }

  const json = JSON.stringify(payload, null, 2);
  const newHtml = html.replace(DATA_BLOCK_RE, `$1${json}$3`);
  if (newHtml === html && !DATA_BLOCK_RE.test(html)) {
    throw new Error("No se pudo sustituir el bloque de datos.");
  }
  writeFileSync(INDEX_HTML_PATH, newHtml, "utf8");
  console.log(`[update-data] index.html actualizado (${INDEX_HTML_PATH}).`);
}

main().catch((err) => {
  console.error(`[update-data] Fallo fatal: ${describeError(err)}`);
  process.exitCode = 1;
});
