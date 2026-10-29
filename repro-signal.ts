import { bash } from "./src/tools/impl/bash";
import {
  spawnWithLauncher,
  startShellProcess,
} from "./src/tools/impl/shell-runner";

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

let ready!: () => void;
const started = new Promise<void>((resolve) => {
  ready = resolve;
});
const running = startShellProcess(
  ["bash", "-c", "echo buffered-before-kill; sleep 60"],
  {
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 0,
    onOutput() {
      ready();
    },
  },
);
await started;
running.process.kill("SIGKILL");
console.log("forced handle SIGKILL", await running.completion);
