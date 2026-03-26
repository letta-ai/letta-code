/**
 * `letta cron` CLI subcommand.
 *
 * Usage:
 *   letta cron add --prompt <text> --every <interval> [--agent <id>] [--conversation <id>]
 *   letta cron add --prompt <text> --at <time> [--once] [--agent <id>]
 *   letta cron add --prompt <text> --cron <expr> [--agent <id>]
 *   letta cron list [--agent <id>] [--conversation <id>]
 *   letta cron get <id>
 *   letta cron delete <id>
 *   letta cron delete --all [--agent <id>]
 */

import { parseArgs } from "node:util";
import {
  addTask,
  deleteAllTasks,
  deleteTask,
  getTask,
  isValidCron,
  listTasks,
  parseAt,
  parseEvery,
} from "../../cron";

// ── Usage ───────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(
    `
Usage:
  letta cron add --prompt <text> --every <interval> [options]
  letta cron add --prompt <text> --at <time> [--once] [options]
  letta cron add --prompt <text> --cron <expr> [options]
  letta cron list [options]
  letta cron get <id>
  letta cron delete <id>
  letta cron delete --all [--agent <id>]

Add options:
  --prompt <text>        Prompt to send to the agent (required)
  --every <interval>     Recurring interval (e.g. 5m, 2h, 1d)
  --at <time>            Scheduled time (e.g. "3:00pm", "in 45m")
  --once                 Fire once (with --at); default for --at
  --cron <expr>          Raw 5-field cron expression
  --agent <id>           Agent ID (defaults to LETTA_AGENT_ID)
  --conversation <id>    Conversation ID (defaults to LETTA_CONVERSATION_ID or "default")

List/filter options:
  --agent <id>           Filter by agent ID
  --conversation <id>    Filter by conversation ID

Delete options:
  --all                  Delete all tasks for the given agent

Output is JSON.
`.trim(),
  );
}

// ── Args ────────────────────────────────────────────────────────────

const CRON_OPTIONS = {
  help: { type: "boolean", short: "h" },
  name: { type: "string" },
  description: { type: "string" },
  prompt: { type: "string" },
  every: { type: "string" },
  at: { type: "string" },
  once: { type: "boolean" },
  cron: { type: "string" },
  agent: { type: "string" },
  conversation: { type: "string" },
  all: { type: "boolean" },
} as const;

function parseCronArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: CRON_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
}

function getAgentId(fromArgs?: string): string {
  return fromArgs || process.env.LETTA_AGENT_ID || "";
}

function getConversationId(fromArgs?: string): string {
  return fromArgs || process.env.LETTA_CONVERSATION_ID || "default";
}

// ── Handlers ────────────────────────────────────────────────────────

