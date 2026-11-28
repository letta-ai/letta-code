export interface ListMemoryCommand {
  type: "list_memory";
  request_id: string;
  agent_id: string;
  include_references?: boolean;
  include_frontmatter?: boolean;
}

export function isListMemoryCommand(
  value: unknown,
): value is ListMemoryCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
    include_references?: unknown;
    include_frontmatter?: unknown;
  };
  return (
    c.type === "list_memory" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string" &&
    (c.include_frontmatter === undefined ||
      typeof c.include_frontmatter === "boolean") &&
    (c.include_references === undefined ||
      typeof c.include_references === "boolean")
  );
}
