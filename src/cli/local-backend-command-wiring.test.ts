import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readInteractiveAppSource } from "@/test-utils/read-interactive-app-source";

function appSource(): string {
  return readInteractiveAppSource();
}

function segmentBetween(
  source: string,
  startNeedle: string,
  endNeedle: string,
) {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("local backend command wiring", () => {
  test("new, fork, clear, and resume route conversation operations through Backend", () => {
    const source = appSource();
    expect(source).toContain("getResumeDataFromBackend");
    expect(source).not.toContain('from "@/backend/api/conversations"');

    const newSegment = segmentBetween(
      source,
      "const newMatch = msg.trim().match(/^\\/new(?:\\s+(.+))?$/);",
      "// Special handling for /fork command",
    );
    expect(newSegment).toContain("const backend = getBackend();");
    expect(newSegment).toContain("await backend.createConversation({");
    expect(newSegment).not.toContain("await getClient()");

    const forkSegment = segmentBetween(
      source,
      "// Special handling for /fork command",
      "// Special handling for /btw command",
    );
    expect(forkSegment).toContain("await backend.forkConversation(");
    expect(forkSegment).toContain("await backend.updateConversation(");
    expect(forkSegment).not.toContain("await getClient()");

    const clearSegment = segmentBetween(
      source,
      'if (msg.trim() === "/clear")',
      "// Special handling for /compact command",
    );
    expect(clearSegment).toContain("const backend = getBackend();");
    expect(clearSegment).toContain("await backend.createConversation({");
    expect(clearSegment).toContain("!backend.capabilities.localModelCatalog");

    const resumeSegment = segmentBetween(
      source,
      "// Special handling for /resume command",
      "// Special handling for /search command",
    );
    expect(resumeSegment).toContain("await getResumeDataFromBackend(");
    expect(resumeSegment).not.toContain("await getClient()");
  });

  test("agent and memory viewers use active backend instead of API client", () => {
    const source = appSource();

    const agentSelectSegment = segmentBetween(
      source,
      "const handleAgentSelect = useCallback(",
      "// Handle creating a new agent and switching to it",
    );
    expect(agentSelectSegment).toContain(
      "await getBackend().retrieveAgent(targetAgentId)",
    );
    expect(agentSelectSegment).not.toContain("await getClient()");

    const renameSegment = segmentBetween(
      source,
      "// Special handling for /rename command",
      "// Special handling for /description command",
    );
    expect(renameSegment).toContain("await backend.updateConversation(");
    expect(renameSegment).toContain("await getBackend().updateAgent(");
    expect(renameSegment).not.toContain("await getClient()");

    const descriptionSegment = segmentBetween(
      source,
      "// Special handling for /description command",
      "// Special handling for /agents command",
    );
    expect(descriptionSegment).toContain("await getBackend().updateAgent(");
    expect(descriptionSegment).not.toContain("await getClient()");

    const profilePath = fileURLToPath(
      new URL("../cli/commands/profile.ts", import.meta.url),
    );
    const profileSource = readFileSync(profilePath, "utf-8");
    expect(profileSource).toContain('import { getBackend } from "@/backend"');
    expect(profileSource).not.toContain("getClient");

    const memoryViewerPath = fileURLToPath(
      new URL("../cli/components/MemoryTabViewer.tsx", import.meta.url),
    );
    const memoryViewerSource = readFileSync(memoryViewerPath, "utf-8");
    expect(memoryViewerSource).toContain("getBackend().retrieveAgent(");
    expect(memoryViewerSource).not.toContain("getClient");
  });

  test("local memfs helper paths avoid API client-only lookups", () => {
    const memoryGitPath = fileURLToPath(
      new URL("../agent/memory-git.ts", import.meta.url),
    );
    const memoryGitSource = readFileSync(memoryGitPath, "utf-8");

    const authSegment = segmentBetween(
      memoryGitSource,
      "async function getAuthToken(): Promise<string>",
      "export function buildGitAuthArgs",
    );
    expect(authSegment).toContain("backend.capabilities.localMemfs");
    expect(authSegment).toContain("!backend.capabilities.remoteMemfs");

    const fetchNameSegment = segmentBetween(
      memoryGitSource,
      "async function fetchAgentDisplayName",
      "export async function ensureLocalMemfsGitConfig",
    );
    expect(fetchNameSegment).toContain("getBackend().retrieveAgent(agentId)");
    expect(fetchNameSegment).not.toContain("getClient");

    const tagSegment = segmentBetween(
      memoryGitSource,
      "export async function addGitMemoryTag",
      "export async function removeGitMemoryTag",
    );
    expect(tagSegment).toContain("backend.retrieveAgent(agentId)");
    expect(tagSegment).toContain("backend.updateAgent(agentId");
    expect(tagSegment).not.toContain("getClient");
  });

  test("message search and subcommands avoid unguarded API-only paths in local mode", () => {
    const source = appSource();

    const searchSegment = segmentBetween(
      source,
      "// Special handling for /search command",
      "// Special handling for /profile command",
    );
    expect(searchSegment).not.toContain("getClient");

    const installGithubAppSegment = segmentBetween(
      source,
      "// Special handling for /install-github-app command",
      "// Special handling for /sleeptime command",
    );
    expect(installGithubAppSegment).toContain(
      "getBackend().capabilities.localModelCatalog",
    );

    const messageSearchPath = fileURLToPath(
      new URL("../cli/components/MessageSearch.tsx", import.meta.url),
    );
    const messageSearchSource = readFileSync(messageSearchPath, "utf-8");
    expect(messageSearchSource).toContain("searchMessagesForBackend");
    expect(messageSearchSource).not.toContain("@/backend/api/search");

    const messagesSubcommandPath = fileURLToPath(
      new URL("../cli/subcommands/messages.ts", import.meta.url),
    );
    const messagesSubcommandSource = readFileSync(
      messagesSubcommandPath,
      "utf-8",
    );
    expect(messagesSubcommandSource).toContain("getBackend");
    expect(messagesSubcommandSource).toContain("searchMessagesForBackend");
    expect(messagesSubcommandSource).not.toContain("getClient");

    const agentsSubcommandPath = fileURLToPath(
      new URL("../cli/subcommands/agents.ts", import.meta.url),
    );
    const agentsSubcommandSource = readFileSync(agentsSubcommandPath, "utf-8");
    expect(agentsSubcommandSource).toContain("getBackend");
    expect(agentsSubcommandSource).not.toContain("getClient");

    const routerPath = fileURLToPath(
      new URL("../cli/subcommands/router.ts", import.meta.url),
    );
    const routerSource = readFileSync(routerPath, "utf-8");
    expect(routerSource).not.toContain("runBlocksSubcommand");
    expect(routerSource).not.toContain('case "blocks"');
  });

  test("remote listener startup is allowed for local backends", () => {
    const source = appSource();
    const serverSegment = segmentBetween(
      source,
      "// Special handling for /server command (alias: /remote)",
      "// Special handling for /help command",
    );

    expect(serverSegment).toContain("await handleListen(");
    expect(serverSegment).not.toContain(
      "Remote listener mode is not supported by the local backend.",
    );
    expect(serverSegment).not.toContain("capabilities.remoteMemfs");
  });

  test("subagent fork and child launch wiring use the active backend", () => {
    const taskPath = fileURLToPath(
      new URL("../tools/impl/task.ts", import.meta.url),
    );
    const taskSource = readFileSync(taskPath, "utf-8");
    expect(taskSource).toContain('import { getBackend } from "@/backend"');
    expect(taskSource).toContain("await getBackend().forkConversation(");
    expect(taskSource).not.toContain('from "@/backend/api/conversations"');

    const managerPath = fileURLToPath(
      new URL("../agent/subagents/manager.ts", import.meta.url),
    );
    const managerSource = readFileSync(managerPath, "utf-8");
    expect(managerSource).toContain(
      'args.push("--backend", options.backendMode);',
    );
    expect(managerSource).toContain('args.push("--no-memfs");');
    expect(managerSource).toContain(
      'childEnv.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";',
    );
  });
});