function handleAdd(values: ReturnType<typeof parseCronArgs>["values"]): number {
  const name = values.name;
  if (!name || typeof name !== "string") {
    console.error("Error: --name is required.");
    return 1;
  }

  const description = values.description;
  if (!description || typeof description !== "string") {
    console.error("Error: --description is required.");
    return 1;
  }

  const prompt = values.prompt;
  if (!prompt || typeof prompt !== "string") {
    console.error("Error: --prompt is required.");
    return 1;
  }

  const agentId = getAgentId(values.agent);
  if (!agentId) {
    console.error("Error: --agent or LETTA_AGENT_ID required.");
    return 1;
  }

  const conversationId = getConversationId(values.conversation);

  // Determine schedule type
  const everyValue = values.every;
  const atValue = values.at;
  const cronValue = values.cron;

  const specCount = [everyValue, atValue, cronValue].filter(Boolean).length;
  if (specCount === 0) {
    console.error("Error: one of --every, --at, or --cron is required.");
    return 1;
  }
  if (specCount > 1) {
    console.error("Error: only one of --every, --at, or --cron allowed.");
    return 1;
  }

  let cron: string;
  let recurring: boolean;
  let scheduledFor: Date | undefined;
  let note: string | undefined;

  if (everyValue) {
    const parsed = parseEvery(everyValue);
    if (!parsed) {
      console.error(`Error: invalid interval "${everyValue}". Try: 5m, 2h, 1d`);
      return 1;
    }
    cron = parsed.cron;
    recurring = true;
    note = parsed.note;
  } else if (atValue) {
    const parsed = parseAt(atValue);
    if (!parsed) {
      console.error(
        `Error: invalid time "${atValue}". Try: "3:00pm", "in 45m"`,
      );
      return 1;
    }
    cron = parsed.cron;
    recurring = false;
    scheduledFor = parsed.scheduledFor;
    note = parsed.note;
  } else if (cronValue) {
    if (!isValidCron(cronValue)) {
      console.error(
        `Error: invalid cron expression "${cronValue}". Needs 5 fields.`,
      );
      return 1;
    }
    if (values.once) {
      console.error(
        "Error: --once cannot be used with --cron. Use --at for one-shot tasks.",
      );
      return 1;
    }
    cron = cronValue;
    recurring = true;
  } else {
    console.error("Error: no schedule specified.");
    return 1;
  }

  try {
    const result = addTask({
      agent_id: agentId,
      conversation_id: conversationId,
      name,
      description,
      cron,
      recurring,
      prompt,
      scheduled_for: scheduledFor,
    });

    const output: Record<string, unknown> = {
      id: result.task.id,
      status: result.task.status,
      cron: result.task.cron,
      recurring: result.task.recurring,
      agent_id: result.task.agent_id,
      conversation_id: result.task.conversation_id,
      created_at: result.task.created_at,
    };

    if (result.task.scheduled_for) {
      output.scheduled_for = result.task.scheduled_for;
    }
    if (result.task.expires_at) {
      output.expires_at = result.task.expires_at;
    }
    if (note) {
      output.note = note;
    }
    if (result.warning) {
      output.warning = result.warning;
    }

    console.log(JSON.stringify(output, null, 2));
    return 0;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function handleList(
  values: ReturnType<typeof parseCronArgs>["values"],
): number {
  const agentId = values.agent || process.env.LETTA_AGENT_ID || undefined;
  const conversationId = values.conversation || undefined;

  const tasks = listTasks({
    agent_id: agentId,
    conversation_id: conversationId,
  });

  console.log(JSON.stringify(tasks, null, 2));
  return 0;
}

function handleGet(positionals: string[]): number {
  const taskId = positionals[1];
  if (!taskId) {
    console.error("Error: task ID required. Usage: letta cron get <id>");
    return 1;
  }

  const task = getTask(taskId);
  if (!task) {
    console.error(`Error: task ${taskId} not found.`);
    return 1;
  }

  console.log(JSON.stringify(task, null, 2));
  return 0;
}

function handleDelete(
  values: ReturnType<typeof parseCronArgs>["values"],
  positionals: string[],
): number {
  if (values.all) {
    const agentId = getAgentId(values.agent);
    if (!agentId) {
      console.error("Error: --agent or LETTA_AGENT_ID required with --all.");
      return 1;
    }
    const count = deleteAllTasks(agentId);
    console.log(JSON.stringify({ deleted: count, agent_id: agentId }));
    return 0;
  }

  const taskId = positionals[1];
  if (!taskId) {
    console.error(
      "Error: task ID required. Usage: letta cron delete <id> or --all --agent <id>",
    );
    return 1;
  }

  const found = deleteTask(taskId);
  if (!found) {
    console.error(`Error: task ${taskId} not found.`);
    return 1;
  }

  console.log(JSON.stringify({ deleted: taskId }));
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────

export async function runCronSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCronArgs>;
  try {
    parsed = parseCronArgs(argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    return 1;
  }

  const [action] = parsed.positionals;
  if (parsed.values.help || !action || action === "help") {
    printUsage();
    return 0;
  }

  switch (action) {
    case "add":
      return handleAdd(parsed.values);
    case "list":
      return handleList(parsed.values);
    case "get":
      return handleGet(parsed.positionals);
    case "delete":
      return handleDelete(parsed.values, parsed.positionals);
    default:
      console.error(`Unknown action: ${action}`);
      printUsage();
      return 1;
  }
}
