---
name: releasing
description: Releases a new version of this Letta Code repository by updating package.json, running the test suite, committing the version bump, creating the matching vX.Y.Z tag, and pushing the commit and tag. Use when preparing or publishing a repository release, bumping the package version, or tagging a release.
---

# Release Letta Code

Use this skill only from a clean, checked-out release branch or from the repository's intended release branch. The release workflow publishes when `main` receives a commit whose subject starts with `chore: bump version to `, so preserve that commit-message convention.

## Procedure

1. **Inspect the starting state.** Run `git status --short --branch`, confirm the current branch and remotes, and read the current `version` from `package.json`. Do not overwrite unrelated work or release from a dirty tree; stop and report any unexpected changes.
2. **Choose and validate the target version.** Use an explicit semantic version (`X.Y.Z`, including a valid prerelease suffix when appropriate). Confirm it is different from the current version and that `vX.Y.Z` is not already present locally or on `origin`.
3. **Update only the package version.** Change the top-level `version` field in `package.json`, preserving its formatting. Check the diff and verify the resulting value matches the intended version.
4. **Run the required tests.** Run `npm test` from the repository root. If it fails, do not commit, tag, or push; fix the cause or report the failure. Do not treat a partial test run as success.
5. **Review and commit.** Re-check `git diff` and `git status`; ensure only the intended version change is staged. Commit with exactly:

   ```text
   chore: bump version to X.Y.Z
   ```

   Follow the repository's normal commit policy and hooks. Never amend an existing commit.

6. **Create the release tag.** After the commit succeeds, verify `package.json` contains the target version and tag the new commit:

   ```bash
   git tag "vX.Y.Z"
   ```

7. **Push the release.** Push the commit to its configured remote, then push the tag:

   ```bash
   git push
   git push origin "vX.Y.Z"
   ```

   If the branch has no upstream, stop before guessing a remote or branch and report what is needed. Never force-push.

8. **Verify publication inputs.** Run `git status --short --branch`, `git rev-parse HEAD`, and `git rev-list -n 1 "vX.Y.Z"` to confirm the tree is clean and the tag points at the pushed commit. Report the version, commit, tag, and push results.

## Safety checks

- Before editing, use `git status` and inspect the current branch. A release must not silently include another engineer's changes.
- Before tagging, ensure the tag name is unused. If an existing tag points elsewhere, stop; never move it with force.
- If tests, commit hooks, tag creation, or either push fails, stop at that step and leave the failure visible. Do not continue with a partially completed release.
- Do not edit lockfiles, generated artifacts, changelogs, or source files unless the repository's release instructions explicitly require them.
- The GitHub release workflow also performs publishing and additional checks after the version-bump commit reaches `main`; a successful local release does not by itself prove npm, Docker, or PyPI publication completed.

## Gotchas

- This repository uses Bun for many development commands, but this release procedure intentionally requires `npm test` as the release gate.
- The tag must include the `v` prefix (`vX.Y.Z`), while `package.json` contains only `X.Y.Z`.
- The publish workflow detects the release from the commit subject, so do not substitute a different commit-message style.
- Tag only after the version-bump commit and tests succeed; tagging an uncommitted or untested working tree makes the release difficult to reproduce.
