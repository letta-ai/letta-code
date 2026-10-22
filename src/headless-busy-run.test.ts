import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

const fixture = `
import { APIError } from "@letta-ai/letta-client/core/error";
import { __testSetBackend } from "./src/backend";
import { setConfiguredBackendMode } from "./src/backend/backend-mode";
import { FakeHeadlessBackend } from "./src/backend/dev/fake-headless-backend";
import { createAssistantMessageStream } from "./src/backend/dev/headless-turn-executor";
import { parseCliArgs } from "./src/cli/args";
import { handleHeadlessCommand } from "./src/headless";
import { settingsManager } from "./src/settings-manager";
import { queueSkillContent } from "./src/tools/impl/skill-content-registry";
const mode = process.env.BUSY_TEST_MODE;
const audit = { posts: [], resumes: [], reads: [] };
process.on("exit", () => process.stderr.write("BUSY_AUDIT=" + JSON.stringify(audit) + "\\n"));
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
const agentId = "agent-headless-busy";
const backend = new FakeHeadlessBackend(agentId);
backend.createConversationMessageStream = async (_id, body) => {
  audit.posts.push(structuredClone(body.messages));
  if (audit.posts.length === 1 || mode === "rotating") {
    throw new APIError(409, { detail: "Another request is currently being processed for this conversation. run_id=run-foreign-" + audit.posts.length }, "busy", new Headers());
  }
  return createAssistantMessageStream();
};
backend.streamConversationMessages = async (_id, body, options) => {
  audit.resumes.push(body);
  if (!options?.signal) throw new Error("Missing captured abort signal");
  if (mode === "accepted-own") return createAssistantMessageStream();
  throw new Error("OTID not indexed");
};
backend.retrieveRun = async (id, options) => {
  audit.reads.push(id);
  if (!options?.signal) throw new Error("Missing metadata cancellation signal");
  if (mode === "abort") {
    process.emit("SIGINT");
    return new Promise(() => {});
  }
  if (mode === "settled") queueSkillContent("later-skill", "Queued after rejected input");
  return { id, status: "completed" };
};
setConfiguredBackendMode("local");
__testSetBackend(backend);
await settingsManager.initialize();
await handleHeadlessCommand(parseCliArgs([
  "bun", "letta", "--agent", agentId, "--conversation", "default",
  "-p", "Retained input", "--output-format", "stream-json",
  "--memfs-startup", "skip", "--no-mods"
], true), undefined, undefined, [], false);
`;

test.each([
  { mode: "settled", posts: 2, reads: 1, code: 0 },
  { mode: "accepted-own", posts: 1, reads: 0, code: 0 },
  { mode: "rotating", posts: 4, reads: 3, code: 1 },
  { mode: "abort", posts: 1, reads: 1, code: 130 },
])(
  "one-shot headless busy recovery $mode",
  async ({ mode, posts, reads, code }) => {
    const home = await mkdtemp(join(tmpdir(), "letta-headless-busy-"));
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--loader=.md:text",
          "--loader=.mdx:text",
          "--loader=.txt:text",
          "--eval",
          fixture,
        ],
        {
          cwd: resolve(import.meta.dir, ".."),
          env: createIsolatedCliTestEnv({
            HOME: home,
            USER_CWD: home,
            BUSY_TEST_MODE: mode,
            LETTA_FS_SANDBOX: "0",
          }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(() => child.kill(), 25_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, stderr + stdout).toBe(code);
        const rawAudit = stderr
          .split("\n")
          .find((line) => line.startsWith("BUSY_AUDIT="));
        if (!rawAudit)
          throw new Error(`Missing busy recovery audit: ${stderr}`);
        const audit = JSON.parse(rawAudit.slice("BUSY_AUDIT=".length));
        expect(audit.posts).toHaveLength(posts);
        expect(audit.reads).toHaveLength(reads);
        expect(audit.resumes).toHaveLength(mode === "rotating" ? 3 : 1);
        const otid = audit.posts[0][0].otid;
        expect(typeof otid).toBe("string");
        for (const request of audit.resumes) {
          expect(request.otid).toBe(otid);
          expect(request).not.toHaveProperty("run_id");
        }
        for (const input of audit.posts) expect(input).toEqual(audit.posts[0]);
        const events = stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const result = events.findLast((event) => event.type === "result");
        if (code === 0) {
          expect(result?.subtype, stdout).toBe("success");
          expect(events.some((event) => event.stop_reason === "end_turn")).toBe(
            true,
          );
        } else {
          expect(result).toBeUndefined();
          expect(events.some((event) => event.type === "error")).toBe(true);
        }
      } finally {
        clearTimeout(timeout);
        child.kill();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  30_000,
);
