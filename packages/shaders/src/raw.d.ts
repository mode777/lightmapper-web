/**
 * Vite `?raw` imports of the canonical .wgsl sources
 * (validated by tools/wgsl-check in CI).
 */
declare module '*.wgsl?raw' {
  const source: string;
  export default source;
}
