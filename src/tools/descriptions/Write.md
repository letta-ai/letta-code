# Write

Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first. Exception: system memory files whose contents are already shown in your prompt do not require a Read call first. For memory files, pass an expanded absolute path (use Bash to resolve `$MEMORY_DIR` first if needed).
- `file_path` is literal: `$VAR`, `$MEMORY_DIR`, `~`, etc. are not expanded.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.
