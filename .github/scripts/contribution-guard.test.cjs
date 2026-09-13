const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractSection,
  stripHtmlComments,
  validateDisclosure,
} = require("./contribution-guard.cjs");

const policyAcknowledgment =
  "- [x] I have read the [AI Policy](https://github.com/letta-ai/letta-code/blob/main/AI_POLICY.md) and agree to its terms";
const bugVerification =
  "I have personally reproduced or verified this issue, reviewed its contents, and take responsibility for its accuracy.";
const featureVerification =
  "I have personally reviewed this request, verified that it addresses a real use case, and take responsibility for its contents.";
const pullRequestVerification =
  "I have reviewed and understand every change in this pull request and take responsibility for its correctness.";

function issueBody({ authorship, tools, verification = bugVerification }) {
  return [
    "## AI Disclosure",
    authorship,
    policyAcknowledgment,
    "",
    "### AI Tool(s) Used",
    tools,
    "",
    "### Human Verification",
    verification,
    "",
    "### Description",
    "A verified report.",
  ].join("\n");
}

function pullRequestBody({
  authorship,
  tools,
  verification = pullRequestVerification,
}) {
  return [
    "## AI Disclosure",
    authorship,
    policyAcknowledgment,
    "",
    "## AI Tool(s) Used",
    tools,
    "",
    "## Human Verification",
    verification,
  ].join("\n");
}

test("accepts a human-written issue that explicitly states no AI tools", () => {
  const failures = validateDisclosure(
    issueBody({
      authorship: "- [x] This issue was written entirely by a human",
      tools: "None",
    }),
    "issue",
  );
  assert.deepEqual(failures, []);
});

test("accepts an AI-assisted feature request that names its tools", () => {
  const failures = validateDisclosure(
    issueBody({
      authorship:
        "- [x] This issue was written with AI assistance and reviewed and edited by a human",
      tools: "Letta Code and ChatGPT",
      verification: featureVerification,
    }),
    "issue",
  );
  assert.deepEqual(failures, []);
});

test("rejects contradictory authorship options", () => {
  const body = issueBody({
    authorship: [
      "- [x] This issue was written entirely by a human",
      "- [x] This issue was written with AI assistance and reviewed and edited by a human",
    ].join("\n"),
    tools: "ChatGPT",
  });
  assert.match(
    validateDisclosure(body, "issue").join("\n"),
    /exactly one authorship option/,
  );
});

test("rejects AI-assisted submissions that do not name a tool", () => {
  const failures = validateDisclosure(
    issueBody({
      authorship:
        "- [x] This issue was written with AI assistance and reviewed and edited by a human",
      tools: "None",
    }),
    "issue",
  );
  assert.match(failures.join("\n"), /must name the AI tool/);
});

test("rejects human-written submissions that list AI tools", () => {
  const failures = validateDisclosure(
    issueBody({
      authorship: "- [x] This issue was written entirely by a human",
      tools: "Copilot",
    }),
    "issue",
  );
  assert.match(failures.join("\n"), /must state None/);
});

test("accepts a compliant AI-assisted pull request", () => {
  const failures = validateDisclosure(
    pullRequestBody({
      authorship:
        "- [x] This pull request was written with AI assistance and reviewed and edited by a human",
      tools: "Letta Code",
    }),
    "pull_request",
  );
  assert.deepEqual(failures, []);
});

test("template comments do not satisfy pull request requirements", () => {
  const body = [
    "## AI Disclosure",
    "- [ ] This pull request was written entirely by a human",
    "- [ ] This pull request was written with AI assistance and reviewed and edited by a human",
    "- [ ] I have read the [AI Policy](https://github.com/letta-ai/letta-code/blob/main/AI_POLICY.md)",
    "## AI Tool(s) Used",
    "<!-- None -->",
    "## Human Verification",
    `<!-- ${pullRequestVerification} -->`,
  ].join("\n");
  const failures = validateDisclosure(body, "pull_request");
  assert.equal(failures.length, 4);
});

test("extractSection preserves multiline tool disclosures", () => {
  const body =
    "## AI Tool(s) Used\nLetta Code\nChatGPT for research\n\n## Human Verification\nDone";
  assert.equal(
    extractSection(body, "AI Tool(s) Used"),
    "Letta Code\nChatGPT for research",
  );
});

test("stripHtmlComments removes multiline template instructions", () => {
  assert.equal(
    stripHtmlComments("before<!-- hidden\ntext -->after"),
    "beforeafter",
  );
});
