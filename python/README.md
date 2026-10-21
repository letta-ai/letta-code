# Letta Code

**Stateful agents in your terminal.** Letta Code agents remember your work,
learn over time, and can read, edit, and run code in your project. This package
installs the `letta` command with a bundled Node.js runtime and native tools.
You do not need Node.js, npm, or a compiler to install or start it.

## Install

With [uv](https://docs.astral.sh/uv/):

```sh
uv tool install letta
```

Or with [pipx](https://pipx.pypa.io/):

```sh
pipx install letta
```

You can also install into a Python virtual environment:

```sh
python -m pip install letta
letta --help
```

Requires Python 3.9+. Platform wheels target glibc Linux (2.28+, x86-64 and
ARM64), macOS (14+, Intel and Apple Silicon), and Windows x64. Alpine/musl,
32-bit systems, and Windows ARM64 are not currently supported. Git and any
tools you want your agent to use must be installed separately.

## Start working

```sh
cd your-project
letta
```

Use `/connect` to configure an LLM provider, coding plan, or local inference
server. Ask your agent to explore the project, or run `/init` to bootstrap its
memory. Use `/model` to switch models, `/new` to start a conversation, `/resume`
to switch conversations, and `/agent` to switch agents.

Sign in with `/login` to back up agents to Letta Cloud and access them across
devices, including [chat.letta.com](https://chat.letta.com). Without an account,
local agents stay on disk and may need manual backups. Provider or hosted model
usage can incur charges; installing the CLI does not include model credits.

```sh
letta --help
letta --version
letta -p "Explain this project"
```

## Upgrade

Use the same tool that installed Letta Code:

```sh
uv tool upgrade letta
# or
pipx upgrade letta
# or, inside your virtual environment
python -m pip install --upgrade letta
```

In-app self-update is disabled for this distribution: upgrades replace the
whole wheel, including its runtime. No npm install runs when you launch Letta.

## Learn more

- [Quickstart](https://docs.letta.com/quickstart/)
- [CLI reference](https://docs.letta.com/platform/cli/reference/)
- [Documentation](https://docs.letta.com/)
- [Source and issues](https://github.com/letta-ai/letta-code)
- [Community](https://discord.gg/letta)

This distribution is the Letta Code CLI, not a Python SDK or API server.
For Python applications calling the Letta API, use
[`letta-client`](https://pypi.org/project/letta-client/).
