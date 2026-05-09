import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INTERACTIVE_APP_SOURCE_FILES = [
  "../../cli/app/useSubmitHandler.ts",
  "../../cli/app/useConversationLoop.ts",
  "../../cli/app/useConfigurationHandlers.ts",
  "../../cli/app/AppCoordinator.tsx",
  "../../cli/app/useApprovalFlow.ts",
  "../../cli/app/useConversationSwitching.ts",
  "../../cli/app/useBashHandlers.ts",
  "../../cli/app/useQueuedApprovalSubmit.ts",
  "../../cli/app/useFeedbackHandler.ts",
];

export function readInteractiveAppSource(): string {
  return INTERACTIVE_APP_SOURCE_FILES.map((relativePath) => {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    return readFileSync(path, "utf-8");
  }).join("\n");
}
