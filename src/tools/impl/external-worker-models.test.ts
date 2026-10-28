import { expect, test } from "bun:test";
import { listExternalWorkerModels } from "./external-worker-models";

for (const worker of ["claude-code", "codex", "cursor"]) {
  test(`${worker} discovery spawns with the native CLI PATH`, async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    await listExternalWorkerModels(worker, {
      env: { HOME: "/home/test", PATH: "/usr/bin:/bin" },
      listNativeModels: async (_worker, _cwd, env) => {
        envs.push(env);
        return [];
      },
    });
    expect(envs).toHaveLength(1);
    expect(envs[0]?.PATH).toBe(
      process.platform === "win32"
        ? "/usr/bin:/bin"
        : "/usr/bin:/bin:/home/test/.local/bin",
    );
  });
}
