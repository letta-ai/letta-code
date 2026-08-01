const fs = require("node:fs");

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER"]);
const NO_AI_TOOLS = /^(none|n\/a|no ai(?: tools?)?)\.?$/i;

const VERIFICATION_PHRASES = {
  issue: [
    "I have personally reproduced or verified this issue, reviewed its contents, and take responsibility for its accuracy.",
    "I have personally reviewed this request, verified that it addresses a real use case, and take responsibility for its contents.",
  ],
  pull_request: [
    "I have reviewed and understand every change in this pull request and take responsibility for its correctness.",
  ],
};

function stripHtmlComments(body) {
  return body.replace(/<!--[\s\S]*?-->/g, "");
}

function extractSection(body, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(
    new RegExp(
      `(?:^|\\n)#{2,3}\\s+${escapedHeading}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n#{2,3}\\s+|$)`,
      "i",
    ),
  );
  return (match?.[1] || "").trim();
}

function validateDisclosure(rawBody, kind) {
  const body = stripHtmlComments(rawBody || "");
  const failures = [];
  const subject = kind === "pull_request" ? "pull request" : "issue";

  const humanWritten = new RegExp(
    `- \\[x\\] This ${subject} was written entirely by a human`,
    "i",
  ).test(body);
  const aiAssisted = new RegExp(
    `- \\[x\\] This ${subject} was written with AI assistance`,
    "i",
  ).test(body);

  if (humanWritten === aiAssisted) {
    failures.push(
      "Select exactly one authorship option (human-written or AI-assisted)",
    );
  }

  if (!/- \[x\] I have read the \[AI Policy\]/i.test(body)) {
    failures.push("AI Policy acknowledgment checkbox not checked");
  }

  const aiTools = extractSection(body, "AI Tool(s) Used");
  const noTools = NO_AI_TOOLS.test(aiTools);
  if (!aiTools || /^_?no response_?$/i.test(aiTools)) {
    failures.push("AI Tool(s) Used must list every tool used, or state None");
  } else if (aiAssisted && noTools) {
    failures.push("AI-assisted submissions must name the AI tool(s) used");
  } else if (humanWritten && !noTools) {
    failures.push(
      "Human-written submissions must state None under AI Tool(s) Used",
    );
  }

  const verificationPhrases = VERIFICATION_PHRASES[kind] || [];
  if (!verificationPhrases.some((phrase) => body.includes(phrase))) {
    failures.push("Missing exact Human Verification phrase");
  }

  return failures;
}

function trustedContributors() {
  try {
    return new Set(
      fs
        .readFileSync(".github/TRUSTED_CONTRIBUTORS", "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
  } catch (error) {
    console.log(`Unable to read TRUSTED_CONTRIBUTORS: ${error.message}`);
    return new Set();
  }
}

async function isExempt({
  github,
  context,
  author,
  userType,
  authorAssociation,
}) {
  if (userType === "Bot") {
    console.log(`Skipping ${author}: bot account`);
    return true;
  }

  if (TRUSTED_ASSOCIATIONS.has(authorAssociation)) {
    console.log(
      `Skipping ${author}: author association is ${authorAssociation}`,
    );
    return true;
  }

  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      username: author,
    });
    if (["admin", "write", "maintain"].includes(data.permission)) {
      console.log(
        `Skipping ${author}: repository permission is ${data.permission}`,
      );
      return true;
    }
  } catch (error) {
    console.log(
      `Collaborator check failed (${error.status || error.message}); continuing`,
    );
  }

  try {
    await github.rest.orgs.checkPublicMembershipForUser({
      org: "letta-ai",
      username: author,
    });
    console.log(`Skipping ${author}: public letta-ai organization member`);
    return true;
  } catch (error) {
    if (error.status !== 404) {
      console.log(
        `Organization membership check failed (${error.status || error.message}); continuing`,
      );
    }
  }

  if (trustedContributors().has(author)) {
    console.log(`Skipping ${author}: listed in TRUSTED_CONTRIBUTORS`);
    return true;
  }

  return false;
}

async function applyInvalidLabel({ github, context, number }) {
  for (const label of ["invalid", "auto-closed", "spam"]) {
    try {
      await github.rest.issues.addLabels({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: number,
        labels: [label],
      });
      return;
    } catch {
      console.log(`Unable to apply '${label}' label; trying next`);
    }
  }
}

async function closeSubmission({ github, context, kind, number, failures }) {
  const label = kind === "pull_request" ? "pull request" : "issue";
  const templateUrl =
    kind === "pull_request"
      ? `https://github.com/${context.repo.owner}/${context.repo.repo}/compare`
      : `https://github.com/${context.repo.owner}/${context.repo.repo}/issues/new/choose`;

  const comment = [
    `**This ${label} was automatically closed** because it does not meet our submission requirements.`,
    "",
    "**What failed:**",
    ...failures.map((failure) => `- ${failure}`),
    "",
    "Please use the repository template and provide the required AI disclosure, AI tool list, policy acknowledgment, and exact Human Verification phrase.",
    "",
    `- [Submission template](${templateUrl})`,
    `- [AI Usage Policy](https://github.com/${context.repo.owner}/${context.repo.repo}/blob/main/AI_POLICY.md)`,
  ].join("\n");

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: number,
    body: comment,
  });
  await applyInvalidLabel({ github, context, number });

  if (kind === "pull_request") {
    await github.rest.pulls.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: number,
      state: "closed",
    });
    return;
  }

  await github.rest.issues.update({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: number,
    state: "closed",
  });
  await github.rest.issues.lock({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: number,
    lock_reason: "spam",
  });
}

async function runContributionGuard({ github, context }) {
  const isPullRequest = context.eventName === "pull_request_target";
  const submission = isPullRequest
    ? context.payload.pull_request
    : context.payload.issue;
  const kind = isPullRequest ? "pull_request" : "issue";

  if (!submission) {
    throw new Error(`Unsupported event: ${context.eventName}`);
  }

  const author = submission.user.login;
  if (
    await isExempt({
      github,
      context,
      author,
      userType: submission.user.type,
      authorAssociation: submission.author_association,
    })
  ) {
    return;
  }

  const failures = validateDisclosure(submission.body || "", kind);
  if (failures.length === 0) {
    console.log(
      `${kind} #${submission.number} passed contribution policy checks`,
    );
    return;
  }

  console.log(`${kind} #${submission.number} failed: ${failures.join(", ")}`);
  await closeSubmission({
    github,
    context,
    kind,
    number: submission.number,
    failures,
  });
}

module.exports = runContributionGuard;
module.exports.extractSection = extractSection;
module.exports.stripHtmlComments = stripHtmlComments;
module.exports.validateDisclosure = validateDisclosure;
