/**
 * Setup flow handler - can be triggered via `letta setup` or automatically on first run
 */

import { render } from "ink";
import React from "react";
import { type SetupInitialMode, type SetupResult, SetupUI } from "./setup-ui";

interface RunSetupOptions {
  initialMode?: SetupInitialMode;
  localModeDisabledReason?: string;
}

/**
 * Run the setup flow
 * Returns a promise that resolves when setup is complete
 */
export async function runSetup(
  options: RunSetupOptions = {},
): Promise<SetupResult> {
  return new Promise<SetupResult>((resolve) => {
    let settled = false;
    let instance: ReturnType<typeof render>;
    const settle = (result: SetupResult) => {
      if (settled) {
        return;
      }
      settled = true;
      instance.unmount();
      resolve(result);
    };

    instance = render(
      React.createElement(SetupUI, {
        initialMode: options.initialMode,
        localModeDisabledReason: options.localModeDisabledReason,
        onComplete: settle,
        onCancel: () => settle({ kind: "cancelled" }),
      }),
    );

    instance
      .waitUntilExit()
      .then(() => settle({ kind: "cancelled" }))
      .catch((error) => {
        console.error("Setup failed:", error);
        process.exit(1);
      });
  });
}
