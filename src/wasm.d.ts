// Wrangler bundles .wasm imports as compiled WebAssembly.Module values.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
