// src/cli/commands/connect.ts
// Command handlers for OAuth connection management

import {
  exchangeCodeForTokens,
  startAnthropicOAuth,
  validateAnthropicCredentials,
} from "../../auth/anthropic-oauth";
import {
  ANTHROPIC_PROVIDER_NAME,
  checkAnthropicOAuthEligibility,
  createOrUpdateAnthropicProvider,
  removeAnthropicProvider,
} from "../../providers/anthropic-provider";
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
 * Usage: /connect claude [code]
 *
 * Flow:
 * 1. User runs `/connect claude` - opens browser for authorization
 * 2. User authorizes on claude.ai, gets redirected to Anthropic's callback page
 * 3. User copies the authorization code from the URL
 * 4. User runs `/connect claude <code>` to complete the exchange
 */
export async function handleConnect(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  const parts = msg.trim().split(/\s+/);
  const provider = parts[1]?.toLowerCase();
  // Join all remaining parts in case the code#state got split across lines
  const authCode = parts.slice(2).join(""); // Optional authorization code

  // Validate provider argument
  if (!provider) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Usage: /connect <provider> [options]\n\nAvailable providers:\n  • claude          - Connect via OAuth to authenticate without an API key\n  • zai <api_key>   - Connect to Zai with your API key",
      false,
    );
    return;
  }

  if (provider !== "claude" && provider !== "zai") {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      `Error: Unknown provider "${provider}"\n\nAvailable providers: claude, zai\nUsage: /connect <provider> [options]`,
      false,
    );
    return;
  }

  // Zai is handled separately in App.tsx, but add a fallback just in case
  if (provider === "zai") {
    await handleConnectZai(ctx, msg);
    return;
  }

  // If authorization code is provided, complete the OAuth flow
  if (authCode && authCode.length > 0) {
    await completeOAuthFlow(ctx, msg, authCode);
    return;
  }

  // Check if already connected
  if (
    settingsManager.hasAnthropicOAuth() &&
    !settingsManager.isAnthropicTokenExpired()
  ) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Already connected to Claude via OAuth.\n\nUse /disconnect to remove the current connection first.",
      false,
    );
    return;
  }

  // Start the OAuth flow (step 1)
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
    const eligibility = await checkAnthropicOAuthEligibility();
    if (!eligibility.eligible) {
      updateCommandResult(
        ctx.buffersRef,
        ctx.refreshDerived,
        cmdId,
        msg,
        `✗ Claude OAuth requires a Pro or Enterprise plan\n\n` +
          `This feature is only available for Letta Pro or Enterprise customers.\n` +
          `Current plan: ${eligibility.billing_tier}\n\n` +
          `To upgrade your plan, visit:\n\n` +
          `  https://app.letta.com/settings/organization/usage\n\n` +
          `If you have an Anthropic API key, you can use it directly by setting:\n` +
          `  export ANTHROPIC_API_KEY=your-key`,
        false,
        "finished",
      );
      return;
    }

    // 2. Start OAuth flow - generate PKCE and authorization URL
    const { authorizationUrl, state, codeVerifier } =
      await startAnthropicOAuth();

    // 3. Store state for validation when user returns with code
    settingsManager.storeOAuthState(state, codeVerifier, "anthropic");

    // 4. Try to open browser
    let browserOpened = false;
    try {
      const { default: open } = await import("open");
      const subprocess = await open(authorizationUrl, { wait: false });
      browserOpened = true;
      // Handle errors from the spawned process (e.g., xdg-open not found in containers)
      subprocess.on("error", () => {
        // Silently ignore - user can still manually visit the URL
      });
    } catch {
      // If auto-open fails, user can still manually visit the URL
    }

    // 5. Show instructions
    const browserMsg = browserOpened
      ? "Opening browser for authorization..."
      : "Please open the following URL in your browser:";

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `${browserMsg}\n\n${authorizationUrl}\n\n` +
        "After authorizing, you'll be redirected to a page showing: code#state\n" +
        "Copy the entire value and run:\n\n" +
        "  /connect claude <code#state>\n\n" +
        "Example: /connect claude abc123...#def456...",
      true,
      "finished",
    );
  } catch (error) {
    // Clear any partial state
    settingsManager.clearOAuthState();

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to start OAuth flow: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}

/**
 * Complete OAuth flow after user provides authorization code
 * Accepts either:
 * - Just the code: "n3nzU6B7gMep..."
 * - Code#state format: "n3nzU6B7gMep...#9ba626d8..."
 */
