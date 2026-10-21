/** Electron owns the OAuth grant. This process only holds its current token. */
export class DesktopCredentialSession {
  private token: string | null = null;
  private closed = false;

  receive(message: unknown): boolean {
    if (this.closed || !message || typeof message !== "object") return false;
    if (!("type" in message) || message.type !== "desktop_credentials") {
      return false;
    }
    if (
      !("accessToken" in message) ||
      typeof message.accessToken !== "string" ||
      !message.accessToken.trim()
    ) {
      return false;
    }
    this.token = message.accessToken;
    return true;
  }

  getAccessToken(): string {
    if (!this.token || this.closed) {
      throw new Error("Desktop credentials are unavailable");
    }
    return this.token;
  }

  close(): void {
    this.closed = true;
    this.token = null;
  }
}

let session: DesktopCredentialSession | null = null;

/** Undefined means an ordinary CLI process, never a Desktop fallback. */
export function getDesktopAccessToken(): string | undefined {
  return session?.getAccessToken();
}

export async function initializeDesktopCredentials(): Promise<void> {
  if (session || process.env.LETTA_DESKTOP_CREDENTIALS_IPC !== "1") return;
  delete process.env.LETTA_DESKTOP_CREDENTIALS_IPC;
  delete process.env.LETTA_API_KEY;
  if (!process.connected || !process.send) {
    throw new Error("Desktop credentials require the parent IPC channel");
  }
  const credentials = new DesktopCredentialSession();
  session = credentials;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      credentials.close();
      reject(new Error("Desktop did not provide its initial credentials"));
    }, 30_000);
    process.on("message", (message) => {
      if (!credentials.receive(message)) return;
      clearTimeout(timeout);
      resolve();
    });
    process.once("disconnect", () => {
      credentials.close();
      clearTimeout(timeout);
      reject(new Error("Desktop credential owner disconnected"));
      process.kill(process.pid, "SIGTERM");
    });
    process.send?.({ type: "desktop_credentials_ready" });
  });
}

/** SDK authHeaders reads apiKey for each request, including retained clients. */
export function bindDesktopCredentials<T extends { apiKey: string | null }>(
  client: T,
): T {
  if (session) {
    Object.defineProperty(client, "apiKey", {
      get: getDesktopAccessToken,
      configurable: false,
    });
  }
  return client;
}
