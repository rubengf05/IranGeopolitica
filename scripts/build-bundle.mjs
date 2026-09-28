#!/usr/bin/env node
// Regenera data/bundle.js sin llamar a GDELT (p. ej. tras editar data/ a mano).
import path from "node:path";
import { ROOT, loadConfig } from "./lib/gdelt.mjs";
import { writeBundle } from "./lib/bundle.mjs";
writeBundle(loadConfig(), process.env.DATA_DIR || path.join(ROOT, "data"));
console.log("data/bundle.js regenerado.");
