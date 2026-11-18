Reads a file from the local filesystem.

- `file_path` must be an absolute path. It is literal: `$VAR`, `$MEMORY_DIR`, `~`, etc. are not expanded.
- Reads up to 2000 lines by default; lines longer than 2000 characters are truncated.
- When you already know which part of the file you need, only read that part with `offset` and `limit`. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1.
- Reads images (PNG, JPG, …) and presents them visually.
- Reading a directory or a missing file returns an error; an empty file returns a system reminder instead of content.
