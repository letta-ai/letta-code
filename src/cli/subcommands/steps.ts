import { parseArgs } from "node:util";
import type {
  ProviderTrace,
  Step,
} from "@letta-ai/letta-client/resources/steps/steps";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import { settingsManager } from "@/settings-manager";

interface StepsDependencies {
  initialize?: () => Promise<void>;
  isLocal?: () => boolean;
  retrieveStep?: (id: string) => Promise<Step>;
  retrieveTrace?: (id: string) => Promise<ProviderTrace | null>;
}

/** Read-only access to existing provider traces, using ordinary CLI auth. */
export async function runStepsSubcommand(
  argv: string[],
  deps: StepsDependencies = {},
): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        agent: { type: "string" },
        step: { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (values.help || positionals.length === 0) {
      console.log(
        "Usage: letta steps trace --agent <agent-id> --step <step-id>\nRead step metadata and an available provider trace with CLI authentication. Local provider traces are unsupported. Output is JSON.",
      );
      return 0;
    }
    if (
      positionals.length !== 1 ||
      positionals[0] !== "trace" ||
      !values.agent ||
      !values.step
    ) {
      throw new Error(
        "Expected: letta steps trace --agent <agent-id> --step <step-id>",
      );
    }
    await (deps.initialize ?? (() => settingsManager.initialize()))();
    if ((deps.isLocal ?? (() => getBackend().capabilities.localMemfs))()) {
      console.log(
        JSON.stringify({
          status: "unsupported",
          reason:
            "Local provider traces are not recorded. Inspect stored messages and client transcripts.",
          step: null,
          trace: null,
        }),
      );
      return 0;
    }
    const step = await (
      deps.retrieveStep ??
      (async (id) => (await getClient()).steps.retrieve(id))
    )(values.step);
    if (step.agent_id !== values.agent) {
      throw new Error("Step does not belong to the requested agent.");
    }
    const trace = await (
      deps.retrieveTrace ??
      (async (id) => (await getClient()).steps.trace.retrieve(id))
    )(values.step);
    if (
      trace &&
      (trace.agent_id !== values.agent || trace.step_id !== step.id)
    ) {
      throw new Error(
        "Provider trace does not match the requested agent and step.",
      );
    }
    console.log(
      JSON.stringify(
        { status: trace ? "available" : "unavailable", step, trace },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    console.error(
      `Failed to inspect step: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}
