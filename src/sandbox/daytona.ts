/**
 * Daytona Sandbox Tool Definitions
 *
 * Python source code extracted from letta-ai/letta-tools/daytona_sandbox_tools/tools.py
 * These tools execute inside Daytona cloud sandboxes.
 */

import type { SandboxToolDefinition } from "./e2b";

export const DAYTONA_PIP_PACKAGE = "daytona";

// Helper to get or create Daytona sandbox (shared by all tools)
const GET_SANDBOX_HELPER = `
from letta_client import Letta
client = Letta()

def _get_or_create_daytona_sandbox():
    """Get existing sandbox or create new one for the current agent."""
    import os
    from daytona import Daytona, DaytonaConfig, CreateSandboxFromSnapshotParams

    agent_id = os.environ.get("LETTA_AGENT_ID")
    if not agent_id:
        raise ValueError("LETTA_AGENT_ID environment variable not set")

    daytona_api_key = os.environ.get("DAYTONA_API_KEY")
    if not daytona_api_key:
        raise ValueError("DAYTONA_API_KEY environment variable not set")

    daytona_api_url = os.environ.get("DAYTONA_API_URL", "https://app.daytona.io/api")

    config = DaytonaConfig(api_key=daytona_api_key, api_url=daytona_api_url)
    daytona = Daytona(config)

    agent = client.agents.retrieve(agent_id=agent_id)
    sandbox_id = None
    if agent.metadata and isinstance(agent.metadata, dict):
        sandbox_id = agent.metadata.get("daytona_sandbox_id")

    sandbox = None
    if sandbox_id:
        try:
            sandbox = daytona.get(sandbox_id)
            if sandbox.state == "stopped":
                sandbox.start(timeout=60)
            elif sandbox.state == "archived":
                sandbox = None
        except Exception:
            sandbox = None

    if sandbox is None:
        params = CreateSandboxFromSnapshotParams(
            auto_stop_interval=60,
            auto_archive_interval=0,
            labels={"letta_agent_id": agent_id},
        )
        sandbox = daytona.create(params, timeout=120)
        
        current_metadata = agent.metadata or {}
        if not isinstance(current_metadata, dict):
            current_metadata = {}
        current_metadata["daytona_sandbox_id"] = sandbox.id
        client.agents.modify(agent_id=agent_id, metadata=current_metadata)

    return sandbox, daytona
`;

