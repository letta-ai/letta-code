import { createHash } from "node:crypto";
import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";

const WARNING_THRESHOLD = 2;
const BLOCK_THRESHOLD = 4;
const PRESENTATION_ONLY_DESCRIPTION_TOOLS = new Set([
  "Bash",
  "exec_command",
  "run_shell_command",
  "RunShellCommand",
  "shell_command",
  "ShellCommand",
]);

export type ToolLoopCall = {
  toolName: string;
  toolArgs: unknown;
  workingDirectory?: string;
};

export type ToolLoopToolReturn = string | Array<TextContent | ImageContent>;

export type ToolLoopResult = {
  status: unknown;
  toolReturn: ToolLoopToolReturn;
};

export type ToolLoopPreflight = {
  action: "allow" | "block";
  allowed: boolean;
  blocked: boolean;
  callFingerprint: string;
  consecutiveIdenticalPairs: number;
  reason: string | null;
};

export type ToolLoopObservation = {
  callFingerprint: string;
  resultFingerprint: string;
  pairFingerprint: string;
  consecutiveIdenticalPairs: number;
  warning: string | null;
  willBlockNextIdenticalCall: boolean;
  annotatedToolReturn: ToolLoopToolReturn;
};

export type ToolLoopGuardSnapshot = {
  activeCallFingerprint: string | null;
  consecutiveIdenticalPairs: number;
  blocked: boolean;
};

function canonicalizeValue(
  value: unknown,
  ancestors: Set<object>,
  inArray: boolean,
): string | undefined {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
    case "function":
    case "symbol":
      return inArray ? "null" : undefined;
    case "object":
      break;
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError("Cannot canonicalize a circular value");
  }

  ancestors.add(objectValue);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry) => canonicalizeValue(entry, ancestors, true) ?? "null")
        .join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const canonicalValue = canonicalizeValue(record[key], ancestors, false);
        return canonicalValue === undefined
          ? []
          : [`${JSON.stringify(key)}:${canonicalValue}`];
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}

/** Stable JSON-like serialization: object keys are sorted and array order is kept. */
export function canonicalizeToolLoopValue(value: unknown): string {
  return canonicalizeValue(value, new Set(), false) ?? "null";
}

/** SHA-256 a value after stable canonicalization. */
export function hashToolLoopValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeToolLoopValue(value))
    .digest("hex");
}

/** Parse JSON tool arguments and remove known presentation-only fields. */
export function normalizeToolLoopArgs(
  toolName: string,
  toolArgs: unknown,
): unknown {
  let parsedArgs = toolArgs;
  if (typeof toolArgs === "string") {
    const trimmed = toolArgs.trim();
    if (trimmed.length === 0) {
      parsedArgs = {};
    } else {
      try {
        parsedArgs = JSON.parse(trimmed);
      } catch {
        // Preserve malformed input so distinct raw calls do not collapse together.
        parsedArgs = toolArgs;
      }
    }
  }

  if (
    parsedArgs === null ||
    typeof parsedArgs !== "object" ||
    Array.isArray(parsedArgs)
  ) {
    return parsedArgs;
  }

  if (PRESENTATION_ONLY_DESCRIPTION_TOOLS.has(toolName)) {
    const { description: _description, ...semanticArgs } = parsedArgs as Record<
      string,
      unknown
    >;
    return semanticArgs;
  }
  return parsedArgs;
}

export function canonicalizeToolCall(call: ToolLoopCall): string {
  return canonicalizeToolLoopValue({
    args: normalizeToolLoopArgs(call.toolName, call.toolArgs),
    toolName: call.toolName,
    workingDirectory: call.workingDirectory,
  });
}

export function fingerprintToolCall(call: ToolLoopCall): string {
  return createHash("sha256").update(canonicalizeToolCall(call)).digest("hex");
}

export function fingerprintToolResult(result: ToolLoopResult): string {
  return hashToolLoopValue({
    status: result.status,
    toolReturn: result.toolReturn,
  });
}

export function createToolLoopWarning(
  consecutiveIdenticalPairs: number,
): string {
  const suffix =
    consecutiveIdenticalPairs >= BLOCK_THRESHOLD
      ? " The next identical call will be stopped for explicit user approval; change the call or approach."
      : " Change the call or approach if you need a different outcome.";
  return `[Tool loop warning: this call produced the same result ${consecutiveIdenticalPairs} consecutive times.${suffix}]`;
}

export function createToolLoopBlockReason(): string {
  return `Tool call stopped after ${BLOCK_THRESHOLD} consecutive identical call/result pairs. Change the arguments or approach; explicit user approval is required to repeat it.`;
}

