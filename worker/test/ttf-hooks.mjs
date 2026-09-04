// Worker-thread hooks for ttf-loader.mjs (registered via module.register).
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
