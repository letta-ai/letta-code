export interface ImageEntry {
  data: string;
  mediaType: string;
  filename?: string;
}

const textRegistry = new Map<number, string>();

const imageRegistry = new Map<number, ImageEntry>();

let nextId = 1;

export function allocatePaste(content: string): number {
  const id = nextId++;
  textRegistry.set(id, content);
  return id;
}

export function resolvePlaceholders(text: string): string {
  if (!text) return text;
  let result = text.replace(
    /\[Pasted text #(\d+) \+(\d+) lines\]/g,
    (_match, idStr) => {
      const id = Number(idStr);
      const content = textRegistry.get(id);
      return content !== undefined ? content : _match;
    },
  );
  result = result.replace(/↵/g, "\n");
  return result;
}

export function extractTextPlaceholderIds(text: string): number[] {
  const ids: number[] = [];
  if (!text) return ids;
  const re = /\[Pasted text #(\d+) \+(\d+) lines\]/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex matching
  while ((match = re.exec(text)) !== null) {
    const id = Number(match[1]);
    if (!Number.isNaN(id)) ids.push(id);
  }
  return ids;
}

export function hasAnyTextPlaceholders(text: string): boolean {
  return /\[Pasted text #\d+ \+\d+ lines\]/.test(text || "");
}

export function allocateImage(args: {
  data: string;
  mediaType: string;
  filename?: string;
}): number {
  const id = nextId++;
  imageRegistry.set(id, {
    data: args.data,
    mediaType: args.mediaType,
    filename: args.filename,
  });
  return id;
}

export function getImage(id: number): ImageEntry | undefined {
  return imageRegistry.get(id);
}

export function extractImagePlaceholderIds(text: string): number[] {
  const ids: number[] = [];
  if (!text) return ids;
  const re = /\[Image #(\d+)\]/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex matching
  while ((match = re.exec(text)) !== null) {
    const id = Number(match[1]);
    if (!Number.isNaN(id)) ids.push(id);
  }
  return ids;
}

export function hasAnyImagePlaceholders(text: string): boolean {
  return /\[Image #\d+\]/.test(text || "");
}

export function clearPlaceholdersInText(text: string): void {
  for (const id of extractTextPlaceholderIds(text)) {
    if (textRegistry.has(id)) textRegistry.delete(id);
  }
  for (const id of extractImagePlaceholderIds(text)) {
    if (imageRegistry.has(id)) imageRegistry.delete(id);
  }
}

export function releaseDiscardedPlaceholders(
  discardedText: string,
  keepTexts: ReadonlyArray<string | null | undefined> = [],
): void {
  if (!discardedText) return;
  const textIds = extractTextPlaceholderIds(discardedText);
  const imageIds = extractImagePlaceholderIds(discardedText);
  if (textIds.length === 0 && imageIds.length === 0) return;

  const keptTextIds = new Set<number>();
  const keptImageIds = new Set<number>();
  for (const keepText of keepTexts) {
    if (!keepText) continue;
    for (const id of extractTextPlaceholderIds(keepText)) keptTextIds.add(id);
    for (const id of extractImagePlaceholderIds(keepText)) keptImageIds.add(id);
  }

  for (const id of textIds) {
    if (!keptTextIds.has(id)) textRegistry.delete(id);
  }
  for (const id of imageIds) {
    if (!keptImageIds.has(id)) imageRegistry.delete(id);
  }
}

type Base64ImageSource = { type: "base64"; media_type: string; data: string };
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: Base64ImageSource };

export function buildMessageContentFromDisplay(text: string): ContentPart[] {
  const parts: ContentPart[] = [];
  if (!text) return [{ type: "text", text: "" }];

  const re = /\[Image #(\d+)\]/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;

  const pushText = (s: string) => {
    if (!s) return;
    const resolved = resolvePlaceholders(s);
    if (resolved.length === 0) return;
    const prev = parts[parts.length - 1];
    if (prev && prev.type === "text") {
      prev.text = (prev.text || "") + resolved;
    } else {
      parts.push({ type: "text", text: resolved });
    }
  };

  // biome-ignore lint/suspicious/noAssignInExpressions: Standard pattern for regex matching
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const before = text.slice(lastIdx, start);
    pushText(before);
    const id = Number(match[1]);
    const img = getImage(id);
    if (img?.data) {
      parts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType || "image/jpeg",
          data: img.data,
        },
      });
    } else {
      pushText(match[0]);
    }
    lastIdx = end;
  }
  pushText(text.slice(lastIdx));

  if (parts.length === 0) return [{ type: "text", text }];
  return parts;
}
