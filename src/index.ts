#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { LETTA_CLOUD_API_URL } from "./auth/oauth";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getResumeData, type ResumeData } from "./agent/check-approval";
import { getClient } from "./agent/client";
import { initializeLoadedSkillsFlag, setAgentContext } from "./agent/context";
import type { AgentProvenance } from "./agent/create";
import { permissionMode } from "./permissions/mode";
import { settingsManager } from "./settings-manager";
import { loadTools, upsertToolsToServer } from "./tools/manager";

function printHelp() {
  // Keep this plaintext (no colors) so output pipes cleanly
  const usage = `
Letta Code is a general purpose CLI for interacting with Letta agents

USAGE
  # interactive TUI
  letta                 Auto-resume project agent (from .letta/settings.local.json)
  letta --new           Create a new agent (reuses global persona/human blocks)
  letta --fresh-blocks  Create a new agent with all new memory blocks
  letta --continue      Resume global last agent (deprecated, use project-based)
  letta --agent <id>    Open a specific agent by ID

  # headless
  letta -p "..."        One-off prompt in headless mode (no TTY UI)

OPTIONS
  -h, --help            Show this help and exit
  -v, --version         Print version and exit
  --new                 Create new agent (reuses global blocks like persona/human)
  --fresh-blocks        Force create all new memory blocks (isolate from other agents)
  --init-blocks <list>  Comma-separated memory blocks to initialize when using --new (e.g., "persona,skills")
  --base-tools <list>   Comma-separated base tools to attach when using --new (e.g., "memory,web_search,conversation_search")
  -c, --continue        Resume previous session (uses global lastAgent, deprecated)
  -a, --agent <id>      Use a specific agent ID
  -m, --model <id>      Model ID or handle (e.g., "opus-4.5" or "anthropic/claude-opus-4-5")
  -s, --system <id>     System prompt ID (e.g., "codex", "gpt-5.1", "review")
  --toolset <name>      Force toolset: "codex", "default", or "gemini" (overrides model-based auto-selection)
  -p, --prompt          Headless prompt mode
  --output-format <fmt> Output format for headless mode (text, json, stream-json)
                        Default: text
  --skills <path>       Custom path to skills directory (default: .skills in current directory)
  --sleeptime           Enable sleeptime memory management (only for new agents)


BEHAVIOR
  By default, letta auto-resumes the last agent used in the current directory
  (stored in .letta/settings.local.json).

  Memory blocks (persona, human, project, skills) are shared between agents:
  - Global blocks (persona, human) are shared across all agents
  - Local blocks (project, skills) are shared within the current directory

  Use --new to create a new agent that reuses your global persona/human blocks.
  Use --fresh-blocks to create a completely isolated agent with new blocks.

  If no credentials are configured, you'll be prompted to authenticate via
  Letta Cloud OAuth on first run.

EXAMPLES
  # when installed as an executable
  letta                    # Auto-resume project agent or create new
  letta --new              # New agent, keeps your persona/human blocks
  letta --fresh-blocks     # New agent, all blocks fresh (full isolation)
  letta --agent agent_123

  # inside the interactive session
  /logout               # Clear credentials and exit

  # headless with JSON output (includes stats)
  letta -p "hello" --output-format json

`.trim();

  console.log(usage);
}

/**
 * Helper to determine which model identifier to pass to loadTools()
 * based on user's model and/or toolset preferences.
 */
function getModelForToolLoading(
  specifiedModel?: string,
  specifiedToolset?: "codex" | "default" | "gemini",
): string | undefined {
  // If toolset is explicitly specified, use a dummy model from that provider
  // to trigger the correct toolset loading logic
  if (specifiedToolset === "codex") {
    return "openai/gpt-4";
  }
  if (specifiedToolset === "gemini") {
    return "google/gemini-3-pro";
  }
  if (specifiedToolset === "default") {
    return "anthropic/claude-sonnet-4";
  }
  // Otherwise, use the specified model (or undefined for auto-detection)
  return specifiedModel;
}

