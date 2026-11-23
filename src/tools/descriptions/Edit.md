Performs exact string replacement in a file.

- Read the file in this conversation before editing it. Exception: memory files whose contents are already present in your system prompt do not require a Read call first. For memory files, pass an expanded absolute path.
- `file_path` is literal: `$VAR`, `$MEMORY_DIR`, `~`, etc. are not expanded.
- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.
- `replace_all: true` replaces every occurrence instead.
