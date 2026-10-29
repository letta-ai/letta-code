import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeModelCatalog,
  loadPersistedModelCatalog,
} from "@/agent/remote-model-catalog";
import { getApiRequestConfig } from "@/backend/api/request";
import { settingsManager } from "@/settings-manager";

// Share only the public model catalog, not credentials or per-test settings.
// Warm it before parallel CLI startups so a failed refresh can use real data.
const cacheDir = await mkdtemp(join(tmpdir(), "letta-api-test-catalog-"));
process.env.LETTA_MODEL_CATALOG_CACHE_DIR = cacheDir;
try {
  await settingsManager.initialize();
  await initializeModelCatalog();
  const { baseUrl } = await getApiRequestConfig();
  if (!loadPersistedModelCatalog(baseUrl)) {
    throw new Error(
      "API integration catalog warmup did not persist a valid cache",
    );
  }
  const child = Bun.spawn(
    [process.execPath, "test", ...process.argv.slice(2)],
    {
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exitCode = await child.exited;
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
