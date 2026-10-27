import { trackBoundaryError } from "./telemetry/error-reporting";

export interface UpdateNotification {
  latestVersion: string;
}

export function startStartupAutoUpdateCheck(
  checkAndAutoUpdate: () => Promise<
    | {
        enotemptyFailed?: boolean;
        latestVersion?: string;
        updateApplied?: boolean;
        manualUpdateCommand?: string;
      }
    | undefined
  >,
  logError: (
    message?: unknown,
    ...optionalParams: unknown[]
  ) => void = console.error,
): Promise<UpdateNotification | undefined> {
  return checkAndAutoUpdate()
    .then((result) => {
      // Surface ENOTEMPTY failures so users know how to fix
      if (result?.enotemptyFailed) {
        logError("\nAuto-update failed due to filesystem issue (ENOTEMPTY).");
        logError(
          "Fix: rm -rf $(npm prefix -g)/lib/node_modules/@letta-ai/letta-code && npm i -g @letta-ai/letta-code\n",
        );
      }
      if (result?.manualUpdateCommand && result.latestVersion) {
        logError(
          `\nLetta Code ${result.latestVersion} is available. Close Letta Code and run: ${result.manualUpdateCommand}\n`,
        );
        return undefined;
      }
      // Return notification payload for the TUI to consume
      if (result?.updateApplied && result.latestVersion) {
        return { latestVersion: result.latestVersion };
      }
      return undefined;
    })
    .catch((error) => {
      trackBoundaryError({
        errorType: "startup_auto_update_failed",
        error,
        context: "startup_auto_update",
      });
      return undefined;
    });
}