async function completeOAuthFlow(
  ctx: ConnectCommandContext,
  msg: string,
  authCodeInput: string,
): Promise<void> {
  // Show initial status
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Exchanging authorization code for tokens...",
    true,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    // 1. Get stored OAuth state
    const storedState = settingsManager.getOAuthState();
    if (!storedState) {
      throw new Error(
        "No pending OAuth flow found. Please run '/connect claude' first to start the authorization.",
      );
    }

    // 2. Check if state is too old (5 minute timeout)
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() - storedState.timestamp > fiveMinutes) {
      settingsManager.clearOAuthState();
      throw new Error(
        "OAuth session expired. Please run '/connect claude' again to start a new authorization.",
      );
    }

    // 3. Parse code#state format if provided
    let authCode = authCodeInput;
    let stateFromInput: string | undefined;
    if (authCodeInput.includes("#")) {
      const [code, stateVal] = authCodeInput.split("#");
      authCode = code ?? authCodeInput;
      stateFromInput = stateVal;
      // Validate state matches what we stored
      if (stateVal && stateVal !== storedState.state) {
        throw new Error(
          "State mismatch - the authorization may have been tampered with. Please try again.",
        );
      }
    }

    // Use state from input if provided, otherwise use stored state
    const stateToUse = stateFromInput || storedState.state;

    // 4. Exchange code for tokens
    const tokens = await exchangeCodeForTokens(
      authCode,
      storedState.codeVerifier,
      stateToUse,
    );

    // 5. Update status
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "Validating credentials...",
      true,
      "running",
    );

    // 6. Validate tokens work
    const isValid = await validateAnthropicCredentials(tokens.access_token);
    if (!isValid) {
      throw new Error(
        "Token validation failed - the token may not have the required permissions.",
      );
    }

    // 7. Store tokens locally
    settingsManager.storeAnthropicTokens(tokens);

    // 8. Update status for provider creation
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      "Creating Anthropic provider...",
      true,
      "running",
    );

    // 9. Create or update provider in Letta with the access token
    await createOrUpdateAnthropicProvider(tokens.access_token);

    // 10. Clear OAuth state
    settingsManager.clearOAuthState();

    // 11. Success!
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Successfully connected to Claude via OAuth!\n\n` +
        `Provider '${ANTHROPIC_PROVIDER_NAME}' created/updated in Letta.\n` +
        `Your OAuth tokens are stored securely in ~/.letta/settings.json`,
      true,
      "finished",
    );
  } catch (error) {
    // Check if this is a plan upgrade requirement error from provider creation
    const errorMessage = getErrorMessage(error);

    let displayMessage: string;
    if (errorMessage === "PLAN_UPGRADE_REQUIRED") {
      displayMessage =
        `✗ Claude OAuth requires a Pro or Enterprise plan\n\n` +
        `This feature is only available for Letta Pro or Enterprise customers.\n` +
        `To upgrade your plan, visit:\n\n` +
        `  https://app.letta.com/settings/organization/usage\n\n` +
        `If you have an Anthropic API key, you can use it directly by setting:\n` +
        `  export ANTHROPIC_API_KEY=your-key`;
    } else {
      displayMessage = `✗ Failed to connect: ${errorMessage}`;
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
      "Usage: /disconnect <provider>\n\nAvailable providers: claude, zai",
      false,
    );
    return;
  }

  // Handle /disconnect zai
  if (provider === "zai") {
    await handleDisconnectZai(ctx, msg);
    return;
  }

  // Handle /disconnect claude
  if (provider === "claude") {
    await handleDisconnectClaude(ctx, msg);
    return;
  }

  // Unknown provider
  addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    `Error: Unknown provider "${provider}"\n\nAvailable providers: claude, zai\nUsage: /disconnect <provider>`,
    false,
  );
}

/**
 * Handle /disconnect claude
 */
async function handleDisconnectClaude(
  ctx: ConnectCommandContext,
  msg: string,
): Promise<void> {
  // Check if connected
  if (!settingsManager.hasAnthropicOAuth()) {
    addCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      msg,
      "Not currently connected to Claude via OAuth.\n\nUse /connect claude to authenticate.",
      false,
    );
    return;
  }

  // Show running status
  const cmdId = addCommandResult(
    ctx.buffersRef,
    ctx.refreshDerived,
    msg,
    "Disconnecting from Claude OAuth...",
    true,
    "running",
  );

  ctx.setCommandRunning(true);

  try {
    // Remove provider from Letta
    await removeAnthropicProvider();

    // Clear local tokens
    settingsManager.clearAnthropicOAuth();

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Disconnected from Claude OAuth.\n\n` +
        `Provider '${ANTHROPIC_PROVIDER_NAME}' removed from Letta.`,
      true,
      "finished",
    );
  } catch (error) {
    // Still clear local tokens even if provider removal fails
    settingsManager.clearAnthropicOAuth();

    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✓ Disconnected from Claude OAuth.\n\n` +
        `Warning: Failed to remove provider from Letta: ${getErrorMessage(error)}\n` +
        `Your local OAuth tokens have been removed.`,
      true,
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
      `✓ Disconnected from Zai.\n\n` +
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
      `✗ Failed to disconnect from Zai: ${getErrorMessage(error)}`,
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
      `✓ Successfully connected to Zai!\n\n` +
        `Provider '${ZAI_PROVIDER_NAME}' created in Letta.\n\n` +
        `The models are populated in /model → "All Available Models"`,
      true,
      "finished",
    );
  } catch (error) {
    updateCommandResult(
      ctx.buffersRef,
      ctx.refreshDerived,
      cmdId,
      msg,
      `✗ Failed to create Zai provider: ${getErrorMessage(error)}`,
      false,
      "finished",
    );
  } finally {
    ctx.setCommandRunning(false);
  }
}
