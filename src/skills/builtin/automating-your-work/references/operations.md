# Operations options for automations

An automation can include operational features when it runs repeatedly, handles events, or performs external actions. This document lists common options. A one-off, read-only program may need only a few of them.

## Event handling

- **Event envelope:** an object with the event ID, resource ID, source time, idempotency key, and a link to the original data.
- **Cursor:** a stored position that lets a polling program continue from its last event.
- **Reconciliation pass:** a periodic query that finds events missed by a webhook or stream.
- **Resource lock or queue:** a way to prevent two turns from changing the same resource at the same time.
- **Author filter:** a way to ignore events created by the automation itself.

These options become more useful as event volume and external effects increase.

## External actions

An effects record can connect an event to the action, Agent SDK run IDs, and result. This record helps the program determine whether it already performed an action.

A timeout can leave the result of an external action unknown. The program can query the external system before it sends the action again. For example, it can check whether a comment exists or whether a ticket was created.

A `--dry-run` option can show matched events, planned turns, and planned actions without performing them. The same mode can run against real events during testing.

## Limits and delegated work

An automation can track limits such as:

- Agent turns per hour.
- Notifications per person.
- Model cost.
- Number of delegated conversations.
- Delegation depth.

Lineage fields such as a root ID, parent ID, and depth can connect delegated turns. They also make it easier to stop or inspect a group of related turns.

## Automation manifest

A manifest provides one place to inspect an automation. Possible fields include:

- Name and purpose.
- Owner and source version.
- Trigger and execution location.
- Agent and conversation IDs.
- Credentials and allowed actions.
- State location.
- Cost and activity limits.
- Last event and last action.
- Dry-run, pause, stop, and remove commands.
- Review or expiration date.

For example:

```markdown
# pr-shepherd
purpose: judge PR staleness/risk for letta-code; escalate what needs humans
owner: cameron
source: github.com/…/automations@a1b2c3   sdk: @letta-ai/letta-agent-sdk@0.6.3
trigger: poll GitHub every 30m (cron on ops-host)
agent: agent-xxx           conversations: per-repo (map in automation-state.sqlite)
authority: read GitHub; draft comments; post reviewer nudges matching routing map
credentials: GitHub token (repo:read, PR:write) in ops-host keychain
budgets: ≤20 turns/hr, ≤3 nudges/person/day, ≤$2/day
state: /opt/automations/pr-shepherd/automation-state.sqlite
health: last event 2026-08-11T14:02Z; last effect run-abc123
dry-run: bun run sweep.ts --dry-run
stop: disable the pr-shepherd cron entry
review-by: 2026-09-15
```

## Inventory

A shared inventory of manifests can show which automations watch the same resource or send messages to the same destination. It can also provide commands such as:

```text
automations list
automations inspect <name>
automations history <name>
automations run <name> --dry-run
automations pause <name>
automations stop <name>
automations remove <name>
```

The Agent SDK does not provide this inventory. An application can build one from its own manifests and run history.

## Review and removal

An automation may need review when its trigger changes, its credentials expire, its assumptions stop matching the product, or its cost exceeds its value. A review can result in a code change, a different execution form, a pause, or removal.

Removal can preserve the source and run history while it disables the schedule, process, and credentials. This keeps prior decisions available without leaving the automation active.
