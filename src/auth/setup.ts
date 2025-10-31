/**
 * Setup flow handler - can be triggered via `letta setup` or automatically on first run
 */

import { render } from "ink";
import React from "react";
import { SetupUI } from "./setup-ui";

/**
 * Run the setup flow
 * Returns a promise that resolves when setup is complete
 */
export async function runSetup(): Promise<void> {
  return new Promise<void>((resolve) => {
    const { waitUntilExit } = render(
      React.createElement(SetupUI, {
        onComplete: () => {
          resolve();
        },
      }),
    );

    waitUntilExit().catch((error) => {
      console.error("Setup failed:", error);
      process.exit(1);
    });
  });
}
