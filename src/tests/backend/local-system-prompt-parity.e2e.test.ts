import { describe, test } from "bun:test";

describe("local/API system prompt parity", () => {
  test.skip("compares API dry-run recompile with local compiled MemFS prompt", async () => {
    // TODO(LET-8726 follow-up): enable once local MemFS initialization/sync can
    // create equivalent API-backed and local-backed agents in CI. The intended
    // flow is:
    // 1. create an API-backed MemFS agent and a local-backed agent with the same
    //    raw system prompt and equivalent MemFS contents;
    // 2. call API conversations.recompile(..., dry_run: true) and local
    //    recompileConversation(..., dry_run: true);
    // 3. normalize dynamic metadata (agent id, conversation id, timestamps, and
    //    machine-specific memory roots);
    // 4. assert the persisted compiled prompts match; and
    // 5. separately assert request-scoped <available_skills> rendering because
    //    API dry-run recompile intentionally does not persist client_skills.
  });
});
