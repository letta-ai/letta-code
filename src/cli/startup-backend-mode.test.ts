import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend, configureBackendMode, getBackend } from "@/backend";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import {
  LOCAL_BACKEND_DIR_ENV,
  LOCAL_BACKEND_EXPERIMENTAL_ENV,
} from "@/backend/local/paths";
import {
  createStartupAgentPickerHandler,
  getStartupBackendLookupOrder,
  inferBackendModeFromAgentId,
  resolveSubcommandBackendMode,
  switchBackendForSelectedStartupAgent,
} from "@/cli/startup-backend-mode";

describe("startup backend mode inference", () => {
  test("local agent IDs use the local backend", () => {
    expect(inferBackendModeFromAgentId("agent-local-abc")).toBe("local");
  });

  test("cloud agent IDs use the API backend", () => {
    expect(inferBackendModeFromAgentId("agent-abc")).toBe("api");
  });

  test("missing agent IDs do not infer a backend", () => {
    expect(inferBackendModeFromAgentId(null)).toBeUndefined();
    expect(inferBackendModeFromAgentId(undefined)).toBeUndefined();
  });

  test("lookup order tries the active backend first", () => {
    expect(getStartupBackendLookupOrder("local")).toEqual(["local", "api"]);
    expect(getStartupBackendLookupOrder("api")).toEqual(["api", "local"]);
  });

  test("explicit backend mode disables fallback", () => {
    expect(getStartupBackendLookupOrder("local", "api")).toEqual(["api"]);
    expect(getStartupBackendLookupOrder("api", "local")).toEqual(["local"]);
  });

  test("subcommands use saved backend mode when no stronger selector exists", () => {
    expect(
      resolveSubcommandBackendMode({
        savedBackendMode: "local",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBe("local");
    expect(
      resolveSubcommandBackendMode({
        savedBackendMode: "api",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBe("api");
  });

  test("explicit backend flag takes precedence over saved subcommand mode", () => {
    expect(
      resolveSubcommandBackendMode({
        explicitBackendMode: "api",
        savedBackendMode: "local",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBeUndefined();
  });

  test("local backend env takes precedence over saved API subcommand mode", () => {
    expect(
      resolveSubcommandBackendMode({
        envBackendMode: "local",
        savedBackendMode: "api",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBe("local");
  });

  test("custom API base URL blocks saved local subcommand mode", () => {
    expect(
      resolveSubcommandBackendMode({
        savedBackendMode: "local",
        baseURL: "http://localhost:8283",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBeUndefined();
  });
});

describe("startup picker backend selection", () => {
  let storageDir: string;
  let originalStorageDir: string | undefined;
  let originalBackendFlag: string | undefined;
  let originalMode: ReturnType<typeof resolveBackendMode>;
  let originalBackend: ReturnType<typeof getBackend>;

  beforeEach(async () => {
    originalStorageDir = process.env[LOCAL_BACKEND_DIR_ENV];
    originalBackendFlag = process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV];
    originalMode = resolveBackendMode();
    originalBackend = getBackend();
    storageDir = await mkdtemp(join(tmpdir(), "letta-startup-pin-"));
    process.env[LOCAL_BACKEND_DIR_ENV] = storageDir;
  });

  afterEach(async () => {
    if (originalStorageDir === undefined) {
      delete process.env[LOCAL_BACKEND_DIR_ENV];
    } else {
      process.env[LOCAL_BACKEND_DIR_ENV] = originalStorageDir;
    }
    if (originalBackendFlag === undefined) {
      delete process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV];
    } else {
      process.env[LOCAL_BACKEND_EXPERIMENTAL_ENV] = originalBackendFlag;
    }
    setConfiguredBackendMode(originalMode);
    __testSetBackend(originalBackend);
    await rm(storageDir, { recursive: true, force: true });
  });

  test("local pin opens on its backend despite a Cloud startup preference", async () => {
    const agentId = "agent-local-startup-pin";
    const agentsDir = join(storageDir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, `${Buffer.from(agentId).toString("base64url")}.json`),
      JSON.stringify({
        id: agentId,
        name: "Pinned Local Agent",
        system: "",
        tags: [],
        model: "local/default",
        model_settings: {},
      }),
    );
    configureBackendMode("api");
    const selectedAgentIds: string[] = [];
    let ready = false;
    const onSelect = createStartupAgentPickerHandler(
      async () => {
        configureBackendMode("local");
        return true;
      },
      (selected) => {
        expect(resolveBackendMode()).toBe("local");
        selectedAgentIds.push(selected);
      },
      () => {
        ready = true;
      },
      (message) => {
        throw new Error(message);
      },
    );
    await onSelect(agentId);

    expect(ready).toBe(true);
    expect(selectedAgentIds).toEqual([agentId]);
    expect(resolveBackendMode()).toBe("local");
    expect((await getBackend().retrieveAgent(agentId)).name).toBe(
      "Pinned Local Agent",
    );
  });

  test("a failed local migration does not continue into Cloud retrieval", async () => {
    configureBackendMode("api");
    const selected = await switchBackendForSelectedStartupAgent(
      "agent-local-unavailable",
      async () => false,
    );
    expect(selected).toBe(false);
    expect(resolveBackendMode()).toBe("api");
  });

  test("an unexpected local backend failure rolls back to Cloud", async () => {
    configureBackendMode("api");
    await expect(
      switchBackendForSelectedStartupAgent("agent-local-broken", async () => {
        configureBackendMode("local");
        throw new Error("Local storage unavailable");
      }),
    ).rejects.toThrow("Local storage unavailable");
    expect(resolveBackendMode()).toBe("api");
  });

  test("Cloud pin switches back from an active local backend", async () => {
    configureBackendMode("local");
    const selected = await switchBackendForSelectedStartupAgent(
      "agent-cloud-pin",
      async () => {
        throw new Error("Local selection must not run");
      },
    );
    expect(selected).toBe(true);
    expect(resolveBackendMode()).toBe("api");
  });
});