async function main() {
  // Initialize settings manager (loads settings once into memory)
  await settingsManager.initialize();
  const settings = settingsManager.getSettings();

  // set LETTA_API_KEY from environment if available
  if (process.env.LETTA_API_KEY && !settings.env?.LETTA_API_KEY) {
    settings.env = settings.env || {};
    settings.env.LETTA_API_KEY = process.env.LETTA_API_KEY;

    settingsManager.updateSettings({ env: settings.env });
  }

  // Parse command-line arguments (Bun-idiomatic approach using parseArgs)
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: process.argv,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        continue: { type: "boolean", short: "c" },
        new: { type: "boolean" },
        "fresh-blocks": { type: "boolean" },
        "init-blocks": { type: "string" },
        "base-tools": { type: "string" },
        agent: { type: "string", short: "a" },
        model: { type: "string", short: "m" },
        system: { type: "string", short: "s" },
        toolset: { type: "string" },
        prompt: { type: "boolean", short: "p" },
        run: { type: "boolean" },
        tools: { type: "string" },
        allowedTools: { type: "string" },
        disallowedTools: { type: "string" },
        "permission-mode": { type: "string" },
        yolo: { type: "boolean" },
        "output-format": { type: "string" },
        skills: { type: "string" },
        link: { type: "boolean" },
        unlink: { type: "boolean" },
        sleeptime: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Improve error message for common mistakes
    if (errorMsg.includes("Unknown option")) {
      console.error(`Error: ${errorMsg}`);
      console.error(
        "\nNote: Flags should use double dashes for full names (e.g., --yolo, not -yolo)",
      );
    } else {
      console.error(`Error: ${errorMsg}`);
    }
    console.error("Run 'letta --help' for usage information.");
    process.exit(1);
  }

  // Check for subcommands
  const _command = positionals[2]; // First positional after node and script

  // Handle help flag first
  if (values.help) {
    printHelp();
    process.exit(0);
  }

  // Handle version flag
  if (values.version) {
    const { getVersion } = await import("./version");
    console.log(`${getVersion()} (Letta Code)`);
    process.exit(0);
  }

  const shouldContinue = (values.continue as boolean | undefined) ?? false;
  const forceNew = (values.new as boolean | undefined) ?? false;
  const freshBlocks = (values["fresh-blocks"] as boolean | undefined) ?? false;
  const initBlocksRaw = values["init-blocks"] as string | undefined;
  const baseToolsRaw = values["base-tools"] as string | undefined;
  const specifiedAgentId = (values.agent as string | undefined) ?? null;
  const specifiedModel = (values.model as string | undefined) ?? undefined;
  const specifiedSystem = (values.system as string | undefined) ?? undefined;
  const specifiedToolset = (values.toolset as string | undefined) ?? undefined;
  const skillsDirectory = (values.skills as string | undefined) ?? undefined;
  const sleeptimeFlag = (values.sleeptime as boolean | undefined) ?? undefined;
  const isHeadless = values.prompt || values.run || !process.stdin.isTTY;

  // --init-blocks only makes sense when creating a brand new agent
  if (initBlocksRaw && !forceNew) {
    console.error(
      "Error: --init-blocks can only be used together with --new to control initial memory blocks.",
    );
    process.exit(1);
  }

  let initBlocks: string[] | undefined;
  if (initBlocksRaw !== undefined) {
    const trimmed = initBlocksRaw.trim();
    if (!trimmed || trimmed.toLowerCase() === "none") {
      // Explicitly requested zero blocks
      initBlocks = [];
    } else {
      initBlocks = trimmed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    }
  }

  // --base-tools only makes sense when creating a brand new agent
  if (baseToolsRaw && !forceNew) {
    console.error(
      "Error: --base-tools can only be used together with --new to control initial base tools.",
    );
    process.exit(1);
  }

  let baseTools: string[] | undefined;
  if (baseToolsRaw !== undefined) {
    const trimmed = baseToolsRaw.trim();
    if (!trimmed || trimmed.toLowerCase() === "none") {
      baseTools = [];
    } else {
      baseTools = trimmed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    }
  }

  // Validate toolset if provided
  if (
    specifiedToolset &&
    specifiedToolset !== "codex" &&
    specifiedToolset !== "default" &&
    specifiedToolset !== "gemini"
  ) {
    console.error(
      `Error: Invalid toolset "${specifiedToolset}". Must be "codex", "default", or "gemini".`,
    );
    process.exit(1);
  }

  // Validate system prompt if provided (dynamically from SYSTEM_PROMPTS)
  if (specifiedSystem) {
    const { SYSTEM_PROMPTS } = await import("./agent/promptAssets");
    const validSystemPrompts = SYSTEM_PROMPTS.map((p) => p.id);
    if (!validSystemPrompts.includes(specifiedSystem)) {
      console.error(
        `Error: Invalid system prompt "${specifiedSystem}". Must be one of: ${validSystemPrompts.join(", ")}.`,
      );
      process.exit(1);
    }
  }

  // Check if API key is configured
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL;

  // Check if refresh token is missing for Letta Cloud (only when not using env var)
  if (baseURL === LETTA_CLOUD_API_URL && !settings.refreshToken) {
    // For headless mode, error out (assume automation context)
    if (isHeadless) {
      console.error("Missing refresh token");
      console.error("Run 'letta' in interactive mode to re-authenticate.");
      process.exit(1);
    }

    // For interactive mode, show setup flow
    const { runSetup } = await import("./auth/setup");
    await runSetup();
    // After setup, restart main flow
    return main();
  }

  if (!apiKey && baseURL === LETTA_CLOUD_API_URL) {
    // For headless mode, error out (assume automation context)
    if (isHeadless) {
      console.error("Missing LETTA_API_KEY");
      console.error(
        "Run 'letta' in interactive mode to authenticate or export the missing environment variable",
      );
      process.exit(1);
    }

    // For interactive mode, show setup flow
    console.log("No credentials found. Let's get you set up!\n");
    const { runSetup } = await import("./auth/setup");
    await runSetup();
    // After setup, restart main flow
    return main();
  }

  // Validate credentials by checking health endpoint
  const { validateCredentials } = await import("./auth/oauth");
  const isValid = await validateCredentials(baseURL, apiKey ?? "");

  if (!isValid) {
    // For headless mode, error out with helpful message
    if (isHeadless) {
      console.error("Failed to connect to Letta server");
      console.error(`Base URL: ${baseURL}`);
      console.error(
        "Your credentials may be invalid or the server may be unreachable.",
      );
      console.error(
        "Delete ~/.letta/settings.json then run 'letta' to re-authenticate",
      );
      process.exit(1);
    }

    // For interactive mode, show setup flow
    console.log("Failed to connect to Letta server.");
    console.log(`Base URL: ${baseURL}\n`);
    console.log(
      "Your credentials may be invalid or the server may be unreachable.",
    );
    console.log("Let's reconfigure your setup.\n");
    const { runSetup } = await import("./auth/setup");
    await runSetup();
    // After setup, restart main flow
    return main();
  }

  // Set tool filter if provided (controls which tools are loaded)
  if (values.tools !== undefined) {
    const { toolFilter } = await import("./tools/filter");
    toolFilter.setEnabledTools(values.tools as string);
  }

  // Set CLI permission overrides if provided
  if (values.allowedTools || values.disallowedTools) {
    const { cliPermissions } = await import("./permissions/cli");
    if (values.allowedTools) {
      cliPermissions.setAllowedTools(values.allowedTools as string);
    }
    if (values.disallowedTools) {
      cliPermissions.setDisallowedTools(values.disallowedTools as string);
    }
  }

  // Set permission mode if provided (or via --yolo alias)
  const permissionModeValue = values["permission-mode"] as string | undefined;
  const yoloMode = values.yolo as boolean | undefined;

  if (yoloMode || permissionModeValue) {
    if (yoloMode) {
      // --yolo is an alias for --permission-mode bypassPermissions
      permissionMode.setMode("bypassPermissions");
    } else if (permissionModeValue) {
      const mode = permissionModeValue;
      const validModes = [
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
      ] as const;

      if (validModes.includes(mode as (typeof validModes)[number])) {
        permissionMode.setMode(mode as (typeof validModes)[number]);
      } else {
        console.error(
          `Invalid permission mode: ${mode}. Valid modes: ${validModes.join(", ")}`,
        );
        process.exit(1);
      }
    }
  }

  // Handle --link and --unlink flags (modify tools before starting session)
  const shouldLink = values.link as boolean | undefined;
  const shouldUnlink = values.unlink as boolean | undefined;

  // Validate --link/--unlink flags require --agent
  if (shouldLink || shouldUnlink) {
    if (!specifiedAgentId) {
      console.error(
        `Error: --${shouldLink ? "link" : "unlink"} requires --agent <id>`,
      );
      process.exit(1);
    }
    // Implementation is in InteractiveSession init()
  }

  if (isHeadless) {
    // For headless mode, load tools synchronously (respecting model/toolset when provided)
    const modelForTools = getModelForToolLoading(
      specifiedModel,
      specifiedToolset as "codex" | "default" | undefined,
    );
    await loadTools(modelForTools);
    const client = await getClient();
    await upsertToolsToServer(client);

    const { handleHeadlessCommand } = await import("./headless");
    await handleHeadlessCommand(process.argv, specifiedModel, skillsDirectory);
    return;
  }

  // Interactive: lazy-load React/Ink + App
  const React = await import("react");
  const { render } = await import("ink");
  const { useState, useEffect } = React;
  const AppModule = await import("./cli/App");
  const App = AppModule.default;

  function LoadingApp({
    continueSession,
    forceNew,
    freshBlocks,
    initBlocks,
    baseTools,
    agentIdArg,
    model,
    system,
    toolset,
    skillsDirectory,
  }: {
    continueSession: boolean;
    forceNew: boolean;
    freshBlocks: boolean;
    initBlocks?: string[];
    baseTools?: string[];
    agentIdArg: string | null;
    model?: string;
    system?: string;
    toolset?: "codex" | "default" | "gemini";
    skillsDirectory?: string;
  }) {
    const [loadingState, setLoadingState] = useState<
      | "assembling"
      | "upserting"
      | "linking"
      | "unlinking"
      | "initializing"
      | "checking"
      | "ready"
    >("assembling");
    const [agentId, setAgentId] = useState<string | null>(null);
    const [agentState, setAgentState] = useState<AgentState | null>(null);
    const [resumeData, setResumeData] = useState<ResumeData | null>(null);
    const [isResumingSession, setIsResumingSession] = useState(false);
    const [agentProvenance, setAgentProvenance] =
      useState<AgentProvenance | null>(null);

    useEffect(() => {
      async function init() {
        setLoadingState("assembling");
        const client = await getClient();

        // Determine which agent we'll be using (before loading tools)
        let resumingAgentId: string | null = null;

        // Priority 1: --agent flag
        if (agentIdArg) {
          try {
            await client.agents.retrieve(agentIdArg);
            resumingAgentId = agentIdArg;
          } catch {
            // Agent doesn't exist, will create new later
          }
        }

        // Priority 2: Skip resume if --new flag
        if (!resumingAgentId && !forceNew) {
          // Priority 3: Try project settings
          await settingsManager.loadLocalProjectSettings();
          const localProjectSettings =
            settingsManager.getLocalProjectSettings();
          if (localProjectSettings?.lastAgent) {
            try {
              await client.agents.retrieve(localProjectSettings.lastAgent);
              resumingAgentId = localProjectSettings.lastAgent;
            } catch {
              // Agent no longer exists
            }
          }

          // Priority 4: Try global settings if --continue flag
          if (!resumingAgentId && continueSession && settings.lastAgent) {
            try {
              await client.agents.retrieve(settings.lastAgent);
              resumingAgentId = settings.lastAgent;
            } catch {
              // Agent no longer exists
            }
          }
        }

        // Set resuming state early so loading messages are accurate
        setIsResumingSession(!!resumingAgentId);

        // If resuming an existing agent, load the exact tools attached to it
        // Otherwise, load a full toolset based on model/toolset preference
        if (resumingAgentId && !toolset) {
          try {
            const { getAttachedLettaTools } = await import("./tools/toolset");
            const { loadSpecificTools } = await import("./tools/manager");
            const attachedTools = await getAttachedLettaTools(
              client,
              resumingAgentId,
            );
            if (attachedTools.length > 0) {
              // Load only the specific tools attached to this agent
              await loadSpecificTools(attachedTools);
            } else {
              // No Letta Code tools attached, load default based on model
              const modelForTools = getModelForToolLoading(model, undefined);
              await loadTools(modelForTools);
            }
          } catch {
            // Detection failed, use model-based default
            const modelForTools = getModelForToolLoading(model, undefined);
            await loadTools(modelForTools);
          }
        } else {
          // Creating new agent or explicit toolset specified - load full toolset
          const modelForTools = getModelForToolLoading(model, toolset);
          await loadTools(modelForTools);
        }

        setLoadingState("upserting");
        await upsertToolsToServer(client);

        // Handle --link/--unlink after upserting tools
        if (shouldLink || shouldUnlink) {
          if (!agentIdArg) {
            console.error("Error: --link/--unlink requires --agent <id>");
            process.exit(1);
          }

          setLoadingState(shouldLink ? "linking" : "unlinking");
          const { linkToolsToAgent, unlinkToolsFromAgent } = await import(
            "./agent/modify"
          );

          const result = shouldLink
            ? await linkToolsToAgent(agentIdArg)
            : await unlinkToolsFromAgent(agentIdArg);

          if (!result.success) {
            console.error(`✗ ${result.message}`);
            process.exit(1);
          }
        }

        setLoadingState("initializing");
        const { createAgent } = await import("./agent/create");
        const { getModelUpdateArgs } = await import("./agent/model");

        let agent: AgentState | null = null;

        // Priority 1: Try to use --agent specified ID
        if (agentIdArg) {
          try {
            agent = await client.agents.retrieve(agentIdArg);
            // console.log(`Using agent ${agentIdArg}...`);
          } catch (error) {
            console.error(
              `Agent ${agentIdArg} not found (error: ${JSON.stringify(error)})`,
            );
            console.error(
              "When using --agent, the specified agent ID must exist.",
            );
            console.error("Run 'letta' without --agent to create a new agent.");
            process.exit(1);
          }
        }

        // Priority 2: Check if --new flag was passed (skip all resume logic)
        if (!agent && forceNew) {
          // Create new agent (reuses global blocks unless --fresh-blocks passed)
          const updateArgs = getModelUpdateArgs(model);
          const result = await createAgent(
            undefined,
            model,
            undefined,
            updateArgs,
            freshBlocks, // Only create new blocks if --fresh-blocks passed
            skillsDirectory,
            settings.parallelToolCalls,
            sleeptimeFlag ?? settings.enableSleeptime,
            system,
            initBlocks,
            baseTools,
          );
          agent = result.agent;
          setAgentProvenance(result.provenance);
        }

        // Priority 3: Try to resume from project settings (.letta/settings.local.json)
        if (!agent) {
          await settingsManager.loadLocalProjectSettings();
          const localProjectSettings =
            settingsManager.getLocalProjectSettings();
          if (localProjectSettings?.lastAgent) {
            try {
              agent = await client.agents.retrieve(
                localProjectSettings.lastAgent,
              );
              // console.log(`Resuming project agent ${localProjectSettings.lastAgent}...`);
            } catch (error) {
              console.error(
                `Project agent ${localProjectSettings.lastAgent} not found (error: ${JSON.stringify(error)}), creating new one...`,
              );
            }
          }
        }

        // Priority 4: Try to reuse global lastAgent if --continue flag is passed
        if (!agent && continueSession && settings.lastAgent) {
          try {
            agent = await client.agents.retrieve(settings.lastAgent);
            // console.log(`Continuing previous agent ${settings.lastAgent}...`);
          } catch (error) {
            console.error(
              `Previous agent ${settings.lastAgent} not found (error: ${JSON.stringify(error)}), creating new one...`,
            );
          }
        }

        // Priority 5: Create a new agent
        if (!agent) {
          const updateArgs = getModelUpdateArgs(model);
          const result = await createAgent(
            undefined,
            model,
            undefined,
            updateArgs,
            false, // Don't force new blocks when auto-creating (reuse shared blocks)
            skillsDirectory,
            settings.parallelToolCalls,
            sleeptimeFlag ?? settings.enableSleeptime,
            system,
            undefined,
            undefined,
          );
          agent = result.agent;
          setAgentProvenance(result.provenance);
        }

        // Ensure local project settings are loaded before updating
        // (they may not have been loaded if we didn't try to resume from project settings)
        try {
          settingsManager.getLocalProjectSettings();
        } catch {
          await settingsManager.loadLocalProjectSettings();
        }

        // Save agent ID to both project and global settings
        settingsManager.updateLocalProjectSettings({ lastAgent: agent.id });
        settingsManager.updateSettings({ lastAgent: agent.id });

        // Set agent context for tools that need it (e.g., Skill tool)
        setAgentContext(agent.id, client, skillsDirectory);
        await initializeLoadedSkillsFlag();

        // Re-discover skills and update the skills memory block
        // This ensures new skills added after agent creation are available
        try {
          const { discoverSkills, formatSkillsForMemory, SKILLS_DIR } =
            await import("./agent/skills");
          const { join } = await import("node:path");

          const resolvedSkillsDirectory =
            skillsDirectory || join(process.cwd(), SKILLS_DIR);
          const { skills, errors } = await discoverSkills(
            resolvedSkillsDirectory,
          );

          if (errors.length > 0) {
            console.warn("Errors encountered during skill discovery:");
            for (const error of errors) {
              console.warn(`  ${error.path}: ${error.message}`);
            }
          }

          // Update the skills memory block with freshly discovered skills
          const formattedSkills = formatSkillsForMemory(
            skills,
            resolvedSkillsDirectory,
          );
          await client.agents.blocks.update("skills", {
            agent_id: agent.id,
            value: formattedSkills,
          });
        } catch (error) {
          console.warn(
            `Failed to update skills: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        // Check if we're resuming an existing agent
        const localProjectSettings = settingsManager.getLocalProjectSettings();
        const isResumingProject =
          !forceNew &&
          localProjectSettings?.lastAgent &&
          agent.id === localProjectSettings.lastAgent;
        const resuming = !!(continueSession || agentIdArg || isResumingProject);
        setIsResumingSession(resuming);

        // Get resume data (pending approval + message history) if resuming
        if (resuming) {
          setLoadingState("checking");
          const data = await getResumeData(client, agent);
          setResumeData(data);
        }

        setAgentId(agent.id);
        setAgentState(agent);
        setLoadingState("ready");
      }

      init();
    }, [continueSession, forceNew, freshBlocks, agentIdArg, model, system]);

    if (!agentId) {
      return React.createElement(App, {
        agentId: "loading",
        loadingState,
        continueSession: isResumingSession,
        startupApproval: resumeData?.pendingApproval ?? null,
        startupApprovals: resumeData?.pendingApprovals ?? [],
        messageHistory: resumeData?.messageHistory ?? [],
        tokenStreaming: settings.tokenStreaming,
        agentProvenance,
      });
    }

    return React.createElement(App, {
      agentId,
      agentState,
      loadingState,
      continueSession: isResumingSession,
      startupApproval: resumeData?.pendingApproval ?? null,
      startupApprovals: resumeData?.pendingApprovals ?? [],
      messageHistory: resumeData?.messageHistory ?? [],
      tokenStreaming: settings.tokenStreaming,
      agentProvenance,
    });
  }

  render(
    React.createElement(LoadingApp, {
      continueSession: shouldContinue,
      forceNew: forceNew,
      freshBlocks: freshBlocks,
      initBlocks: initBlocks,
      baseTools: baseTools,
      agentIdArg: specifiedAgentId,
      model: specifiedModel,
      system: specifiedSystem,
      toolset: specifiedToolset as "codex" | "default" | "gemini" | undefined,
      skillsDirectory: skillsDirectory,
    }),
    {
      exitOnCtrlC: false, // We handle CTRL-C manually with double-press guard
    },
  );
}

main();
