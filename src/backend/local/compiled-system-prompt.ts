import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LocalCompiledSystemPrompt } from "./system-prompt-compilation";

export function readCompiledSystemPromptFile(
  conversationDir: string,
): LocalCompiledSystemPrompt | undefined {
  try {
    const raw = readFileSync(
      join(conversationDir, "system-prompt.json"),
      "utf8",
    );
    const prompt = JSON.parse(raw) as LocalCompiledSystemPrompt | undefined;
    return prompt?.content ? prompt : undefined;
  } catch {
    return undefined;
  }
}
