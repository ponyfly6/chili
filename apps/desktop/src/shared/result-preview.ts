export const MAX_RESULT_TEXT_BYTES = 512_000;
export const MAX_RESULT_IMAGE_BYTES = 4_000_000;

export type DesktopResultKind = "text" | "markdown" | "code" | "html" | "image";
export type DesktopResultRead = {
  status: "ready";
  path: string;
  kind: DesktopResultKind;
  content: string;
  mimeType: string;
  bytes: number;
  previewUrl?: string;
} | {
  status: "unavailable";
  reason: "outside_workspace" | "missing" | "unsupported" | "too_large" | "not_file" | "invalid_text" | "unavailable";
};

export function isResultPreviewUrl(value: string): boolean {
  if (value.length > 13_000 || /[\\\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "chili-result:" && !url.username && !url.password && !url.port
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(url.hostname)
      && url.pathname !== "/" && !url.search;
  } catch { return false; }
}

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "jsonc", "css", "scss", "less",
  "xml", "svg", "yaml", "yml", "toml", "ini", "py", "rs", "go", "java", "c", "h",
  "cpp", "hpp", "cs", "swift", "kt", "rb", "php", "sh", "bash", "zsh", "sql", "vue", "svelte",
]);

export function resultFileType(path: string): { kind: DesktopResultKind; mimeType: string } | undefined {
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  const extension = name.split(".").at(-1) ?? "";
  if (extension === "md" || extension === "markdown") return { kind: "markdown", mimeType: "text/markdown" };
  if (extension === "html" || extension === "htm") return { kind: "html", mimeType: "text/html" };
  const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  if (imageTypes[extension]) return { kind: "image", mimeType: imageTypes[extension] };
  if (CODE_EXTENSIONS.has(extension)) return { kind: "code", mimeType: "text/plain" };
  if (["txt", "csv", "tsv", "log", "diff", "patch", "rst"].includes(extension)
    || ["readme", "license", "makefile", "dockerfile", ".gitignore"].includes(name)) {
    return { kind: "text", mimeType: "text/plain" };
  }
  return undefined;
}
