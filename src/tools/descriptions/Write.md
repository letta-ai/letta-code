Writes a file to the local filesystem, overwriting if one exists.

When to use: creating a new file, or fully replacing one you've already Read. For partial changes, use Edit instead.

- Exception: memory files whose contents are already present in your system prompt do not require a Read call first. For memory files, pass an expanded absolute path.
- `file_path` is literal: `$VAR`, `$MEMORY_DIR`, `~`, etc. are not expanded.
