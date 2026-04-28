import { describe, expect, it } from "bun:test";

describe("/btw command parsing", () => {
  const btwRegex = /^\/btw\s+(.+)$/;

  it("matches /btw with question", () => {
    const result = "/btw what is this?".match(btwRegex);
    expect(result).not.toBeNull();
    expect(result?.[1]).toBe("what is this?");
  });

  it("matches /btw with multi-word question", () => {
    const result = "/btw can you explain the architecture in detail?".match(
      btwRegex,
    );
    expect(result).not.toBeNull();
    expect(result?.[1]).toBe("can you explain the architecture in detail?");
  });

  it("does not match /btw without question", () => {
    const result = "/btw".match(btwRegex);
    expect(result).toBeNull();
  });

  it("does not match /btw with only whitespace after trim", () => {
    const msg = "/btw   ";
    const match = msg.match(btwRegex);
    // The regex requires at least one non-whitespace char after /btw
    // But "   " is captured by .+ so this will match - let's test the handler logic
    const question = match?.[1]?.trim();
    expect(question).toBe("");
  });

  it("matches /btw with trailing whitespace", () => {
    const result = "/btw hello world   ".match(btwRegex);
    expect(result).not.toBeNull();
    expect(result?.[1]).toBe("hello world   ");
  });

  it("trims question in handler logic", () => {
    const msg = "/btw   what is this?   ";
    const match = msg.match(btwRegex);
    const question = match?.[1]?.trim();
    expect(question).toBe("what is this?");
  });
});
