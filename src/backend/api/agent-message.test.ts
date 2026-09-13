import { expect, test } from "bun:test";
import { normalizeAgentMessageComputer } from "./agent-message";

test.each([undefined, null, "", " \t\n"])(
  "an unset optional computer uses the existing destination: %j",
  (value) => {
    expect(normalizeAgentMessageComputer(value)).toBeUndefined();
  },
);

test.each([
  ["cloud", "cloud"],
  [" Cloud-Sandbox ", "cloud"],
  [" My laptop ", "My laptop"],
  ["device-123", "device-123"],
])("normalizes %s to %s", (input, expected) => {
  expect(normalizeAgentMessageComputer(input)).toBe(expected);
});

test.each([{ value: false }, { value: 0 }, { value: [] }, { value: {} }])(
  "rejects an invalid computer value %j",
  ({ value }) => {
    expect(() => normalizeAgentMessageComputer(value)).toThrow(
      "computer must be a computer name, or omitted",
    );
  },
);
