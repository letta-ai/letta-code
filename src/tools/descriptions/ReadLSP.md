# Read

Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than 2000 characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- This tool can only read files, not directories. To read a directory, use the ls command via Bash.
- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.

## Diagnostics (TypeScript/JavaScript/Python)

When reading supported files, the Read tool automatically includes LSP diagnostics (type errors, syntax errors, etc.):

**Supported languages:**
- TypeScript/JavaScript: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`
- Python: `.py`, `.pyi`

**Behavior:**
- **Auto-included** for files under 500 lines
- **Manually controlled** via `include_types` parameter:
  - `include_types: true` - Force include diagnostics (even for large files)
  - `include_types: false` - Skip diagnostics (even for small files)
  
When errors are found, they appear at the end of the file content:
```
This file has errors, please fix
<file_diagnostics>
ERROR [10:5] Cannot find name 'foo'
ERROR [15:3] Type 'string' is not assignable to type 'number'
</file_diagnostics>
```

This helps you catch type errors before making edits.