export const DAYTONA_TOOLS: SandboxToolDefinition[] = [
  {
    name: "sandbox_read",
    description: "Read a file from the Daytona sandbox filesystem.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_read(file_path: str, offset: int = 0, limit: int = None) -> str:
    """
    Reads a file from the Daytona sandbox.

    Args:
        file_path: The absolute path to the file to read
        offset: The line number to start reading from (0-indexed)
        limit: The number of lines to read. If not provided, reads all lines.

    Returns:
        str: The file contents with line numbers
    """
    sandbox, _ = _get_or_create_daytona_sandbox()

    try:
        content_bytes = sandbox.fs.download_file(file_path)
        content = content_bytes.decode('utf-8')

        lines = content.split('\\n')
        total_lines = len(lines)

        if offset > 0:
            lines = lines[offset:]
        if limit is not None:
            lines = lines[:limit]

        start_line = offset + 1
        numbered_lines = []
        for i, line in enumerate(lines):
            line_num = start_line + i
            numbered_lines.append(f"{line_num:6d}\\t{line}")

        result = '\\n'.join(numbered_lines)

        if limit and offset + limit < total_lines:
            result += f"\\n[Showing lines {offset + 1}-{offset + limit} of {total_lines}]"

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
    description: "Write content to a file in the Daytona sandbox.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_write(file_path: str, content: str) -> str:
    """
    Writes content to a file in the Daytona sandbox.

    Args:
        file_path: The absolute path to the file to write
        content: The content to write to the file

    Returns:
        str: Success message
    """
    sandbox, _ = _get_or_create_daytona_sandbox()

    try:
        parent_dir = "/".join(file_path.rsplit("/", 1)[:-1])
        if parent_dir:
            sandbox.process.exec(f"mkdir -p {parent_dir}")

        sandbox.fs.upload_file(content.encode('utf-8'), file_path)

        return f"Successfully wrote {len(content)} characters to {file_path}"

    except Exception as e:
        raise ValueError(f"Failed to write file: {str(e)}")
`,
  },
  {
    name: "sandbox_edit",
    description:
      "Performs exact string replacement in a file in the Daytona sandbox.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_edit(file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> str:
    """
    Performs exact string replacement in a file in the Daytona sandbox.

    Args:
        file_path: The absolute path to the file to modify
        old_string: The text to replace
        new_string: The text to replace it with
        replace_all: Replace all occurrences of old_string (default false)

    Returns:
        str: A message indicating the edit was successful
    """
    if old_string == new_string:
        raise ValueError("old_string and new_string are the same - no edit needed")

    sandbox, _ = _get_or_create_daytona_sandbox()

    try:
        content_bytes = sandbox.fs.download_file(file_path)
        content = content_bytes.decode('utf-8')

        occurrences = content.count(old_string)
        if occurrences == 0:
            raise ValueError(f"String not found in file.\\nString: {old_string}")

        if occurrences > 1 and not replace_all:
            raise ValueError(
                f"Found {occurrences} matches but replace_all is False. "
                f"Set replace_all=True or provide more context.\\nString: {old_string}"
            )

        if replace_all:
            new_content = content.replace(old_string, new_string)
            replaced_count = occurrences
        else:
            new_content = content.replace(old_string, new_string, 1)
            replaced_count = 1

        sandbox.fs.upload_file(new_content.encode('utf-8'), file_path)

        return f"Successfully replaced {replaced_count} occurrence{'s' if replaced_count != 1 else ''} in {file_path}"

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
    description: "Execute a bash command in the Daytona sandbox.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_bash(command: str, timeout: int = 120, run_in_background: bool = False, shell_id: str = None) -> str:
    """
    Execute a bash command in the Daytona sandbox.

    Args:
        command: The bash command to execute
        timeout: Timeout in seconds (default: 120, max: 600)
        run_in_background: Run the command in the background
        shell_id: Optional custom ID for background shell

    Returns:
        str: Command output or shell_id for background commands
    """
    import uuid

    sandbox, _ = _get_or_create_daytona_sandbox()

    MAX_OUTPUT_CHARS = 30000
    timeout_seconds = max(1, min(timeout, 600))

    if run_in_background:
        from daytona import SessionExecuteRequest
        session_id = shell_id if shell_id else f"bg-{uuid.uuid4().hex[:8]}"

        try:
            sandbox.process.create_session(session_id)
            req = SessionExecuteRequest(command=command, run_async=True)
            result = sandbox.process.execute_session_command(session_id, req, timeout=timeout_seconds)

            return f"Background shell started with ID: {session_id}\\nCommand ID: {result.cmd_id}\\nUse sandbox_bash_output('{session_id}') to check output."

        except Exception as e:
            raise ValueError(f"Failed to start background command: {str(e)}")

    else:
        try:
            result = sandbox.process.exec(command, timeout=timeout_seconds)

            output = result.result if hasattr(result, 'result') else ""
            exit_code = result.exit_code if hasattr(result, 'exit_code') else 0

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

    sandbox, _ = _get_or_create_daytona_sandbox()

    try:
        session = sandbox.process.get_session(shell_id)

        if not session.commands:
            return f"No commands found in session '{shell_id}'"

        cmd = session.commands[-1]
        cmd_id = cmd.id if hasattr(cmd, 'id') else cmd.command_id

        logs = sandbox.process.get_session_command_logs(shell_id, cmd_id)

        text = logs.stdout if hasattr(logs, 'stdout') else ""
        stderr = logs.stderr if hasattr(logs, 'stderr') else ""

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

        exit_code = cmd.exit_code if hasattr(cmd, 'exit_code') else None
        status = "running" if exit_code is None else f"finished (exit code: {exit_code})"

        return f"Status: {status}\\n\\n{text}"

    except Exception as e:
        return f"Failed to get output for session '{shell_id}': {str(e)}"
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
    sandbox, _ = _get_or_create_daytona_sandbox()

    try:
        sandbox.process.delete_session(shell_id)
        return f"Killed shell '{shell_id}'"

    except Exception as e:
        return f"Failed to kill shell '{shell_id}': {str(e)}"
`,
  },
  {
    name: "sandbox_grep",
    description:
      "Search for a pattern in files in the Daytona sandbox using grep.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_grep(pattern: str, path: str = None, include: str = None, context_lines: int = 0, max_results: int = 100) -> str:
    """
    Search for a pattern in files in the Daytona sandbox using grep.

    Args:
        pattern: The regular expression pattern to search for
        path: File or directory to search in. Defaults to /home/daytona.
        include: File pattern to include (e.g., '*.py')
        context_lines: Number of context lines to show before and after
        max_results: Maximum number of results to return

    Returns:
        str: Search results with file paths, line numbers, and matching content
    """
    search_path = path if path else "/home/daytona"
    sandbox, _ = _get_or_create_daytona_sandbox()

    MAX_OUTPUT_CHARS = 30000

    try:
        cmd_parts = ["grep", "-rn"]

        if context_lines > 0:
            cmd_parts.append(f"-C{context_lines}")

        if include:
            cmd_parts.append(f"--include='{include}'")

        escaped_pattern = pattern.replace("'", "'\\\\''")
        cmd_parts.append(f"'{escaped_pattern}'")
        cmd_parts.append(search_path)

        cmd = " ".join(cmd_parts) + f" 2>/dev/null | head -n {max_results}"

        result = sandbox.process.exec(cmd, timeout=60)
        output = result.result if hasattr(result, 'result') else ""

        if not output or output.strip() == "":
            return f"No matches found for pattern: {pattern}"

        if len(output) > MAX_OUTPUT_CHARS:
            output = output[:MAX_OUTPUT_CHARS] + "\\n[Output truncated]"

        return output

    except Exception as e:
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
        path: The directory to search in. Defaults to /home/daytona.

    Returns:
        str: List of matching files
    """
    search_path = path if path else "/home/daytona"
    sandbox, _ = _get_or_create_daytona_sandbox()

    try:
        if "**" in pattern:
            name_pattern = pattern.replace("**/", "").replace("**", "*")
            find_cmd = f"find {search_path} -type f -name '{name_pattern}' 2>/dev/null | sort"
        else:
            find_cmd = f"find {search_path} -type f -name '{pattern}' 2>/dev/null | sort"

        result = sandbox.process.exec(find_cmd, timeout=30)
        output = result.result if hasattr(result, 'result') else ""

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
    description: "List directory contents in the Daytona sandbox.",
    source_code: `${GET_SANDBOX_HELPER}

def sandbox_ls(path: str = "/home/daytona", ignore: list = None) -> str:
    """
    List directory contents in the Daytona sandbox.

    Args:
        path: The absolute path to the directory to list
        ignore: List of glob patterns to ignore

    Returns:
        str: Formatted directory listing
    """
    sandbox, _ = _get_or_create_daytona_sandbox()

    try:
        try:
            files = sandbox.fs.list_files(path)
            lines = []
            for f in files:
                name = f.name if hasattr(f, 'name') else str(f)
                is_dir = f.is_dir if hasattr(f, 'is_dir') else False

                if ignore:
                    import fnmatch
                    should_ignore = any(fnmatch.fnmatch(name, pat) for pat in ignore)
                    if should_ignore:
                        continue

                if is_dir:
                    lines.append(f"📁 {name}/")
                else:
                    size = f.size if hasattr(f, 'size') else 0
                    lines.append(f"📄 {name} ({size} bytes)")

            if not lines:
                return f"{path}/ (empty)"

            return f"{path}/\\n" + "\\n".join(sorted(lines))

        except Exception:
            cmd = f"ls -la {path}"
            result = sandbox.process.exec(cmd, timeout=30)
            output = result.result if hasattr(result, 'result') else ""

            if ignore and output:
                lines = output.split("\\n")
                filtered = []
                import fnmatch
                for line in lines:
                    should_ignore = False
                    for pat in ignore:
                        if fnmatch.fnmatch(line, f"*{pat}*"):
                            should_ignore = True
                            break
                    if not should_ignore:
                        filtered.append(line)
                output = "\\n".join(filtered)

            return output if output else f"{path}/ (empty or inaccessible)"

    except Exception as e:
        raise ValueError(f"Failed to list directory: {str(e)}")
`,
  },
  {
    name: "sandbox_status",
    description: "Get the status of the current agent's sandbox.",
    source_code: `from letta_client import Letta
client = Letta()

def sandbox_status() -> str:
    """
    Get the status of the current agent's sandbox.

    Returns:
        str: Sandbox status information
    """
    import os
    from daytona import Daytona, DaytonaConfig

    agent_id = os.environ.get("LETTA_AGENT_ID")
    if not agent_id:
        raise ValueError("LETTA_AGENT_ID environment variable not set")

    agent = client.agents.retrieve(agent_id=agent_id)

    sandbox_id = None
    if agent.metadata and isinstance(agent.metadata, dict):
        sandbox_id = agent.metadata.get("daytona_sandbox_id")

    if not sandbox_id:
        return "No sandbox associated with this agent. A new one will be created on the next sandbox operation."

    try:
        daytona_api_key = os.environ.get("DAYTONA_API_KEY")
        daytona_api_url = os.environ.get("DAYTONA_API_URL", "https://app.daytona.io/api")

        config = DaytonaConfig(api_key=daytona_api_key, api_url=daytona_api_url)
        daytona = Daytona(config)

        sandbox = daytona.get(sandbox_id)
        sandbox.refresh_data()

        info = [
            f"Sandbox ID: {sandbox.id}",
            f"Name: {sandbox.name}",
            f"State: {sandbox.state}",
            f"Resources: {sandbox.cpu} CPU, {sandbox.memory} GiB RAM, {sandbox.disk} GiB disk",
            f"Auto-stop interval: {sandbox.auto_stop_interval} minutes",
        ]

        return "\\n".join(info)

    except Exception as e:
        return f"Sandbox ID: {sandbox_id}\\nStatus: Unavailable\\nError: {str(e)}"
`,
  },
  {
    name: "sandbox_kill",
    description: "Kill the current agent's sandbox permanently.",
    source_code: `from letta_client import Letta
client = Letta()

def sandbox_kill() -> str:
    """
    Kill the current agent's sandbox permanently.

    This will permanently delete the sandbox. A new one will be created
    on the next tool call that needs a sandbox.

    Returns:
        str: A confirmation message
    """
    import os
    from daytona import Daytona, DaytonaConfig

    agent_id = os.environ.get("LETTA_AGENT_ID")
    if not agent_id:
        raise ValueError("LETTA_AGENT_ID environment variable not set")

    agent = client.agents.retrieve(agent_id=agent_id)

    sandbox_id = None
    if agent.metadata and isinstance(agent.metadata, dict):
        sandbox_id = agent.metadata.get("daytona_sandbox_id")

    if not sandbox_id:
        return "No sandbox found for this agent"

    try:
        daytona_api_key = os.environ.get("DAYTONA_API_KEY")
        daytona_api_url = os.environ.get("DAYTONA_API_URL", "https://app.daytona.io/api")

        config = DaytonaConfig(api_key=daytona_api_key, api_url=daytona_api_url)
        daytona = Daytona(config)

        sandbox = daytona.get(sandbox_id)
        daytona.delete(sandbox)

    except Exception:
        pass

    current_metadata = agent.metadata or {}
    if isinstance(current_metadata, dict) and "daytona_sandbox_id" in current_metadata:
        del current_metadata["daytona_sandbox_id"]
        client.agents.modify(agent_id=agent_id, metadata=current_metadata)

    return f"Sandbox {sandbox_id} has been deleted"
`,
  },
];

export const DAYTONA_TOOL_NAMES = DAYTONA_TOOLS.map((t) => t.name);
