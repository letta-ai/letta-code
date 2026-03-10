import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";

const INIT_INTAKE_QUESTION_GUIDANCE = `
Ask one AskUserQuestion bundle with these recommended upfront questions (adapt wording as needed):

1. Research depth (required): "Standard research or deep research (comprehensive, as long as needed)?"
   - Offer exactly two options:
     - "Standard research" -> research_depth: shallow
     - "Deep research" -> research_depth: deep
2. Identity: "Which contributor are you?"
   - If git context suggests a likely contributor, ask for confirmation (for example: "Are you <name>?")
3. Related repos: "Are there other repositories I should know about and consider in this initialization?"
4. Workflow style: "How proactive should I be?" (auto-commit vs ask-first)
5. Communication style: "Terse or detailed responses?"
6. Rules: "Any specific rules I should always follow?"

Do not ask questions that can be answered by reading repository files.
`.trim();

export interface InitIntakeReminderArgs {
  agentId: string;
  workingDirectory: string;
  memoryMode: "memfs" | "legacy-api";
  memoryDir: string;
  modeSpecificDispatch: string;
  initTaskDescription: string;
}

export function buildInitIntakeReminder(args: InitIntakeReminderArgs): string {
  return `${SYSTEM_REMINDER_OPEN}
The user explicitly ran /init and wants an interactive setup flow.

You are the primary agent for intake only. Follow this sequence:
1. Ask ONE AskUserQuestion bundle with upfront intake questions.
2. Wait for answers, then dispatch the real work in a background Task.
3. Tell the user initialization is running in the background.

Question bundle guidance:
${INIT_INTAKE_QUESTION_GUIDANCE}

Constraints:
- Do NOT do deep project research in this foreground turn.
- Do NOT invoke \`initializing-memory\` in this foreground turn.
- Use \`run_in_background: true\` (init/reflection background workflows use silent completion automatically).
- Use this Task description exactly: ${args.initTaskDescription}
- Dispatch exactly one background Task.

Runtime context:
- parent_agent_id: ${args.agentId}
- working_directory: ${args.workingDirectory}
- memory_mode: ${args.memoryMode}
- memory_dir: ${args.memoryDir}

After intake, dispatch the background worker:
${args.modeSpecificDispatch}

Before dispatching, replace all placeholder values (\`<answer>\`, \`<build from intake>\`) with real intake answers and selected depth.
${SYSTEM_REMINDER_CLOSE}`;
}
