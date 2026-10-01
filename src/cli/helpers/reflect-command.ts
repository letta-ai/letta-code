import { parseModCommandArgv } from "@/cli/mods/command-runtime";

type ReflectCommandArgs =
  | { instruction?: string; kind: "single" }
  | { instruction?: string; kind: "recent"; limit: number }
  | { conversationIds: string[]; instruction?: string; kind: "conversations" }
  | { instruction?: string; kind: "auto" };

function isReflectCommandFlag(value: string): boolean {
  return (
    value === "--" ||
    value === "--auto" ||
    value === "--conversation" ||
    value === "--instruction" ||
    value === "--instructions" ||
    value === "--recent" ||
    value === "-i" ||
    value.startsWith("--instruction=")
  );
}

export function parseReflectCommandArgs(input: string): ReflectCommandArgs {
  const trimmed = input.trim();
  const command = trimmed.split(/\s+/, 1)[0] ?? "/reflect";
  const parts = parseModCommandArgv(trimmed.slice(command.length).trim());
  if (parts.length === 0) {
    return { kind: "single" };
  }

  let recentLimit: number | null = null;
  const conversationIds: string[] = [];
  const instructions: string[] = [];
  let auto = false;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    if (
      part === "--instruction" ||
      part === "--instructions" ||
      part === "-i"
    ) {
      let instructionEnd = index + 1;
      while (instructionEnd < parts.length) {
        const instructionPart = parts[instructionEnd];
        if (!instructionPart || isReflectCommandFlag(instructionPart)) break;
        instructionEnd += 1;
      }
      const instruction = parts
        .slice(index + 1, instructionEnd)
        .join(" ")
        .trim();
      if (!instruction) {
        throw new Error("Usage: /reflect --instruction <instruction>");
      }
      instructions.push(instruction);
      index = instructionEnd - 1;
      continue;
    }
    if (part.startsWith("--instruction=")) {
      const instruction = part.slice("--instruction=".length).trim();
      if (!instruction) {
        throw new Error("Usage: /reflect --instruction <instruction>");
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
        throw new Error("Usage: /reflect -- <instruction>");
      }
      instructions.push(instruction);
      break;
    }
    if (part === "--auto") {
      auto = true;
      continue;
    }
    if (part === "--recent") {
      const raw = parts[index + 1];
      const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("Usage: /reflect --recent <positive integer>");
      }
      recentLimit = parsed;
      index += 1;
      continue;
    }
    if (part === "--conversation") {
      const conversationId = parts[index + 1];
      if (!conversationId) {
        throw new Error("Usage: /reflect --conversation <conversation-id>");
      }
      conversationIds.push(conversationId);
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: /reflect [--recent N | --conversation <id> ... | --auto] [--instruction <instruction>]",
    );
  }

  const instruction = instructions.join("\n").trim() || undefined;
  const modes = [recentLimit !== null, conversationIds.length > 0, auto].filter(
    Boolean,
  ).length;
  if (modes > 1) {
    throw new Error("Use only one of --recent, --conversation, or --auto.");
  }
  if (auto) {
    return { instruction, kind: "auto" };
  }
  if (recentLimit !== null) {
    return { instruction, kind: "recent", limit: recentLimit };
  }
  if (conversationIds.length > 0) {
    return { conversationIds, instruction, kind: "conversations" };
  }
  return { instruction, kind: "single" };
}
