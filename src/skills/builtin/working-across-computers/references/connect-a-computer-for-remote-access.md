# Connect a computer for remote access

Use this guide when the user is connecting a computer for the first time, no suitable computers are listed, or their local machine cannot be reached.

Explain that the user must complete setup **on the computer they want to connect**, signed into the same Letta account they use on chat.letta.com. Remote access lets agents run commands and access files on that machine, subject to tool approvals. Local-only / “Skip login” mode is not sufficient.

When the user is talking to you through an organization's Slack workspace, use the `send_computer_link` tool: the computer has to be registered in that organization, and the user has no Letta browser session to approve it from. For chat.letta.com users, use the CLI server path for any computer, including a personal laptop, a terminal-only machine, or a VM. Give the relevant steps below rather than only saying the computer is unavailable. Do not run registration commands in the Cloud sandbox as a substitute for connecting the user's machine.

## Option 1: Slack (`send_computer_link`)

Only for requests that arrive through Slack. Call the `send_computer_link` tool; do not mint connect codes through the API or write `letta server --token` commands yourself. The tool posts a one-time command privately to the requester's DM. When they run it on their computer, it signs that computer into the organization for you. Optional arguments are `computer_name` and `shared`.

The tool only works in a 1:1 DM. If the request comes from a channel, ask the person to DM you and call it there. The command expires in 15 minutes; if it expires or was already used, call the tool again rather than asking them to retry the old command.

## Option 2: CLI server (browser sign-in)

Ask the user to install [Node.js ^22.23.4, ^24.22.1, or ^26.12.1](https://nodejs.org/en/download), then run these commands in a terminal **on the target computer**:

```bash
npm install -g @letta-ai/letta-code
letta server --computer-name "work-laptop"
```

If not already authenticated, the server prints a login URL. Ask the user to open it in a browser and authorize with their Letta account. Do not ask them to paste credentials into chat.

Keep the server process running and the computer awake and online. The named computer will appear in the picker on chat.letta.com. For an always-on VM, use a service manager and persist the CLI's authentication state across restarts.

No inbound ports, public IP, or reverse proxy are required: the server connects outward to Letta Cloud. Use plain `letta server`, not `letta server --listen`; `--listen` starts the separate App Server interface for direct application connections.

## Verify access or reconnect an existing computer

After the user completes setup, run:

```bash
letta teleport list
```

Use the returned computer name or ID for remote delegation or teleportation. Do not claim access is ready until the desired computer is listed. Keep the current conversation in place unless the user wants to move it; remote subagents can work there while the parent stays in Cloud.

If the computer is still missing or unreachable, ask the user to check that:

- The computer is awake and connected to the internet.
- `letta server` is still running.
- The CLI is signed into the same Letta account as the web session.

Re-list after the user changes the relevant state, rather than repeatedly retrying an unavailable target. If it is listed but an operation still fails, use the concrete error to diagnose authentication, connectivity, or version compatibility; do not assume it needs reinstalling or bypass access controls.

For current installation details, consult the [machine setup docs](https://docs.letta.com/platform/computers/byom/). Verify CLI flags with `letta server --help` if docs and the installed version disagree.
