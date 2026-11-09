# Watcher & Automation Workflows

## Upstream Release Watchers

Claude, Codex, and pi-ai watchers run every 2 hours, detect upstream releases,
and create draft parity PRs when warranted.

- Each run uses `--new` for a fresh conversation (isolated runs, no state
  compounding).
- Selective upgrade policy: only upgrade when there's concrete Letta Code
  benefit, a consumed contract fix, or a specific risk avoidance. Default is
  `no_upgrade`.
- Slack notifications post to the code-review channel only for `pr_created` outcomes.
  One random owner selected per notification.

## CI Workflow Patterns

- **Typecheck in workflow prompts:** After making edits in the target repo, run
  `npx tsc --noEmit` before committing/pushing. Prevents pushing broken types.
- **Draft-gate skip false failure:** Jobs with `if: github.event.pull_request.draft
  == false` are marked as skipped (not failed) in draft mode. Downstream
  `needs:` gates with `if: always()` treat skipped as non-success, causing false
  failures. Fix: check `needs.draft-gate.result == 'success' || needs.draft-gate.result
  == 'skipped'`.
- **Action ref caching:** GitHub Actions resolves branch refs to SHAs at trigger
  time and caches. Pushing new commits to the action branch doesn't update
  already-triggered runs. Pin to a specific SHA instead of `@main`.

## Review Workflow

- `review.yml` runs on ALL non-draft PRs.
- Silent by default: only posts inline review comments when flagging issues.
- Final response: `LGTM` or `Left comments`.
- Conversation persistence via `summary_search` API lookup.
- Review prompt (~600 tokens) is re-sent on each run (intentional: compaction
  can evict old instructions).
- Compact prompt for re-reviews (existing conversation detected).
- Background agent gets stuck on complex reviews requiring repo setup + extensive
  reading. Do those in the foreground.

## Release Cascade

Automated cross-repository release orchestration publishes Agent SDK and ACP to
follow every stable Letta Code release. Not Dependabot, it needs multi-step
package releases in lockstep. Currently blocked by token permissions
(the release bot account has read-only access to downstream repos).
