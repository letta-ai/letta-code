import { CloudReadinessError } from "./cloud-readiness-retry";

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry only a rejected capability preflight, never an ambiguous POST outcome. */
export async function initiateFixtureTeleport<T>(
  initiate: () => Promise<T>,
  wait = delay,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await initiate();
    } catch (error) {
      if (
        attempt >= 2 ||
        !(error instanceof CloudReadinessError) ||
        error.status !== 409 ||
        error.errorCode !== "TELEPORT_NOT_SUPPORTED"
      )
        throw error;
      await wait(500 * (attempt + 1));
    }
  }
}

/** Deletion is idempotent; missing fixtures are already clean. */
export async function deleteCloudFixture(
  remove: () => Promise<unknown>,
  wait = delay,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove();
      return;
    } catch (error) {
      const status =
        error instanceof CloudReadinessError
          ? error.status
          : typeof error === "object" && error !== null && "status" in error
            ? error.status
            : undefined;
      if (status === 404) return;
      if (
        attempt >= 2 ||
        typeof status !== "number" ||
        status < 500 ||
        status >= 600
      )
        throw error;
      await wait(500 * (attempt + 1));
    }
  }
}
