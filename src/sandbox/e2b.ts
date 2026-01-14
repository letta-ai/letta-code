/**
 * E2B Sandbox Tool Definitions
 *
 * Python source code extracted from letta-ai/letta-tools/e2b_sandbox_tools/tools.py
 * These tools execute inside E2B persistent sandboxes.
 */

export interface SandboxToolDefinition {
  name: string;
  description: string;
  source_code: string;
}

export const E2B_PIP_PACKAGE = "e2b-code-interpreter";

// Helper to get sandbox (shared by all tools)
const GET_SANDBOX_HELPER = `
def _get_or_create_e2b_sandbox():
    """Get existing sandbox or create new one for the current agent."""
    import os
    from e2b_code_interpreter import Sandbox
    
    agent_id = os.environ.get("LETTA_AGENT_ID")
    if not agent_id:
        raise ValueError("LETTA_AGENT_ID environment variable not set")
    
    agent = client.agents.retrieve(agent_id=agent_id)
    sandbox_id = None
    if agent.metadata and isinstance(agent.metadata, dict):
        sandbox_id = agent.metadata.get("sandbox_id")
    
    if sandbox_id:
        try:
            sandbox = Sandbox.connect(sandbox_id, timeout=600)
            return sandbox
        except Exception:
            pass
    
    sandbox = Sandbox.beta_create(auto_pause=True)
    current_metadata = agent.metadata or {}
    if not isinstance(current_metadata, dict):
        current_metadata = {}
    current_metadata["sandbox_id"] = sandbox.sandbox_id
    client.agents.update(agent_id=agent_id, metadata=current_metadata)
    return sandbox
`;

