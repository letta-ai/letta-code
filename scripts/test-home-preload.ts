import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const require = createRequire(import.meta.url);
const os = require("node:os") as typeof import("node:os");
const originalHome = resolve(os.homedir());
const configuredTestHome = process.env.LETTA_TEST_HOME?.trim();
const testHome = configuredTestHome
  ? resolve(configuredTestHome)
  : mkdtempSync(join(os.tmpdir(), "letta-code-test-home-"));

if (testHome === originalHome) {
  throw new Error("LETTA_TEST_HOME must not be the operator home directory");
}

const filesystemEnvKeys = [
  "LETTA_ARTIFACTS_DIR",
  "LETTA_CODE_DEV_BACKEND_DIR",
  "LETTA_DEBUG_FILE",
  "LETTA_HOME",
  "LETTA_LISTENER_PERF_FILE",
  "LETTA_LOCAL_BACKEND_DIR",
  "LETTA_MEMORY_DIR",
  "LETTA_MODEL_CATALOG_CACHE_DIR",
  "LETTA_TRANSCRIPT_ROOT",
  "LETTA_TUI_PERF_FILE",
  "MEMORY_DIR",
  "WEZTERM_CONFIG_FILE",
  "XDG_CONFIG_HOME",
] as const;

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

for (const key of filesystemEnvKeys) {
  const value = process.env[key]?.trim();
  if (!value || !isAbsolute(value)) continue;
  const absolute = resolve(value);
  if (!isWithin(absolute, originalHome)) continue;
  process.env[key] = join(testHome, relative(originalHome, absolute));
}

process.env.LETTA_TEST_HOME = testHome;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.LETTA_TEST_SECRETS_SERVICE_PREFIX = `letta-code-test-${process.pid}-${basename(testHome)}`;
process.env.LETTA_CODE_TELEM ??= "0";

// Bun resolves os.homedir() before preloads run. Patch the shared built-in
// module so both ESM and CommonJS consumers use the disposable home. This is a
// direct module update rather than a Bun test mock, so mock.restore() in an
// unrelated suite cannot remove the filesystem boundary. Child processes use
// the redirected environment before their runtimes initialize.
os.homedir = () => testHome;

if (!configuredTestHome) {
  const cleanup = () => {
    rmSync(testHome, { recursive: true, force: true });
  };
  afterAll(cleanup);
  process.once("exit", cleanup);
}
