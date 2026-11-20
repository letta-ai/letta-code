/**
 * Detects Monitor commands that poll a GitHub pull request with the gh CLI and
 * builds a one-line pointer to WatchPR. Shell polling usually checks only a few
 * fields (for example state and review decision), so it misses merge
 * conflicts, comments and pushes that WatchPR reports. The pointer is advisory:
 * the monitor still starts.
 */

const REPO_FLAG = /(?:^|\s)(?:-R|--repo)(?:\s+|=)["']?([\w.-]+\/[\w.-]+)/;
const PR_URL = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
// One shell command segment: gh [global flags] pr view|checks <args>.
const GH_PR_SUBCOMMAND = /\bgh\b[^\n;|&]*?\bpr\s+(?:view|checks)\b([^\n;|&)]*)/;
const PR_NUMBER_ARG = /(?:^|\s)["']?#?(\d+)(?=["']?(?:\s|$))/;
const GH_PR_STATUS = /\bgh\s+pr\s+status\b/;
const GH_API_PULL =
  /\bgh\s+api\b[^\n;|&]*?\brepos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\b/;

function prUrl(repo: string, number: string): string {
  return `https://github.com/${repo}/pull/${number}`;
}

/**
 * Returns the WatchPR pointer for a command that polls a GitHub pull request,
 * or undefined when the command does not look like PR polling.
 */
export function monitorPullRequestHint(command: string): string | undefined {
  let url: string | undefined;
  let matched = false;

  const api = command.match(GH_API_PULL);
  if (api?.[1] && api[2]) {
    matched = true;
    url = prUrl(api[1], api[2]);
  }

  const pr = matched ? null : command.match(GH_PR_SUBCOMMAND);
  if (pr) {
    const args = pr[1] ?? "";
    const direct = args.match(PR_URL);
    const number = args.match(PR_NUMBER_ARG)?.[1];
    const repo = pr[0].match(REPO_FLAG)?.[1];
    // Without a URL or number, gh uses the current branch's PR.
    matched = true;
    if (direct?.[1] && direct[2]) url = prUrl(direct[1], direct[2]);
    else if (number && repo) url = prUrl(repo, number);
  }

  if (!matched && GH_PR_STATUS.test(command)) matched = true;
  if (!matched) return undefined;

  const target = url ?? "that pull request";
  return `This command polls a GitHub pull request. WatchPR also reports reviews, comments, conflicts and pushes; stop this monitor with TaskStop and call WatchPR on ${target} instead.`;
}
