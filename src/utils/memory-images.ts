const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function getLowercaseExtension(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  if (lastDot <= lastSlash) return "";
  return path.slice(lastDot).toLowerCase();
}

export function getMemoryImageMimeType(path: string): string | null {
  return IMAGE_MIME_BY_EXTENSION[getLowercaseExtension(path)] ?? null;
}

export function isMarkdownMemoryPath(path: string): boolean {
  return getLowercaseExtension(path) === ".md";
}
