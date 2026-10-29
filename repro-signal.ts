import { bash } from "./src/tools/impl/bash";
import { spawnWithLauncher } from "./src/tools/impl/shell-runner";

console.log(
  "raw SIGKILL",
  await spawnWithLauncher(["bash", "-c", "kill -KILL $$"], {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 0,
  }),
);
console.log(
  "Bash child SIGKILL",
  JSON.stringify(
    await bash({
      command: "bash -c 'kill -KILL $$'; status=$?; exit $status",
      description: "Signal status probe",
    }),
  ),
);
console.log(
  "Bash launcher SIGKILL",
  JSON.stringify(
    await bash({
      command: "kill -KILL $$",
      description: "Launcher signal probe",
    }),
  ),
);