/**
 * Append feedback for the model while leaving the supplied raw return untouched.
 * Call fingerprints and result fingerprints must always be computed from the raw
 * return; observeResult does that before invoking this helper.
 */
export function annotateToolLoopReturn(
  toolReturn: ToolLoopToolReturn,
  warning: string | null,
): ToolLoopToolReturn {
  if (!warning) return toolReturn;
  if (typeof toolReturn === "string") {
    return toolReturn.length > 0 ? `${toolReturn}\n\n${warning}` : warning;
  }
  return [...toolReturn, { type: "text" as const, text: warning }];
}

/**
 * Stateful only within one turn. Construct a new guard per turn, or call reset
 * at the turn boundary. It performs no I/O and does not mutate calls/results.
 */
export class ToolLoopGuard {
  private activeCallFingerprint: string | null = null;
  private lastPairFingerprint: string | null = null;
  private consecutiveIdenticalPairs = 0;
  private blockedCallFingerprint: string | null = null;
  private reportedToolCallIds = new Set<string>();

  preflight(call: ToolLoopCall): ToolLoopPreflight {
    const callFingerprint = fingerprintToolCall(call);
    this.activateCall(callFingerprint);

    const blocked = this.blockedCallFingerprint === callFingerprint;
    return {
      action: blocked ? "block" : "allow",
      allowed: !blocked,
      blocked,
      callFingerprint,
      consecutiveIdenticalPairs: this.consecutiveIdenticalPairs,
      reason: blocked ? createToolLoopBlockReason() : null,
    };
  }

  isBlocked(call: ToolLoopCall): boolean {
    return this.blockedCallFingerprint === fingerprintToolCall(call);
  }

  recordPrevention(toolCallId: string): boolean {
    if (this.reportedToolCallIds.has(toolCallId)) return false;
    this.reportedToolCallIds.add(toolCallId);
    return true;
  }

  observeResult(
    call: ToolLoopCall,
    rawResult: ToolLoopResult,
  ): ToolLoopObservation {
    const callFingerprint = fingerprintToolCall(call);
    this.activateCall(callFingerprint);

    // Fingerprint the unannotated result first. The returned model-facing
    // annotation therefore cannot alter subsequent loop comparisons.
    const resultFingerprint = fingerprintToolResult(rawResult);
    const pairFingerprint = hashToolLoopValue({
      callFingerprint,
      resultFingerprint,
    });

    this.consecutiveIdenticalPairs =
      this.lastPairFingerprint === pairFingerprint
        ? this.consecutiveIdenticalPairs + 1
        : 1;
    this.lastPairFingerprint = pairFingerprint;

    const willBlockNextIdenticalCall =
      this.consecutiveIdenticalPairs >= BLOCK_THRESHOLD;
    this.blockedCallFingerprint = willBlockNextIdenticalCall
      ? callFingerprint
      : null;

    const warning =
      this.consecutiveIdenticalPairs >= WARNING_THRESHOLD
        ? createToolLoopWarning(this.consecutiveIdenticalPairs)
        : null;

    return {
      callFingerprint,
      resultFingerprint,
      pairFingerprint,
      consecutiveIdenticalPairs: this.consecutiveIdenticalPairs,
      warning,
      willBlockNextIdenticalCall,
      annotatedToolReturn: annotateToolLoopReturn(
        rawResult.toolReturn,
        warning,
      ),
    };
  }

  annotateToolReturn(
    rawToolReturn: ToolLoopToolReturn,
    observation: Pick<ToolLoopObservation, "warning">,
  ): ToolLoopToolReturn {
    return annotateToolLoopReturn(rawToolReturn, observation.warning);
  }

  snapshot(): ToolLoopGuardSnapshot {
    return {
      activeCallFingerprint: this.activeCallFingerprint,
      consecutiveIdenticalPairs: this.consecutiveIdenticalPairs,
      blocked:
        this.activeCallFingerprint !== null &&
        this.blockedCallFingerprint === this.activeCallFingerprint,
    };
  }

  reset(): void {
    this.activeCallFingerprint = null;
    this.lastPairFingerprint = null;
    this.consecutiveIdenticalPairs = 0;
    this.blockedCallFingerprint = null;
    this.reportedToolCallIds.clear();
  }

  private activateCall(callFingerprint: string): void {
    if (
      this.activeCallFingerprint !== null &&
      this.activeCallFingerprint !== callFingerprint
    ) {
      this.reset();
    }
    this.activeCallFingerprint = callFingerprint;
  }
}

export function createToolLoopGuard(): ToolLoopGuard {
  return new ToolLoopGuard();
}
