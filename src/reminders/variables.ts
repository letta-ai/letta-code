import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { getMcpScopeAgentId } from "@/mcp-scope";
import { ensureSecretsLoaded, loadSecrets } from "@/utils/secrets-store";
import { ensureVariablesLoaded, loadVariables } from "@/utils/variables-store";
import type { SharedReminderState } from "./state";

export async function buildVariablesInfoReminder(context: {
  agent: { id: string };
  state: SharedReminderState;
}): Promise<string | null> {
  try {
    const id = context.agent.id;
    await ensureVariablesLoaded(id);
    let values = loadVariables(id);
    let secrets = loadSecrets(id);
    try {
      const parent = await getMcpScopeAgentId(id);
      if (parent !== id) {
        await ensureVariablesLoaded(parent);
        await ensureSecretsLoaded(parent);
        values = { ...loadVariables(parent), ...values };
        secrets = { ...loadSecrets(parent), ...secrets };
      }
    } catch {
      /* Parent lookup failures keep the own-agent view. */
    }
    const entries = Object.entries(values)
      .filter(([key]) => !(key in secrets))
      .sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify(entries);
    const previous = context.state.lastSentVariablesKey;
    if (context.state.hasSentVariablesInfo && previous === key) return null;
    context.state.lastSentVariablesKey = key;
    context.state.hasSentVariablesInfo = true;
    if (!entries.length)
      return previous && previous !== "[]"
        ? `${SYSTEM_REMINDER_OPEN}\nThe agent variables were updated. No variables are currently set.\n${SYSTEM_REMINDER_CLOSE}`
        : null;
    const list = entries
      .map(([name, value]) => `- \`$${name}\` = ${JSON.stringify(value)}`)
      .join("\n");
    return `${SYSTEM_REMINDER_OPEN}\nThe following variables are available on your agent:\n${list}\n\nVariables are plain values you can read. They are never redacted. Reference \`$NAME\` in a shell command to load it into the child shell's environment, just like a secret. Use secrets for passwords and credentials. Manage variables with \`letta variable set|list|unset\`.\n${SYSTEM_REMINDER_CLOSE}`;
  } catch {
    return null;
  }
}
