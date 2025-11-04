#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getResumeData, type ResumeData } from "./agent/check-approval";
import { getClient } from "./agent/client";
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
  letta --new           Force create a new agent
  letta --continue      Resume global last agent (deprecated, use project-based)
  letta --agent <id>    Open a specific agent by ID

  # headless
  letta -p "..."        One-off prompt in headless mode (no TTY UI)

OPTIONS
  -h, --help            Show this help and exit
  -v, --version         Print version and exit
  --new                 Force create new agent (skip auto-resume)
  -c, --continue        Resume previous session (uses global lastAgent, deprecated)
  -a, --agent <id>      Use a specific agent ID
  -m, --model <id>      Model ID or handle (e.g., "opus" or "anthropic/claude-opus-4-1-20250805")
  -p, --prompt          Headless prompt mode
  --output-format <fmt> Output format for headless mode (text, json, stream-json)
                        Default: text
  --skills <path>       Custom path to skills directory (default: .skills in current directory)

BEHAVIOR
  By default, letta auto-resumes the last agent used in the current directory
  (stored in .letta/settings.local.json). Use --new to force a new agent.
  
  If no credentials are configured, you'll be prompted to authenticate via
  Letta Cloud OAuth on first run.

EXAMPLES
  # when installed as an executable
  letta                 # Auto-resume project agent or create new
  letta --new           # Force new agent
  letta --agent agent_123
  
  # inside the interactive session
  /logout               # Clear credentials and exit
  
  # headless with JSON output (includes stats)
  letta -p "hello" --output-format json

`.trim();

  console.log(usage);
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
        agent: { type: "string", short: "a" },
        model: { type: "string", short: "m" },
        prompt: { type: "boolean", short: "p" },
        run: { type: "boolean" },
        tools: { type: "string" },
        allowedTools: { type: "string" },
        disallowedTools: { type: "string" },
        "permission-mode": { type: "string" },
        yolo: { type: "boolean" },
        "output-format": { type: "string" },
        skills: { type: "string" },
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
  const specifiedAgentId = (values.agent as string | undefined) ?? null;
  const specifiedModel = (values.model as string | undefined) ?? undefined;
  const skillsDirectory = (values.skills as string | undefined) ?? undefined;
  const isHeadless = values.prompt || values.run || !process.stdin.isTTY;

  // Check if API key is configured
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    "https://api.letta.com";

  if (!apiKey && baseURL === "https://api.letta.com") {
    // For headless mode, error out (assume automation context)
    if (isHeadless) {
      console.error("Missing LETTA_API_KEY");
      console.error("Run 'letta' in interactive mode to authenticate");
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
  const isValid = await validateCredentials(baseURL, apiKey);

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

  if (isHeadless) {
    // For headless mode, load tools synchronously
    await loadTools();
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
    agentIdArg,
    model,
    skillsDir,
  }: {
    continueSession: boolean;
    forceNew: boolean;
    agentIdArg: string | null;
    model?: string;
    skillsDir?: string;
  }) {
    const [loadingState, setLoadingState] = useState<
      "assembling" | "upserting" | "initializing" | "checking" | "ready"
    >("assembling");
    const [agentId, setAgentId] = useState<string | null>(null);
    const [agentState, setAgentState] = useState<Letta.AgentState | null>(null);
    const [resumeData, setResumeData] = useState<ResumeData | null>(null);
    const [isResumingSession, setIsResumingSession] = useState(false);

    useEffect(() => {
      async function init() {
        setLoadingState("assembling");
        await loadTools();

        setLoadingState("upserting");
        const client = await getClient();
        await upsertToolsToServer(client);

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
              `Agent ${agentIdArg} not found (error: ${JSON.stringify(error)}), creating new one...`,
            );
          }
        }

        // Priority 2: Check if --new flag was passed (skip all resume logic)
        if (!agent && forceNew) {
          // Create new agent, don't check any lastAgent fields
          const updateArgs = getModelUpdateArgs(model);
          agent = await createAgent(undefined, model, undefined, updateArgs, skillsDir);
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
          agent = await createAgent(undefined, model, undefined, updateArgs, skillsDir);
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

        // Check if we're resuming an existing agent
        const localProjectSettings = settingsManager.getLocalProjectSettings();
        const isResumingProject =
          !forceNew &&
          localProjectSettings?.lastAgent &&
          agent.id === localProjectSettings.lastAgent;
        const resuming = continueSession || !!agentIdArg || isResumingProject;
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
    }, [continueSession, forceNew, agentIdArg, model]);

    if (!agentId) {
      return React.createElement(App, {
        agentId: "loading",
        loadingState,
        continueSession: isResumingSession,
        startupApproval: resumeData?.pendingApproval ?? null,
        messageHistory: resumeData?.messageHistory ?? [],
        tokenStreaming: settings.tokenStreaming,
      });
    }

    return React.createElement(App, {
      agentId,
      agentState,
      loadingState,
      continueSession: isResumingSession,
      startupApproval: resumeData?.pendingApproval ?? null,
      messageHistory: resumeData?.messageHistory ?? [],
      tokenStreaming: settings.tokenStreaming,
    });
  }

  render(
    React.createElement(LoadingApp, {
      continueSession: shouldContinue,
      forceNew: forceNew,
      agentIdArg: specifiedAgentId,
      model: specifiedModel,
      skillsDir: skillsDirectory,
    }),
    {
      exitOnCtrlC: false, // We handle CTRL-C manually with double-press guard
    },
  );
}

main();
