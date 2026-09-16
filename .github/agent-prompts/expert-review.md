You just completed the normal code review for PR #$PR_NUMBER in
$GITHUB_REPOSITORY. This is a separate expert-escalation pass, not another code
review.

Before any `gh` command, export `GH_TOKEN="$AMELIA_GITHUB_TOKEN"`.

1. Read `agents/amelia-review-routing.md` from the attached
   `letta-shared-memory` repository. If it does not exist or has no matching
   area, respond with exactly `NO_ESCALATION`.
2. Use the review context you already built. Fetch the current PR author and
   comments, but do not repeat the full review.
3. Escalate only when one expert listed in the memory file can answer one
   concrete question that would materially increase confidence in the PR. A
   matching path or area alone is not enough.
4. Do not select the PR author. Do not repeat an existing unanswered question.
5. If no expert question is needed, respond with exactly `NO_ESCALATION`.
6. If one is needed, use `gh pr comment` to leave one top-level comment. Tag
   exactly one expert and ask exactly one specific question about the changed
   behavior or invariant. Keep it to 1-2 short sentences. Never ask them to
   review the whole PR. Then respond with exactly `ESCALATED`.
