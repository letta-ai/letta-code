import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeModelCatalog,
  loadPersistedModelCatalog,
  refreshModelCatalog,
} from "@/agent/remote-model-catalog";
import { getApiRequestConfig } from "@/backend/api/request";
import { settingsManager } from "@/settings-manager";

// Share only the public model catalog, not credentials or per-test settings.
// Warm it before parallel CLI startups so a failed refresh can use real data.
const cacheDir = await mkdtemp(join(tmpdir(), "letta-api-test-catalog-"));
process.env.LETTA_MODEL_CATALOG_CACHE_DIR = cacheDir;
// This one-time warmup is the only network fetch the shard depends on before
// any test runs, so a single slow response must not fail the whole shard.
const WARMUP_ATTEMPTS = 4;
const WARMUP_BACKOFF_MS = 3_000;

try {
  await settingsManager.initialize();
  const { baseUrl } = await getApiRequestConfig();
  for (let attempt = 1; ; attempt++) {
    if (
      (await refreshModelCatalog({ force: true })) ||
      loadPersistedModelCatalog(baseUrl)
    ) {
      break;
    }
    if (attempt >= WARMUP_ATTEMPTS) break;
    console.warn(
      `Model catalog warmup attempt ${attempt}/${WARMUP_ATTEMPTS} failed; retrying`,
    );
    await Bun.sleep(WARMUP_BACKOFF_MS * attempt);
  }
  await initializeModelCatalog();
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
