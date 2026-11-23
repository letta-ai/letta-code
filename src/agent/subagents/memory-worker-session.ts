export const MEMORY_WORKER_SESSION_ENV = "LETTA_MEMORY_WORKER_SESSION";

export function isMemoryWorkerSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[MEMORY_WORKER_SESSION_ENV] === "1";
}
