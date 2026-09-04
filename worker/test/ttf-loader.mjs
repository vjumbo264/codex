// Node ESM loader shim for tests ONLY: wrangler's wrangler.toml
// `rules = [{ type = "Data", globs = ["**/*.ttf"] }]` bundles fonts as
// ArrayBuffers in production. Node has no equivalent, so register a
// resolver+load hook that hands back an empty ArrayBuffer for .ttf
// imports. The regression tests exercise telegram.js/gemini.js logic —
// they never render PDFs, so the stub bytes are never read.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.ttf')) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.endsWith('.ttf')) {
    return { format: 'module', source: 'export default new ArrayBuffer(0);', shortCircuit: true };
  }
  return nextLoad(url, context);
}
