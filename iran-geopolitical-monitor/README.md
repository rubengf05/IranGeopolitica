# Iran Geopolitical Monitor

Panel del tono medio de cobertura mediática sobre Irán (GDELT DOC 2.0 API),
con benchmarks históricos fijos.

## Cómo funciona

```
fetch-gdelt-scheduled.mjs  →  Netlify Blobs  →  get-geopolitical-data.mjs  →  index.html
   (llama a GDELT,               (guarda el         (lee la caché y          (lee /api/...,
    1 vez por hora)                último payload)    la sirve tal cual)       nunca llama a GDELT)
```

- **`netlify/functions/fetch-gdelt-scheduled.mjs`** — única función que llama a GDELT.
  Se ejecuta sola cada hora (`schedule: "0 * * * *"`), pide el tono medio de los
  últimos 6 meses y lo guarda en Netlify Blobs.
- **`netlify/functions/get-geopolitical-data.mjs`** — endpoint público
  `GET /api/geopolitical-data`. Lee lo último guardado en Blobs y lo devuelve.
- **`index.html`** — solo llama a `/api/geopolitical-data`. Da igual cuánta
  gente tenga la página abierta: GDELT nunca recibe tráfico directo desde el
  navegador de nadie.

## Desplegar

1. `npm install` (instala `@netlify/blobs`, necesaria para las dos funciones).
2. Sube el proyecto a un repo Git y conéctalo en Netlify, o despliega la
   carpeta con `netlify deploy --prod` (Netlify CLI).
3. Netlify Blobs no necesita configuración adicional: está disponible por
   defecto en cualquier sitio de Netlify.
4. Las Scheduled Functions solo se activan **en producción** — no se
   ejecutan solas en `netlify dev` ni en despliegues de vista previa.

## Primer arranque

El primer ciclo programado puede tardar hasta 1 hora tras el despliegue.
Hasta entonces, `index.html` mostrará "No historical data available" y
`/api/geopolitical-data` devolverá un mensaje de "aún no hay datos".

Para no esperar, dispara la función a mano con Netlify CLI:

```bash
netlify functions:invoke fetch-gdelt-scheduled
```

(Requiere tener el sitio enlazado con `netlify link` y estar autenticado
con `netlify login`.)

## Cambiar la frecuencia de actualización

Edita el valor de `schedule` en `fetch-gdelt-scheduled.mjs` (sintaxis cron
estándar, en UTC):

```js
export const config = {
  schedule: "0 * * * *", // cada hora — cámbialo si lo necesitas más o menos frecuente
};
```

Por ejemplo, `"0 */3 * * *"` para cada 3 horas, o `"0 6,18 * * *"` para
dos veces al día (6:00 y 18:00 UTC).

## Cambiar el rango de datos guardado

`fetch-gdelt-scheduled.mjs` pide `timespan=6m` a GDELT (6 meses, resolución
diaria). Las tres pestañas de `index.html` ("7 Days", "1 Month", "War Total")
recortan esa misma serie en el cliente, sin volver a llamar a GDELT. Si
necesitas más histórico, sube ese valor (por ejemplo `1y`).
