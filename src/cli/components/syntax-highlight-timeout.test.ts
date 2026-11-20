import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Sanitized Go input from https://github.com/letta-ai/letta-code/issues/5532.
const GO_SAMPLE =
  'package main\nfunc name0(){name1:=name2.name3[1];name4,name5:=name2.name6(name7.name8(name1,"example"));if name5!=nil{name9(name5)};var name10 struct{name11 string `name12:"example"`;name13 map[string]int64 `name12:"example"`;name14 map[string]int64 `name12:"example"`};if name5=name12.name15(name4,&name10);name5!=nil{name9(name5)};name4,name5=name2.name6(name7.name8(name1,"example"));if name5!=nil{name9(name5)};var name16 name17.name18;if name5=name12.name15(name4,&name16);name5!=nil{name9(name5)};if name16.name19!=name10.name11||name10.name11!="example"{name9("example")}}';

describe("syntax highlighting timeouts", () => {
  it.each(["source", "bundle"] as const)(
    "falls back and recovers in the %s runtime",
    async (runtime) => {
      let moduleUrl = new URL(
        "./SyntaxHighlightedCommand.tsx",
        import.meta.url,
      );
      let outputDirectory: string | undefined;
      if (runtime === "bundle") {
        const cache = join(process.cwd(), ".cache");
        mkdirSync(cache, { recursive: true });
        outputDirectory = mkdtempSync(join(cache, "syntax-highlight-"));
        const build = await Bun.build({
          entrypoints: [
            fileURLToPath(moduleUrl),
            fileURLToPath(
              new URL("./syntax-highlight-worker.ts", import.meta.url),
            ),
          ],
          outdir: outputDirectory,
          target: "node",
          format: "esm",
          packages: "external",
        });
        expect(build.success).toBe(true);
        moduleUrl = pathToFileURL(
          join(outputDirectory, "SyntaxHighlightedCommand.js"),
        );
      }
      try {
        let script = `
      import assert from "node:assert/strict";
      import { highlightCode, highlightCommand } from ${JSON.stringify(moduleUrl.href)};
      const sample = ${JSON.stringify(GO_SAMPLE)};
      assert.equal(highlightCode(sample, "go"), undefined);
      const command = "cat > example.go <<EOF\\n" + sample + "\\nEOF";
      const spans = highlightCommand(command);
      assert.equal(spans.map(line => line.map(span => span.text).join("")).join("\\n"), command);
      const normal = highlightCode("package main\\nfunc main() {}", "go");
      assert.ok(normal?.[0]?.length > 1);
      assert.equal(normal.map(line => line.map(span => span.text).join("")).join("\\n"), "package main\\nfunc main() {}");
      console.log("highlighting recovered");
    `;
        if (runtime === "source") {
          const approvalUrl = new URL(
            "./InlineFileEditApproval.tsx",
            import.meta.url,
          );
          script += `
        const { createElement } = await import("react");
        const { render } = await import("ink");
        const { Readable, Writable } = await import("node:stream");
        const { default: stripAnsi } = await import("strip-ansi");
        const { InlineFileEditApproval } = await import(${JSON.stringify(approvalUrl.href)});
        const pause = () => new Promise(resolve => setTimeout(resolve, 30));
        for (const columns of [60, 140]) {
          process.stdout.columns = columns;
          process.stdout.emit("resize");
          const chunks = [];
          const stdout = new Writable({write(chunk, _encoding, done) {chunks.push(String(chunk)); done();}});
          Object.assign(stdout, {columns, rows: 40, isTTY: true});
          const stdin = new Readable({read() {}});
          Object.assign(stdin, {isTTY: true, setRawMode() {return this;}, ref() {return this;}, unref() {return this;}});
          let approved = 0, always = 0, cancelled = 0;
          const patchInput = "*** Begin Patch\\n*** Add File: example.go\\n" + sample.split("\\n").map(line => "+" + line).join("\\n") + "\\n*** End Patch";
          const app = render(createElement(InlineFileEditApproval, {
            fileEdit: {toolName: "ApplyPatch", filePath: "example.go", patchInput},
            onApprove: () => approved++, onApproveAlways: () => always++,
            onDeny: () => {}, onCancel: () => cancelled++,
          }), {stdout, stdin, patchConsole: false, exitOnCtrlC: false});
          try {
            await pause();
            const preview = stripAnsi(chunks.join(""));
            assert.ok(preview.includes("package main"));
            assert.ok(preview.includes("Yes"));
            stdin.push("\\x1b[B"); await pause();
            stdin.push("\\r"); await pause();
            assert.equal(always, 1);
            assert.equal(approved, 0);
            stdin.push("\\x1b"); await pause();
            assert.equal(cancelled, 1);
          } finally { app.unmount(); app.cleanup(); }
        }
        console.log("approval controls recovered");
      `;
        }
        // A subprocess also bounds this test on the unfixed, synchronously stuck code.
        const executable = runtime === "source" ? process.execPath : "node";
        let args = ["--eval", script];
        if (outputDirectory) {
          const entry = join(outputDirectory, "exercise.mjs");
          writeFileSync(entry, script);
          args = [entry];
        }
        const result = spawnSync(executable, args, {
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("highlighting recovered");
        if (runtime === "source") {
          expect(result.stdout).toContain("approval controls recovered");
        }
        if (outputDirectory) {
          rmSync(join(outputDirectory, "syntax-highlight-worker.js"));
          const entry = join(outputDirectory, "missing-worker.mjs");
          writeFileSync(
            entry,
            `
            import assert from "node:assert/strict";
            import { highlightCode } from ${JSON.stringify(moduleUrl.href)};
            assert.equal(highlightCode("package main", "go"), undefined);
          `,
          );
          const missingWorker = spawnSync("node", [entry], {
            encoding: "utf8",
            timeout: 5_000,
          });
          expect(missingWorker.error).toBeUndefined();
          expect(missingWorker.stderr).toBe("");
          expect(missingWorker.status).toBe(0);
        }
      } finally {
        if (outputDirectory)
          rmSync(outputDirectory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
