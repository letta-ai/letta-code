const { appendFileSync } = require("node:fs");
const started = Date.now();
function trace(message) {
  appendFileSync(process.env.LETTA_TIMING_TRACE_FILE, `${message}\n`);
}
trace(
  `[usage-trace] preload pid=${process.pid} at=${new Date().toISOString()}`,
);
process.on("exit", (code) => {
  trace(`[usage-trace] exit code=${code} elapsed_ms=${Date.now() - started}`);
});
process.on("beforeExit", (code) => {
  trace(
    `[usage-trace] beforeExit code=${code} elapsed_ms=${Date.now() - started}`,
  );
});
