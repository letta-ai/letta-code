export interface UpdateNotification {
  latestVersion: string;
}

export function startStartupAutoUpdateCheck(
  checkAndAutoUpdate: () => Promise<
    | {
        enotemptyFailed?: boolean;
        latestVersion?: string;
        updateApplied?: boolean;
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
      // Return notification payload for the TUI to consume
      if (result?.updateApplied && result.latestVersion) {
        return { latestVersion: result.latestVersion };
      }
      return undefined;
    })
    .catch(() => undefined);
}
