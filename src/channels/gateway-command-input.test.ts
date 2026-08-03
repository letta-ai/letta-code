import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { listenForGatewayCommands } from "./gateway-command-input";

test("gateway command input handles piped chunks and Windows line endings", () => {
  const input = new PassThrough();
  const lines: string[] = [];
  const commandInput = listenForGatewayCommands(
    (line) => lines.push(line),
    input,
  );

  input.write("first\r\nsec");
  input.write("ond\n");
  expect(lines).toEqual(["first", "second"]);

  commandInput.close();
  expect(input.isPaused()).toBe(true);
  input.write("ignored\n");
  expect(lines).toEqual(["first", "second"]);
  input.destroy();
});
