import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAttachmentPolicy,
  inferMimeType,
  MIME_EXTENSION_MAP,
  type AttachmentPolicyParams,
} from "@/channels/whatsapp/media";

const NO_FILTER: AttachmentPolicyParams = {
  attachmentFilter: false,
  attachmentMimeTypes: [],
  attachmentAllowedRecipients: [],
  attachmentAllowedPaths: [],
  attachmentPathRecursive: false,
};

const ALL_ALLOWED: AttachmentPolicyParams = {
  attachmentFilter: true,
  attachmentMimeTypes: ["*"],
  attachmentAllowedRecipients: ["*"],
  attachmentAllowedPaths: [],
  attachmentPathRecursive: false,
};

function basePolicyDir(dir: string): string {
  return dir;
}

describe("inferMimeType", () => {
  test("maps common extensions", () => {
    expect(inferMimeType("photo.png")).toBe("image/png");
    expect(inferMimeType("song.mp3")).toBe("audio/mpeg");
    expect(inferMimeType("doc.pdf")).toBe("application/pdf");
  });

  test("returns octet-stream for unknown extensions", () => {
    expect(inferMimeType("file.xyz")).toBe("application/octet-stream");
  });

  test("MIME_EXTENSION_MAP covers core types", () => {
    expect(MIME_EXTENSION_MAP[".jpg"]).toBe("image/jpeg");
    expect(MIME_EXTENSION_MAP[".ogg"]).toBe("audio/ogg");
    expect(MIME_EXTENSION_MAP[".mp4"]).toBe("video/mp4");
    expect(MIME_EXTENSION_MAP[".json"]).toBe("application/json");
  });
});

describe("checkAttachmentPolicy", () => {
  test("filter disabled always returns null", () => {
    expect(
      checkAttachmentPolicy({
        policy: NO_FILTER,
        mediaPath: "/tmp/anything.png",
        recipientChatId: "12345@s.whatsapp.net",
      }),
    ).toBeNull();
  });

  test("filter disabled returns null even with empty lists", () => {
    expect(
      checkAttachmentPolicy({
        policy: {
          attachmentFilter: false,
          attachmentMimeTypes: [],
          attachmentAllowedRecipients: [],
          attachmentAllowedPaths: [],
          attachmentPathRecursive: false,
        },
        mediaPath: "/nonexistent.png",
        recipientChatId: "",
      }),
    ).toBeNull();
  });

  // ── MIME type checks ──

  test("MIME type allowed when in list", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["image/png"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: false,
        },
        mediaPath: filePath,
        recipientChatId: "12345@s.whatsapp.net",
      });
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("MIME type denied when not in list", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["image/jpeg"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: false,
        },
        mediaPath: filePath,
        recipientChatId: "12345@s.whatsapp.net",
      });
      expect(result).toContain("image/png");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("MIME type wildcard allows all", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const filePath = join(root, "doc.pdf");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["*"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: false,
        },
        mediaPath: filePath,
        recipientChatId: "12345@s.whatsapp.net",
      });
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("empty MIME type list denies all", () => {
    const result = checkAttachmentPolicy({
      policy: {
        attachmentFilter: true,
        attachmentMimeTypes: [],
        attachmentAllowedRecipients: ["*"],
        attachmentAllowedPaths: ["*"],
        attachmentPathRecursive: false,
      },
      mediaPath: "/tmp/file.png",
      recipientChatId: "12345@s.whatsapp.net",
    });
    expect(result).toContain("no MIME types");
  });

  // ── Recipient checks ──

  test("recipient allowed when phone digits match", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["*"],
          attachmentAllowedRecipients: ["15551234567"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: false,
        },
        mediaPath: filePath,
        recipientChatId: "15551234567@s.whatsapp.net",
      });
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recipient denied when not in list", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["*"],
          attachmentAllowedRecipients: ["15551234567"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: false,
        },
        mediaPath: filePath,
        recipientChatId: "19998765432@s.whatsapp.net",
      });
      expect(result).toContain("recipient");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recipient wildcard allows all", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["*"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: false,
        },
        mediaPath: filePath,
        recipientChatId: "anything@lid",
      });
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("empty recipient list denies all", () => {
    const result = checkAttachmentPolicy({
      policy: {
        attachmentFilter: true,
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: [],
        attachmentAllowedPaths: ["*"],
        attachmentPathRecursive: false,
      },
      mediaPath: "/tmp/file.png",
      recipientChatId: "12345@s.whatsapp.net",
    });
    expect(result).toContain("no recipients");
  });

  // ── Path checks ──

  test("path allowed when file is in exact allowed directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["*"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: false,
        },
        mediaPath: filePath,
        recipientChatId: "12345@s.whatsapp.net",
      });
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("path denied when file is in subdirectory and recursive is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const subDir = join(root, "subdir");
    await mkdir(subDir, { recursive: true });
    const filePath = join(subDir, "photo.png");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["*"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: false,
        },
        mediaPath: filePath,
        recipientChatId: "12345@s.whatsapp.net",
      });
      expect(result).toContain("path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("path allowed when file is in subdirectory and recursive is true", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const subDir = join(root, "subdir");
    await mkdir(subDir, { recursive: true });
    const filePath = join(subDir, "photo.png");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["*"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: true,
        },
        mediaPath: filePath,
        recipientChatId: "12345@s.whatsapp.net",
      });
      expect(result).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("symlink escape blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const outside = await mkdtemp(join(tmpdir(), "wa-out-"));
    const realFile = join(outside, "secret.png");
    await writeFile(realFile, "secret");
    const linkPath = join(root, "link.png");
    try {
      await symlink(realFile, linkPath);
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["*"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [root],
          attachmentPathRecursive: true,
        },
        mediaPath: linkPath,
        recipientChatId: "12345@s.whatsapp.net",
      });
      // realpath resolves to outside dir, which is not under root
      expect(result).toContain("path");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("empty path list denies all", async () => {
    const root = await mkdtemp(join(tmpdir(), "wa-pol-"));
    const filePath = join(root, "photo.png");
    await writeFile(filePath, "data");
    try {
      const result = checkAttachmentPolicy({
        policy: {
          attachmentFilter: true,
          attachmentMimeTypes: ["*"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [],
          attachmentPathRecursive: false,
        },
        mediaPath: filePath,
        recipientChatId: "12345@s.whatsapp.net",
      });
      expect(result).toContain("no paths");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("nonexistent media path denied", () => {
    const result = checkAttachmentPolicy({
      policy: {
        ...ALL_ALLOWED,
        attachmentAllowedPaths: [basePolicyDir("/tmp")],
      },
      mediaPath: "/tmp/__nonexistent_file_that_should_not_exist__.png",
      recipientChatId: "12345@s.whatsapp.net",
    });
    expect(result).toContain("does not exist");
  });
});
