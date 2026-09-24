# Iran Geopolitical Monitor

Panel del tono medio de cobertura mediática sobre Irán (GDELT DOC 2.0 API),
con benchmarks históricos fijos. Sitio estático de un único fichero
(`index.html`), sin backend ni build.

## Cómo funciona

```
GitHub Actions (cron diario, 06:00 UTC + reintento 15:00 UTC)
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
  (`query=Iran&mode=timelinetone`, con `startdatetime`/`enddatetime` fijos).
  Funciona en modo **append-only**: la serie embebida en `index.html` es el
  histórico persistido y cada ejecución pide solo una ventana corta (los
  últimos días + huecos recientes) y la fusiona por fecha, sin borrar nunca
  un día ya guardado. Reintenta hasta 3 veces respetando el límite de GDELT
  (≥ 5 s entre peticiones); si GDELT falla del todo, conserva los datos y
  marca `stale: true` en vez de romper el sitio.
- **Huecos (`knownGaps`)** — todo día entre el 28 feb 2026 y el último dato
  que no tenga valor queda listado en `knownGaps` del JSON embebido, con su
  motivo (`gdelt-no-data`: se pidió y GDELT no lo devolvió;
  `backfill-failed`: la petición falló; `not-captured`). Los huecos de
  menos de 14 días se reintentan en cada ejecución; para forzar el
  reintento de uno antiguo, bórralo de `knownGaps`.
- **Run en rojo** — el script sale con código 1 si la validación falla (se
  perdería un día guardado, hueco sin documentar…), si los datos llevan más
  de 48 h sin refrescarse, o si GDELT responde pero sin días recientes.
- **`index.html`** — contiene los datos embebidos en
  `<script type="application/json" id="tone-data-json">`. El resto del
  JavaScript del panel (gráfico, pestañas 7 Days / 1 Month / War Total,
  cálculo de media/desviación típica, "Automated Assessment") lee ese
  bloque directamente: no hace `fetch` a ningún endpoint ni a GDELT.
- **`.github/workflows/update-data.yml`** — dispara `update-data.mjs` dos
  veces al día (06:00 y 15:00 UTC) en los servidores de GitHub (no depende de que ningún
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
- Rango histórico: la pestaña "War Total" cubre desde `WAR_START`
  (2026-02-28, constante en `scripts/update-data.mjs`) y crece cada día; ya
  no hay ventana móvil. Las pestañas de `index.html` recortan esa misma
  serie en el propio navegador, sin volver a llamar a GDELT.
- Recuperar días antiguos: `node scripts/backfill-from-git-history.mjs`
  busca en versiones anteriores de `index.html` (historial de git) días que
  falten en la serie actual; con `--write` los añade sin sobrescribir nada.

## Tabla "Historical Extremes"

Los 12 eventos de la tabla son una **instantánea editorial fija**, escrita
a mano: no se derivan del JSON embebido ni se recalculan. GDELT puede
revisar el tono de artículos antiguos, así que conviene contrastarlos de
vez en cuando con la serie (última comprobación, 24 sept 2026: los 10
eventos que caen dentro de la serie disponible —del 22 mar en adelante—
coinciden al centésimo; los del 28 feb y 1 mar no se pudieron contrastar
porque GDELT no ha devuelto esos días en ninguna versión guardada).

## Historial

Este proyecto usaba antes Netlify Scheduled Functions + Netlify Blobs
para cachear los datos servidos vía `/api/geopolitical-data`. Esa capa se
retiró en favor de datos estáticos embebidos directamente en `index.html`,
actualizados por GitHub Actions — mismo objetivo (que el navegador nunca
llame a GDELT), sin depender de funciones serverless ni de un proveedor de
hosting concreto.
