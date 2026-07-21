import { describe, expect, test } from "bun:test";
import {
  buildLocalNoModelResponse,
  splitSyntheticAssistantResponse,
} from "@/cli/helpers/local-no-model-response";

describe("local no-model synthetic response", () => {
  test("logged-out copy includes /login guidance", () => {
    const message = buildLocalNoModelResponse(false);
    expect(message).toContain("/connect");
    expect(message).toContain("export OPENAI_API_KEY=...");
    expect(message).toContain("/login");
  });

  test("logged-in copy omits /login guidance", () => {
    const message = buildLocalNoModelResponse(true);
    expect(message).toContain("/connect");
    expect(message).toContain("models available through Letta Cloud");
    expect(message).not.toContain("/login");
  });

  test("synthetic streaming chunks preserve line breaks", () => {
    expect(splitSyntheticAssistantResponse("hi\n\nthere")).toEqual([
      "hi",
      "\n",
      "\n",
      "there",
    ]);
  });
});
