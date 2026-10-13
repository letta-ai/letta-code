import { ApiRequestError, apiRequest } from "@/backend/api/request";
import {
  type BrowserDeviceMcpOAuthRequest,
  BrowserDeviceMcpOAuthSiteMismatchError,
  browserDeviceMcpOAuthServerUrls,
  connectBrowserDeviceMcpOAuth,
  matchBrowserDeviceMcpOAuthServerUrl,
} from "@/browser-device-mcp-oauth";
import { McpCliError, type McpOutput } from "./mcp-io";

export interface McpOAuthHandoff {
  handoff_key: string;
  expires_in: number;
}

export interface McpConnectDependencies {
  /** Mint a single-use OAuth handoff for the agent with this login's credentials. */
  mintMcpOAuthHandoff?: (
    agentId: string,
    service: string,
    serverUrl: string,
  ) => Promise<McpOAuthHandoff>;
  /** Run the localhost-callback OAuth and submit the credentials to Cloud. */
  connectMcpOAuth?: (
    request: BrowserDeviceMcpOAuthRequest,
    onSubmissionStarted: () => void,
  ) => Promise<void>;
}

const CONNECT_USAGE =
  "Usage: letta mcp connect <service> [--server-url <url>] [--agent <id>]";

async function defaultMintMcpOAuthHandoff(
  agentId: string,
  service: string,
  serverUrl: string,
): Promise<McpOAuthHandoff> {
  return apiRequest<McpOAuthHandoff>(
    "POST",
    `/v1/agents/${encodeURIComponent(agentId)}/mcp-connections/${encodeURIComponent(service)}/browser-device-oauth-handoffs`,
    { server_url: serverUrl },
  );
}

function defaultConnectMcpOAuth(
  request: BrowserDeviceMcpOAuthRequest,
  onSubmissionStarted: () => void,
): Promise<void> {
  return connectBrowserDeviceMcpOAuth(
    request,
    undefined,
    undefined,
    undefined,
    onSubmissionStarted,
  );
}

function resolveConnectServer(
  service: string | undefined,
  serverUrl: string | undefined,
): { service: string; serverUrl: string } {
  const services = browserDeviceMcpOAuthServerUrls();
  const names = Object.keys(services).join(", ");
  if (!service) {
    throw new McpCliError(
      "invalid_arguments",
      CONNECT_USAGE,
      `Valid services: ${names}.`,
    );
  }
  const urls = Object.hasOwn(services, service) ? services[service] : undefined;
  if (!urls?.[0]) {
    throw new McpCliError(
      "unsupported_service",
      `Unsupported MCP OAuth service '${service}'`,
      `Valid services: ${names}.`,
    );
  }
  if (serverUrl === undefined) return { service, serverUrl: urls[0] };
  const matched = matchBrowserDeviceMcpOAuthServerUrl(service, serverUrl);
  if (!matched) {
    throw new McpCliError(
      "unsupported_server_url",
      `Server URL '${serverUrl}' is not allowed for '${service}'`,
      `Valid --server-url values for ${service}: ${urls.join(", ")}.`,
    );
  }
  return { service, serverUrl: matched };
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function authorizeAndSubmit(
  deps: McpConnectDependencies & { stderr: McpOutput },
  agentId: string,
  service: string,
  serverUrl: string,
): Promise<void> {
  let handoff: McpOAuthHandoff;
  try {
    handoff = await (deps.mintMcpOAuthHandoff ?? defaultMintMcpOAuthHandoff)(
      agentId,
      service,
      serverUrl,
    );
  } catch (error) {
    if (
      error instanceof ApiRequestError &&
      [401, 403, 404].includes(error.status)
    ) {
      throw new McpCliError(
        "agent_not_accessible",
        `Agent '${agentId}' is not accessible to this login (HTTP ${error.status})`,
        "This computer may be signed into a different organization. Re-run `letta server --org <org>` with the agent's organization, then retry.",
      );
    }
    throw error;
  }
  if (typeof handoff?.handoff_key !== "string") {
    throw new Error("Letta API did not return an MCP OAuth handoff key");
  }

  await deps.stderr(
    `Opening your browser to authorize ${service}. Complete the sign-in there; waiting for the localhost callback...`,
  );
  let submitting = false;
  // The OAuth callback server and its timeouts are unref'd so a long-lived
  // listener can exit cleanly; this one-shot command must stay alive until the
  // callback arrives or the authorization times out.
  const keepAlive = setInterval(() => undefined, 60_000);
  try {
    await (deps.connectMcpOAuth ?? defaultConnectMcpOAuth)(
      { handoffKey: handoff.handoff_key, service, serverUrl },
      () => {
        submitting = true;
      },
    );
  } catch (error) {
    if (
      error instanceof BrowserDeviceMcpOAuthSiteMismatchError &&
      !submitting
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (submitting) {
      throw new McpCliError(
        "handoff_submit_failed",
        `Authorization succeeded but saving the connection to the agent failed: ${message}`,
        `Re-run \`letta mcp connect ${service}\` to try again.`,
      );
    }
    if (isTimeout(error)) {
      throw new McpCliError(
        "authorization_timeout",
        `Authorization for ${service} was not completed in time`,
        `Re-run \`letta mcp connect ${service}\` and finish signing in within the browser window.`,
      );
    }
    throw new McpCliError("authorization_failed", message);
  } finally {
    clearInterval(keepAlive);
  }
}

/**
 * Authorize a localhost-callback MCP server (Datadog, Comfy) on this machine
 * and save the connection to the Cloud agent through a minted OAuth handoff.
 */
export async function runMcpConnect(
  deps: McpConnectDependencies & { stderr: McpOutput },
  agentId: string,
  serviceArg: string | undefined,
  serverUrlArg: string | undefined,
  stdout: McpOutput,
): Promise<number> {
  const resolved = resolveConnectServer(serviceArg, serverUrlArg);
  const { service } = resolved;
  let { serverUrl } = resolved;
  // Datadog may authorize on the org's real site (e.g. us5) rather than the
  // selected one. Its callback `domain` names that site, so restart once
  // against the matching allowlisted URL with a handoff bound to it.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await authorizeAndSubmit(deps, agentId, service, serverUrl);
      break;
    } catch (error) {
      if (!(error instanceof BrowserDeviceMcpOAuthSiteMismatchError)) {
        throw error;
      }
      if (attempt > 0) {
        throw new McpCliError(
          "datadog_site_mismatch",
          `Your Datadog org is on ${error.site}. Re-run: letta mcp connect ${service} --server-url ${error.serverUrl}`,
        );
      }
      serverUrl = error.serverUrl;
      await deps.stderr(
        `Your Datadog org is on ${error.site}. Restarting authorization against ${serverUrl}; approve the second browser prompt.`,
      );
    }
  }

  await stdout(
    JSON.stringify(
      { connected: true, service, server_url: serverUrl },
      null,
      2,
    ),
  );
  return 0;
}
