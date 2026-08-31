import { describe, expect, test } from "bun:test";
import {
  classifyReflectionConfigurationError,
  type ReflectionConfigurationErrorKind,
} from "@/cli/helpers/reflection-configuration-error";

const configurationErrors: Array<
  [string, ReflectionConfigurationErrorKind, string]
> = [
  [
    '400 {"error":"Model handle not found: openai-proxy/deepseek-v4-flash"}',
    "model_handle_not_found",
    'Model handle "openai-proxy/deepseek-v4-flash" was not found.',
  ],
  [
    '404 {"detail":"NOT_FOUND: Handle letta/auto-memory not found, must be one of []"}',
    "model_handle_not_found",
    'Model handle "letta/auto-memory" was not found.',
  ],
  [
    '{"error":{"message":"Model provider \\"openai-proxy\\" is not registered. Load or repair the provider mod."}}',
    "model_provider_not_registered",
    'Model provider "openai-proxy" is not registered.',
  ],
  [
    '{"error":{"message":"Unknown model \\"poolside/laguna-s-2.1\\" for provider \\"lmstudio\\"."}}',
    "unknown_model",
    'Model "poolside/laguna-s-2.1" is not available from provider "lmstudio".',
  ],
  [
    `{"error":{"message":"Model provider \\"\u001b[31mopenai-proxy\u001b[0m\\" is not registered."}}`,
    "model_provider_not_registered",
    'Model provider "openai-proxy" is not registered.',
  ],
];

describe("classifyReflectionConfigurationError", () => {
  test.each(configurationErrors)("classifies %s", (error, kind, message) => {
    expect(classifyReflectionConfigurationError(error)).toEqual({
      kind,
      message,
    });
  });

  test.each([
    "terminated",
    "Connection error.",
    "429 rate limit exceeded",
    "Context size has been exceeded.",
    "File handle transcript-123 not found",
    "Tool handle bash-123 not found",
  ])("leaves retryable failure unclassified: %s", (error) => {
    expect(classifyReflectionConfigurationError(error)).toBeUndefined();
  });
});
