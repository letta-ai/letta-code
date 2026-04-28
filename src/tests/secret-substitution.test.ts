// src/tests/secret-substitution.test.ts
// Tests for secret env extraction and scrubbing

import { describe, expect, mock, test } from "bun:test";
import {
  extractSecretEnvFromCommand,
  scrubSecretsFromString,
} from "../tools/secret-substitution";

// Mock the secrets store
const mockSecrets: Record<string, string> = {
  API_KEY: "sk-12345",
  PASSWORD: "he$$o",
  TOKEN: "$foo$bar",
  EMPTY: "",
  BACKTICK: "`whoami`",
};

mock.module("../utils/secretsStore", () => ({
  loadSecrets: () => mockSecrets,
}));

describe("extractSecretEnvFromCommand", () => {
  test("extracts single secret reference", () => {
    expect(extractSecretEnvFromCommand("key=$API_KEY")).toEqual({
      API_KEY: "sk-12345",
    });
  });

  test("extracts multiple secrets", () => {
    expect(extractSecretEnvFromCommand("$API_KEY:$PASSWORD")).toEqual({
      API_KEY: "sk-12345",
      PASSWORD: "he$$o",
    });
  });

  test("ignores unknown secrets", () => {
    expect(extractSecretEnvFromCommand("key=$UNKNOWN")).toEqual({});
  });

  test("returns empty object for empty command", () => {
    expect(extractSecretEnvFromCommand("")).toEqual({});
  });

  test("returns empty object when no secrets referenced", () => {
    expect(extractSecretEnvFromCommand("echo hello")).toEqual({});
  });

  test("includes empty-value secrets", () => {
    expect(extractSecretEnvFromCommand("empty=$EMPTY")).toEqual({
      EMPTY: "",
    });
  });

  test("does not double-extract duplicate references", () => {
    expect(extractSecretEnvFromCommand("$API_KEY and $API_KEY")).toEqual({
      API_KEY: "sk-12345",
    });
  });
});

describe("scrubSecretsFromString", () => {
  test("replaces secret values with NAME=<REDACTED>", () => {
    expect(scrubSecretsFromString("key=sk-12345")).toBe(
      "key=API_KEY=<REDACTED>",
    );
  });

  test("scrubs longer values first", () => {
    expect(scrubSecretsFromString("pw=he$$o")).toBe("pw=PASSWORD=<REDACTED>");
  });

  test("scrubs backtick secret", () => {
    expect(scrubSecretsFromString("x=`whoami`")).toBe("x=BACKTICK=<REDACTED>");
  });
});
