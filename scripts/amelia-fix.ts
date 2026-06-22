#!/usr/bin/env tsx
/**
 * Amelia — SDK script triggered by @amelia-letta mentions on PR comments.
 *
 * Resumes the same conversation where the review was done (found via
 * Letta API conversation summary) for context, then runs the user's
 * prompt locally via the Letta Code SDK. Posts the response back as a PR comment.
 */

import { resumeSession, createSession } from "@letta-ai/letta-code-sdk";

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
// 2. Resume (or create) a session via the SDK
//    The SDK spawns the Letta Code CLI locally as a subprocess.
// ---------------------------------------------------------------------------

const sessionOptions = {
  permissionMode: "bypassPermissions" as const,
  disallowedTools: ["AskUserQuestion"],
  systemInfoReminder: false,
};

await using session = conversationId
  ? resumeSession(conversationId, sessionOptions)
  : createSession(AGENT_ID, sessionOptions);

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

If you made code changes, commit and push them to the PR branch.
- Commit co-author: Letta Code <noreply@letta.com>
If you didn't make changes (e.g. answering a question), just reply with your response.

Either way, end your response with a clear summary of what you did or said.`;

await session.send(prompt);

// Collect the final assistant response to post as a PR comment
let finalResponse = "";

for await (const message of session.stream()) {
  if (message.type === "assistant") {
    console.log(message.content);
    finalResponse += message.content;
  }
  if (message.type === "result") {
    if (!message.success) {
      console.error("Failed:", message.errorDetail ?? message.error);
      process.exit(1);
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// 4. Post the response as a PR comment
// ---------------------------------------------------------------------------

if (finalResponse.trim()) {
  const commentRes = await fetch(
    `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${githubToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: finalResponse.trim(),
      }),
    },
  );

  if (!commentRes.ok) {
    console.error(`Failed to post comment: ${commentRes.status}`);
  } else {
    console.log("Posted response as PR comment");
  }
}

console.log("Done.");