export const E2B_TOOLS: SandboxToolDefinition[] = [
  {
    name: "sandbox_read",
    description: "Read a file from the sandbox filesystem with line numbers.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_read(file_path: str, offset: int = 0, limit: int = None) -> str:
    """
    Read a file from the sandbox filesystem with line numbers.
    
    Args:
        file_path: The absolute path to the file to read in the sandbox
        offset: Line number to start reading from (0-indexed)
        limit: Maximum number of lines to read (default: 2000)
        
    Returns:
        str: The file content with line numbers
    """
    sandbox = _get_or_create_e2b_sandbox()
    
    MAX_READ_LINES = 2000
    MAX_CHARS_PER_LINE = 2000
    
    try:
        content = sandbox.files.read(file_path)
        
        if not content or content.strip() == "":
            return f"<system-reminder>\\nThe file {file_path} exists but has empty contents.\\n</system-reminder>"
        
        lines = content.split("\\n")
        original_count = len(lines)
        effective_limit = limit if limit is not None else MAX_READ_LINES
        start_line = offset
        end_line = min(start_line + effective_limit, len(lines))
        selected_lines = lines[start_line:end_line]
        
        max_line_num = start_line + len(selected_lines)
        padding = max(1, len(str(max_line_num)))
        
        formatted_lines = []
        lines_truncated = False
        
        for i, line in enumerate(selected_lines):
            line_num = start_line + i + 1
            if len(line) > MAX_CHARS_PER_LINE:
                lines_truncated = True
                line = line[:MAX_CHARS_PER_LINE] + "... [line truncated]"
            formatted_lines.append(f"{str(line_num).rjust(padding)}→{line}")
        
        result = "\\n".join(formatted_lines)
        
        if end_line < original_count and limit is None:
            result += f"\\n\\n[File truncated: showing lines {start_line + 1}-{end_line} of {original_count} total lines.]"
        if lines_truncated:
            result += f"\\n\\n[Some lines exceeded {MAX_CHARS_PER_LINE:,} characters and were truncated.]"
        
        return result
        
    except Exception as e:
        error_msg = str(e)
        if "not found" in error_msg.lower() or "no such file" in error_msg.lower():
            raise ValueError(f"File does not exist: {file_path}")
        raise ValueError(f"Failed to read file: {error_msg}")
`,
  },
  {
    name: "sandbox_write",
    description: "Write content to a file in the sandbox filesystem.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_write(file_path: str, content: str) -> str:
    """
    Write content to a file in the sandbox filesystem.
    
    Args:
        file_path: The absolute path to the file to write in the sandbox
        content: The content to write to the file
        
    Returns:
        str: A success message
    """
    sandbox = _get_or_create_e2b_sandbox()
    
    try:
        parent_dir = "/".join(file_path.rsplit("/", 1)[:-1])
        if parent_dir:
            sandbox.commands.run(f"mkdir -p {parent_dir}")
        
        sandbox.files.write(file_path, content)
        return f"Successfully wrote {len(content)} characters to {file_path}"
    except Exception as e:
        raise ValueError(f"Failed to write file: {str(e)}")
`,
  },
  {
    name: "sandbox_edit",
    description: "Edit a file in the sandbox by replacing text.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_edit(file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> str:
    """
    Edit a file in the sandbox by replacing text.
    
    Args:
        file_path: The absolute path to the file to edit
        old_string: The text to find and replace
        new_string: The text to replace with
        replace_all: If True, replace all occurrences; otherwise replace only the first
        
    Returns:
        str: A message indicating how many replacements were made
    """
    if old_string == new_string:
        raise ValueError("No changes to make: old_string and new_string are exactly the same.")
    
    sandbox = _get_or_create_e2b_sandbox()
    
    try:
        content = sandbox.files.read(file_path)
        occurrences = content.count(old_string)
        
        if occurrences == 0:
            raise ValueError(f"String to replace not found in file.\\nString: {old_string}")
        
        if replace_all:
            new_content = content.replace(old_string, new_string)
            replacements = occurrences
        else:
            new_content = content.replace(old_string, new_string, 1)
            replacements = 1
        
        sandbox.files.write(file_path, new_content)
        return f"Successfully replaced {replacements} occurrence{'s' if replacements != 1 else ''} in {file_path}"
        
    except ValueError:
        raise
    except Exception as e:
        error_msg = str(e)
        if "not found" in error_msg.lower():
            raise ValueError(f"File does not exist: {file_path}")
        raise ValueError(f"Failed to edit file: {error_msg}")
`,
  },
  {
    name: "sandbox_bash",
    description: "Execute a bash command in the sandbox.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_bash(command: str, timeout: int = None, description: str = None, run_in_background: bool = False) -> str:
    """
    Execute a bash command in the sandbox.

    Args:
        command: The command to execute
        timeout: Optional timeout in milliseconds (max 600000)
        description: Clear, concise description of what this command does
        run_in_background: Set to true to run in background. Use sandbox_bash_output to read output.

    Returns:
        str: Command output, or shell_id if run_in_background is True
    """
    import uuid
    
    sandbox = _get_or_create_e2b_sandbox()
    MAX_OUTPUT_CHARS = 30000
    
    if timeout is not None:
        timeout_seconds = max(1, min(timeout // 1000, 600))
    else:
        timeout_seconds = 120

    if run_in_background:
        shell_id = str(uuid.uuid4())[:8]
        jobs_dir = "/home/user/.sandbox_jobs"
        sandbox.commands.run(f"mkdir -p {jobs_dir}")
        
        stdout_file = f"{jobs_dir}/{shell_id}.stdout"
        stderr_file = f"{jobs_dir}/{shell_id}.stderr"
        pid_file = f"{jobs_dir}/{shell_id}.pid"
        
        bg_command = f"nohup bash -c '{command}' > {stdout_file} 2> {stderr_file} & echo $! > {pid_file}"
        sandbox.commands.run(bg_command)
        
        return f"Started background shell '{shell_id}'. Use sandbox_bash_output to check output."

    try:
        result = sandbox.commands.run(command, timeout=timeout_seconds)
        
        stdout = result.stdout if hasattr(result, 'stdout') else ""
        stderr = result.stderr if hasattr(result, 'stderr') else ""
        exit_code = result.exit_code if hasattr(result, 'exit_code') else 0
        
        output = stdout
        if stderr:
            output = f"{output}\\n{stderr}" if output else stderr
        
        if not output:
            output = "(Command completed with no output)"
        
        if len(output) > MAX_OUTPUT_CHARS:
            output = output[:MAX_OUTPUT_CHARS] + "\\n[Output truncated]"
        
        if exit_code != 0:
            return f"Exit code: {exit_code}\\n{output}"
        
        return output
        
    except Exception as e:
        error_msg = str(e)
        if "timeout" in error_msg.lower():
            raise ValueError(f"Command timed out after {timeout_seconds} seconds")
        raise ValueError(f"Command failed: {error_msg}")
`,
  },
  {
    name: "sandbox_bash_output",
    description:
      "Retrieves output from a running or completed background bash shell.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_bash_output(shell_id: str, filter: str = None) -> str:
    """
    Retrieves output from a running or completed background bash shell.

    Args:
        shell_id: The ID of the background shell to retrieve output from
        filter: Optional regular expression to filter the output lines

    Returns:
        str: The stdout and stderr from the shell
    """
    import re
    
    sandbox = _get_or_create_e2b_sandbox()
    
    jobs_dir = "/home/user/.sandbox_jobs"
    stdout_file = f"{jobs_dir}/{shell_id}.stdout"
    stderr_file = f"{jobs_dir}/{shell_id}.stderr"
    pid_file = f"{jobs_dir}/{shell_id}.pid"
    
    result = sandbox.commands.run(f"test -f {pid_file} && echo exists || echo missing")
    if "missing" in result.stdout:
        return f"No background process found with ID: {shell_id}"
    
    result = sandbox.commands.run(f"cat {pid_file}")
    pid = result.stdout.strip()
    result = sandbox.commands.run(f"ps -p {pid} > /dev/null 2>&1 && echo running || echo finished")
    status = "running" if "running" in result.stdout else "finished"
    
    try:
        stdout = sandbox.files.read(stdout_file)
    except Exception:
        stdout = ""
    try:
        stderr = sandbox.files.read(stderr_file)
    except Exception:
        stderr = ""
    
    text = stdout
    if stderr:
        text = f"{text}\\n{stderr}" if text else stderr
    
    if filter and text:
        try:
            pattern = re.compile(filter)
            text = "\\n".join(line for line in text.split("\\n") if pattern.search(line))
        except re.error:
            pass
    
    if not text:
        text = "(no output yet)"
    
    if len(text) > 30000:
        text = text[:30000] + "\\n[Output truncated]"
    
    return f"Status: {status}\\n\\n{text}"
`,
  },
  {
    name: "sandbox_bash_kill",
    description: "Kills a running background bash shell by its ID.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_bash_kill(shell_id: str) -> str:
    """
    Kills a running background bash shell by its ID.

    Args:
        shell_id: The ID of the shell to terminate

    Returns:
        str: Confirmation message
    """
    sandbox = _get_or_create_e2b_sandbox()
    
    jobs_dir = "/home/user/.sandbox_jobs"
    pid_file = f"{jobs_dir}/{shell_id}.pid"
    
    result = sandbox.commands.run(f"test -f {pid_file} && echo exists || echo missing")
    if "missing" in result.stdout:
        return f"No background process found with ID: {shell_id}"
    
    result = sandbox.commands.run(f"cat {pid_file}")
    pid = result.stdout.strip()
    sandbox.commands.run(f"kill {pid} 2>/dev/null || true")
    sandbox.commands.run(f"rm -f {jobs_dir}/{shell_id}.*")
    
    return f"Killed shell '{shell_id}' (PID {pid})"
`,
  },
  {
    name: "sandbox_grep",
    description: "Search for a pattern in files within the sandbox using grep.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_grep(pattern: str, path: str = None, glob: str = None, output_mode: str = "files_with_matches", context_before: int = None, context_after: int = None, context: int = None, line_numbers: bool = True, case_insensitive: bool = False, file_type: str = None, head_limit: int = 100, offset: int = 0, multiline: bool = False) -> str:
    """
    Search for a pattern in files within the sandbox using grep.
    
    Args:
        pattern: The regular expression pattern to search for
        path: File or directory to search in. Defaults to /home/user.
        glob: Glob pattern to filter files (e.g. "*.js")
        output_mode: "content", "files_with_matches", or "count"
        context_before: Lines to show before match (-B)
        context_after: Lines to show after match (-A)
        context: Lines before and after (-C)
        line_numbers: Show line numbers (-n)
        case_insensitive: Case insensitive (-i)
        file_type: File type to search (e.g. py, js)
        head_limit: Limit results (default 100)
        offset: Skip first N results
        multiline: Enable multiline mode
    
    Returns:
        str: Search results
    """
    sandbox = _get_or_create_e2b_sandbox()
    
    MAX_OUTPUT_CHARS = 30000
    search_path = path if path else "/home/user"
    
    grep_cmd = "grep -r"
    if case_insensitive:
        grep_cmd += " -i"
    if output_mode == "files_with_matches":
        grep_cmd += " -l"
    elif output_mode == "count":
        grep_cmd += " -c"
    else:
        if context is not None and context > 0:
            grep_cmd += f" -C {context}"
        else:
            if context_before is not None and context_before > 0:
                grep_cmd += f" -B {context_before}"
            if context_after is not None and context_after > 0:
                grep_cmd += f" -A {context_after}"
        if line_numbers:
            grep_cmd += " -n"
    
    if multiline:
        grep_cmd += " -z"
    
    escaped_pattern = pattern.replace("'", "'\\\\''")
    grep_cmd += f" -E '{escaped_pattern}'"
    
    if glob:
        grep_cmd += f" --include='{glob}'"
    if file_type:
        type_map = {"py": "*.py", "js": "*.js", "ts": "*.ts", "tsx": "*.tsx", "java": "*.java", "go": "*.go", "rs": "*.rs", "rust": "*.rs"}
        ext = type_map.get(file_type, f"*.{file_type}")
        grep_cmd += f" --include='{ext}'"
    
    grep_cmd += f" {search_path}"
    
    try:
        result = sandbox.commands.run(grep_cmd)
        output = result.stdout if hasattr(result, 'stdout') else str(result)
        
        if not output or output.strip() == "":
            if output_mode == "files_with_matches":
                return "No files found"
            elif output_mode == "count":
                return "0\\n\\nFound 0 total occurrences across 0 files."
            return "No matches found"
        
        lines = output.strip().split("\\n")
        
        if offset > 0:
            lines = lines[offset:]
        if head_limit > 0 and len(lines) > head_limit:
            lines = lines[:head_limit]
            lines.append(f"\\n[Output truncated: showing {head_limit} results]")
        
        result_text = "\\n".join(lines)
        if len(result_text) > MAX_OUTPUT_CHARS:
            result_text = result_text[:MAX_OUTPUT_CHARS] + "\\n[Output truncated]"
        
        if output_mode == "files_with_matches":
            file_count = len([l for l in lines if l and not l.startswith("[")])
            return f"Found {file_count} file{'s' if file_count != 1 else ''}\\n{result_text}"
        
        return result_text
        
    except Exception as e:
        if "exit code 1" in str(e).lower() or "returned 1" in str(e).lower():
            if output_mode == "files_with_matches":
                return "No files found"
            elif output_mode == "count":
                return "0\\n\\nFound 0 total occurrences across 0 files."
            return "No matches found"
        raise ValueError(f"Grep failed: {str(e)}")
`,
  },
  {
    name: "sandbox_glob",
    description: "Find files matching a glob pattern in the sandbox.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_glob(pattern: str, path: str = None) -> str:
    """
    Find files matching a glob pattern in the sandbox.

    Args:
        pattern: The glob pattern to match files against
        path: The directory to search in. Defaults to /home/user.

    Returns:
        str: List of matching files
    """
    search_path = path if path else "/home/user"
    sandbox = _get_or_create_e2b_sandbox()
    
    try:
        if "**" in pattern:
            name_pattern = pattern.replace("**/", "").replace("**", "*")
            find_cmd = f"find {search_path} -type f -name '{name_pattern}' 2>/dev/null | sort"
        else:
            find_cmd = f"find {search_path} -type f -name '{pattern}' 2>/dev/null | sort"
        
        result = sandbox.commands.run(find_cmd)
        output = result.stdout if hasattr(result, 'stdout') else str(result)
        
        if not output or output.strip() == "":
            return "No files found"
        
        files = [f for f in output.strip().split("\\n") if f]
        total_files = len(files)
        
        max_files = 2000
        if total_files > max_files:
            files = files[:max_files]
            files.append(f"\\n[Output truncated: showing {max_files:,} of {total_files:,} files.]")
        
        return f"Found {total_files} file{'s' if total_files != 1 else ''}\\n" + "\\n".join(files)
        
    except Exception as e:
        raise ValueError(f"Glob failed: {str(e)}")
`,
  },
  {
    name: "sandbox_ls",
    description: "List contents of a directory in the sandbox.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_ls(path: str, ignore: list = None) -> str:
    """
    List contents of a directory in the sandbox.

    Args:
        path: The directory to list
        ignore: Optional list of glob patterns to ignore

    Returns:
        str: A tree-like listing of the directory contents
    """
    import fnmatch
    
    sandbox = _get_or_create_e2b_sandbox()
    MAX_ENTRIES = 1000
    ignore = ignore or []
    
    try:
        result = sandbox.commands.run(f"ls -la {path}")
        output = result.stdout if hasattr(result, 'stdout') else str(result)
        
        if not output or output.strip() == "":
            return f"{path}/ (empty directory)"
        
        lines = output.strip().split("\\n")
        entries = []
        
        for line in lines[1:]:
            parts = line.split()
            if len(parts) < 9:
                continue
            
            name = " ".join(parts[8:])
            if name in (".", ".."):
                continue
            
            if any(fnmatch.fnmatch(name, p) for p in ignore):
                continue
            
            is_dir = parts[0].startswith("d")
            entries.append({"name": name, "type": "directory" if is_dir else "file"})
        
        entries.sort(key=lambda x: (0 if x["type"] == "directory" else 1, x["name"].lower()))
        
        total_entries = len(entries)
        truncated = False
        if total_entries > MAX_ENTRIES:
            entries = entries[:MAX_ENTRIES]
            truncated = True
        
        if not entries:
            return f"{path}/ (empty directory)"
        
        path_parts = path.rstrip("/").split("/")
        last_part = path_parts[-1] if path_parts else "/"
        parent_path = "/".join(path_parts[:-1]) if len(path_parts) > 1 else "/"
        
        output_lines = [f"- {parent_path}/", f"  - {last_part}/"]
        
        for entry in entries:
            suffix = "/" if entry["type"] == "directory" else ""
            output_lines.append(f"    - {entry['name']}{suffix}")
        
        if truncated:
            output_lines.append("")
            output_lines.append(f"[Output truncated: showing {MAX_ENTRIES:,} of {total_entries:,} entries.]")
        
        return "\\n".join(output_lines)
        
    except Exception as e:
        error_msg = str(e)
        if "not found" in error_msg.lower() or "no such" in error_msg.lower():
            raise ValueError(f"Directory not found: {path}")
        if "not a directory" in error_msg.lower():
            raise ValueError(f"Not a directory: {path}")
        raise ValueError(f"Failed to list directory: {error_msg}")
`,
  },
  {
    name: "sandbox_status",
    description: "Get the status of the current agent's sandbox.",
    source_code: `def sandbox_status() -> str:
    """
    Get the status of the current agent's sandbox.
    
    Returns:
        str: Sandbox status information
    """
    import os
    from e2b_code_interpreter import Sandbox
    
    agent_id = os.environ.get("LETTA_AGENT_ID")
    if not agent_id:
        raise ValueError("LETTA_AGENT_ID environment variable not set")
    
    agent = client.agents.retrieve(agent_id=agent_id)
    
    sandbox_id = None
    if agent.metadata and isinstance(agent.metadata, dict):
        sandbox_id = agent.metadata.get("sandbox_id")
    
    if not sandbox_id:
        return "No sandbox associated with this agent. A new one will be created on the next sandbox operation."
    
    try:
        sandbox = Sandbox.connect(sandbox_id, timeout=600)
        return f"Sandbox ID: {sandbox_id}\\nStatus: Running"
    except Exception as e:
        return f"Sandbox ID: {sandbox_id}\\nStatus: Unavailable (may be paused or expired)\\nError: {str(e)}"
`,
  },
  {
    name: "sandbox_kill",
    description: "Kill the current agent's sandbox permanently.",
    source_code: `def sandbox_kill() -> str:
    """
    Kill the current agent's sandbox permanently.
    
    This will permanently delete the sandbox. A new one will be created
    on the next tool call that needs a sandbox.
    
    Returns:
        str: A confirmation message
    """
    import os
    from e2b_code_interpreter import Sandbox
    
    agent_id = os.environ.get("LETTA_AGENT_ID")
    if not agent_id:
        raise ValueError("LETTA_AGENT_ID environment variable not set")
    
    agent = client.agents.retrieve(agent_id=agent_id)
    
    sandbox_id = None
    if agent.metadata and isinstance(agent.metadata, dict):
        sandbox_id = agent.metadata.get("sandbox_id")
    
    if not sandbox_id:
        return "No sandbox found for this agent"
    
    try:
        Sandbox.kill(sandbox_id)
    except Exception:
        pass
    
    current_metadata = agent.metadata or {}
    if isinstance(current_metadata, dict) and "sandbox_id" in current_metadata:
        del current_metadata["sandbox_id"]
        client.agents.update(agent_id=agent_id, metadata=current_metadata)
    
    return f"Sandbox {sandbox_id} has been killed"
`,
  },
];

export const E2B_TOOL_NAMES = E2B_TOOLS.map((t) => t.name);
