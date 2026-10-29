import { spawn } from "node:child_process";

/** Run git with a deadline that also reaps its HTTP/SSH helper processes. */
export async function execGit(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  let termination = Promise.resolve();
  let timedOut = false;
  const child = spawn("git", args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let bufferError: Error | undefined;
  const collect = (stream: "stdout" | "stderr", data: string) => {
    if (bufferError) return;
    if (stream === "stdout") stdout += data;
    else stderr += data;
    if (
      Buffer.byteLength(stream === "stdout" ? stdout : stderr) >
      10 * 1024 * 1024
    ) {
      bufferError = new Error(`git ${stream} exceeded maxBuffer`);
      terminate();
    }
  };
  child.stdout
    .setEncoding("utf8")
    .on("data", (data) => collect("stdout", data));
  child.stderr
    .setEncoding("utf8")
    .on("data", (data) => collect("stderr", data));
  const closed = new Promise<void>((resolve) => child.once("close", resolve));
  const result = new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (timedOut || bufferError || code !== 0) {
          reject(
            Object.assign(
              bufferError ??
                new Error(
                  `git ${args.join(" ")} failed${timedOut ? " (ETIMEDOUT)" : ""}: ${stderr}`,
                ),
              { code: timedOut ? "ETIMEDOUT" : code, signal, stdout, stderr },
            ),
          );
        } else resolve({ stdout, stderr });
      });
    },
  );
  function terminate(): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      // Killing only git.exe leaves git-remote-http.exe holding cwd open.
      termination = new Promise<void>((resolve) => {
        const killer = spawn(
          "taskkill.exe",
          ["/pid", String(child.pid), "/t", "/f"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.once("error", () => {
          child.kill("SIGKILL");
          resolve();
        });
        killer.once("close", (code) => {
          if (code !== 0) child.kill("SIGKILL");
          resolve();
        });
      });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  const timer =
    options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeoutMs)
      : undefined;
  try {
    return await result;
  } finally {
    clearTimeout(timer);
    await termination;
    await closed;
  }
}
