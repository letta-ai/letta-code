import { createServer, type Server } from "node:http";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthCallbackServer {
  redirectUrl: string;
  expectedState: { value?: string };
  waitForCode(): Promise<string>;
  close(): void;
}

export async function startOAuthCallbackServer(
  preferredPort?: number,
): Promise<OAuthCallbackServer> {
  try {
    return await startOAuthCallbackServerOnPort(preferredPort ?? 0);
  } catch (error) {
    if (!preferredPort) throw error;
    return startOAuthCallbackServerOnPort(0);
  }
}

export function callbackPort(redirectUrl?: string): number | undefined {
  if (!redirectUrl) return undefined;
  try {
    const parsed = new URL(redirectUrl);
    return parsed.hostname === "127.0.0.1" && parsed.port
      ? Number(parsed.port)
      : undefined;
  } catch {
    return undefined;
  }
}

async function startOAuthCallbackServerOnPort(
  port: number,
): Promise<OAuthCallbackServer> {
  const expectedState: { value?: string } = {};
  let server: Server;
  let completed = false;
  let settle: ((code: string) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const codePromise = new Promise<string>((resolve, rejectPromise) => {
    settle = (code) => {
      completed = true;
      resolve(code);
    };
    reject = (error) => {
      completed = true;
      rejectPromise(error);
    };
  });
  void codePromise.catch(() => undefined);

  server = createServer((request, response) => {
    if (
      request.method !== "GET" ||
      !request.url?.startsWith("/") ||
      request.url.startsWith("//") ||
      request.url.includes("\\")
    ) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid request target");
      return;
    }
    const address = server.address();
    const expectedHost =
      address && typeof address !== "string"
        ? `127.0.0.1:${address.port}`
        : undefined;
    if (!expectedHost || request.headers.host !== expectedHost) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid callback host");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url, `http://${expectedHost}`);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid request target");
      return;
    }
    if (
      url.origin !== `http://${expectedHost}` ||
      url.pathname !== "/callback"
    ) {
      response.writeHead(404).end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!state || state !== expectedState.value) {
      response.writeHead(400, { "Content-Type": "text/html" });
      response.end(
        callbackPage("Authorization failed", "Invalid OAuth callback"),
      );
      return;
    }
    if (error) {
      response.writeHead(400, { "Content-Type": "text/html" });
      reject?.(new Error(`MCP OAuth authorization failed: ${error}`));
      response.end(callbackPage("Authorization failed", error), () => {
        void closeServer(true);
      });
      return;
    }
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/html" });
      response.end(
        callbackPage("Authorization failed", "Missing authorization code"),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    settle?.(code);
    response.end(
      callbackPage(
        "Authorization complete",
        "You can close this tab and return to Letta Code.",
      ),
      () => {
        void closeServer(true);
      },
    );
  });
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });

  let serverClosing = false;
  const closeServer = (force = false): void => {
    if (serverClosing) return;
    serverClosing = true;
    server.close();
    if (force) server.closeAllConnections();
  };

  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolve);
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start MCP OAuth callback server");
  }
  const timeout = setTimeout(() => {
    reject?.(new Error("Timed out waiting for MCP OAuth authorization"));
    void closeServer(true);
  }, CALLBACK_TIMEOUT_MS);
  timeout.unref();

  return {
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    expectedState,
    waitForCode: () => codePromise.finally(() => clearTimeout(timeout)),
    close: () => {
      clearTimeout(timeout);
      if (!completed) reject?.(new Error("MCP OAuth flow was cancelled"));
      closeServer(true);
    },
  };
}

function callbackPage(title: string, message: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}
