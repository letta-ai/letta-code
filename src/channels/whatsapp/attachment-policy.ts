import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, sep } from "node:path";
import {
  isGroupJid,
  isLidJid,
  isStrictPhoneJid,
  normalizeMaybePhoneJid,
  normalizePhoneLike,
  stripDeviceSuffix,
} from "./jid";

/** Extension classification only; this does not inspect file contents. */
const WHATSAPP_ATTACHMENT_MIME_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

export type WhatsAppAttachmentPolicyDecision =
  | {
      allowed: true;
      mediaPath: string;
      mimeType: string;
    }
  | {
      allowed: false;
      reason: string;
    };

export type WhatsAppAttachmentPolicyInput = {
  policy: {
    enabled: boolean;
    allowedMimeTypes: readonly string[];
    allowedRecipients: readonly string[];
    allowedDirectories: readonly string[];
    recursiveDirectories: boolean;
  };
  mediaPath: string;
  targetJid: string;
};

function deny(reason: string): WhatsAppAttachmentPolicyDecision {
  return { allowed: false, reason: `Attachment denied: ${reason}` };
}

function inferMimeType(mediaPath: string): string {
  return (
    WHATSAPP_ATTACHMENT_MIME_TYPES[extname(mediaPath).toLowerCase()] ??
    "application/octet-stream"
  );
}

export function inferWhatsAppAttachmentMimeType(mediaPath: string): string {
  return inferMimeType(mediaPath);
}

function isMimeAllowed(
  mimeType: string,
  allowedMimeTypes: readonly string[],
): boolean {
  const normalizedMimeType = mimeType.toLowerCase();
  return allowedMimeTypes.some((allowedMimeType) => {
    const normalizedAllowedMimeType = allowedMimeType.trim().toLowerCase();
    if (normalizedAllowedMimeType === "*") return true;
    if (normalizedAllowedMimeType === normalizedMimeType) return true;
    if (normalizedAllowedMimeType.endsWith("/*")) {
      const prefix = normalizedAllowedMimeType.slice(0, -1);
      return normalizedMimeType.startsWith(prefix);
    }
    return false;
  });
}

function normalizeGroupRecipient(value: string): string | null {
  const normalized = stripDeviceSuffix(value);
  if (!isGroupJid(normalized)) return null;
  const localPart = normalized.slice(0, -"@g.us".length);
  return localPart && !/\s/.test(localPart) ? normalized : null;
}

type NormalizedRecipientTarget =
  | { kind: "direct"; phoneDigits: string }
  | { kind: "group"; groupJid: string };

function normalizeRecipientTarget(
  targetJid: string,
): NormalizedRecipientTarget | null {
  const normalizedTargetJid = stripDeviceSuffix(targetJid);
  const groupJid = normalizeGroupRecipient(normalizedTargetJid);
  if (groupJid) return { kind: "group", groupJid };
  if (!isStrictPhoneJid(normalizedTargetJid)) return null;
  return {
    kind: "direct",
    phoneDigits: normalizePhoneLike(normalizedTargetJid),
  };
}

function isDirectRecipientAllowed(
  targetPhoneDigits: string,
  allowedRecipients: readonly string[],
): boolean {
  return allowedRecipients.some((recipient) => {
    if (isGroupJid(recipient) || isLidJid(recipient)) return false;
    const phoneJid = normalizeMaybePhoneJid(recipient);
    return (
      phoneJid !== null &&
      isStrictPhoneJid(phoneJid) &&
      normalizePhoneLike(phoneJid) === targetPhoneDigits
    );
  });
}

function isRecipientAllowed(
  targetJid: string,
  allowedRecipients: readonly string[],
): boolean {
  const normalizedTarget = normalizeRecipientTarget(targetJid);
  if (!normalizedTarget) return false;
  if (allowedRecipients.includes("*")) return true;
  if (normalizedTarget.kind === "group") {
    return allowedRecipients.some(
      (recipient) =>
        normalizeGroupRecipient(recipient) === normalizedTarget.groupJid,
    );
  }
  return isDirectRecipientAllowed(
    normalizedTarget.phoneDigits,
    allowedRecipients,
  );
}

function isContainedFile(
  resolvedMediaPath: string,
  resolvedDirectory: string,
  recursiveDirectories: boolean,
): boolean {
  const relativePath = relative(resolvedDirectory, resolvedMediaPath);
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    return false;
  }
  return recursiveDirectories || !relativePath.includes(sep);
}

export function decideWhatsAppAttachmentPolicy(
  input: WhatsAppAttachmentPolicyInput,
): WhatsAppAttachmentPolicyDecision {
  if (!input.policy.enabled) {
    return {
      allowed: true,
      mediaPath: input.mediaPath,
      mimeType: inferMimeType(input.mediaPath),
    };
  }

  if (input.policy.allowedMimeTypes.length === 0) {
    return deny("no MIME types are allowed");
  }
  if (input.policy.allowedRecipients.length === 0) {
    return deny("no recipients are allowed");
  }
  if (!isRecipientAllowed(input.targetJid, input.policy.allowedRecipients)) {
    return deny(`recipient "${input.targetJid}" is not allowed`);
  }
  if (input.policy.allowedDirectories.length === 0) {
    return deny("no directories are allowed");
  }

  try {
    const resolvedMediaPath = realpathSync(input.mediaPath);
    if (!statSync(resolvedMediaPath).isFile()) {
      return deny("media path is not a regular file");
    }
    const mimeType = inferMimeType(resolvedMediaPath);
    if (!isMimeAllowed(mimeType, input.policy.allowedMimeTypes)) {
      return deny(`MIME type "${mimeType}" is not allowed`);
    }

    for (const directory of input.policy.allowedDirectories) {
      try {
        const resolvedDirectory = realpathSync(directory);
        if (!statSync(resolvedDirectory).isDirectory()) continue;
        if (
          isContainedFile(
            resolvedMediaPath,
            resolvedDirectory,
            input.policy.recursiveDirectories,
          )
        ) {
          return {
            allowed: true,
            mediaPath: resolvedMediaPath,
            mimeType,
          };
        }
      } catch {}
    }
  } catch {
    return deny("media or directory path could not be safely resolved");
  }

  return deny("media path is outside the allowed directories");
}
