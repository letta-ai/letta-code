import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttachmentPolicyParams,
  checkAttachmentPolicy,
  inferMimeType,
} from "@/channels/whatsapp/media";

function makePolicy(
  overrides?: Partial<AttachmentPolicyParams>,
): AttachmentPolicyParams {
  return {
    attachmentFilter: true,
    attachmentMimeTypes: ["*"],
    attachmentAllowedRecipients: ["*"],
    attachmentAllowedPaths: [],
    attachmentPathRecursive: false,
    ...overrides,
  };
}

describe("inferMimeType", () => {
  test("maps common extensions", () => {
    expect(inferMimeType("photo.png")).toBe("image/png");
    expect(inferMimeType("doc.pdf")).toBe("application/pdf");
    expect(inferMimeType("song.mp3")).toBe("audio/mpeg");
    expect(inferMimeType("clip.mp4")).toBe("video/mp4");
  });

  test("returns octet-stream for unknown extensions", () => {
    expect(inferMimeType("file.xyz")).toBe("application/octet-stream");
  });
});

describe("checkAttachmentPolicy", () => {
  test("returns null when filter is disabled", () => {
    const result = checkAttachmentPolicy({
      policy: makePolicy({ attachmentFilter: false }),
      mediaPath: "/tmp/anything.png",
      recipientChatId: "12345@s.whatsapp.net",
    });
    expect(result).toBeNull();
  });

  test("denies all MIME types when list is empty", () => {
    const result = checkAttachmentPolicy({
      policy: makePolicy({ attachmentMimeTypes: [] }),
      mediaPath: "/tmp/file.png",
      recipientChatId: "12345@s.whatsapp.net",
    });
    expect(result).toContain("no MIME types are allowed");
  });

  test("allows all MIME types when list is ['*']", () => {
    const result = checkAttachmentPolicy({
      policy: makePolicy({
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: ["*"],
        attachmentAllowedPaths: [],
      }),
      mediaPath: "/tmp/file.png",
      recipientChatId: "12345@s.whatsapp.net",
    });
    // Should fail on allowedPaths being empty, not MIME
    expect(result).toContain("no source paths are allowed");
  });

  test("does exact MIME match for explicit list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-mime-"));
    try {
      const filePath = join(dir, "photo.png");
      await writeFile(filePath, "test");

      const basePolicy = makePolicy({
        attachmentMimeTypes: ["image/png", "application/pdf"],
        attachmentAllowedRecipients: ["*"],
        attachmentAllowedPaths: ["/tmp"],
      });

      // Passes MIME check, but fails path check (real dir is not under /tmp on all platforms)
      const mimePass = checkAttachmentPolicy({
        policy: basePolicy,
        mediaPath: filePath,
        recipientChatId: "123@s.whatsapp.net",
      });
      // Should reach the path check (not MIME denial), meaning MIME passed
      expect(mimePass).not.toContain("not in the allowed list");

      // Now test MIME rejection
      expect(
        checkAttachmentPolicy({
          policy: { ...basePolicy, attachmentMimeTypes: ["application/pdf"] },
          mediaPath: filePath,
          recipientChatId: "123@s.whatsapp.net",
        }),
      ).toContain("not in the allowed list");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("denies all recipients when list is empty", () => {
    const result = checkAttachmentPolicy({
      policy: makePolicy({
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: [],
      }),
      mediaPath: "/tmp/file.png",
      recipientChatId: "12345@s.whatsapp.net",
    });
    expect(result).toContain("no recipients are allowed");
  });

  test("matches recipient by phone number parity", () => {
    const result = checkAttachmentPolicy({
      policy: makePolicy({
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: ["1234567890"],
        attachmentAllowedPaths: [],
      }),
      mediaPath: "/tmp/file.png",
      recipientChatId: "1234567890@s.whatsapp.net",
    });
    // Passes MIME and recipient, fails on path
    expect(result).toContain("no source paths are allowed");
  });

  test("rejects unmatched recipient", () => {
    const result = checkAttachmentPolicy({
      policy: makePolicy({
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: ["9999999999"],
        attachmentAllowedPaths: [],
      }),
      mediaPath: "/tmp/file.png",
      recipientChatId: "1234567890@s.whatsapp.net",
    });
    expect(result).toContain("not in the allowed list");
  });

  // ── Path checks with real filesystem ──
  test("non-recursive allows files directly inside allowed directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-pol-"));
    try {
      const filePath = join(dir, "doc.pdf");
      await writeFile(filePath, "test");

      const result = checkAttachmentPolicy({
        policy: makePolicy({
          attachmentMimeTypes: ["application/pdf"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [dir],
          attachmentPathRecursive: false,
        }),
        mediaPath: filePath,
        recipientChatId: "123@s.whatsapp.net",
      });
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-recursive rejects file in subdirectory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-pol-"));
    try {
      const subdir = join(dir, "sub");
      await mkdir(subdir, { recursive: true });
      const otherPath = join(subdir, "other.pdf");
      await writeFile(otherPath, "other");

      const result = checkAttachmentPolicy({
        policy: makePolicy({
          attachmentMimeTypes: ["application/pdf"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [dir],
          attachmentPathRecursive: false,
        }),
        mediaPath: otherPath,
        recipientChatId: "123@s.whatsapp.net",
      });
      expect(result).toContain("not directly inside");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-directory allowed path is ignored and denies send", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-pol-"));
    try {
      const filePath = join(dir, "doc.pdf");
      await writeFile(filePath, "test");

      const result = checkAttachmentPolicy({
        policy: makePolicy({
          attachmentMimeTypes: ["application/pdf"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [filePath],
          attachmentPathRecursive: false,
        }),
        mediaPath: filePath,
        recipientChatId: "123@s.whatsapp.net",
      });
      expect(result).toContain("not directly inside");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recursive allows child under allowed root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-pol-"));
    try {
      const subdir = join(dir, "sub");
      await mkdir(subdir, { recursive: true });
      const filePath = join(subdir, "doc.pdf");
      await writeFile(filePath, "test");

      const result = checkAttachmentPolicy({
        policy: makePolicy({
          attachmentMimeTypes: ["application/pdf"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [dir],
          attachmentPathRecursive: true,
        }),
        mediaPath: filePath,
        recipientChatId: "123@s.whatsapp.net",
      });
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recursive rejects path outside allowed root (symlink escape)", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "wa-pol-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "wa-pol-b-"));
    try {
      const realFile = join(dirB, "secret.pdf");
      await writeFile(realFile, "secret");
      const symlinkPath = join(dirA, "escape.pdf");
      await symlink(realFile, symlinkPath);

      const result = checkAttachmentPolicy({
        policy: makePolicy({
          attachmentMimeTypes: ["application/pdf"],
          attachmentAllowedRecipients: ["*"],
          attachmentAllowedPaths: [dirA],
          attachmentPathRecursive: true,
        }),
        mediaPath: symlinkPath,
        recipientChatId: "123@s.whatsapp.net",
      });
      // realpath of symlink resolves to dirB/secret.pdf, which is not under dirA
      expect(result).toContain("not within any allowed path");
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test("returns error for nonexistent source path", () => {
    const result = checkAttachmentPolicy({
      policy: makePolicy({
        attachmentMimeTypes: ["*"],
        attachmentAllowedRecipients: ["*"],
        attachmentAllowedPaths: ["/tmp"],
        attachmentPathRecursive: true,
      }),
      mediaPath: "/tmp/__nonexistent_file_123456789__.pdf",
      recipientChatId: "123@s.whatsapp.net",
    });
    expect(result).toContain("does not exist");
  });
});
