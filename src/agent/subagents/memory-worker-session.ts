/**
 * Marks a child CLI process as a background memory worker. Kept free of
 * imports so launchers and the headless sender can check it without loading
 * the worker's sync and backend dependencies.
 */
export const MEMORY_WORKER_SESSION_ENV = "LETTA_MEMORY_WORKER_SESSION";

export function isMemoryWorkerSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[MEMORY_WORKER_SESSION_ENV] === "1";
}
