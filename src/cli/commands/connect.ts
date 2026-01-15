// src/cli/commands/connect.ts
// Command handlers for OAuth connection management

import {
  exchangeCodeForTokens,
  extractAccountIdFromToken,
  OPENAI_OAUTH_CONFIG,
  startLocalOAuthServer,
  startOpenAIOAuth,
} from "../../auth/openai-oauth";
import {
  checkOpenAICodexEligibility,
  createOrUpdateOpenAICodexProvider,
  getOpenAICodexProvider,
  OPENAI_CODEX_PROVIDER_NAME,
  removeOpenAICodexProvider,
} from "../../providers/openai-codex-provider";
import {
  createOrUpdateZaiProvider,
  getZaiProvider,
  removeZaiProvider,
  ZAI_PROVIDER_NAME,
} from "../../providers/zai-provider";
import { settingsManager } from "../../settings-manager";
import { getErrorMessage } from "../../utils/error";
import type { Buffers, Line } from "../helpers/accumulator";

// tiny helper for unique ids
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Helper type for command result
type CommandLine = Extract<Line, { kind: "command" }>;

// Context passed to connect handlers
export interface ConnectCommandContext {
  buffersRef: { current: Buffers };
  refreshDerived: () => void;
  setCommandRunning: (running: boolean) => void;
}

// Helper to add a command result to buffers
function addCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): string {
  const cmdId = uid("cmd");
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  buffersRef.current.order.push(cmdId);
  refreshDerived();
  return cmdId;
}

// Helper to update an existing command result
function updateCommandResult(
  buffersRef: { current: Buffers },
  refreshDerived: () => void,
  cmdId: string,
  input: string,
  output: string,
  success: boolean,
  phase: "running" | "finished" = "finished",
): void {
  const line: CommandLine = {
    kind: "command",
    id: cmdId,
    input,
    output,
    phase,
    ...(phase === "finished" && { success }),
  };
  buffersRef.current.byId.set(cmdId, line);
  refreshDerived();
}

/**
 * Handle /connect command
 * Usage: /connect codex
 *
 * Flow:
 * 1. User runs `/connect codex` - starts local server and opens browser for authorization
 * 2. User authorizes in browser, gets redirected back to local server
 * 3. Server automatically exchanges code for tokens and API key
 * 4. Provider is created and user sees success message
 */
