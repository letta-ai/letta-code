import { describe, expect, test } from "bun:test";
import { parseWorkflowMeta, stripMetaExport } from "./meta.ts";

const VALID = `export const meta = {
  name: 'find-bugs',
  description: 'Find bugs and verify them',
  phases: [{ title: 'Find' }, { title: 'Verify', detail: 'one agent per bug' }],
}
const x = 1;
return x;
`;

describe("parseWorkflowMeta", () => {
  test("parses a valid pure-literal meta block", () => {
    const meta = parseWorkflowMeta(VALID);
    expect(meta.name).toBe("find-bugs");
    expect(meta.phases?.length).toBe(2);
  });

  test("rejects a script without a meta block", () => {
    expect(() => parseWorkflowMeta("const x = 1;")).toThrow(/must begin/);
  });

  test("rejects non-literal meta (variable reference)", () => {
    const script = `export const meta = { name: 'x', description: DESC }`;
    expect(() => parseWorkflowMeta(script)).toThrow(/pure literal/);
  });

  test("rejects non-literal meta (function call)", () => {
    const script = `export const meta = { name: 'x', description: makeDesc() }`;
    expect(() => parseWorkflowMeta(script)).toThrow(/pure literal/);
  });

  test("rejects non-kebab-case names", () => {
    const script = `export const meta = { name: 'FindBugs', description: 'd' }`;
    expect(() => parseWorkflowMeta(script)).toThrow(/kebab-case/);
  });

  test("rejects missing description", () => {
    const script = `export const meta = { name: 'find-bugs' }`;
    expect(() => parseWorkflowMeta(script)).toThrow(/description/);
  });

  test("handles braces inside string values", () => {
    const script = `export const meta = { name: 'a-b', description: 'has } brace { chars' }
return 1;`;
    expect(parseWorkflowMeta(script).description).toContain("}");
  });

  test.each([
    "// user's workflow\n",
    "// } ignored brace\n",
    "/* user's workflow */",
    "/* } ignored brace { */",
  ])("ignores comment syntax when locating the meta object: %s", (comment) => {
    const script = `export const meta = {
      name: 'find-bugs', ${comment}
      description: 'Review files',
      phases: [{ title: 'Review' }],
    };
    return 1;`;
    expect(parseWorkflowMeta(script)).toEqual({
      name: "find-bugs",
      description: "Review files",
      phases: [{ title: "Review" }],
    });
  });

  test.each(["\n", "\r", "\u2028", "\u2029"])(
    "ends line comments at JavaScript line terminator %j",
    (lineTerminator) => {
      const script = `export const meta = {name: 'find-bugs', // user's workflow${lineTerminator}description: 'Review files'};`;
      expect(parseWorkflowMeta(script).description).toBe("Review files");
    },
  );

  test("preserves comment delimiters inside strings", () => {
    const description = "user's // workflow /* } */";
    const script = `export const meta = {name: 'find-bugs', description: ${JSON.stringify(description)}};`;
    expect(parseWorkflowMeta(script).description).toBe(description);
  });

  test("stripMetaExport removes only the export keyword", () => {
    const stripped = stripMetaExport(VALID);
    expect(stripped).toContain("const meta = {");
    expect(stripped).not.toContain("export const meta");
  });
});
