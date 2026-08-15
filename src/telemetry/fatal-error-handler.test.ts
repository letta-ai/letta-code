import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { installFatalErrorHandlers } from "./fatal-error-handler";

type FatalScenario =
  | "filtered-rejection"
  | "hanging-drain"
  | "recursive-failure"
  | "throwing-value-conversion"
  | "uncaught-exception"
  | "unhandled-rejection";

interface ScenarioResult {
  exitCode: number;
  output: string;
}

const handlerModuleUrl = pathToFileURL(
  `${import.meta.dir}/fatal-error-handler.ts`,
).href;

async function runFatalScenario(
  scenario: FatalScenario,
): Promise<ScenarioResult> {
  const script = `
    import { installFatalErrorHandlers } from ${JSON.stringify(handlerModuleUrl)};

    const scenario = process.env.FATAL_TEST_SCENARIO;
    installFatalErrorHandlers({
      timeoutMs: 50,
      trackError(errorType, message) {
        console.log(\`tracked:\${errorType}:\${message}\`);
      },
      drain() {
        console.log("drain-attempted");
        if (scenario === "recursive-failure") {
          process.emit("uncaughtException", new Error("recursive"));
        }
        if (scenario === "hanging-drain") {
          return new Promise(() => {});
        }
        return Promise.resolve();
      },
    });

    setTimeout(() => console.log("process-continued"), 1_000);
    if (scenario === "throwing-value-conversion") {
      void Promise.reject({
        toString() {
          throw new Error("conversion-failed");
        },
      });
    } else if (
      scenario === "unhandled-rejection" ||
      scenario === "filtered-rejection"
    ) {
      const message =
        scenario === "filtered-rejection"
          ? "429 rate limit fixture"
          : "rejection-fixture";
      void Promise.reject(new Error(message));
    } else {
      queueMicrotask(() => {
        throw new Error("exception-fixture");
      });
    }
  `;

  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      FATAL_TEST_SCENARIO: scenario,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return {
    exitCode,
    output: `${stdout}${stderr}`,
  };
}

describe("fatal telemetry error handlers", () => {
  test("cleanup removes the installed process listeners", () => {
    const uncaughtListenerCount = process.listenerCount("uncaughtException");
    const rejectionListenerCount = process.listenerCount("unhandledRejection");
    const cleanup = installFatalErrorHandlers({
      drain: async () => {},
      trackError: () => {},
    });

    expect(process.listenerCount("uncaughtException")).toBe(
      uncaughtListenerCount + 1,
    );
    expect(process.listenerCount("unhandledRejection")).toBe(
      rejectionListenerCount + 1,
    );

    cleanup();

    expect(process.listenerCount("uncaughtException")).toBe(
      uncaughtListenerCount,
    );
    expect(process.listenerCount("unhandledRejection")).toBe(
      rejectionListenerCount,
    );
  });

  test("an uncaught exception drains telemetry and exits non-zero", async () => {
    const result = await runFatalScenario("uncaught-exception");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "tracked:uncaught_exception:exception-fixture",
    );
    expect(result.output).toContain("drain-attempted");
    expect(result.output).not.toContain("process-continued");
  });

  test("an unhandled rejection drains telemetry and exits non-zero", async () => {
    const result = await runFatalScenario("unhandled-rejection");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "tracked:unhandled_rejection:rejection-fixture",
    );
    expect(result.output).toContain("drain-attempted");
    expect(result.output).not.toContain("process-continued");
  });

  test("a non-stringifiable rejection still drains and exits", async () => {
    const result = await runFatalScenario("throwing-value-conversion");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(
      "tracked:unhandled_rejection:Unknown error",
    );
    expect(result.output).toContain("drain-attempted");
    expect(result.output).not.toContain("process-continued");
  });

  test("a hanging drain cannot keep the process alive", async () => {
    const result = await runFatalScenario("hanging-drain");

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("drain-attempted");
    expect(result.output).not.toContain("process-continued");
  });

  test("a filtered fatal error still exits non-zero", async () => {
    const result = await runFatalScenario("filtered-rejection");

    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain("tracked:");
    expect(result.output).toContain("drain-attempted");
    expect(result.output).not.toContain("process-continued");
  });

  test("a recursive failure does not emit a second fatal event", async () => {
    const result = await runFatalScenario("recursive-failure");

    expect(result.exitCode).toBe(1);
    expect(result.output.match(/tracked:/g)).toHaveLength(1);
    expect(result.output).not.toContain("recursive");
  });
});
