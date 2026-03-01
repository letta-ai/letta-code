/**
 * Shared registration helper for letta remote / /remote command.
 * Owns the HTTP request contract and error handling; callers own UX strings and logging.
 */

export interface RegisterResult {
  connectionId: string;
  wsUrl: string;
}

export interface RegisterOptions {
  serverUrl: string;
  apiKey: string;
  deviceId: string;
  connectionName: string;
}

/**
 * Register this device with the Letta Cloud environments endpoint.
 * Throws on any failure with an error message suitable for wrapping in caller-specific context.
 */
export async function registerWithCloud(
  opts: RegisterOptions,
): Promise<RegisterResult> {
  const registerUrl = `${opts.serverUrl}/v1/environments/register`;

  const response = await fetch(registerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
      "X-Letta-Source": "letta-code",
    },
    body: JSON.stringify({
      deviceId: opts.deviceId,
      connectionName: opts.connectionName,
    }),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    const text = await response.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) {
          detail = parsed.message;
        } else {
          detail += `: ${text.slice(0, 200)}`;
        }
      } catch {
        detail += `: ${text.slice(0, 200)}`;
      }
    }
    throw new Error(detail);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "Server returned non-JSON response — is the server running?",
    );
  }

  const result = body as Record<string, unknown>;
  if (
    typeof result.connectionId !== "string" ||
    typeof result.wsUrl !== "string"
  ) {
    throw new Error(
      "Server returned unexpected response shape (missing connectionId or wsUrl)",
    );
  }

  return {
    connectionId: result.connectionId,
    wsUrl: result.wsUrl,
  };
}
