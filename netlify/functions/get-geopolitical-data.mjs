// netlify/functions/get-geopolitical-data.mjs
//
// Endpoint público: GET /api/geopolitical-data
// Lee el último payload guardado por fetch-gdelt-scheduled.mjs y lo
// devuelve tal cual. El frontend llama SOLO a esto — nunca a GDELT
// directamente — así que da igual cuánta gente tenga el panel abierto:
// GDELT solo recibe tráfico de la función programada, una vez por hora.

import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("gdelt");
  let data = null;
  try {
    data = await store.get("geopolitical-data", { type: "json" });
  } catch {
    data = null;
  }

  const body =
    data ?? {
      series: [],
      updatedAt: null,
      error:
        "Aún no hay datos guardados. El primer ciclo programado puede tardar hasta 1 hora tras el despliegue, o dispáralo a mano (ver README).",
    };

  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
};

export const config = {
  path: "/api/geopolitical-data",
};
