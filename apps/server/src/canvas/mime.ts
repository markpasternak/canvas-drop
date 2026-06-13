/**
 * Extension → MIME mapping for canvas assets (§6.1.6). Anything not in the safe
 * map — including server-side executables — is served as `text/plain` and never
 * interpreted (§6.1.19, §12.1.5), always with `X-Content-Type-Options: nosniff`.
 */
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  wasm: "application/wasm",
  csv: "text/csv; charset=utf-8",
};

/** Extensions explicitly downgraded to text even though a "native" type exists. */
const BLOCKED_EXECUTABLE = new Set([
  "php",
  "phtml",
  "asp",
  "aspx",
  "jsp",
  "cgi",
  "pl",
  "py",
  "rb",
  "sh",
  "bash",
  "exe",
  "bat",
  "cmd",
  "com",
  "dll",
  "so",
  "bin",
]);

export interface MimeResult {
  contentType: string;
  /** True when the type was downgraded to text/plain (a deploy-time warning, §6.1.19). */
  downgraded: boolean;
}

export function mimeFor(path: string): MimeResult {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (BLOCKED_EXECUTABLE.has(ext)) {
    return { contentType: "text/plain; charset=utf-8", downgraded: true };
  }
  const known = MIME[ext];
  if (known) return { contentType: known, downgraded: false };
  // Unknown extension → safe default, downgraded.
  return { contentType: "text/plain; charset=utf-8", downgraded: true };
}
