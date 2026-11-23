import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const helper = new URL("./process-title.ts", import.meta.url).href;
const runtimes = [process.execPath, Bun.which("node")].filter(
  (runtime) => runtime !== null,
);

for (const runtime of runtimes) {
  test.skipIf(process.platform !== "linux")(
    `hides the prompt from cmdline and preserves argv under ${runtime}`,
    async () => {
      const marker = `headless-${randomUUID()}`;
      const prompt = `Find the process called ${marker}`;
      const child = Bun.spawn(
        [
          runtime,
          "--eval",
          `import(${JSON.stringify(helper)}).then(({ hidePromptFromProcessTitle }) => {
            const before = JSON.stringify(process.argv);
            if (process.argv.at(-2) !== "-p") throw new Error("Expected prompt flag");
            hidePromptFromProcessTitle();
            if (JSON.stringify(process.argv) !== before) {
              throw new Error("Expected the original prompt in process.argv");
            }
            console.log("ready");
            setInterval(() => {}, 1000);
          });`,
          "--",
          "-p",
          prompt,
        ],
        { stdout: "pipe", stderr: "inherit" },
      );
      const reader = child.stdout.getReader();
      try {
        let output = "";
        while (!output.includes("\n")) {
          const { done, value } = await reader.read();
          if (done) break;
          output += Buffer.from(value).toString("utf8");
        }

        expect(output).toBe("ready\n");
        const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
        expect(cmdline).not.toContain(marker);
        expect(cmdline.replace(/\0+$/, "")).toBe("letta");
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill();
        await reader.cancel();
        await child.exited;
      }
    },
  );
}
