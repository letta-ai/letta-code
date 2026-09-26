import {
  isEnvironmentOnline,
  listEnvironments,
} from "@/backend/api/environments";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";

/** Build a prompt for the primary agent; the command itself never moves the conversation. */
export async function buildTeleportMessage(
  cloudExecution = isManagedCloudRuntime(),
  list: typeof listEnvironments = listEnvironments,
): Promise<string> {
  if (!cloudExecution) {
    return `${SYSTEM_REMINDER_OPEN}\nThe user invoked /teleport. Teleport this conversation to Cloud with \`letta teleport cloud\`.\n${SYSTEM_REMINDER_CLOSE}`;
  }

  const destinations: string[] = [];
  let after: string | undefined;
  do {
    const page = await list({ limit: 100, onlineOnly: true, after });
    for (const environment of page.connections) {
      if (
        isEnvironmentOnline(environment) &&
        environment.organizationId !== "local" &&
        !environment.connectionId?.startsWith("local-") &&
        environment.deviceId !== "__letta_cloud__" &&
        !environment.deviceId.startsWith("sandbox-")
      ) {
        destinations.push(
          `- ${environment.connectionName} (${environment.deviceId})`,
        );
      }
    }
    if (!page.hasNextPage || page.connections.length === 0) break;
    after = page.connections.at(-1)?.id;
  } while (after);

  return `${SYSTEM_REMINDER_OPEN}\nThe user invoked /teleport. ${destinations.length ? `Online locations:\n${destinations.join("\n")}\nAsk which location to teleport to, then use \`letta teleport <computer>\`.` : "No other locations are online. Tell the user that there is nowhere to teleport right now."}\n${SYSTEM_REMINDER_CLOSE}`;
}
