Read deferred memory from your memory filesystem.

Your root memory files are already in your system prompt. Everything else is deferred: the <deferred-memory> section lists directories you have not opened. Use this tool to open them progressively instead of guessing what they contain.

- Memory("projects") returns projects/MEMORY.md, then the files (<memory_files>) and subdirectories (<deferred-memory>) directly beneath it, with their descriptions.
- Memory("projects/code") opens a subdirectory the same way.
- Memory("projects/example.md") returns that file.

Entries are listed most recently edited first, up to 10 per directory.

Paths are relative to your memory directory. Before acting on a person, project, channel, or topic that your memory index points to, open the matching memory rather than working from assumptions. Open one level at a time and only what the task needs.

Do not use this tool for root memory files (already loaded) or skills/ (use Skill).
