export function startStartupAutoUpdateCheck(
  checkAndAutoUpdate: () => Promise<{ enotemptyFailed?: boolean } | undefined>,
  logError: (
    message?: unknown,
    ...optionalParams: unknown[]
  ) => void = console.error,
): void {
  checkAndAutoUpdate()
    .then((result) => {
      // Surface ENOTEMPTY failures so users know how to fix
      if (result?.enotemptyFailed) {
        logError("\nAuto-update failed due to filesystem issue (ENOTEMPTY).");
        logError(
          "Fix: rm -rf $(npm prefix -g)/lib/node_modules/@letta-ai/letta-code && npm i -g @letta-ai/letta-code\n",
        );
      }
    })
    .catch(() => {
      // Silently ignore other update failures (network timeouts, etc.)
    });
}
