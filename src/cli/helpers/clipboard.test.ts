import { describe, expect, test } from "bun:test";
import {
  type ClipboardImageImportDeps,
  tryImportClipboardImage,
} from "./clipboard";
import type { LinuxClipboardImage } from "./clipboard-linux";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function linuxDeps(
  clipboard: LinuxClipboardImage,
  overrides: Partial<ClipboardImageImportDeps> = {},
): Partial<ClipboardImageImportDeps> {
  return {
    platform: "linux",
    readLinux: async () => clipboard,
    importBuffer: async () => ({
      placeholder: "[Image #1]",
      resized: false,
      width: 4,
      height: 4,
    }),
    toolsMissingNotice: { shown: false },
    ...overrides,
  };
}

describe("tryImportClipboardImage", () => {
  test("delegates to the macOS importer on darwin", async () => {
    const result = await tryImportClipboardImage({
      platform: "darwin",
      importMac: async () => ({ error: "from mac" }),
      readLinux: async () => {
        throw new Error("linux reader must not run on darwin");
      },
    });

    expect(result).toEqual({ error: "from mac" });
  });

  test("returns null on unsupported platforms", async () => {
    const result = await tryImportClipboardImage({
      platform: "win32",
      readLinux: async () => {
        throw new Error("linux reader must not run on win32");
      },
    });

    expect(result).toBeNull();
  });

  test("imports the Linux clipboard image bytes", async () => {
    const imported: Array<{ size: number; mediaType: string }> = [];

    const result = await tryImportClipboardImage(
      linuxDeps(
        { kind: "image", data: PNG_BYTES, mediaType: "image/png" },
        {
          importBuffer: async (buffer, mediaType) => {
            imported.push({ size: buffer.length, mediaType });
            return {
              placeholder: "[Image #7]",
              resized: false,
              width: 4,
              height: 4,
            };
          },
        },
      ),
    );

    expect(imported).toEqual([
      { size: PNG_BYTES.length, mediaType: "image/png" },
    ]);
    expect(result).toMatchObject({ placeholder: "[Image #7]" });
  });

  test("returns null when the Linux clipboard has no image", async () => {
    const result = await tryImportClipboardImage(linuxDeps({ kind: "empty" }));

    expect(result).toBeNull();
  });

  test("reports a Linux read error as a paste failure", async () => {
    const result = await tryImportClipboardImage(
      linuxDeps({ kind: "error", message: "wl-paste timed out listing types" }),
    );

    expect(result).toEqual({
      error: "Image paste failed: wl-paste timed out listing types",
    });
  });

  test("reports missing Linux clipboard tools only once", async () => {
    const deps = linuxDeps({ kind: "tools-missing" });

    const first = await tryImportClipboardImage(deps);
    const second = await tryImportClipboardImage(deps);

    expect(first).toEqual({
      error: "Image paste needs wl-clipboard (Wayland) or xclip (X11)",
    });
    expect(second).toBeNull();
  });
});
