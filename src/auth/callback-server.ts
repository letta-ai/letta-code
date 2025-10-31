/**
 * Local HTTP server for handling OAuth authorization code callback
 */

import type { Server } from "node:http";

export interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/**
 * Start a local HTTP server to handle OAuth callback
 * Returns a promise that resolves when the callback is received
 */
export async function startCallbackServer(port: number = 4853): Promise<{
  waitForCallback: () => Promise<CallbackResult>;
  close: () => Promise<void>;
}> {
  const { default: express } = await import("express");
  const app = express();

  let server: Server | null = null;
  let resolveCallback: ((result: CallbackResult) => void) | null = null;

  // Handle OAuth callback
  app.get("/callback", (req, res) => {
    const { code, state, error, error_description } = req.query;

    // Build result
    const result: CallbackResult = {
      code: code as string | undefined,
      state: state as string | undefined,
      error: error as string | undefined,
      error_description: error_description as string | undefined,
    };

    // Send response to user
    if (error) {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Authorization Failed</title>
            <style>
              body {
                font-family: system-ui, -apple-system, sans-serif;
                max-width: 600px;
                margin: 100px auto;
                padding: 20px;
                text-align: center;
              }
              .error { color: #dc2626; }
              .description { color: #6b7280; margin-top: 10px; }
            </style>
          </head>
          <body>
            <h1 class="error">❌ Authorization Failed</h1>
            <p class="description">${error_description || error}</p>
            <p>You can close this window and return to the terminal.</p>
          </body>
        </html>
      `);
    } else {
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Authorization Successful</title>
            <style>
              body {
                font-family: system-ui, -apple-system, sans-serif;
                max-width: 600px;
                margin: 100px auto;
                padding: 20px;
                text-align: center;
              }
              .success { color: #16a34a; }
              .description { color: #6b7280; margin-top: 10px; }
            </style>
          </head>
          <body>
            <h1 class="success">✅ Authorization Successful!</h1>
            <p class="description">You have successfully authorized Letta Code.</p>
            <p>You can close this window and return to the terminal.</p>
          </body>
        </html>
      `);
    }

    // Resolve the promise
    if (resolveCallback) {
      resolveCallback(result);
      resolveCallback = null;
    }
  });

  // Start server
  await new Promise<void>((resolve, reject) => {
    server = app.listen(port, () => {
      resolve();
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Please close other applications using this port.`,
          ),
        );
      } else {
        reject(err);
      }
    });
  });

  return {
    waitForCallback: () =>
      new Promise<CallbackResult>((resolve) => {
        resolveCallback = resolve;
      }),
    close: async () => {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server?.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    },
  };
}
