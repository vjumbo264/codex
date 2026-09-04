// Node ESM loader shim for tests ONLY: wrangler's wrangler.toml
// `rules = [{ type = "Data", globs = ["**/*.ttf"] }]` bundles fonts as
// ArrayBuffers in production. Node has no equivalent, so register a
// resolve+load hook that hands back an empty ArrayBuffer for .ttf
// imports. The regression tests exercise telegram.js/gemini.js logic —
// they never render PDFs, so the stub bytes are never read.
// Use: node --import ./test/ttf-loader.mjs test/<suite>.test.mjs
import { register } from 'node:module';
register(new URL('./ttf-hooks.mjs', import.meta.url));
