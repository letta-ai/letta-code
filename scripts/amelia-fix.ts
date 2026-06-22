#!/usr/bin/env tsx
/**
 * Amelia — SDK script triggered by @amelia-letta mentions on PR comments.
 *
 * Resumes the same conversation where the review was done (found via
 * Letta API conversation summary) for context, then runs the user's
 * prompt in a cloud sandbox.
 */

import { LettaCodeClient } from "@letta-ai/letta-code-sdk";

const prNumber = process.env.PR_NUMBER;
const repo = process.env.REPO;
const githubToken = process.env.GITHUB_TOKEN;
const lettaApiKey = process.env.LETTA_API_KEY;
const userComment = process.env.USER_PROMPT || "";

// Extract the prompt from the comment (everything after @amelia-letta)
const userPrompt = userComment.replace(/^@amelia-letta\s*/i, "").trim();

if (!userPrompt) {
  console.error("No prompt found after @amelia-letta mention");
  process.exit(1);
}

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
// 3. Send the user's prompt with PR context
// ---------------------------------------------------------------------------

const prompt = `You are working on PR #${prNumber} in ${repo}.

Your GitHub token is in $GITHUB_TOKEN. To get started:
1. Clone the repo: git clone https://x-access-token:${githubToken}@github.com/${repo}.git workspace && cd workspace
2. Get the PR branch: curl -s -H "Authorization: token ${githubToken}" https://api.github.com/repos/${repo}/pulls/${prNumber} | jq -r .head.ref
3. Checkout the PR branch

Then do the following:
${userPrompt}

When done, commit and push your changes to the PR branch.
- Commit co-author: Letta Code <noreply@letta.com>
- Reply with a summary of what you did.`;

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
