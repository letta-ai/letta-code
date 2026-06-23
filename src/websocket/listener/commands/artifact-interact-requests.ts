import type { ArtifactInteractResponseCommand } from "@/types/protocol_v2";

interface PendingArtifactInteractRequest {
  resolve: (response: ArtifactInteractResponseCommand) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingArtifactInteractRequest>();

export function waitForArtifactInteractResponse(input: {
  requestId: string;
  timeoutMs: number;
}): Promise<ArtifactInteractResponseCommand> {
  if (pendingRequests.has(input.requestId)) {
    throw new Error(
      `artifact_interact: duplicate request id ${input.requestId}`,
    );
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(input.requestId);
      reject(
        new Error(
          `artifact_interact: timed out waiting for UI response after ${input.timeoutMs}ms`,
        ),
      );
    }, input.timeoutMs);

    pendingRequests.set(input.requestId, {
      resolve,
      timeoutId,
    });
  });
}

export function resolveArtifactInteractResponse(
  response: ArtifactInteractResponseCommand,
): boolean {
  const pending = pendingRequests.get(response.request_id);
  if (!pending) return false;
  pendingRequests.delete(response.request_id);
  clearTimeout(pending.timeoutId);
  pending.resolve(response);
  return true;
}
