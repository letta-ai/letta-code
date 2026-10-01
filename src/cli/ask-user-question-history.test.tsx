import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { ToolCallMessage } from "@/cli/components/ToolCallMessageRich";

test("saved V1 answers stay readable while V2 receipts do not claim an answer", async () => {
  for (const [resultText, header] of [
    [
      'User has answered your questions: "Which warehouse?"="Snowflake".',
      "User answered Letta Code's questions:",
    ],
    [
      JSON.stringify({
        type: "ask_user_question",
        version: 2,
        toolCallId: "question-1",
        questions: [
          {
            question: "Which warehouse?",
            header: "Warehouse",
            options: [
              { label: "Snowflake", description: "SQL" },
              { label: "BigQuery", description: "SQL" },
            ],
          },
        ],
      }),
      "Questions posted",
    ],
  ]) {
    const chunks: string[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }) as NodeJS.WriteStream;
    stdout.columns = 120;
    stdout.rows = 24;
    stdout.isTTY = true;
    const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    const instance = render(
      <ToolCallMessage
        line={{
          kind: "tool_call",
          id: "question-1",
          name: "AskUserQuestion",
          resultText,
          resultOk: true,
          phase: "finished",
        }}
        isStreaming={false}
      />,
      { stdout, stdin, debug: false, patchConsole: false, exitOnCtrlC: false },
    );
    await Bun.sleep(20);
    instance.unmount();
    instance.cleanup();
    const output = stripAnsi(chunks.join(""));
    expect(output).toContain(header ?? "");
    if (header === "Questions posted")
      expect(output).not.toContain("User answered");
    else expect(output).toContain("Snowflake");
  }
});
