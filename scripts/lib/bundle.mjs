// scripts/lib/bundle.mjs
//
// Genera data/bundle.js a partir de data/<serie>.<modo>.json. Es lo que
// carga index.html con <script src>, así la página funciona igual en la
// web que abierta como fichero local (file://), donde fetch() no va.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { buildQueries } from "./gdelt.mjs";

export const MODES = ["tone", "volraw"];

export function writeBundle(cfg, dataDir) {
  const out = { generatedAt: new Date().toISOString(), config: cfg, queries: {}, units: {} };
  for (const q of buildQueries(cfg)) {
    out.queries[q.id] = q.query;
    for (const mode of MODES) {
      const f = path.join(dataDir, `${q.id}.${mode}.json`);
      if (!existsSync(f)) continue;
      const d = JSON.parse(readFileSync(f, "utf8"));
      out.units[`${q.id}.${mode}`] = {
        series: d.series.map((p) => (p.norm === undefined ? [p.date, p.value] : [p.date, p.value, p.norm])),
        lastUpdated: d.lastUpdated ?? null,
        stale: Boolean(d.stale),
        knownGaps: d.knownGaps || [],
        lastError: d.lastError ? d.lastError.message : null,
      };
    }
  }
  writeFileSync(
    path.join(dataDir, "bundle.js"),
    "// Generado por scripts/update-data.mjs — no editar a mano.\nwindow.GEO_DATA = " + JSON.stringify(out) + ";\n"
  );
}
