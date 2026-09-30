import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, validateEnvironmentName } from "./settings-store";

test("environment names are trimmed and control characters are rejected", () => {
  expect(validateEnvironmentName("  workshop  ")).toBe("workshop");
  expect(() => validateEnvironmentName(" ")).toThrow("required");
  expect(() => validateEnvironmentName("bad\nname")).toThrow(
    "control characters",
  );
});

test("settings persist without storing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letta-daemon-settings-"));
  const path = join(directory, "settings.json");
  const store = new SettingsStore(path);

  await store.load();
  expect(store.current).toEqual({ environmentName: null, startAtLogin: true });

  await store.setEnvironmentName("Home lab");
  await store.setStartAtLogin(false);

  const reloaded = new SettingsStore(path);
  await reloaded.load();
  expect(reloaded.current).toEqual({
    environmentName: "Home lab",
    startAtLogin: false,
  });
  expect(await readFile(path, "utf8")).not.toContain("token");
});

test("serializes concurrent settings writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letta-daemon-settings-"));
  const path = join(directory, "settings.json");
  const store = new SettingsStore(path);
  await store.load();

  await Promise.all([
    store.setEnvironmentName("Studio"),
    store.setStartAtLogin(false),
  ]);

  const reloaded = new SettingsStore(path);
  await reloaded.load();
  expect(reloaded.current).toEqual({
    environmentName: "Studio",
    startAtLogin: false,
  });
});

test("quarantines corrupt settings and restores defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letta-daemon-settings-"));
  const path = join(directory, "settings.json");
  await writeFile(path, "not json", "utf8");

  const store = new SettingsStore(path);
  await store.load();

  expect(store.current).toEqual({ environmentName: null, startAtLogin: true });
  expect(
    (await readdir(directory)).some((name) => name.includes(".corrupt-")),
  ).toBe(true);
});
