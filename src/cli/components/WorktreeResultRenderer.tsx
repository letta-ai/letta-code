import {
  EnterWorktreeResultRenderer,
  parseEnterWorktreeResult,
} from "./EnterWorktreeResultRenderer.js";
import {
  ExitWorktreeResultRenderer,
  parseExitWorktreeResult,
} from "./ExitWorktreeResultRenderer.js";

export function hasWorktreeResultRenderer(
  toolName: string,
  resultText: string,
  resultOk?: boolean,
): boolean {
  if (resultOk === false) {
    return false;
  }
  if (toolName === "EnterWorktree") {
    return parseEnterWorktreeResult(resultText) !== null;
  }
  if (toolName === "ExitWorktree") {
    return parseExitWorktreeResult(resultText) !== null;
  }
  return false;
}

export function WorktreeToolResult({
  toolName,
  resultText,
}: {
  toolName: string;
  resultText: string;
}) {
  if (toolName === "EnterWorktree") {
    return <EnterWorktreeResultRenderer resultText={resultText} />;
  }
  if (toolName === "ExitWorktree") {
    return <ExitWorktreeResultRenderer resultText={resultText} />;
  }
  return null;
}
