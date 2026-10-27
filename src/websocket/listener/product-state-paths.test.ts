import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { authorityPersistentPathForServer } from "@/agent/mcp-originator-authority-file";
import { getMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getAgentRootDir } from "@/agent/memory-git";
import { getAgentSkillsDir } from "@/agent/skills";
import { getGlobalAgentsDir } from "@/agent/subagents";
import { analyzeApprovalContext } from "@/permissions/analyzer";
import { extractTargetAgentPaths } from "@/permissions/cross-agent-guard";
import {
  getDefaultAgentsTreeRoot,
  getLettaHomeRoot,
} from "@/permissions/sandbox-policy";
import { getOverflowDirectory } from "@/tools/impl/overflow";
import { getManagedToolsDir } from "@/tools/impl/ripgrep-manager";
import { getLettaShimDir } from "@/tools/impl/shell-env";
import { defaultExecutionsDir } from "@/tools/workflow/journal";
import { getLocalBackendStorageDir } from "@/utils/local-backend-paths";
import { getTranscriptRoot } from "@/utils/transcript-paths";
import { inputDispositionPersistentPath } from "./input-disposition-path";
import { defaultInterruptedTurnDirectory } from "./interrupted-turn-storage";
import { defaultTurnFinishedDirectory } from "./turn-finished-replay";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.LETTA_CONFIG_DIR;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
  else process.env.LETTA_CONFIG_DIR = originalConfigDir;
});

test("durable listener execution state follows the product config root", () => {
  const productRoot = join("/Users/alice", ".dream");
  process.env.HOME = "/Users/alice";
  process.env.LETTA_CONFIG_DIR = productRoot;
  const serverUrl = "https://api.example.test";

  for (const statePath of [
    authorityPersistentPathForServer(serverUrl),
    inputDispositionPersistentPath(serverUrl),
    defaultInterruptedTurnDirectory(),
    defaultTurnFinishedDirectory(),
    getLocalBackendStorageDir(),
    getLocalBackendStorageDir("/fallback-home", process.env),
    getMemoryFilesystemRoot("agent-test"),
    getMemoryFilesystemRoot("agent-test", "/fallback-home", process.env),
    getAgentRootDir("agent-test"),
    getAgentSkillsDir("agent-test"),
    getGlobalAgentsDir(),
    getDefaultAgentsTreeRoot("/fallback-home", process.env),
    getTranscriptRoot(),
    defaultExecutionsDir(),
    getOverflowDirectory("/workspace/project"),
    getManagedToolsDir(process.env),
    getLettaShimDir({ ...process.env, LETTA_SANDBOX: "1" }),
  ]) {
    expect(statePath.startsWith(`${productRoot}/`)).toBe(true);
    expect(statePath.startsWith("/Users/alice/.letta/")).toBe(false);
  }
  expect(getLettaHomeRoot("/fallback-home", process.env)).toBe(productRoot);

  const targets = extractTargetAgentPaths(
    "Read",
    { file_path: join(productRoot, "agents", "agent-other", "memory", "x.md") },
    "/workspace",
    process.env,
    "/fallback-home",
  );
  expect(targets.anyAgentScoped).toBe(true);
  expect(targets.agentIds).toContain("agent-other");

  const approval = analyzeApprovalContext(
    "Bash",
    {
      command: `npx tsx ${productRoot}/agents/agent-test/memory/skills/finding-agents/scripts/main.ts --help`,
    },
    "/workspace",
  );
  expect(approval.approveAlwaysText).toContain("agent-scoped skill");
});
