# Iran Geopolitical Monitor

Panel del tono medio de cobertura mediática sobre Irán (GDELT DOC 2.0 API),
con benchmarks históricos fijos. Sitio estático de un único fichero
(`index.html`), sin backend ni build.

## Cómo funciona

```
GitHub Actions (cron diario, 06:00 UTC)
        │
        ▼
scripts/update-data.mjs  ──llama a GDELT server-side──▶  reescribe el bloque
                                                          de datos embebido
                                                          en index.html
        │
        ▼
   commit + push automático (si hubo cambios)
        │
        ▼
   index.html se sirve tal cual (Netlify, GitHub Pages, o cualquier
   hosting estático) — nunca hace peticiones de red al cargarse.
```

- **`scripts/update-data.mjs`** — único sitio del repo que llama a GDELT
  (`query=Iran&mode=timelinetone&timespan=6m&format=json`). Reintenta hasta
  3 veces con backoff; si GDELT falla del todo, conserva los datos del día
  anterior y marca `stale: true` en vez de romper el sitio.
- **`index.html`** — contiene los datos embebidos en
  `<script type="application/json" id="tone-data-json">`. El resto del
  JavaScript del panel (gráfico, pestañas 7 Days / 1 Month / War Total,
  cálculo de media/desviación típica, "Automated Assessment") lee ese
  bloque directamente: no hace `fetch` a ningún endpoint ni a GDELT.
- **`.github/workflows/update-data.yml`** — dispara `update-data.mjs` una
  vez al día en los servidores de GitHub (no depende de que ningún
  ordenador esté encendido) y comitea el resultado con el token que
  GitHub Actions genera automáticamente para cada ejecución.

## Actualizar los datos a mano

```bash
node scripts/update-data.mjs
```

Sobrescribe el bloque de datos de `index.html` en el sitio. Revisa el
`git diff` y comitea si el resultado tiene sentido.

También puedes lanzar el workflow a mano desde la pestaña **Actions** del
repo en GitHub (botón "Run workflow" sobre "Actualización diaria de datos
GDELT"), sin esperar a las 06:00 UTC.

## Cambiar la frecuencia o el rango de datos

- Frecuencia: edita el `cron` en `.github/workflows/update-data.yml`
  (sintaxis cron estándar, en UTC).
- Rango histórico: `scripts/update-data.mjs` pide `timespan=6m` a GDELT
  (6 meses, resolución diaria). Las pestañas de `index.html` recortan esa
  misma serie en el propio navegador, sin volver a llamar a GDELT.

## Historial

Este proyecto usaba antes Netlify Scheduled Functions + Netlify Blobs
para cachear los datos servidos vía `/api/geopolitical-data`. Esa capa se
retiró en favor de datos estáticos embebidos directamente en `index.html`,
actualizados por GitHub Actions — mismo objetivo (que el navegador nunca
llame a GDELT), sin depender de funciones serverless ni de un proveedor de
hosting concreto.
