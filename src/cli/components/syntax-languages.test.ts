import { describe, expect, it } from "bun:test";
import {
  highlightCode,
  highlightCommand,
  languageFromPath,
} from "./SyntaxHighlightedCommand";
import { ensureLanguageLoaded } from "./syntax-languages";
import { subscribeToTranscriptDisplayRepaint } from "./transcript-display-state";

describe("syntax-languages", () => {
  it("treats core languages as immediately ready", () => {
    expect(ensureLanguageLoaded("bash")).toBe(true);
    expect(ensureLanguageLoaded("typescript")).toBe(true);
    expect(ensureLanguageLoaded("json")).toBe(true);
  });

  it("marks unknown languages unavailable without retrying", () => {
    expect(ensureLanguageLoaded("not-a-real-language")).toBe(false);
    // Second call is a set lookup, not another load attempt.
    expect(ensureLanguageLoaded("not-a-real-language")).toBe(false);
  });

  it("highlights a tail language on its first use", () => {
    const rust = highlightCode('fn main() { println!("hi"); }', "rust");
    expect(rust?.[0]?.length).toBeGreaterThan(1);

    const go = highlightCode("package main", "go");
    expect(go?.[0]?.length).toBeGreaterThan(1);
  });

  it("loads non-extension fence aliases without requesting the canonical name", () => {
    // Do not also request cpp / csharp / kotlin — those loads register these
    // aliases too and would hide a miss.
    const cases = [
      { alias: "c++", code: "int main() { return 0; }" },
      { alias: "c#", code: "class C {}" },
      { alias: "kts", code: "fun main() {}" },
    ];

    for (const { alias, code } of cases) {
      const spans = highlightCode(code, alias);
      expect(spans?.[0]?.length).toBeGreaterThan(1);
    }
  });

  it("does not repaint the transcript when a tail grammar loads", async () => {
    let repaints = 0;
    const unsubscribe = subscribeToTranscriptDisplayRepaint(() => {
      repaints += 1;
    });
    try {
      const spans = highlightCode("local x = 1", "lua");
      // Give an asynchronous grammar load time to settle and notify.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(repaints).toBe(0);
      expect(spans?.[0]?.length).toBeGreaterThan(1);
    } finally {
      unsubscribe();
    }
  });

  it("treats Object.prototype member names as unknown languages", () => {
    expect(highlightCode("x", "constructor")).toBeUndefined();
    expect(highlightCode("x", "__proto__")).toBeUndefined();
    expect(languageFromPath("a.constructor")).toBeUndefined();
    expect(languageFromPath("a.__proto__")).toBeUndefined();
    expect(
      highlightCommand("cat > a.constructor <<EOF\nhello\nEOF")[1]?.[0]?.text,
    ).toBe("hello");
  });
});
