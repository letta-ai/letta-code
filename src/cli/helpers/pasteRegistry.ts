// Clipboard paste registry - manages mappings from placeholders to actual content
// Supports both large text pastes and image pastes (multi-modal)

export interface ImageEntry {
  data: string; // base64
  mediaType: string;
  filename?: string;
}

// Text placeholder registry (for large pasted text collapsed into a placeholder)
const textRegistry = new Map<number, string>();

// Image placeholder registry (maps id -> base64 + mediaType)
const imageRegistry = new Map<number, ImageEntry>();

let nextId = 1;

// ---------- Text placeholders ----------

export function allocatePaste(content: string): number {
  const id = nextId++;
  textRegistry.set(id, content);
  return id;
}

export function resolvePlaceholders(text: string): string {
  if (!text) return text;
  return text.replace(
    /\[Pasted text #(\d+) \+(\d+) lines\]/g,
    (_match, idStr) => {
      const id = Number(idStr);
      const content = textRegistry.get(id);
      return content !== undefined ? content : _match;
    },
  );
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

// ---------- Image placeholders ----------

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

// ---------- Cleanup ----------

export function clearPlaceholdersInText(text: string): void {
  // Clear text placeholders referenced in this text
  for (const id of extractTextPlaceholderIds(text)) {
    if (textRegistry.has(id)) textRegistry.delete(id);
  }
  // Clear image placeholders referenced in this text
  for (const id of extractImagePlaceholderIds(text)) {
    if (imageRegistry.has(id)) imageRegistry.delete(id);
  }
}

// ---------- Content Builder ----------

// Convert display text (with placeholders) into Letta content parts
// Text placeholders are resolved; image placeholders become image content
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
      // If mapping missing, keep the literal placeholder as text
      pushText(match[0]);
    }
    lastIdx = end;
  }
  // Remainder
  pushText(text.slice(lastIdx));

  if (parts.length === 0) return [{ type: "text", text }];
  return parts;
}
