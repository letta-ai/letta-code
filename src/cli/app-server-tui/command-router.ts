import { commands, executeCommand } from "@/cli/commands/registry";
import type { TuiSessionStore } from "./session-store";

export type TuiOverlay =
  | "agents"
  | "model"
  | "resume"
  | "memory"
  | "skills"
  | "help"
  | "login"
  | "connect"
  | "mcp";

export interface SessionTarget {
  agentId: string;
  conversationId: string;
}

export interface CommandContext {
  store: TuiSessionStore;
  agentId: string;
  conversationId: string;
  openOverlay: (overlay: TuiOverlay) => void;
  switchSession: (target: SessionTarget) => void;
  renameAgent: (name: string) => void;
  exit: () => void;
  logout: () => Promise<string>;
  usage: () => Promise<string>;
  context: () => Promise<string>;
}

const OVERLAY_COMMANDS: Record<string, TuiOverlay> = {
  "/agents": "agents",
  "/model": "model",
  "/resume": "resume",
  "/memory": "memory",
  "/skills": "skills",
  "/help": "help",
  "/login": "login",
  "/connect": "connect",
  "/mcp": "mcp",
};

const SERVER_COMMANDS = new Set([
  "init",
  "compact",
  "dream",
  "reflect",
  "context-limit",
  "doctor",
  "reload",
]);

interface ConversationResponse {
  success: boolean;
  conversation: { id: string } | null;
  error?: string;
}

interface AgentResponse {
  success: boolean;
  agent: { name?: string | null } | null;
  error?: string;
}

export async function createConversation(
  context: Pick<CommandContext, "store" | "agentId">,
): Promise<string> {
  const response = await context.store.request<ConversationResponse>(
    { type: "conversation_create", body: { agent_id: context.agentId } },
    "conversation_create_response",
    { scoped: false },
  );
  if (!response.success || !response.conversation) {
    throw new Error(response.error ?? "Unable to create a conversation");
  }
  return response.conversation.id;
}

async function startNewConversation(
  context: CommandContext,
  input: string,
): Promise<void> {
  let created: string | null = null;
  await context.store.runLocalCommand(input, async () => {
    created = await createConversation(context);
    return { output: "Started a new conversation" };
  });
  if (created) {
    context.switchSession({
      agentId: context.agentId,
      conversationId: created,
    });
  }
}

async function rename(context: CommandContext, input: string): Promise<void> {
  const [, target, ...rest] = input.split(/\s+/);
  const name = rest.join(" ").trim();
  await context.store.runLocalCommand(input, async () => {
    if ((target !== "agent" && target !== "convo") || !name) {
      return {
        output: "Usage: /rename agent <name> | /rename convo <name>",
        success: false,
      };
    }
    if (target === "agent") {
      const response = await context.store.request<AgentResponse>(
        { type: "agent_update", agent_id: context.agentId, body: { name } },
        "agent_update_response",
        { scoped: false },
      );
      if (!response.success) {
        throw new Error(response.error ?? "Unable to rename the agent");
      }
      context.renameAgent(name);
      return { output: `Agent renamed to ${name}` };
    }
    if (context.conversationId === "default") {
      return {
        output: "The default conversation cannot be renamed. Run /new first.",
        success: false,
      };
    }
    const response = await context.store.request<ConversationResponse>(
      {
        type: "conversation_update",
        conversation_id: context.conversationId,
        body: { summary: name },
      },
      "conversation_update_response",
      { scoped: false },
    );
    if (!response.success) {
      throw new Error(response.error ?? "Unable to rename the conversation");
    }
    return { output: `Conversation renamed to ${name}` };
  });
}

export async function routeCommand(
  context: CommandContext,
  rawInput: string,
): Promise<void> {
  const input = rawInput.trim();
  const name = input.split(/\s+/)[0] ?? "";
  const args = input.slice(name.length).trim();
  const { store } = context;

  if (name === "/exit" || name === "/quit") {
    context.exit();
    return;
  }
  const overlay = OVERLAY_COMMANDS[name];
  if (overlay && !args) {
    context.openOverlay(overlay);
    return;
  }
  if (name === "/new" || name === "/clear") {
    await startNewConversation(context, input);
    return;
  }
  if (name === "/history") {
    await store.runLocalCommand(input, async () => {
      if (!store.getSnapshot().hasOlder) {
        return { output: "No older messages to load" };
      }
      await store.loadOlder();
      return { output: "Loaded older messages" };
    });
    return;
  }
  if (name === "/rename") {
    await rename(context, input);
    return;
  }
  if (name === "/logout") {
    await store.runLocalCommand(input, async () => ({
      output: await context.logout(),
    }));
    return;
  }
  if (name === "/usage") {
    await store.runLocalCommand(input, async () => ({
      output: await context.usage(),
    }));
    return;
  }
  if (name === "/context") {
    await store.runLocalCommand(input, async () => ({
      output: await context.context(),
    }));
    return;
  }
  const commandId = name.slice(1);
  if (SERVER_COMMANDS.has(commandId)) {
    await store.runServerCommand(commandId, args);
    return;
  }
  if (commands[name]) {
    await store.runLocalCommand(input, async () => {
      const result = await executeCommand(input, {
        agentId: context.agentId,
        conversationId: context.conversationId,
      });
      return { output: result.output, success: result.success };
    });
    return;
  }
  await store.runServerCommand(commandId, args);
}
