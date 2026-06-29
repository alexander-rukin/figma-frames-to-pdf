declare module "pako" {
  export function inflate(data: Uint8Array | ArrayBuffer): Uint8Array;
  export function deflate(data: Uint8Array, opts?: { level?: number }): Uint8Array;
}

// esbuild base64 loader: imports the font file as a base64 string.
declare module "*.ttf" {
  const base64: string;
  export default base64;
}

declare module "@pdf-lib/fontkit" {
  const fontkit: unknown;
  export default fontkit;
}
