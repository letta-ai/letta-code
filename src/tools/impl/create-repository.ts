import { getCurrentAgentId } from "@/agent/context";
import { createAgentRepository } from "@/agent/memory-git";
import { validateRequiredParams } from "./validation";

interface CreateRepositoryArgs {
  name: string;
}

interface CreateRepositoryResult {
  id: string;
  name: string;
  path: string;
  message: string;
}

function resolveAgentId(): string {
  try {
    const agentId = getCurrentAgentId().trim();
    if (agentId) return agentId;
  } catch {
    // Fall back to env below.
  }

  const envAgentId = (
    process.env.LETTA_AGENT_ID ||
    process.env.AGENT_ID ||
    ""
  ).trim();
  if (envAgentId) return envAgentId;

  throw new Error("create_repository: unable to resolve current agent id");
}

export async function create_repository(
  args: CreateRepositoryArgs,
): Promise<CreateRepositoryResult> {
  validateRequiredParams(args, ["name"], "create_repository");

  const agentId = resolveAgentId();
  const repository = await createAgentRepository({ agentId, name: args.name });

  return {
    id: repository.id,
    name: repository.name,
    path: repository.path,
    message: `Created and mounted repository "${repository.name}" at ${repository.path}`,
  };
}
