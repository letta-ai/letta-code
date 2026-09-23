import { describe, expect, it } from "bun:test";
import { highlightCode } from "./SyntaxHighlightedCommand";
import { ensureLanguageLoaded } from "./syntax-languages";

async function waitForLanguage(lang: string): Promise<void> {
  for (let i = 0; i < 100 && !ensureLanguageLoaded(lang); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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

  it("loads a tail language on first use and highlights afterwards", async () => {
    // A core highlight first so the highlighter and its registration hooks
    // exist before the tail import resolves.
    expect(highlightCode("echo hi", "bash")).toBeDefined();

    expect(ensureLanguageLoaded("rust")).toBe(false);
    await waitForLanguage("rust");
    expect(ensureLanguageLoaded("rust")).toBe(true);

    const spans = highlightCode('fn main() { println!("hi"); }', "rust");
    expect(spans).toBeDefined();
    expect(spans?.[0]?.length).toBeGreaterThan(1);
  });

  it("loads non-extension fence aliases without requesting the canonical name", async () => {
    // Highlighter + registration hooks must exist before the tail import
    // resolves. Do not also request cpp / csharp / kotlin — those loaders
    // populate loadedTail with aliases after the fact and would hide a miss.
    expect(highlightCode("echo hi", "bash")).toBeDefined();

    const cases = [
      { alias: "c++", code: "int main() { return 0; }" },
      { alias: "c#", code: "class C {}" },
      { alias: "kts", code: "fun main() {}" },
    ];

    for (const { alias, code } of cases) {
      expect(ensureLanguageLoaded(alias)).toBe(false);
      await waitForLanguage(alias);
      expect(ensureLanguageLoaded(alias)).toBe(true);
      const spans = highlightCode(code, alias);
      expect(spans).toBeDefined();
      expect(spans?.[0]?.length).toBeGreaterThan(1);
    }
  });
});
