import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideWhatsAppAttachmentPolicy,
  type WhatsAppAttachmentPolicyInput,
} from "@/channels/whatsapp/attachment-policy";

const directTarget = "15551234567@s.whatsapp.net";
const groupTarget = "120363000000000000@g.us";

describe("WhatsApp attachment policy", () => {
  let root: string;
  let nested: string;
  let outside: string;
  let mediaPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "whatsapp-policy-"));
    nested = join(root, "nested");
    outside = await mkdtemp(join(tmpdir(), "whatsapp-policy-outside-"));
    await mkdir(nested);
    mediaPath = join(root, "photo.png");
    await writeFile(mediaPath, "image");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  function input(
    overrides: Partial<WhatsAppAttachmentPolicyInput["policy"]> = {},
    extra: Partial<
      Pick<WhatsAppAttachmentPolicyInput, "mediaPath" | "targetJid">
    > = {},
  ): WhatsAppAttachmentPolicyInput {
    return {
      policy: {
        enabled: true,
        allowedMimeTypes: ["*"],
        allowedRecipients: ["*"],
        allowedDirectories: [root],
        recursiveDirectories: false,
        ...overrides,
      },
      mediaPath,
      targetJid: directTarget,
      ...extra,
    };
  }

  test("disabled policy passes through without touching the filesystem", () => {
    const decision = decideWhatsAppAttachmentPolicy({
      ...input({ enabled: false, allowedDirectories: [] }),
      mediaPath: "/does/not/exist.mp3",
    });
    expect(decision).toEqual({
      allowed: true,
      mediaPath: "/does/not/exist.mp3",
      mimeType: "audio/mpeg",
    });
  });

  test("MIME exact, wildcard, empty and denied cases are table-driven", () => {
    const cases = [
      { name: "exact", allowedMimeTypes: ["image/png"], allowed: true },
      { name: "wildcard", allowedMimeTypes: ["*"], allowed: true },
      { name: "family wildcard", allowedMimeTypes: ["image/*"], allowed: true },
      { name: "empty", allowedMimeTypes: [], allowed: false },
      { name: "denied", allowedMimeTypes: ["image/jpeg"], allowed: false },
    ];
    for (const testCase of cases) {
      const decision = decideWhatsAppAttachmentPolicy(
        input({ allowedMimeTypes: testCase.allowedMimeTypes }),
      );
      expect(decision.allowed, testCase.name).toBe(testCase.allowed);
    }
  });

  test("classifies known and unknown extensions through the decision", async () => {
    const cases = [
      ["image.png", "image/png"],
      ["video.mp4", "video/mp4"],
      ["document.pdf", "application/pdf"],
      ["audio.mp3", "audio/mpeg"],
      ["audio.m4a", "audio/mp4"],
      ["audio.wav", "audio/wav"],
      ["audio.ogg", "audio/ogg"],
      ["audio.oga", "audio/ogg"],
      ["audio.opus", "audio/opus"],
      ["unknown.blob", "application/octet-stream"],
    ] as const;
    for (const [name, mimeType] of cases) {
      const path = join(root, name);
      await writeFile(path, "data");
      const decision = decideWhatsAppAttachmentPolicy(
        input({ allowedMimeTypes: [mimeType] }, { mediaPath: path }),
      );
      expect(decision.allowed, name).toBe(true);
      if (decision.allowed) expect(decision.mimeType).toBe(mimeType);
    }
  });

  test("normalizes direct recipients but compares groups by exact JID", () => {
    const direct = decideWhatsAppAttachmentPolicy(
      input({ allowedRecipients: ["+1 (555) 123-4567"] }),
    );
    expect(direct.allowed).toBe(true);

    const wrongDirect = decideWhatsAppAttachmentPolicy(
      input(
        { allowedRecipients: ["15551234567"] },
        { targetJid: "19990000000@s.whatsapp.net" },
      ),
    );
    expect(wrongDirect.allowed).toBe(false);

    const exactGroup = decideWhatsAppAttachmentPolicy(
      input({ allowedRecipients: [groupTarget] }, { targetJid: groupTarget }),
    );
    expect(exactGroup.allowed).toBe(true);

    const digitCollision = decideWhatsAppAttachmentPolicy(
      input(
        { allowedRecipients: ["120363000000000000"] },
        { targetJid: groupTarget },
      ),
    );
    expect(digitCollision.allowed).toBe(false);

    for (const targetJid of [
      "123456@lid",
      "not-a-jid",
      "@g.us",
      "15551234567",
    ]) {
      expect(
        decideWhatsAppAttachmentPolicy(
          input({ allowedRecipients: ["*"] }, { targetJid }),
        ).allowed,
        targetJid,
      ).toBe(false);
    }
  });

  test("enforces direct-child and recursive directory rules", async () => {
    const nestedMedia = join(nested, "nested.png");
    await writeFile(nestedMedia, "nested");

    expect(decideWhatsAppAttachmentPolicy(input()).allowed).toBe(true);
    expect(
      decideWhatsAppAttachmentPolicy(input({}, { mediaPath: nestedMedia }))
        .allowed,
    ).toBe(false);
    expect(
      decideWhatsAppAttachmentPolicy(
        input({ recursiveDirectories: true }, { mediaPath: nestedMedia }),
      ).allowed,
    ).toBe(true);
  });

  test("rejects sibling-prefix and symlink escapes", async () => {
    const sibling = `${root}-sibling`;
    await mkdir(sibling);
    const siblingMedia = join(sibling, "sibling.png");
    const outsideMedia = join(outside, "secret.png");
    const linkMedia = join(root, "link.png");
    await writeFile(siblingMedia, "sibling");
    await writeFile(outsideMedia, "secret");
    await symlink(outsideMedia, linkMedia);
    try {
      expect(
        decideWhatsAppAttachmentPolicy(
          input({ recursiveDirectories: true }, { mediaPath: siblingMedia }),
        ).allowed,
      ).toBe(false);
      expect(
        decideWhatsAppAttachmentPolicy(
          input({ recursiveDirectories: true }, { mediaPath: linkMedia }),
        ).allowed,
      ).toBe(false);
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  test("rejects nonexistent, non-file, broken-link and missing directories", async () => {
    const brokenLink = join(root, "broken.png");
    await symlink(join(outside, "missing.png"), brokenLink);
    const cases = ["/does/not/exist.png", root, brokenLink];
    for (const candidate of cases) {
      expect(
        decideWhatsAppAttachmentPolicy(input({}, { mediaPath: candidate }))
          .allowed,
      ).toBe(false);
    }
    expect(
      decideWhatsAppAttachmentPolicy(
        input({ allowedDirectories: [join(root, "removed")] }),
      ).allowed,
    ).toBe(false);

    expect(
      decideWhatsAppAttachmentPolicy(
        input({ allowedDirectories: [join(root, "removed"), root] }),
      ).allowed,
    ).toBe(true);
  });

  test("uses canonical extension and returns canonical media path", async () => {
    const canonicalMedia = join(root, "secret.txt");
    const linkMedia = join(root, "alias.png");
    await writeFile(canonicalMedia, "secret");
    await symlink(canonicalMedia, linkMedia);
    const decision = decideWhatsAppAttachmentPolicy(
      input({ allowedMimeTypes: ["text/plain"] }, { mediaPath: linkMedia }),
    );
    const canonicalRealPath = await realpath(canonicalMedia);
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.mimeType).toBe("text/plain");
      expect(await realpath(decision.mediaPath)).toBe(canonicalRealPath);
    }
    expect(await readlink(linkMedia)).toBe(canonicalMedia);
  });
});
