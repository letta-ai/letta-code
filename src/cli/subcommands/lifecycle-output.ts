export type ServerLifecycleState =
  | "connected"
  | "reconnecting"
  | "working"
  | "idle"
  | "error";

export type ServerLifecycleEvent = {
  lettaLifecycleProtocol: 1;
  state: ServerLifecycleState;
};

type LifecycleWriter = (line: string) => void;

export type ServerLifecycleOutput = {
  emit: (state: ServerLifecycleState) => void;
  emitListenerStatus: (status: "idle" | "receiving" | "processing") => void;
};

export function hasJsonlLifecycleIntent(argv: string[]): boolean {
  return argv.some(
    (arg, index) =>
      arg === "--lifecycle-output=jsonl" ||
      (arg === "--lifecycle-output" && argv[index + 1] === "jsonl"),
  );
}

export function resolveServerLifecycleOutput(
  mode: string | undefined,
  debug: boolean,
): { output: ServerLifecycleOutput | null; error: string | null } {
  if (mode && mode !== "jsonl") {
    return {
      output: null,
      error: `unsupported --lifecycle-output value ${JSON.stringify(mode)}; expected "jsonl"`,
    };
  }
  if (mode && debug) {
    return {
      output: null,
      error:
        "--lifecycle-output cannot be used while debug output is enabled by --debug, LETTA_DEBUG, or DEBUG",
    };
  }
  return { output: mode ? createServerLifecycleOutput() : null, error: null };
}

/** Emit deduplicated, payload-free state transitions for process supervisors. */
export function createServerLifecycleOutput(
  write: LifecycleWriter = (line) => process.stdout.write(`${line}\n`),
): ServerLifecycleOutput {
  let previous: ServerLifecycleState | null = null;
  const emit = (state: ServerLifecycleState): void => {
    if (state === previous) return;
    previous = state;
    const event: ServerLifecycleEvent = {
      lettaLifecycleProtocol: 1,
      state,
    };
    write(JSON.stringify(event));
  };

  return {
    emit,
    emitListenerStatus: (status) => {
      emit(status === "idle" ? "idle" : "working");
    },
  };
}