export async function handleConnect(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const parts = msg.trim().split(/\s+/);
  const provider = parts[1]?.toLowerCase();

  // Validate provider argument
  if (!provider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /connect <provider> [options]\n\nAvailable providers:\n  \u2022 codex          - Connect via OAuth to authenticate with ChatGPT Plus/Pro\n  \u2022 zai <api_key>   - Connect to Zai with your API key",
      false,
    );
    return;
  }

  if (provider !== "codex" && provider !== "zai") {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Error: Unknown provider "${provider}"\n\nAvailable providers: codex, zai\nUsage: /connect <provider> [options]`,
      false,
    );
    return;
  }

  // Zai is handled separately in App.tsx, but add a fallback just in case
  if (provider === "zai") {
    await handleConnectZai(ctx, msg);
    return;
  }

  // Handle /connect codex
  await handleConnectCodex(ctx, msg);
}

/**
 * Handle /connect codex - OpenAI Codex OAuth with local server
 */
async function handleConnectCodex(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  // Check if already connected (provider exists on backend)
  const existingProvider = await getOpenAICodexProvider();
  if (existingProvider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Already connected to OpenAI Codex via OAuth.\n\nUse /disconnect codex to remove the current connection first.",
      false,
    );
    return;
  }

  // Start the OAuth flow
  ctx.setCommandRunning(true);

  // Show initial status
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Checking account eligibility...",
    true,
    "running",
  );

  try {
    // 1. Check eligibility before starting OAuth flow
    const eligibility = await checkOpenAICodexEligibility();
    if (!eligibility.eligible) {
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `\u2717 OpenAI Codex OAuth requires a Pro or Enterprise plan\n\n` +
          `This feature is only available for Letta Pro or Enterprise customers.\n` +
          `Current plan: ${eligibility.billing_tier}\n\n` +
          `To upgrade your plan, visit:\n\n` +
          `  https://app.letta.com/settings/organization/usage\n\n` +
          `If you have an OpenAI API key, you can use it directly by setting:\n` +
          `  export OPENAI_API_KEY=your-key`,
        false,
        "finished",
      );
      return;
    }

    // 2. Start OAuth flow - generate PKCE and authorization URL
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "Starting OAuth flow...\nA browser window will open for authorization.",
      true,
      "running",
    );

    const { authorizationUrl, state, codeVerifier, redirectUri } =
      await startOpenAIOAuth(OPENAI_OAUTH_CONFIG.defaultPort);

    // 3. Store state for validation
    settingsManager.storeOAuthState(state, codeVerifier, redirectUri, "openai");

    // 4. Start local server to receive callback
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Starting local OAuth server on port ${OPENAI_OAUTH_CONFIG.defaultPort}...\n\n` +
        `Opening browser for authorization...\n` +
        `If the browser doesn't open automatically, visit:\n\n` +
        `${authorizationUrl}`,
      true,
      "running",
    );

    // Start the server and wait for callback
    const serverPromise = startLocalOAuthServer(
      state,
      OPENAI_OAUTH_CONFIG.defaultPort,
    );

    // 5. Try to open browser
    try {
      const { default: open } = await import("open");
      const subprocess = await open(authorizationUrl, { wait: false });
      // Handle errors from the spawned process (e.g., xdg-open not found in containers)
      subprocess.on("error", () => {
        // Silently ignore - user can still manually visit the URL
      });
    } catch {
      // If auto-open fails, user can still manually visit the URL
    }

    // 6. Wait for callback
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `Waiting for authorization...\n\n` +
        `Please complete the sign-in process in your browser.\n` +
        `The page will redirect automatically when done.\n\n` +
        `If needed, visit:\n${authorizationUrl}`,
      true,
      "running",
    );

    const { result, server } = await serverPromise;

    // Close the server
    server.close();

    // 7. Exchange code for tokens
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "Authorization received! Exchanging code for tokens...",
      true,
      "running",
    );

    const tokens = await exchangeCodeForTokens(
      result.code,
      codeVerifier,
      redirectUri,
    );

    // 8. Extract account ID from JWT
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "Extracting account information...",
      true,
      "running",
    );

    let accountId: string;
    try {
      accountId = extractAccountIdFromToken(tokens.access_token);
    } catch (error) {
      throw new Error(
        `Failed to extract account ID from token. This may indicate an incompatible account type. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 9. Create or update provider in Letta with OAuth config
    // Backend handles request transformation to ChatGPT backend API
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "Creating OpenAI Codex provider...",
      true,
      "running",
    );

    await createOrUpdateOpenAICodexProvider({
      access_token: tokens.access_token,
      id_token: tokens.id_token,
      refresh_token: tokens.refresh_token,
      account_id: accountId,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });

    // 10. Clear OAuth state
    settingsManager.clearOAuthState();

    // 11. Success!
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `\u2713 Successfully connected to OpenAI Codex!\n\n` +
        `Provider '${OPENAI_CODEX_PROVIDER_NAME}' created/updated in Letta.\n` +
        `Your ChatGPT Plus/Pro subscription is now linked.\n\n` +
        `You can now use ChatGPT models via /model`,
      true,
      "finished",
    );
  } catch (error) {
    // Clear any partial state
    settingsManager.clearOAuthState();

    // Check if this is a plan upgrade requirement error from provider creation
    const errorMessage = getErrorMessage(error);

    let displayMessage: string;
    if (errorMessage === "PLAN_UPGRADE_REQUIRED") {
      displayMessage =
        `\u2717 OpenAI Codex OAuth requires a Pro or Enterprise plan\n\n` +
        `This feature is only available for Letta Pro or Enterprise customers.\n` +
        `To upgrade your plan, visit:\n\n` +
        `  https://app.letta.com/settings/organization/usage\n\n` +
        `If you have an OpenAI API key, you can use it directly by setting:\n` +
        `  export OPENAI_API_KEY=your-key`;
    } else {
      displayMessage = `\u2717 Failed to connect: ${errorMessage}`;
    }

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      displayMessage,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

/**
 * Handle /disconnect command
 * Usage: /disconnect <provider>
 */
export async function handleDisconnect(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const parts = msg.trim().split(/\s+/);
  const provider = parts[1]?.toLowerCase();

  // If no provider specified, show usage
  if (!provider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /disconnect <provider>\n\nAvailable providers: codex, claude, zai",
      false,
    );
    return;
  }

  // Handle /disconnect zai
  if (provider === "zai") {
    await handleDisconnectZai(ctx, msg);
    return;
  }

  // Handle /disconnect codex
  if (provider === "codex") {
    await handleDisconnectCodex(ctx, msg);
    return;
  }

  // Handle /disconnect claude (legacy - for users who connected before)
  if (provider === "claude") {
    await handleDisconnectClaude(ctx, msg);
    return;
  }

  // Unknown provider
  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Error: Unknown provider "${provider}"\n\nAvailable providers: codex, claude, zai\nUsage: /disconnect <provider>`,
    false,
  );
}

/**
 * Handle /disconnect codex
 */
async function handleDisconnectCodex(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  // Check if provider exists on backend
  const existingProvider = await getOpenAICodexProvider();
  if (!existingProvider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Not currently connected to OpenAI Codex via OAuth.\n\nUse /connect codex to authenticate.",
      false,
    );
    return;
  }

  // Show running status
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Disconnecting from OpenAI Codex OAuth...",
    true,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    // Remove provider from Letta backend
    await removeOpenAICodexProvider();

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `\u2713 Disconnected from OpenAI Codex OAuth.\n\n` +
        `Provider '${OPENAI_CODEX_PROVIDER_NAME}' removed from Letta.`,
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `\u2717 Failed to disconnect from OpenAI Codex: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

/**
 * Handle /disconnect claude (legacy provider removal)
 * This allows users who connected Claude before it was replaced with Codex
 * to remove the old claude-pro-max provider
 */
async function handleDisconnectClaude(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const CLAUDE_PROVIDER_NAME = "claude-pro-max";

  // Show running status
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Checking for Claude provider...",
    true,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    // Check if claude-pro-max provider exists
    const { listProviders } = await import(
      "../../providers/openai-codex-provider"
    );
    const providers = await listProviders();
    const claudeProvider = providers.find((p) => p.name === CLAUDE_PROVIDER_NAME);

    if (!claudeProvider) {
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `No Claude provider found.\n\nThe '${CLAUDE_PROVIDER_NAME}' provider does not exist in your Letta account.`,
        false,
        "finished",
      );
      return;
    }

    // Remove provider from Letta
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "Removing Claude provider...",
      true,
      "running",
    );

    const { deleteOpenAICodexProvider } = await import(
      "../../providers/openai-codex-provider"
    );
    await deleteOpenAICodexProvider(claudeProvider.id);

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Disconnected from Claude.\n\n` +
        `Provider '${CLAUDE_PROVIDER_NAME}' has been removed from Letta.\n\n` +
        `Note: /connect claude has been replaced with /connect codex for OpenAI ChatGPT Plus/Pro.`,
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to disconnect from Claude: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

/**
 * Handle /disconnect zai
 */
async function handleDisconnectZai(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  // Check if Zai provider exists
  const existing = await getZaiProvider();
  if (!existing) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Not currently connected to Zai.\n\nUse /connect zai <api_key> to connect.",
      false,
    );
    return;
  }

  // Show running status
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Disconnecting from Zai...",
    true,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    // Remove provider from Letta
    await removeZaiProvider();

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `\u2713 Disconnected from Zai.\n\n` +
        `Provider '${ZAI_PROVIDER_NAME}' removed from Letta.`,
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `\u2717 Failed to disconnect from Zai: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

/**
 * Handle /connect zai command
 * Usage: /connect zai <api_key>
 *
 * Creates the zai-coding-plan provider with the provided API key
 */
export async function handleConnectZai(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const parts = msg.trim().split(/\s+/);
  // Join all remaining parts in case the API key got split
  const apiKey = parts.slice(2).join("");

  // If no API key provided, show usage
  if (!apiKey || apiKey.length === 0) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /connect zai <api_key>\n\n" +
        "Connect to Zai by providing your API key.\n\n" +
        "Example: /connect zai <api_key>...",
      false,
    );
    return;
  }

  // Show running status
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Creating Zai coding plan provider...",
    true,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    // Create or update the Zai provider with the API key
    await createOrUpdateZaiProvider(apiKey);

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `\u2713 Successfully connected to Zai!\n\n` +
        `Provider '${ZAI_PROVIDER_NAME}' created in Letta.\n\n` +
        `The models are populated in /model \u2192 "All Available Models"`,
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `\u2717 Failed to create Zai provider: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}
