// CSS imported as text (esbuild's text loader, see tools/build.mjs).
declare module '*.css' {
  const text: string;
  export default text;
}
