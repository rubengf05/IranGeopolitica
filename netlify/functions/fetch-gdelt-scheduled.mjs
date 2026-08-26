// netlify/functions/fetch-gdelt-scheduled.mjs
//
// Función PROGRAMADA (no responde a peticiones HTTP normales — Netlify
// la ejecuta sola según "schedule" en config, más abajo).
//
// Es la ÚNICA parte de todo el proyecto que llama a GDELT. Descarga la
// serie de tono medio ("Iran", modo timelinetone, últimos 6 meses —
// resolución diaria a ese rango) y la guarda en Netlify Blobs.
//
// get-geopolitical-data.mjs y el propio index.html nunca tocan GDELT:
// solo leen lo último que esta función dejó guardado. Así, da igual
// cuánta gente tenga el panel abierto a la vez — GDELT recibe tráfico
// una vez por hora, siempre.
//
// Frecuencia: cada hora, en el minuto 0. La resolución de los datos de
// GDELT para un rango de 6 meses ya es diaria, así que consultar con
// más frecuencia que una vez por hora no aportaría datos más frescos;
// una vez por hora es suficiente para capturar cómo evoluciona el tono
// del día en curso a medida que se publican más artículos.

import { getStore } from "@netlify/blobs";
import { fetch as undiciFetch, Agent } from "undici";

const GDELT_URL =
  "https://api.gdeltproject.org/api/v2/doc/doc?query=Iran&mode=timelinetone&timespan=6m&format=json";

// Netlify corta las Scheduled Functions a los 30s (límite duro, no
// configurable). Le damos 25s a la conexión con GDELT y dejamos ~5s de
// margen para leer la respuesta y guardarla en Blobs. No caben dos
// intentos con este timeout, por eso no hay reintento.
const TIMEOUT_MS = 25000;

// Algunos servicios rechazan o despriorizan peticiones sin User-Agent
// de navegador. El fetch de Node manda uno genérico, así que lo
// ponemos explícito por si acaso es parte del problema.
const FETCH_OPTS = {
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; IranGeopoliticalMonitor/1.0)",
    "Accept": "application/json",
  },
};

function timeoutPromise(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(Object.assign(new Error(`timeout tras ${ms / 1000}s`), { name: "TimeoutError" })), ms);
  });
}

// GDELT devuelve fechas como "20260820T000000Z" (con T y Z de por
// medio). Nos quedamos solo con los dígitos antes de trocear, así
// funciona tanto con ese formato como con "YYYYMMDDHHMMSS" pelado.
function parseGdeltDate(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 8) return null;
  const y = digits.slice(0, 4), mo = digits.slice(4, 6), d = digits.slice(6, 8);
  const hh = digits.slice(8, 10) || "00", mm = digits.slice(10, 12) || "00", ss = digits.slice(12, 14) || "00";
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`;
}

// Node envuelve el motivo real del fallo en err.cause cuando fetch()
// no llega ni a completar la conexión (DNS, TLS, conexión reiniciada).
// err.message solo dice "fetch failed", así que sacamos el detalle real.
function describeError(err) {
  const causeMsg = err?.cause?.message || err?.cause?.code;
  return causeMsg ? `${err.message} (causa: ${causeMsg})` : err.message;
}

async function fetchGdeltOnce() {
  const agent = new Agent({ connectTimeout: TIMEOUT_MS });
  const resp = await Promise.race([
    undiciFetch(GDELT_URL, { ...FETCH_OPTS, dispatcher: agent }),
    timeoutPromise(TIMEOUT_MS),
  ]);
  const rawText = await resp.text();

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} — ${rawText.slice(0, 200)}`);
  }

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

  if (!series.length) {
    throw new Error("GDELT respondió sin puntos de datos utilizables.");
  }

  return series;
}

export default async () => {
  const store = getStore("gdelt");

  try {
    const series = await fetchGdeltOnce();

    await store.setJSON("geopolitical-data", {
      series,
      updatedAt: new Date().toISOString(),
      source: GDELT_URL,
    });

    console.log(`[fetch-gdelt-scheduled] OK — ${series.length} puntos guardados.`);
  } catch (err) {
    console.error(`[fetch-gdelt-scheduled] Fallo: ${describeError(err)}`);

    // No borramos el histórico si ya había uno válido: guardamos el
    // error junto a los últimos datos buenos, para que el frontend
    // pueda seguir mostrando el gráfico y avisar de que la última
    // actualización falló, en vez de quedarse sin nada.
    let previous = null;
    try {
      previous = await store.get("geopolitical-data", { type: "json" });
    } catch {
      previous = null;
    }

    await store.setJSON("geopolitical-data", {
      series: previous?.series ?? [],
      updatedAt: previous?.updatedAt ?? null,
      lastError: { message: describeError(err), at: new Date().toISOString() },
      source: GDELT_URL,
    });
  }
};

export const config = {
  schedule: "0 * * * *", // cada hora, en punto
};
