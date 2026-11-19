import type { AgentSandboxOptions } from "@/backend/api/environments";
import { isCloudEnvironmentSelector } from "@/headless-environment-response";
import taskSchema from "@/tools/schemas/Task.json";

const repositoryPattern = new RegExp(
  taskSchema.properties.cloud.properties.repositories.items.pattern,
);

export function parseTaskCloudOptions(
  computer: unknown,
  cloud: unknown,
): { options?: AgentSandboxOptions } | { error: string } {
  if (cloud === undefined) return {};
  if (typeof computer !== "string" || !isCloudEnvironmentSelector(computer)) {
    return { error: 'cloud requires computer: "cloud" or "cloud-sandbox"' };
  }
  if (
    !cloud ||
    typeof cloud !== "object" ||
    Array.isArray(cloud) ||
    Object.keys(cloud).some(
      (key) => key !== "repositories" && key !== "sandbox_size",
    )
  ) {
    return {
      error: "cloud must be an object with repositories or sandbox_size",
    };
  }
  const { repositories, sandbox_size } = cloud as Record<string, unknown>;
  if (
    sandbox_size !== undefined &&
    sandbox_size !== "regular" &&
    sandbox_size !== "large" &&
    sandbox_size !== "xlarge"
  ) {
    return { error: "cloud.sandbox_size must be regular, large, or xlarge" };
  }

  const options: AgentSandboxOptions = { sandboxSize: sandbox_size };
  if (repositories === undefined) return { options };
  if (
    !Array.isArray(repositories) ||
    repositories.length >
      taskSchema.properties.cloud.properties.repositories.maxItems
  ) {
    return {
      error: "cloud.repositories must be an array of up to 10 repositories",
    };
  }
  options.githubRepositories = [];
  for (const repository of repositories) {
    if (
      typeof repository !== "string" ||
      repository !== repository.trim() ||
      !repositoryPattern.test(repository)
    ) {
      return {
        error:
          "Use owner/repo or owner/repo@<40-hex commit> in cloud.repositories",
      };
    }
    const [owner = "", ref = ""] = repository.split("/");
    const [repo = "", commit] = ref.split("@");
    if (repo === "." || repo === "..") {
      return { error: "Invalid repository name in cloud.repositories" };
    }
    options.githubRepositories.push({ owner, repo, ...(commit && { commit }) });
  }
  return { options };
}
