# Iran Geopolitical Monitor

Panel del tono medio de la cobertura mediática sobre Irán (GDELT DOC 2.0),
con una **descomposición del efecto guerra** y benchmarks históricos fijos.
Sitio estático, sin backend ni build.

## Cómo funciona

```
series.config.json         ← qué series hay (consulta total + grupos)
        │
GitHub Actions (06:00 y 15:00 UTC)
        │
scripts/update-data.mjs ──GDELT server-side──▶ data/<serie>.<modo>.json
        │                                       data/bundle.js
        ▼
commit + push automático de data/ (si hubo cambios)
        │
        ▼
index.html carga data/bundle.js y hace todos los cálculos en el navegador
(nunca llama a GDELT; funciona también abierto como fichero local)
```

### Series

`series.config.json` define:

- **total** — `Iran`: toda la cobertura. Es la serie del gráfico principal.
- **groups** — subconjuntos **disjuntos** de la total, en orden de prioridad.
  Cada grupo excluye las palabras de los anteriores, así un artículo cae en
  un solo grupo. Ahora mismo: *diplomacy* (negociaciones, alto el fuego,
  Araghchi, Witkoff…) y después *military* (guerra, misiles, IRGC, Hormuz…).
  Un artículo que habla de negociaciones y de misiles cuenta como diplomacia.
- **rest** — "todo lo demás". No se pide a GDELT: se calcula en el navegador
  como `total − grupos` (volumen y tono ponderado).

De cada serie se descargan dos modos: `tone` (`timelinetone`, tono medio
diario) y `volraw` (`timelinevolraw`, nº de artículos). Son 6 peticiones
por ejecución, separadas 15 s (GDELT exige ≥ 5 s).

### La descomposición

Para el periodo elegido frente al anterior de igual duración (War Total:
primeros 30 días frente a últimos 30), con medias ponderadas por volumen:

```
tono_total = Σ cuota_g · tono_g
Δtono_total = Σ cuota̅_g · Δtono_g            ← efecto tono (el grupo suena distinto)
            + Σ (tono̅_g − T̄) · Δcuota_g      ← efecto mezcla (el grupo pesa más o menos)
```

Es exacta: efecto tono + efecto mezcla = cambio total. Responde a si el
tono se mueve porque la guerra "suena menos mal" o porque hay más noticias
de otro tipo.

### Robustez del pipeline

Cada fichero de `data/` es independiente y **append-only**:

- se pide una ventana reciente (mínimo 60 días, para que GDELT responda con
  resolución diaria; si no, el run falla en vez de guardar datos horarios);
- se fusiona por fecha y nunca se borra un día ya guardado;
- los días sin dato quedan en `knownGaps` con su motivo; los de menos de
  14 días se reintentan a diario;
- si GDELT falla, esa serie se marca `stale` y las demás siguen. Si dos
  series seguidas reciben 429/timeout, no se insiste en esa ejecución.

El run sale **en rojo** si una serie no valida, lleva más de 48 h sin
refrescarse, GDELT rechaza una consulta o no trae días recientes.

## Cambiar las palabras clave

1. Edita `anyOf` del grupo en `series.config.json`.
2. Pruébalo: pestaña **Actions → "Probar consultas GDELT" → Run workflow**.
   El resumen del run muestra si GDELT acepta la consulta, qué % del
   volumen se lleva cada grupo y titulares de ejemplo.
3. Haz commit. En la siguiente ejecución, el script detecta que la consulta
   ha cambiado, archiva los datos anteriores en `data/archive/` y descarga
   esa serie entera desde `warStart`. No se mezclan definiciones.

## Uso manual

```bash
node scripts/update-data.mjs     # descarga y actualiza data/
node scripts/probe-queries.mjs   # prueba las consultas sin tocar data/
node scripts/build-bundle.mjs    # regenera data/bundle.js sin llamar a GDELT
```

## Tabla "Historical Extremes"

Los 12 eventos son una **instantánea editorial fija**, escrita a mano: no
se recalculan a partir de `data/`. GDELT puede revisar el tono de artículos
antiguos, así que conviene contrastarlos de vez en cuando (24 sept 2026: los
10 eventos desde el 22 mar coinciden al centésimo con la serie).

## Limitaciones

- GDELT puntúa el tono del artículo entero: un texto que mezcla la guerra
  con otro tema no se puede partir.
- Los grupos dependen de las palabras elegidas. Revisa los titulares del
  workflow de prueba antes de fiarte de un grupo.
- Cuando los grupos cubren casi todo el volumen, el "resto" derivado se
  calcula con pocos artículos y su tono es ruidoso.
- La serie arranca el 10 mar 2026 salvo que GDELT devuelva días anteriores;
  del 1 al 4 jul y del 14 al 19 sept 2026 GDELT no tiene datos.

## Historial

- Netlify Scheduled Functions + Blobs → datos embebidos en `index.html`
  actualizados por GitHub Actions → (sept 2026) `data/` con varias series y
  descomposición del efecto guerra.
