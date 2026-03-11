export interface StatusCommandOutputInput {
  agentId: string;
  agentName: string | null;
  conversationId: string;
  serverUrl: string;
  memfsEnabled: boolean;
  memoryDirectory: string;
  currentDirectory: string;
  projectDirectory: string;
  permissionMode: string;
  modelDisplayName: string | null;
}

export function formatStatusCommandOutput(
  input: StatusCommandOutputInput,
): string {
  const memfsState = input.memfsEnabled ? "on" : "off";
  const memoryDirectory = input.memfsEnabled
    ? input.memoryDirectory
    : `${input.memoryDirectory} (memfs off)`;

  const lines = [
    `Agent ID: ${input.agentId}`,
    `Agent name: ${input.agentName || "(unnamed)"}`,
    `Conversation ID: ${input.conversationId}`,
    `Server: ${input.serverUrl}`,
    `Memfs: ${memfsState}`,
    `Memory directory: ${memoryDirectory}`,
    `Current directory: ${input.currentDirectory}`,
    `Project directory: ${input.projectDirectory}`,
    `Permission mode: ${input.permissionMode}`,
    `Model: ${input.modelDisplayName || "unknown"}`,
  ];

  return lines.join("\n");
}
