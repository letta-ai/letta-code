/**
 * Local HTTP callback server for OAuth flows
 * Listens on port 19876 for OAuth redirects
 */

import type { Server } from "bun";

export interface CallbackData {
  code: string;
  state: string;
  error?: string;
  error_description?: string;
}

interface PendingCallback {
  resolve: (data: CallbackData) => void;
  reject: (error: Error) => void;
  timeout: Timer;
}

/**
 * HTML response for successful OAuth callback
 */
function successHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    h1 { margin: 0 0 16px 0; font-size: 24px; }
    p { margin: 0; opacity: 0.9; }
    .checkmark {
      font-size: 48px;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">✓</div>
    <h1>Authorization Successful!</h1>
    <p>You can close this window and return to Letta Code.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`;
}

/**
 * HTML response for OAuth error
 */
function errorHtml(error: string, description?: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Authorization Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    h1 { margin: 0 0 16px 0; font-size: 24px; }
    p { margin: 0; opacity: 0.9; }
    .error-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    .error-details {
      margin-top: 16px;
      font-size: 14px;
      opacity: 0.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">✗</div>
    <h1>Authorization Failed</h1>
    <p>${description || error}</p>
    <p class="error-details">Error: ${error}</p>
  </div>
</body>
</html>`;
}

export class OAuthCallbackServer {
  private server: Server<unknown> | null = null;
  private pendingCallbacks: Map<string, PendingCallback> = new Map();
  private static instance: OAuthCallbackServer | null = null;

  static getInstance(): OAuthCallbackServer {
    if (!OAuthCallbackServer.instance) {
      OAuthCallbackServer.instance = new OAuthCallbackServer();
    }
    return OAuthCallbackServer.instance;
  }

  async ensureRunning(): Promise<void> {
    if (this.server) return;

    const self = this;

    this.server = Bun.serve({
      port: 19876,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          const error = url.searchParams.get("error");
          const errorDescription = url.searchParams.get("error_description");

          // Handle error from OAuth provider
          if (error) {
            const callbackData: CallbackData = {
              code: "",
              state: state || "",
              error,
              error_description: errorDescription || undefined,
            };

            // Resolve pending callback with error
            if (state) {
              const pending = self.pendingCallbacks.get(state);
              if (pending) {
                clearTimeout(pending.timeout);
                pending.resolve(callbackData);
                self.pendingCallbacks.delete(state);
              }
            }

            return new Response(errorHtml(error, errorDescription || undefined), {
              headers: { "Content-Type": "text/html" },
            });
          }

          // Validate required params
          if (!code || !state) {
            return new Response(
              errorHtml("invalid_request", "Missing code or state parameter"),
              {
                status: 400,
                headers: { "Content-Type": "text/html" },
              },
            );
          }

          const callbackData: CallbackData = {
            code,
            state,
          };

          // Resolve pending callback
          const pending = self.pendingCallbacks.get(state);
          if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(callbackData);
            self.pendingCallbacks.delete(state);
          }

          return new Response(successHtml(), {
            headers: { "Content-Type": "text/html" },
          });
        }

        // Health check endpoint
        if (url.pathname === "/health") {
          return new Response("OK", { status: 200 });
        }

        return new Response("Not Found", { status: 404 });
      },
    });
  }

  /**
   * Wait for OAuth callback with matching state
   * @param state The state parameter to match
   * @param timeout Timeout in milliseconds (default: 5 minutes)
   */
  async waitForCallback(
    state: string,
    timeout: number = 300000,
  ): Promise<CallbackData> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingCallbacks.delete(state);
        reject(new Error(`OAuth callback timeout after ${timeout / 1000} seconds`));
      }, timeout);

      this.pendingCallbacks.set(state, {
        resolve,
        reject,
        timeout: timeoutId,
      });
    });
  }

  /**
   * Cancel a pending callback
   */
  cancelPending(state: string): void {
    const pending = this.pendingCallbacks.get(state);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Callback cancelled"));
      this.pendingCallbacks.delete(state);
    }
  }

  /**
   * Stop the callback server
   */
  stop(): void {
    // Reject all pending callbacks
    for (const [state, pending] of this.pendingCallbacks) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Server stopped"));
      this.pendingCallbacks.delete(state);
    }

    this.server?.stop();
    this.server = null;
  }

  /**
   * Check if server is running
   */
  isRunning(): boolean {
    return this.server !== null;
  }
}

// Export singleton instance
export const oauthCallbackServer = OAuthCallbackServer.getInstance();
