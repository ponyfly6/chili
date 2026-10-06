/** Bun embeds this file in standalone executables and returns its readable virtual path. */
declare module "quickjs-wasi/quickjs.wasm" {
  const path: string;
  export default path;
}
