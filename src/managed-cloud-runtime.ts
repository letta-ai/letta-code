export const MANAGED_CLOUD_RUNTIME_ENV = "LETTA_MANAGED_CLOUD_RUNTIME";

const CLOUD_SANDBOX_LISTENER_PREFIX = "sandbox:";

export function markManagedCloudRuntimeFromListenerIdentity(
  listenerInstanceId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (listenerInstanceId.startsWith(CLOUD_SANDBOX_LISTENER_PREFIX)) {
    env[MANAGED_CLOUD_RUNTIME_ENV] = "1";
  }
}

export function isManagedCloudRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[MANAGED_CLOUD_RUNTIME_ENV] === "1";
}
