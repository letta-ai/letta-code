import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_DESKTOP_FAVORITE_TAG } from "@/agent/favorites";
import {
  LOCAL_BACKEND_DIR_ENV,
  LOCAL_BACKEND_EXPERIMENTAL_ENV,
} from "@/backend/local/paths";
import { settingsManager } from "@/settings-manager";
import { setServiceName } from "@/utils/secrets";
import { listPinnedAgentsForCurrentUser } from "./pinned-agent-listing";

const originalHome = process.env.HOME;
const originalLocalBackendDir = process.env[LOCAL_BACKEND_DIR_ENV];
const originalLocalBackendFlag = process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV];

let testHomeDir: string;
let storageDir: string;

beforeEach(async () => {
  setServiceName("letta-code-pinned-agent-listing-test");
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-pinned-home-"));
  storageDir = await mkdtemp(join(tmpdir(), "letta-pinned-storage-"));
  process.env.HOME = testHomeDir;
  process.env[LOCAL_BACKEND_DIR_ENV] = storageDir;
  process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV] = "1";
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
  if (originalLocalBackendDir === undefined) {
    delete process.env[LOCAL_BACKEND_DIR_ENV];
  } else {
    process.env[LOCAL_BACKEND_DIR_ENV] = originalLocalBackendDir;
  }
  if (originalLocalBackendFlag === undefined) {
    delete process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV];
  } else {
    process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV] = originalLocalBackendFlag;
  }
  setServiceName("letta-code");
});

describe("listPinnedAgentsForCurrentUser", () => {
  test("returns local favorites as full named agent records", async () => {
    const agentId = "agent-local-favorite";
    const agentsDir = join(storageDir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, `${Buffer.from(agentId).toString("base64url")}.json`),
      JSON.stringify({
        id: agentId,
        name: "Pinned Local Agent",
        description: null,
        system: "",
        tags: [LOCAL_DESKTOP_FAVORITE_TAG],
        model: "local/default",
        model_settings: {},
      }),
    );

    const pinned = await listPinnedAgentsForCurrentUser(["local"]);

    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({
      agentId,
      backendMode: "local",
      error: null,
      agent: { id: agentId, name: "Pinned Local Agent" },
    });
  });
});
