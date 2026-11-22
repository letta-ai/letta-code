import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSandboxBackend } from "@/sandbox/availability";
import { bash } from "./bash";
import { exec_command } from "./exec-command";
import { killBackgroundProcess } from "./kill-bash";
import { backgroundProcesses } from "./process_manager";

test.skipIf(
  process.platform !== "linux" || detectSandboxBackend().backend !== "bwrap",
)(
  "bwrap preserves managed and nohup Bash servers across calls",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "shell-background-"));
    const portFile = join(dir, "port");
    const pidFile = join(dir, "pid");
    const server = join(dir, "server.cjs");
    const client = join(dir, "client.cjs");
    const variableEnv = {
      LETTA_FS_SANDBOX: "1",
      LETTA_SANDBOX: "",
      MEMORY_DIR: join(dir, "memory"),
      PORT_FILE: portFile,
      PID_FILE: pidFile,
      TEST_SERVER: server,
      TEST_CLIENT: client,
    };
    const run = (command: string, runInBackground = false) =>
      bash({
        command: `test "$LETTA_SANDBOX" = bwrap && { ${command}; }`,
        timeout: 4500,
        run_in_background: runInBackground,
        variableEnv,
      });
    const start = 'node "$TEST_SERVER"';
    const probe = 'node "$TEST_CLIENT"';
    let taskId: string | undefined;
    try {
      const signalCli = `kill -CONT ${process.pid}`;
      expect(
        (await bash({ command: signalCli, variableEnv })).content[0]?.text,
      ).toStartWith("Blocked:");
      await expect(
        exec_command({ cmd: signalCli, variableEnv }),
      ).rejects.toThrow("Blocked:");
      await writeFile(
        server,
        `
        const {writeFileSync} = require("node:fs");
    const server = require("node:http").createServer((req, res) => res.end("server-ready"));
        server.listen(0, "127.0.0.1", () =>
          writeFileSync(process.env.PORT_FILE, String(server.address().port)));
      `,
      );
      await writeFile(
        client,
        `
        const {readFileSync} = require("node:fs");
        async function probe() {
          for (let i = 0; i < (process.argv[2] === "retry" ? 40 : 1); i++) {
            try {
              const port = readFileSync(process.env.PORT_FILE, "utf8");
              const response = await fetch("http://127.0.0.1:" + port, {signal: AbortSignal.timeout(250)});
              console.log(await response.text());
              return;
            } catch {
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          process.exitCode = 1;
        }
        probe();
      `,
      );
      const managed = await run(start, true);
      expect(managed.status).toBe("success");
      taskId = managed.content[0]?.text.match(/bash_\d+/)?.[0];
      expect(taskId).toBeDefined();
      const reachable = await run(`${probe} retry`);
      expect(
        reachable.status,
        JSON.stringify({
          reachable,
          task: backgroundProcesses.get(taskId ?? "")?.stderr,
        }),
      ).toBe("success");
      expect(reachable.content[0]?.text).toContain("server-ready");
      const task = backgroundProcesses.get(taskId ?? "");
      expect(killBackgroundProcess(taskId ?? "")).toBe(true);
      await task?.completion;
      expect((await run(probe)).status).toBe("error");

      await rm(portFile);
      const detached = await run(
        `nohup ${start} </dev/null >/dev/null 2>&1 & printf '%s' "$!" > "$PID_FILE"`,
      );
      expect(detached.status).toBe("success");
      const stillReachable = await run(`${probe} retry`);
      expect(stillReachable.status).toBe("success");
      expect(stillReachable.content[0]?.text).toContain("server-ready");
    } finally {
      const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
      if (Number.isSafeInteger(pid) && pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The server may already have exited.
        }
      }
      if (taskId) {
        const task = backgroundProcesses.get(taskId);
        if (task?.status === "running") killBackgroundProcess(taskId);
        await task?.completion?.catch(() => {});
        if (task?.outputFile) await rm(task.outputFile, { force: true });
        backgroundProcesses.delete(taskId);
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
  10000,
);
