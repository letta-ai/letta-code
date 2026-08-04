import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPersistedAuthTokens } from "@/auth/persisted-tokens";

// Force the non-strict (file-only) path: keychain availability differs per
// platform/CI, and these tests must not read the developer's real keychain.
const ORIGINAL_SKIP = process.env.LETTA_SKIP_KEYCHAIN_CHECK;
process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";

afterEach(() => {
  if (ORIGINAL_SKIP === undefined) delete process.env.LETTA_SKIP_KEYCHAIN_CHECK;
  else process.env.LETTA_SKIP_KEYCHAIN_CHECK = ORIGINAL_SKIP;
  process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";
});

function writeSettingsFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "persisted-tokens-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify(content), "utf-8");
  return path;
}

describe("readPersistedAuthTokens (file-backed path)", () => {
  test("reads expiry and tokens from the settings file on disk", async () => {
    const path = writeSettingsFile({
      tokenExpiresAt: 1_800_000_000_000,
      refreshToken: "file-refresh",
      env: { LETTA_API_KEY: "file-key" },
    });
    const snapshot = await readPersistedAuthTokens(path);
    expect(snapshot).toEqual({
      apiKey: "file-key",
      refreshToken: "file-refresh",
      tokenExpiresAt: 1_800_000_000_000,
      source: "file",
    });
  });

  test("returns nulls for a missing or malformed file", async () => {
    const missing = await readPersistedAuthTokens(
      join(mkdtempSync(join(tmpdir(), "persisted-tokens-")), "nope.json"),
    );
    expect(missing).toEqual({
      apiKey: null,
      refreshToken: null,
      tokenExpiresAt: null,
      source: "file",
    });

    const dir = mkdtempSync(join(tmpdir(), "persisted-tokens-"));
    const corrupt = join(dir, "settings.json");
    writeFileSync(corrupt, "{not json", "utf-8");
    expect(await readPersistedAuthTokens(corrupt)).toEqual({
      apiKey: null,
      refreshToken: null,
      tokenExpiresAt: null,
      source: "file",
    });
  });

  test("ignores wrong-typed and empty fields", async () => {
    const path = writeSettingsFile({
      tokenExpiresAt: "soon",
      refreshToken: "",
      env: { LETTA_API_KEY: 42 },
    });
    expect(await readPersistedAuthTokens(path)).toEqual({
      apiKey: null,
      refreshToken: null,
      tokenExpiresAt: null,
      source: "file",
    });
  });
});
