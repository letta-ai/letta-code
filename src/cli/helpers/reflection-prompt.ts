import type { LocalMemoryFormat } from "@/agent/memory-format";

export interface ReflectionPromptInput {
  instruction?: string;
  parentMemory?: string;
  memoryFormat?: LocalMemoryFormat;
}

export function buildReflectionSubagentPrompt(
  input: ReflectionPromptInput,
): string {
  const lines: string[] = [];
  const v2 = input.memoryFormat === "memfs-v2";
  lines.push(
    'Review the conversation transcript payload and update memory files. The payload path is available as the `$TRANSCRIPT_PATH` env var — read it via Bash (e.g. `wc -c "$TRANSCRIPT_PATH"`). Note: `$TRANSCRIPT_PATH` only expands in shell commands; Edit `file_path` is literal and does NOT expand env vars.',
    "",
    'The payload may be either a JSON message array for one conversation or a `multi_transcript_reflection_payload` manifest. If it is a manifest, read each `payload_path` listed in `transcripts` and synthesize across all conversations. Entries with `mode: "replay"` were already reflected before and are included intentionally for re-review/deduplication; do not ignore them just because they are replay slices.',
    "When reviewing multiple transcripts, prefer durable patterns and latest evidence across sessions. Resolve contradictions by updating stale memory at the source, deduplicate repeated facts, and avoid storing one-off task state.",
    "",
    "The primary agent's memory filesystem is available through the `$MEMORY_DIR` environment variable.",
    "Run git add or git commit commands only from $MEMORY_DIR; the harness handles integration after your commit. If these fail, stop reflecting and report the failure. All other git commands are out of your purview.",
    v2
      ? 'When using Edit, first resolve the absolute file path from `$MEMORY_DIR` with Bash (for example: `printf "%s/persona.md\\n" "$MEMORY_DIR"`) and use the printed path. Do not hardcode memory paths from the prompt.'
      : 'When using Edit, first resolve the absolute file path from `$MEMORY_DIR` with Bash (for example: `printf "%s/system/persona.md\\n" "$MEMORY_DIR"`) and use the printed path. Do not hardcode memory paths from the prompt.',
    v2
      ? "Root Markdown files are in-context memory. Root and child MEMORY.md files are frontmatter-free indexes using ordinary relative Markdown links; every other memory Markdown file has exactly name and description frontmatter. A child directory is memory only when it contains MEMORY.md. Never create system/."
      : "In-context memory (in the parent agent's system prompt) is stored in the `system/` folder and are rendered in <memory> tags below. Modification to files in `system/` will edit the parent agent's system prompt.",
    "Additional memory files (such as skills and external memory) may also be read and modified.",
    "",
  );
  if (input.instruction?.trim()) {
    lines.push(
      "Additional user-provided reflection instruction:",
      input.instruction.trim(),
      "",
      "Use this instruction to focus what you look for, but still only persist durable memory-worthy learnings and do not store transient task state.",
      "",
    );
  }
  if (input.parentMemory) lines.push(input.parentMemory);
  return lines.join("\n");
}
