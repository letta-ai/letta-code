> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Troubleshooting

> Fix Agent SDK errors by the exact message you see, with the cause and fix for each error in the TypeScript and Python SDKs.

Entries on this page are keyed to the error you see. Each names the cause and what to do.

## CLI startup

### CLINotFoundError: Claude Code not found

The Python SDK launches the Claude Code CLI as a subprocess. When it can't find a `claude` executable, connecting fails with a `CLINotFoundError`:

```
Claude Code not found at: /your/configured/path
```

The message includes the configured path when you set `ClaudeAgentOptions(cli_path=...)` and it points at a missing file. Without `cli_path`, the SDK searches your `PATH` and common install locations, and the message includes install instructions for your platform.

To fix it:

* Install Claude Code if it isn't installed. See [Install Claude Code](/docs/en/setup#install-claude-code) for the command on your platform.
* If you set `cli_path`, confirm the file exists and is the `claude` executable.
* If you rely on `PATH` resolution, confirm `claude --version` works in the same environment your application runs in. Processes you launch outside your shell, such as from an IDE or a service manager, often run with a different `PATH`.

### CLIConnectionError: Refusing to execute batch script

On Windows, connecting fails with a `CLIConnectionError` when the CLI path the Python SDK uses is a `.bat` or `.cmd` batch script, including the `claude.cmd` shim that an npm install creates:

```
Refusing to execute batch script 'C:\\Users\\you\\AppData\\Roaming\\npm\\claude.cmd': Windows runs .bat/.cmd files via cmd.exe, which can execute commands injected through CLI arguments, and no reliable escaping for cmd.exe exists. Use a native claude executable instead: install Claude Code natively (irm https://claude.ai/install.ps1 | iex), point ClaudeAgentOptions(cli_path=...) at a claude.exe, or install the claude-agent-sdk wheel for a platform that bundles claude.exe (e.g. Windows x64).
```

The refusal is deliberate security hardening, not a broken install. Windows runs batch scripts by rewriting the spawn into a `cmd.exe /c` invocation, and `cmd.exe` re-parses the whole command line at execution time, so an argument value can execute injected commands.

Most Windows installs never reach this error. The Windows x64 wheel of `claude-agent-sdk` bundles a `claude.exe`, and the SDK prefers the bundled CLI, then any native `claude.exe` it can discover, before falling back to a batch shim. You see the refusal in two cases:

* You set `ClaudeAgentOptions(cli_path=...)` to a `.bat` or `.cmd` file, such as npm's `claude.cmd` shim.
* Your install has no bundled or native `claude.exe`, for example a source install on ARM64 Windows where the only `claude` on your `PATH` is the npm shim.

To fix it, give the SDK a native executable instead of a batch script:

* If you set `ClaudeAgentOptions(cli_path=...)`, point it at a `claude.exe` or remove the option. The SDK skips discovery while `cli_path` is set, so a native install alone can't take effect.
* Install Claude Code natively in PowerShell: `irm https://claude.ai/install.ps1 | iex`
* On x64 Windows, install the `claude-agent-sdk` wheel, which bundles `claude.exe`.

Before `claude-agent-sdk` 0.2.124, the Python SDK spawned batch scripts through `cmd.exe` without this check.

## Structured outputs

### structured\_output is None but the result says success

A result message can end with `subtype: "success"` while `structured_output` is `None` in Python or `undefined` in TypeScript. The run completes, but no validated output exists. One way to hit this is a schema no output can satisfy, for example conflicting length constraints. The run ends without a validation error, and the only signal is the missing `structured_output`.

Treat this result as a failure in application code. Check both that `subtype` is `success` and that `structured_output` is present before using it. The [Error handling](/docs/en/agent-sdk/structured-outputs#error-handling) section shows this pattern for both SDKs.

If it happens repeatedly with a schema you believe is correct, verify the schema is satisfiable, then simplify it until outputs validate, and reintroduce constraints one at a time.

## Report a new issue

If your error isn't covered here, check the open issues or file a new one in the SDK repositories: [claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript/issues) or [claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python/issues). Include the full error text and your SDK version.
