export const WORKLOAD_SYSTEMD_SLICE_ENV = "LETTA_WORKLOAD_SYSTEMD_SLICE";

type WorkloadScopeOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

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
    "--property=OOMPolicy=continue",
    `--slice=${slice}`,
    "--",
    ...launcher,
  ];
}
