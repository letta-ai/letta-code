# Ollama local-backend E2E

GitHub Actions runs the built Node CLI against `qwen3.5:9b` on a temporary
Modal L4 sandbox. Both machines join Tailscale as ephemeral tagged devices.
Ollama has no public endpoint. A local test proxy forwards discovery and
inference over Tailscale and can delay headers, hold a request until the
provider timeout, or drop a stream after actual model output.

The existing CPU-only Ollama smoke remains unchanged.

## One-time setup

1. Use a dedicated test tailnet. Apply `tailnet-policy.json` in its access-control
   editor. Do not retain an allow-all grant alongside this policy: grants are
   additive. The included policy test permits TCP 11434 and rejects SSH.
   Do not replace a shared organization's policy with this example.
2. Create a Tailscale API access token authorized to create tagged enrollment
   keys and remove test devices. The runner does not change tailnet policy.
3. Configure these repository/organization Actions secrets:
   `TAILSCALE_ACCESS_TOKEN`, `MODAL_TOKEN_ID`, and `MODAL_TOKEN_SECRET`.
   Treat the Tailscale access token as an administrative secret and replace it
   before its expiry. Use a dedicated test tailnet, not a network containing
   production services.
4. The Modal workspace must permit L4 sandboxes. The runner creates the
   `letta-ollama-e2e` app and `letta-ollama-e2e-models` volume if absent.

Same-repository PRs and main pushes run this lane through the existing heavy-CI
gate. Fork PRs and Dependabot do not receive infrastructure credentials.
Manual dispatch is available through `ollama-e2e.yml` at the desired branch.
Missing secrets fail explicitly; they do not silently skip coverage.

## Run locally (Linux x86-64)

Install Node 22.19+, Bun 1.3.14, and uv. Export the three infrastructure secrets
in the parent shell, then run from the repository root:

```sh
bun install --frozen-lockfile
bun run build
node --test scripts/ollama-e2e/*.test.cjs
uv run --with modal==1.5.5 python scripts/ollama-e2e/run.py --scenario
```

The runner downloads pinned Tailscale binaries into a temporary directory.
`TAILSCALE_BIN_DIR` can point to an existing installation of those binaries.
It uses local proxy port 11055; run one instance per host.

To test only private discovery and one streamed model response, omit
`--scenario`. `--tui-only` runs only the interactive cases while diagnosing
terminal failures; it does not count as a full-suite pass.
`--cancel-probe` deliberately interrupts after server readiness;
it exits nonzero after exercising cleanup. Inspect `infrastructure.json` for
`sandboxExit` and an empty `cleanupErrors` array afterward.

To run the scenario against an already-managed test Ollama endpoint:

```sh
OLLAMA_BASE_URL=http://your-test-host:11434 node scripts/ollama-e2e/scenario.cjs
```

`OLLAMA_E2E_HTTP_PROXY` optionally specifies the Tailscale userspace HTTP proxy
for this direct invocation. The model must be installed and have sufficient
served context for the ordinary agent prompt. This command alone does not
prove Tailscale routing or infrastructure cleanup.

## What must pass

- Connect Ollama and select the agent model through CLI commands, then resume
  without a model override. Configuration, init events, and upstream inference
  requests must identify the same Ollama model.
- Use the normal system prompt, reminder, skills, and tools. Reflection is
  disabled so unrelated background work does not race the fixture. No Letta
  Cloud or paid-provider credentials are inherited by the CLI or its tools.
- Read a randomly generated fixture and write its calculated result. A model's
  assertion that it succeeded is insufficient: the output file and actual tool
  calls/returns are checked.
- Complete the initial cold-model request using default product timeouts, then
  complete a request whose headers were intentionally delayed.
- Change the provider timeout through `connect --timeout 2s`, hold inference
  requests until a terminal error, restore forwarding and the five-minute
  timeout, and complete a tool-backed turn in the same process and conversation.
- Drop a stream after actual output; require terminal error and same-session
  recovery again. Automatic retries remain enabled. Restarting the CLI is never
  accepted as recovery.
- Run recovery through both bidirectional headless mode and the real Ink TUI
  using `node-pty`. Create a new conversation after recovery, including `/new`
  in the TUI, and verify Ollama remains selected.
- Create a fresh agent without any model override and require it to use the
  only configured provider, Ollama, for another tool-backed turn.

The two-second fault targets only `/v1/chat/completions`. Ollama's separate
model-load and status/discovery requests continue normally. The cold-model
test does not set a timeout override. The shortened fault case does not claim
to measure the default timeout.

## Lifetimes and diagnostics

Modal enforces a 30-minute sandbox lifetime even if CI disappears. The scenario
has a 20-minute deadline and the Actions job a 35-minute deadline. Normal exits,
errors, and SIGTERM clean up the CLI processes, Modal sandbox, local Tailscale
daemon, enrollment keys, and matching temporary devices. Abrupt runner loss is
bounded by Modal's lifetime and Tailscale's ephemeral-device removal. Model
weights remain cached in the volume.

Logs and request summaries live in `.cache/ollama-e2e/` (override with
`OLLAMA_E2E_ARTIFACTS`). They include process/session identities, tool events,
TUI output, fault modes and timings, the model digest, server logs, and
`tailscale ping` output showing direct or relayed connections. They do not
include enrollment keys or the parent environment. CI uploads these on failure
as well as success.

Ollama binds to `0.0.0.0` **inside the sandbox**, with no Modal public ports.
Its loopback-only host-header protection rejects the tailnet's 100.64/10
addresses, so binding only to loopback causes HTTP 403 even when Tailscale
connectivity succeeds.

## Cost

The sandbox requests one L4, four CPU cores, and 16 GiB RAM. At the published
[Modal prices](https://modal.com/pricing), GPU-only cost is $0.000222 per second
(about $0.13 for ten minutes). Sandbox CPU and RAM requests add approximately
$0.16 per ten minutes, before usage above the requests, storage, or plan credits.
Use the recorded timestamps to calculate each run; no GPU is kept idle between
runs. Initial image builds and model downloads take longer than cached runs.

The first complete measured run took 424 seconds with cached weights, including
cold model loading, both session modes, injected failures, and cleanup. Its
tailnet connection used a DERP relay. At the rates above, that is approximately
$0.09 GPU-only or $0.21 including the requested sandbox CPU and RAM, excluding
image builds and storage. This is one observation, not a performance guarantee.
