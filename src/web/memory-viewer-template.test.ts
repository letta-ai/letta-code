import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const template = await Bun.file(
  join(import.meta.dir, "memory-viewer-template.txt"),
).text();

function renderHeader(agent: { id: string; name?: string }) {
  const elements = new Map([
    ["page-title", { textContent: "" }],
    ["agent-name", { textContent: "" }],
  ]);
  const document = {
    title: "",
    getElementById(id: string) {
      const element = elements.get(id);
      if (!element) throw new Error(`Missing element: ${id}`);
      return element;
    },
  };
  const headerStart = template.indexOf("  // Header");
  const headerEnd = template.indexOf("  var agentIdEl", headerStart);
  if (headerStart < 0 || headerEnd < 0) {
    throw new Error("Memory viewer header script was not found");
  }
  const headerScript = template.slice(headerStart, headerEnd);
  new Function("DATA", "document", headerScript)({ agent }, document);
  return {
    documentTitle: document.title,
    pageTitle: elements.get("page-title")?.textContent,
    agentName: elements.get("agent-name")?.textContent,
  };
}

describe("memory viewer header", () => {
  test("uses the agent name consistently in the document title and heading", () => {
    expect(renderHeader({ id: "agent-123", name: "Research Agent" })).toEqual({
      documentTitle: "Research Agent's Memory Palace",
      pageTitle: "Research Agent's Memory Palace",
      agentName: "Research Agent's Memory Palace",
    });
  });

  test("falls back to the generic title when only the agent id is available", () => {
    expect(renderHeader({ id: "agent-123", name: "agent-123" })).toEqual({
      documentTitle: "Memory Palace",
      pageTitle: "Memory Palace",
      agentName: "Memory Palace",
    });
  });

  test("keeps the static HTML title neutral until runtime data is loaded", () => {
    expect(template).toContain("<title>Memory Palace</title>");
    expect(template).toContain('<h1 id="page-title">Memory Palace</h1>');
    expect(template).not.toContain("<title>Memory Palace | Letta Code</title>");
  });
});
