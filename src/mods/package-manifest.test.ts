import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseLettaPackageManifest,
  readLettaPackageManifest,
} from "@/mods/package-manifest";

function createTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "letta-package-manifest-"));
}

function errorPathsFor(packageJson: unknown): string[] {
  const result = parseLettaPackageManifest(packageJson);
  if (result.ok) return [];
  return result.errors.map((error) => error.path);
}

function errorMessagesFor(packageJson: unknown): string[] {
  const result = parseLettaPackageManifest(packageJson);
  if (result.ok) return [];
  return result.errors.map((error) => error.message);
}

describe("Letta package manifest", () => {
  test("parses a valid minimal manifest", () => {
    const result = parseLettaPackageManifest({
      letta: {
        manifestVersion: 1,
        mods: ["./mods/index.ts"],
      },
    });

    expect(result).toEqual({
      errors: [],
      manifest: {
        manifestVersion: 1,
        mods: ["./mods/index.ts"],
      },
      ok: true,
    });
  });

  test("parses capabilities and engines", () => {
    const result = parseLettaPackageManifest({
      letta: {
        manifestVersion: 1,
        mods: ["mods/provider.mjs", "mods/statusline.tsx"],
        capabilities: ["providers", "ui.panels", "events.lifecycle"],
        engines: {
          lettaCodeCli: ">=0.28.0",
          lettaCodeDesktop: ">=0.12.0 <0.20.0",
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest).toEqual({
      manifestVersion: 1,
      mods: ["mods/provider.mjs", "mods/statusline.tsx"],
      capabilities: ["providers", "ui.panels", "events.lifecycle"],
      engines: {
        lettaCodeCli: ">=0.28.0",
        lettaCodeDesktop: ">=0.12.0 <0.20.0",
      },
    });
  });

  test("returns null when package has no Letta manifest", () => {
    expect(parseLettaPackageManifest({ name: "@caren/example" })).toEqual({
      errors: [],
      manifest: null,
      ok: true,
    });
  });

  test("rejects non-object package and manifest values", () => {
    expect(errorPathsFor(null)).toEqual(["package"]);
    expect(errorPathsFor({ letta: true })).toEqual(["letta"]);
  });

  test("rejects invalid manifestVersion", () => {
    expect(
      errorPathsFor({
        letta: {
          manifestVersion: 2,
          mods: ["mods/index.ts"],
        },
      }),
    ).toContain("letta.manifestVersion");
  });

  test("rejects missing, non-array, and empty mods", () => {
    expect(errorPathsFor({ letta: { manifestVersion: 1 } })).toContain(
      "letta.mods",
    );
    expect(
      errorPathsFor({ letta: { manifestVersion: 1, mods: "mods/index.ts" } }),
    ).toContain("letta.mods");
    expect(
      errorPathsFor({ letta: { manifestVersion: 1, mods: [] } }),
    ).toContain("letta.mods");
  });

  test("rejects unsafe mod entry paths", () => {
    const entries = [
      "",
      "/tmp/mod.ts",
      "../mod.ts",
      "mods/../mod.ts",
      "mods\\index.ts",
      "mods/index.json",
      "C:/Users/caren/mod.ts",
      "C:\\Users\\caren\\mod.ts",
      "\\\\server\\share\\mod.ts",
    ];

    const result = parseLettaPackageManifest({
      letta: {
        manifestVersion: 1,
        mods: entries,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors.map((error) => error.path)).toEqual(
      entries.map((_, index) => `letta.mods[${index}]`),
    );
  });

  test("rejects unknown capabilities and non-string capability entries", () => {
    const result = parseLettaPackageManifest({
      letta: {
        manifestVersion: 1,
        mods: ["mods/index.ts"],
        capabilities: ["commands", "ui.unknown", 1],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors.map((error) => error.path)).toEqual([
      "letta.capabilities[1]",
      "letta.capabilities[2]",
    ]);
  });

  test("accepts common semver range syntax", () => {
    const result = parseLettaPackageManifest({
      letta: {
        manifestVersion: 1,
        mods: ["mods/index.ts"],
        engines: {
          lettaCodeCli: "^0.28.0 || ~0.29.0",
          lettaCodeDesktop: ">=0.12.0-beta.1+build.5 <0.20.x",
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  test("rejects malformed engines", () => {
    const result = parseLettaPackageManifest({
      letta: {
        manifestVersion: 1,
        mods: ["mods/index.ts"],
        engines: {
          lettaCodeCli: "1.2.3+build+extra",
          lettaCodeDesktop: 1,
          unknownRuntime: ">=1.0.0",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors.map((error) => error.path).sort()).toEqual([
      "letta.engines.lettaCodeCli",
      "letta.engines.lettaCodeDesktop",
      "letta.engines.unknownRuntime",
    ]);
  });

  test("rejects unknown manifest keys", () => {
    const result = parseLettaPackageManifest({
      letta: {
        manifestVersion: 1,
        mods: ["mods/index.ts"],
        skills: ["skills/example"],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors).toEqual([
      {
        message: "unknown manifest field 'skills'",
        path: "letta.skills",
      },
    ]);
  });

  test("reads manifest from package.json", () => {
    const root = createTempDir();
    try {
      const packageJsonPath = path.join(root, "package.json");
      mkdirSync(path.dirname(packageJsonPath), { recursive: true });
      writeFileSync(
        packageJsonPath,
        JSON.stringify({
          letta: {
            manifestVersion: 1,
            mods: ["mods/index.js"],
          },
        }),
      );

      expect(readLettaPackageManifest(packageJsonPath)).toEqual({
        errors: [],
        manifest: {
          manifestVersion: 1,
          mods: ["mods/index.js"],
        },
        ok: true,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("surfaces package.json read and parse errors", () => {
    const root = createTempDir();
    try {
      const packageJsonPath = path.join(root, "package.json");
      writeFileSync(packageJsonPath, "{");

      expect(
        errorMessagesFor({ letta: { manifestVersion: 1, mods: [1] } }),
      ).toEqual(["mod entry must be a string path"]);
      const result = readLettaPackageManifest(packageJsonPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0]?.path).toBe(packageJsonPath);
      expect(result.errors[0]?.message).toContain("JSON");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
