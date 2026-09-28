// scripts/lib/gdelt.mjs
//
// Utilidades compartidas por update-data.mjs y probe-queries.mjs:
// lectura de series.config.json, construcción de consultas GDELT,
// peticiones con reintentos y utilidades de fecha (UTC, "YYYY-MM-DD").

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const GDELT_BASE =
  process.env.GDELT_BASE_URL || "https://api.gdeltproject.org/api/v2/doc/doc";

// ---- Fechas ---------------------------------------------------------------

const DAY_MS = 86400000;
export const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
export const addDays = (key, n) => dayKey(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS);
export const diffDays = (a, b) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
export const toGdeltStamp = (key) => key.replace(/-/g, "") + "000000";
export const maxKey = (a, b) => (a > b ? a : b);
export const minKey = (a, b) => (a < b ? a : b);

// ---- Configuración y consultas ---------------------------------------------

export function loadConfig() {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "series.config.json"), "utf8"));
  if (!cfg.warStart || !cfg.total?.id || !cfg.total?.base || !Array.isArray(cfg.groups)) {
    throw new Error("series.config.json incompleto (warStart, total.id, total.base, groups).");
  }
  const ids = [cfg.total.id, ...cfg.groups.map((g) => g.id), cfg.rest?.id].filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error("Hay ids repetidos en series.config.json.");
  return cfg;
}

const orGroup = (terms) => (terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`);

// Devuelve [{ id, label, query }] — la total y cada grupo, con las
// exclusiones de los grupos anteriores ya aplicadas (grupos disjuntos).
export function buildQueries(cfg) {
  const out = [{ id: cfg.total.id, label: cfg.total.label, query: cfg.total.base, kind: "total" }];
  const excluded = [];
  for (const g of cfg.groups) {
    if (!Array.isArray(g.anyOf) || !g.anyOf.length) throw new Error(`Grupo ${g.id} sin anyOf.`);
    const parts = [cfg.total.base, orGroup(g.anyOf), ...excluded.map((t) => `-${t}`)];
    out.push({ id: g.id, label: g.label, query: parts.join(" "), kind: "group" });
    excluded.push(...g.anyOf);
  }
  return out;
}

export function buildUrl(params) {
  return `${GDELT_BASE}?${new URLSearchParams({ format: "json", ...params })}`;
}

// ---- Peticiones -----------------------------------------------------------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function describeError(err) {
  const causeMsg = err?.cause?.message || err?.cause?.code;
  return causeMsg ? `${err.message} (causa: ${causeMsg})` : err.message;
}

const FETCH_OPTS = {
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; IranGeopoliticalMonitor/2.0)",
    Accept: "application/json",
  },
};

// GDELT responde con texto plano (no JSON) cuando la consulta no es válida
// ("too short", "too common", etc.). Se trata como error no reintentable.
export async function fetchJson(url, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...FETCH_OPTS, signal: controller.signal });
    const text = await resp.text();
    if (!resp.ok) {
      throw Object.assign(new Error(`HTTP ${resp.status} — ${text.slice(0, 160)}`), {
        rateLimited: resp.status === 429,
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`GDELT no devolvió JSON: ${text.trim().slice(0, 200)}`), {
        invalidQuery: true,
      });
    }
  } catch (err) {
    if (err.name === "AbortError") err.message = `timeout tras ${timeoutMs} ms`;
    if (/timeout|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(describeError(err))) err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWithRetries(url, { backoffMs, log = console.error, label = "" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= backoffMs.length + 1; attempt++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastErr = err;
      log(`[gdelt] ${label} intento ${attempt}/${backoffMs.length + 1} falló: ${describeError(err)}`);
      if (err.invalidQuery) break; // repetir no lo arregla
      if (attempt <= backoffMs.length) await sleep(backoffMs[attempt - 1]);
    }
  }
  throw lastErr;
}

// Convierte data.timeline[0].data en puntos diarios. Si GDELT devuelve una
// resolución menor que un día (lo hace con ventanas cortas), se aborta en vez
// de guardar valores horarios como si fueran diarios.
export function parseDailyTimeline(data) {
  const raw = (data?.timeline && data.timeline[0] && data.timeline[0].data) || [];
  const seen = new Set();
  const points = [];
  for (const p of raw) {
    const digits = String(p.date || "").replace(/\D/g, "");
    if (digits.length < 8) continue;
    const time = digits.slice(8, 14);
    const day = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    if ((time && !/^0*$/.test(time)) || seen.has(day)) {
      throw Object.assign(
        new Error(`GDELT devolvió resolución inferior a un día (${p.date}); amplía MIN_WINDOW_DAYS.`),
        { badResolution: true }
      );
    }
    seen.add(day);
    const value = Number(p.value);
    if (!Number.isFinite(value)) continue;
    const pt = { date: day, value };
    if (p.norm !== undefined && Number.isFinite(Number(p.norm))) pt.norm = Number(p.norm);
    points.push(pt);
  }
  return points;
}

// ---- GitHub Actions ---------------------------------------------------------

export const gh = {
  warning: (msg) => console.log(`::warning title=gdelt::${msg}`),
  error: (msg) => console.log(`::error title=gdelt::${msg}`),
  summary: (md) => {
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch {}
  },
};
