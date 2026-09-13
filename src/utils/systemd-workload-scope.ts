export const WORKLOAD_SYSTEMD_SLICE_ENV = "LETTA_WORKLOAD_SYSTEMD_SLICE";

type WorkloadScopeOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Moves a managed agent workload into the systemd slice named by Cloud.
 *
 * Local, container, macOS, and Windows runtimes do not set the opt-in env var,
 * so their process launchers remain unchanged. The managed Linux VM snapshot
 * owns the slice and its aggregate memory limit.
 */
export function wrapManagedWorkloadLauncher(
  launcher: string[],
  options: WorkloadScopeOptions = {},
): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const slice = env[WORKLOAD_SYSTEMD_SLICE_ENV]?.trim();

  if (launcher.length === 0 || platform !== "linux" || !slice) {
    return launcher;
  }

  return [
    "systemd-run",
    "--scope",
    "--quiet",
    "--collect",
    "--property=TimeoutStopSec=5s",
    `--slice=${slice}`,
    "--",
    ...launcher,
  ];
}
