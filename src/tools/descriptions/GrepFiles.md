# grep_files

Finds files whose contents match a regular expression pattern, similar to Codex's `grep_files` tool.

- **pattern**: Required regular expression pattern to search for.
- **include**: Optional glob that limits which files are searched (for example `*.rs` or `*.{ts,tsx}`).
- **path**: Optional directory or file path to search (defaults to the current working directory).
- **limit**: Accepted for compatibility but currently ignored; output may be truncated for very large result sets.




