import { parseModCommandArgv } from "@/cli/mods/command-runtime";
import type { ReflectionArenaChoice } from "./reflection-arena";

export type ReflectArenaCommandArgs =
  | {
      instruction?: string;
      kind: "launch";
      modelA?: string;
      modelB?: string;
    }
  | {
      choice: ReflectionArenaChoice;
      kind: "choose";
      notes?: string;
      runId: string;
    }
  | { kind: "resume"; runId: string };

export function parseReflectArenaCommandArgs(
  input: string,
): ReflectArenaCommandArgs {
  const trimmed = input.trim();
  const command = trimmed.split(/\s+/, 1)[0] ?? "/reflect-arena";
  const parts = parseModCommandArgv(trimmed.slice(command.length).trim());
  if (parts[0] === "choose") {
    const runId = parts[1];
    const rawChoice = parts[2];
    if (!runId || !rawChoice) {
      throw new Error(
        "Usage: /reflect-arena choose <run-id> <1|2|tie> [notes]",
      );
    }
    if (rawChoice !== "1" && rawChoice !== "2" && rawChoice !== "tie") {
      throw new Error(
        "Usage: /reflect-arena choose <run-id> <1|2|tie> [notes]",
      );
    }
    return {
      kind: "choose",
      runId,
      choice: rawChoice,
      notes: parts.slice(3).join(" ").trim() || undefined,
    };
  }
  if (parts[0] === "resume") {
    const runId = parts[1];
    if (!runId) {
      throw new Error("Usage: /reflect-arena resume <run-id>");
    }
    return { kind: "resume", runId };
  }

  let modelA: string | undefined;
  let modelB: string | undefined;
  const instructions: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (part === "--model-a") {
      modelA = parts[index + 1];
      if (!modelA) throw new Error("Usage: /reflect-arena --model-a <model>");
      index += 1;
      continue;
    }
    if (part.startsWith("--model-a=")) {
      modelA = part.slice("--model-a=".length).trim();
      if (!modelA) throw new Error("Usage: /reflect-arena --model-a <model>");
      continue;
    }
    if (part === "--model-b") {
      modelB = parts[index + 1];
      if (!modelB) throw new Error("Usage: /reflect-arena --model-b <model>");
      index += 1;
      continue;
    }
    if (part.startsWith("--model-b=")) {
      modelB = part.slice("--model-b=".length).trim();
      if (!modelB) throw new Error("Usage: /reflect-arena --model-b <model>");
      continue;
    }
    if (
      part === "--instruction" ||
      part === "--instructions" ||
      part === "-i"
    ) {
      const instruction = parts
        .slice(index + 1)
        .join(" ")
        .trim();
      if (!instruction) {
        throw new Error("Usage: /reflect-arena --instruction <instruction>");
      }
      instructions.push(instruction);
      break;
    }
    if (part.startsWith("--instruction=")) {
      const instruction = part.slice("--instruction=".length).trim();
      if (!instruction) {
        throw new Error("Usage: /reflect-arena --instruction <instruction>");
      }
      instructions.push(instruction);
      continue;
    }
    if (part === "--") {
      const instruction = parts
        .slice(index + 1)
        .join(" ")
        .trim();
      if (!instruction) {
        throw new Error("Usage: /reflect-arena -- <instruction>");
      }
      instructions.push(instruction);
      break;
    }
    throw new Error(
      "Usage: /reflect-arena [--model-a <model>] [--model-b <model>] [--instruction <instruction>]",
    );
  }

  return {
    kind: "launch",
    modelA,
    modelB,
    instruction: instructions.join("\n").trim() || undefined,
  };
}
