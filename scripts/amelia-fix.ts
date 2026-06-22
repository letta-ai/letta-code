#!/usr/bin/env tsx
/**
 * Amelia Fix — SDK script that addresses review comments on a PR.
 *
 * Triggered by the amelia-fix.yml workflow when a user comments
 * "/amelia fix" on a PR. Resumes the same conversation where the
 * review was done (found via Letta API conversation summary), then
 * sends a fix prompt that runs in a cloud sandbox.
 */

import { LettaCodeClient } from "@letta-ai/letta-code-sdk";

const prNumber = process.env.PR_NUMBER;
const repo = process.env.REPO;
const githubToken = process.env.GITHUB_TOKEN;
const lettaApiKey = process.env.LETTA_API_KEY;

if (!prNumber || !repo || !githubToken || !lettaApiKey) {
  console.error(
    "Missing required env vars: PR_NUMBER, REPO, GITHUB_TOKEN, LETTA_API_KEY",
  );
  process.exit(1);
}

const AGENT_ID = "agent-cd664b86-4d28-49b7-8ad6-60677eaff9be";

// ---------------------------------------------------------------------------
// 1. Look up the review conversation via Letta API
//    Same mechanism as letta-code-action's findConversationBySummary:
//    searches for a conversation with summary "owner/repo/pr-123"
// ---------------------------------------------------------------------------

const summary = `${repo}/pr-${prNumber}`;
const searchUrl = `https://api.letta.com/v1/conversations/?agent_id=${AGENT_ID}&summary_search=${encodeURIComponent(summary)}&limit=1&order=desc`;

console.log(`Searching for review conversation: ${summary}`);

const searchRes = await fetch(searchUrl, {
  headers: { Authorization: `Bearer ${lettaApiKey}` },
});

if (!searchRes.ok) {
  console.error(`Failed to search conversations: ${searchRes.status}`);
  process.exit(1);
}

const conversations = (await searchRes.json()) as Array<{
  id: string;
  summary: string;
}>;

// Client-side exact match — summary_search is substring-based (SQL LIKE)
const match = conversations.find((c) => c.summary === summary);
const conversationId = match?.id;

console.log(
  conversationId
    ? `Found review conversation: ${conversationId}`
    : "No review conversation found, starting fresh",
);

// ---------------------------------------------------------------------------
// 2. Connect to cloud backend and resume (or create) session
// ---------------------------------------------------------------------------

const client = new LettaCodeClient({
  backend: "cloud",
  apiKey: lettaApiKey,
});

await using session = conversationId
  ? client.resumeSession(conversationId, {
      permissionMode: "bypassPermissions",
    })
  : client.createSession(AGENT_ID, {
      permissionMode: "bypassPermissions",
    });

// ---------------------------------------------------------------------------
// 3. Send the fix prompt
// ---------------------------------------------------------------------------

const prompt = `Address the review comments on PR #${prNumber} in ${repo}.

Steps:
1. Clone the repo: git clone https://x-access-token:${githubToken}@github.com/${repo}.git workspace && cd workspace
2. Get the PR branch: curl -s -H "Authorization: token ${githubToken}" https://api.github.com/repos/${repo}/pulls/${prNumber} | jq -r .head.ref
3. Checkout the PR branch
4. Fetch your unresolved review comments:
   curl -s -H "Authorization: token ${githubToken}" \\
     "https://api.github.com/repos/${repo}/pulls/${prNumber}/comments"
   Filter for comments authored by "amelia-letta-code" (your bot login)
5. For each unresolved comment, read the code at the flagged location, apply the fix
6. Run lint/typecheck if the repo has it: npx biome check --write . || true
7. Commit all changes, then push to the PR branch

Important:
- Only fix issues you flagged in your own review comments. Don't make unrelated changes.
- If a comment is a suggestion block, apply the suggested fix.
- If a comment is a general concern, use your judgment to fix the root cause.
- Commit message: "fix: address review comments on PR #${prNumber}"
- Co-author: Letta Code <noreply@letta.com>
- After pushing, reply with a summary of what you fixed.`;

await session.send(prompt);

for await (const message of session.stream()) {
  if (message.type === "assistant") {
    console.log(message.content);
  }
  if (message.type === "result") {
    if (!message.success) {
      console.error("Failed:", message.errorDetail ?? message.error);
      process.exit(1);
    }
    break;
  }
}

console.log("Done.");
