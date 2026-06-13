import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAndOpenViewViewer } from "./generate-view-viewer";

// Skip the browser launch in tests.
process.env.SSH_CONNECTION = "1";

function tmpFile(name: string, content: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-view-"));
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return filePath;
}

function readData(html: string): Record<string, unknown> {
  const match = html.match(
    /id="letta-view-data"[^>]*>\s*([\s\S]*?)\s*<\/script>/,
  );
  const json = match?.[1];
  if (!json) throw new Error("no data block found");
  // Reverse the `<` -> `\u003c` escaping applied before embedding.
  return JSON.parse(json.replaceAll("\\u003c", "<"));
}

describe("generateAndOpenViewViewer", () => {
  test("classifies common file kinds", async () => {
    const cases: Array<[string, string, string]> = [
      ["a.md", "# hi", "markdown"],
      ["a.csv", "x,y\n1,2", "csv"],
      ["a.tsv", "x\ty\n1\t2", "csv"],
      ["a.html", "<h1>hi</h1>", "html"],
      ["a.ts", "const x = 1;", "code"],
      ["a.json", "{}", "code"],
    ];
    for (const [name, content, expected] of cases) {
      const result = await generateAndOpenViewViewer(tmpFile(name, content));
      expect(result.kind).toBe(expected as never);
      expect(result.opened).toBe(false); // skipped via SSH_CONNECTION
    }
  });

  test("embeds images as base64 data URIs", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const result = await generateAndOpenViewViewer(tmpFile("icon.svg", svg));
    expect(result.kind).toBe("image");
    const html = await Bun.file(result.filePath).text();
    const data = readData(html);
    expect(String(data.dataUri)).toContain("data:image/svg+xml;base64,");
  });

  test("escapes embedded </script> so it cannot break out of the data block", async () => {
    const html = "<div><script>alert(1)</script></div>";
    const result = await generateAndOpenViewViewer(tmpFile("page.html", html));
    const out = await Bun.file(result.filePath).text();
    // The only literal </script> tags are the two real template tags.
    const literal = out.match(/<\/script>/g) ?? [];
    expect(literal.length).toBe(2);
    // Payload content is still recoverable and valid JSON.
    const data = readData(out);
    expect(data.kind).toBe("html");
    expect(String(data.text)).toContain("alert(1)");
  });

  test("delimiter is tab for tsv and comma for csv", async () => {
    const csv = await generateAndOpenViewViewer(tmpFile("a.csv", "x,y"));
    const csvData = readData(await Bun.file(csv.filePath).text());
    expect(csvData.delimiter).toBe(",");

    const tsv = await generateAndOpenViewViewer(tmpFile("a.tsv", "x\ty"));
    const tsvData = readData(await Bun.file(tsv.filePath).text());
    expect(tsvData.delimiter).toBe("\t");
  });

  test("rejects unsupported file types", async () => {
    await expect(
      generateAndOpenViewViewer(tmpFile("a.unknownext", "x")),
    ).rejects.toThrow(/Unsupported file type/);
  });

  test("rejects missing files", async () => {
    await expect(
      generateAndOpenViewViewer("/no/such/file/here.png"),
    ).rejects.toThrow(/File not found/);
  });
});
