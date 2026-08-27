# Goal-Driven AI PR Reviewer

This repository contains a goal-driven, MCP-enabled JavaScript GitHub Action for reviewing pull requests in any repository. A small, checked-in Node 24 bootstrap verifies and downloads a platform runtime from this repository's GitHub Release. Consumers do not install npm packages, run Python, or build a container.

Each review prompt runs one isolated Codex SDK or Claude Agent SDK session through a shared executor interface; Claude is the default. Both executors receive the same immutable pull-request briefing, fixed-revision repository read/list/search tools, optional exact workflow-provided context files, and explicitly configured HTTP MCP servers. Shell commands and file mutation are unavailable. Validated findings are deterministically merged and deduplicated, then posted as one GitHub pull request review or written only to the workflow run summary. Executor token usage is combined across every goal and included in a default-collapsed section in both destinations.

## Consumer workflow

For event-based reviews, the action expects a pull request event and a full-history checkout so the reviewer can inspect the repository and its history. A PAT is required for target-repository API and Git access; it needs write access only when the action may post a review.

Run the action against a pristine checkout containing no tracked modifications, untracked files, or ignored files and directories. Run it before setup or build steps, or remove every artifact those steps create before starting the review. Workflow-generated review context belongs under `RUNNER_TEMP`, not inside `GITHUB_WORKSPACE`.

```yaml
name: AI review

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
          persist-credentials: false

      - uses: markhuangai/ai-pr-reviewer@v1-prerelease
        with:
          github-pat: ${{ secrets.PR_REVIEW_PAT }}
          ai-base-url: ${{ secrets.AI_BASE_URL }}
          ai-secret: ${{ secrets.AI_SECRET }}
          model: claude-sonnet-4-5
          effort: high
          review-prompts: |
            [
              { "prompt": "Check changed code for correctness and regressions." },
              { "prompt": "Check authentication, authorization, and secret-handling paths." },
              { "prompt": "Check tests and failure handling for the changed behavior." }
            ]
```

The workflow owns whether a newer event cancels an older review. For example, a pull-request workflow can keep only the newest run for each target:

```yaml
concurrency:
  group: ai-pr-review-${{ github.repository }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: true
```

The action reviews the immutable event/API snapshot it captured. It does not reread a moving pull request, restart itself, or decide whether a workflow run should be cancelled; the workflow consumer owns that policy.

Use `@v1` for the newest stable release in major version 1, or `@v1-prerelease` for the newest version-1 release candidate. Use an exact tag when the workflow must remain pinned:

```yaml
- uses: markhuangai/ai-pr-reviewer@v1
- uses: markhuangai/ai-pr-reviewer@v1-prerelease
- uses: markhuangai/ai-pr-reviewer@v1.0.0
- uses: markhuangai/ai-pr-reviewer@v1.0.0-rc.0
```

`pull_request_target` runs the checked-in workflow from the base branch and makes secrets available for fork pull requests. Review the security implications for your repository before enabling it. For same-repository pull requests, `pull_request` is usually preferable. Never interpolate untrusted pull request text into shell commands.

## Inputs

| Input              | Required | Default  | Notes                                                                                                          |
| ------------------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `github-pat`       | yes      |          | Fine-grained PAT with read access to the target; pull request review write access is needed when posting.      |
| `executor`         | no       | `claude` | `codex` or `claude`; one executor applies to every goal in the run.                                            |
| `ai-base-url`      | no       |          | Optional Codex API base URL; required for Claude and must be Anthropic Messages API-compatible.                |
| `ai-secret`        | yes      |          | API key for the selected executor endpoint.                                                                    |
| `model`            | yes      |          | Model name understood by the selected endpoint.                                                                |
| `effort`           | no       |          | `low`, `medium`, `high`, `xhigh`, or `max`; omit it to use the model default.                                  |
| `system-prompt`    | no       |          | Full replacement; written to the redacted action log.                                                          |
| `model-pricing`    | no       |          | Strict JSON with a currency prefix and per-model rates per one million tokens.                                 |
| `review-prompts`   | yes      |          | Non-empty JSON array of `{ "prompt", "files"? }` goal objects.                                                 |
| `parallel-count`   | no       | `5`      | Integer from 1 to 10; limits concurrently running goal sessions.                                               |
| `max-turns`        | no       |          | Claude-only integer from 2 to 100; Claude defaults to 50. Explicit Codex use logs a warning and has no effect. |
| `auto-approve`     | no       | `false`  | An approval is attempted only when every goal completes and no finding is Moderate, High, or Critical.         |
| `interact-with-pr` | no       | `true`   | When `false`, do not create a review; write all findings only to the workflow run summary.                     |
| `pull-request-url` | no       |          | Same-GitHub-host PR URL to review. It may identify a repository other than the workflow repository.            |
| `mcp-servers`      | no       | empty    | Strict YAML mapping of Streamable HTTP MCP servers. Stdio and legacy SSE transports are rejected.              |

`effort` applies to every isolated goal session and its output-repair turns. It is a behavioral signal rather than a strict token budget, and `xhigh` or `max` requires support from the selected model and endpoint. Codex receives the exact value, including `max`, through its CLI configuration. The Claude subprocess does not inherit `CLAUDE_CODE_EFFORT_LEVEL`; configure effort through this action input instead.

For the Claude executor, every isolated goal fixes Claude Code's `API_TIMEOUT_MS` and `CLAUDE_STREAM_IDLE_TIMEOUT_MS` controls at 300000 milliseconds and sets `CLAUDE_CODE_MAX_RETRIES` to `1`. Each Claude model API request therefore gets at most two five-minute attempts. Retry events include the attempt, retry limit, delay, HTTP status, and error class in the action log. These controls bound each request and silent response stream, not the total goal lifetime.

### Custom system prompt

Use `system-prompt` when the built-in reviewer instructions should be replaced for every isolated goal session:

```yaml
system-prompt: |
  You are a reviewer for this repository. Inspect evidence before reporting a defect.
  Return only actionable findings supported by the configured review contract.
```

This is a full replacement, not an addition to the built-in zero-trust guidance. The action still enforces its read-only tools, review completion gates, schema validation, and repair behavior, but the replacement prompt is responsible for any additional model guidance. The effective system prompt is written to the secret-redacted GitHub Actions log, so do not include credentials or other secrets. There is no application-level character cap; GitHub Actions, the selected executor SDK, and the configured endpoint may impose their own input or context limits.

Without `pull-request-url`, the action infers the repository, pull request number, base SHA, and head SHA from the pull request event. When interaction is enabled, it skips a duplicate review only when the same head, configuration, qualifying conversation digest, and authorized context file snapshots already exist. An owner reply or changed context file therefore makes a later run distinct even when the head SHA is unchanged. When a PR event and `pull-request-url` are both present, they must identify the same pull request.

### Breaking `review-prompts` input change

`review-prompts` now accepts only a non-empty JSON array of goal objects. Each object requires a non-empty `prompt` and may omit `files`, use an empty `files` array, or list exact context file paths. JSON arrays of strings and newline-separated prompts are no longer accepted.

Migrate legacy input such as:

```yaml
review-prompts: |
  Check changed code.
  Check error handling.
```

to:

```yaml
review-prompts: |
  [
    { "prompt": "Check changed code." },
    { "prompt": "Check error handling." }
  ]
```

### Per-goal context files

Use the optional `files` array when a workflow step produces text that is too large or unnecessary to embed in the prompt. The array grants that goal access to exact paths; mentioning a path only in `prompt` does not grant access. A goal that only needs the checked-out repository can omit `files`.

```yaml
- id: ticket_context
  shell: bash
  run: |
    context_path="$RUNNER_TEMP/ai-pr-review-context/ticket.json"
    mkdir -p "$(dirname "$context_path")"
    your-ticket-tool PROJ-123 > "$context_path"
    echo "path=$context_path" >> "$GITHUB_OUTPUT"

- uses: markhuangai/ai-pr-reviewer@v1-prerelease
  with:
    github-pat: ${{ secrets.PR_REVIEW_PAT }}
    executor: claude
    ai-base-url: ${{ secrets.AI_BASE_URL }}
    ai-secret: ${{ secrets.AI_SECRET }}
    model: claude-sonnet-4-5
    review-prompts: |
      [
        {
          "prompt": ${{ toJSON(format('Review against the ticket. Read {0} if needed.', steps.ticket_context.outputs.path)) }},
          "files": [${{ toJSON(steps.ticket_context.outputs.path) }}]
        },
        {
          "prompt": "Check concurrency behavior."
        }
      ]
```

Every path must be normalized and absolute. Each goal supports 25 files, a run supports 100 unique files, each file is limited to 100 MiB, and their unique total is limited to 500 MiB. Files must be regular, single-link UTF-8 text without NUL bytes; symlinks, hard links, directories, devices, FIFOs, and changing files are rejected.

The action captures private immutable snapshots before duplicate detection and adds only the authorized original paths to the generated goal prompt. A goal can optionally read a snapshot in ordered 4 KiB pages through the internal `read_context_file` tool; repository tools cannot access workflow context paths. The captured bytes and goal association participate in duplicate-review identity, and snapshots are removed when the action ends.

Context file contents are sent to the configured AI endpoint only when the agent reads them. The action omits the page contents from tool-result logs, but paths are logged and the model may repeat relevant excerpts in assistant text or findings. Treat files as untrusted evidence and never authorize credentials, tokens, or unrelated sensitive data.

### Token usage and model pricing

The action always combines the latest cumulative SDK usage snapshot from every isolated goal. Configure `model-pricing` to add an estimated cost; omit it to show tokens without any cost text. Every rate is required, must be a finite non-negative JSON number, and is interpreted per one million tokens.

```yaml
model-pricing: |
  {
    "currency": "$",
    "models": {
      "review-model": {
        "input": 1.2,
        "output": 2,
        "cache-hit": 0.12,
        "cache-creation": 0.6
      }
    }
  }
```

`currency` is preserved as an exact prefix. For example, `$` produces `$0.36`, `USD` produces `USD0.36`, and <code>USD&nbsp;</code> (with a trailing space) produces `USD 0.36`. Model matching is case-sensitive. The raw SDK model ID is checked first, then its canonical model ID. A model without a matching price remains in the token total, is marked `unpriced`, and makes the estimated cost a lower bound. Incomplete SDK accounting also makes the estimate a lower bound.

For 100,000 input tokens, 50,000 output tokens, 1,000,000 cache-hit tokens, and 30,000 cache-creation tokens, the PR review and run summary include this default-collapsed source:

```markdown
<details>
<summary>📊 Token usage · 1,180,000 tokens · 💰 Estimated $0.36</summary>

| Model                     |   Input | Output | Cache hit | Cache creation |         Total |
| :------------------------ | ------: | -----: | --------: | -------------: | ------------: |
| <code>review-model</code> | 100,000 | 50,000 | 1,000,000 |         30,000 | **1,180,000** |

#### 💳 Pricing per 1M tokens

| Model                     | Input | Output | Cache hit | Cache creation |
| :------------------------ | ----: | -----: | --------: | -------------: |
| <code>review-model</code> |  $1.2 |     $2 |     $0.12 |           $0.6 |

> ✅ **Complete SDK accounting**
> ℹ️ AI executor model usage only; external MCP service usage is excluded.

</details>
```

The calculation sums unrounded model costs and rounds only the grand total to two decimal places:

```text
(input × input rate + output × output rate + cache hit × cache-hit rate + cache creation × cache-creation rate) / 1,000,000
```

Failed goals still contribute valid SDK usage. If a goal crashes after reporting usage, Claude retains its last valid cumulative snapshot and Codex retains summed completed-turn usage; SDK accounting is marked incomplete. Usage incurred inside an external MCP service is outside the SDK totals.

### Summary-only event review

Set `interact-with-pr: false` to keep the result out of the pull request. The action still reads PR metadata, changed files, reviews, inline replies, PR-level comments, and the authenticated PAT identity so each goal receives the same conversation context. It does not post a review, add inline comments, or approve the PR. Complete, partial, and failed results are written to the workflow run summary; partial and failed reviews still fail the action after the summary is written.

```yaml
- uses: markhuangai/ai-pr-reviewer@v1-prerelease
  with:
    github-pat: ${{ secrets.READ_ONLY_REVIEW_PAT }}
    executor: claude
    ai-base-url: ${{ secrets.AI_BASE_URL }}
    ai-secret: ${{ secrets.AI_SECRET }}
    model: claude-sonnet-4-5
    review-prompts: '[{"prompt":"Check changed code for correctness and regressions."}]'
    interact-with-pr: false
```

### Cross-repository review

`pull-request-url` supports dispatch, schedule, or other non-PR workflows. The target must use the same origin as `GITHUB_SERVER_URL`. The action reads the pull request metadata once, fetches `base.sha` and `head.sha` by their exact commit IDs into an isolated temporary checkout, asserts that both refs resolve to those IDs, reviews the detached head, and removes it afterward. Do not add an `actions/checkout` step for this mode.

GitHub serves a requested commit SHA only while the object is reachable from the target repository. A force-push that makes either captured commit unavailable, or deletion and pruning that removes it, fails the checkout closed instead of substituting a live branch tip. The fetch is not shallow, so the reachable history needed for `git merge-base(baseSha, headSha)` remains available. The merge-base-to-head boundary is computed from the two captured SHAs and is unchanged if either branch moves after capture. A later push does not restart or invalidate this review; configure workflow `concurrency` or another consumer-owned policy when that is desired.

```yaml
name: External PR review

on:
  workflow_dispatch:
    inputs:
      pull-request-url:
        description: GitHub pull request URL
        required: true
        type: string

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: markhuangai/ai-pr-reviewer@v1-prerelease
        with:
          github-pat: ${{ secrets.CROSS_REPOSITORY_REVIEW_PAT }}
          executor: claude
          ai-base-url: ${{ secrets.AI_BASE_URL }}
          ai-secret: ${{ secrets.AI_SECRET }}
          model: claude-sonnet-4-5
          review-prompts: '[{"prompt":"Check changed code for correctness and regressions."}]'
          pull-request-url: ${{ inputs.pull-request-url }}
          interact-with-pr: false
```

The PAT must cover the target repository. For summary-only review, grant target contents and pull request metadata read access. If `interact-with-pr` is `true`, also grant pull request review write access.

## HTTP MCP configuration

Both executors accept only explicitly configured HTTPS Streamable HTTP servers. Unknown keys, duplicate YAML keys, URL credentials, non-HTTPS URLs, and unsupported transports fail input validation. Header values are never written to logs or the review marker; only header names participate in the marker identity. Codex receives header values through generated environment variables rather than command arguments.

```yaml
mcp-servers: |
  security-advisor:
    type: http
    url: https://mcp.example.com/review
    headers:
      Authorization: Bearer ${{ secrets.MCP_AUTH }}
    timeout: 30000
    alwaysLoad: true
    tools:
      - name: dependency_advice
        enabled: true
```

Each tool policy is `{ name, enabled? }`; omitted `enabled` defaults to `true`. During the release-candidate compatibility window, legacy `always_allow`/`allow` policies map to enabled, while ask, deny, and blocked policies map to disabled and emit a deprecation warning. The action is non-interactive and never pauses to ask for MCP approval.

The MCP service can provide context, but it cannot grant the reviewer write access to the checkout. Claude enables strict MCP configuration, while Codex uses a per-goal isolated `CODEX_HOME`; project and user MCP settings, plugins, stdio servers, and legacy SSE servers are ignored.

`interact-with-pr: false` controls only this action's built-in GitHub pull request writes. An explicitly configured external MCP tool can have side effects in its own service. Do not enable write-capable MCP tools when the workflow must be end-to-end side-effect-free.

## Review behavior

- Each configured prompt starts one isolated session from the selected executor. Claude receives its bounded `/goal` command before the full prompt; Codex receives the same goal in the full prompt and host-owned instructions file.
- Both executors use the same host-owned tools: `read_repository_file`, `list_repository_files`, and `search_repository` read tracked content at the captured merge base or head. No model-generated shell command performs repository discovery.
- Goal sessions run concurrently up to `parallel-count`. After every goal finishes, their results are synthesized and deduplicated into one review.
- A structured goal may optionally read only its exact authorized workflow context files. Each goal gets independent readers over immutable snapshots, and submitting a review does not require reading optional files.
- Claude Agent SDK usage is cumulative within a goal, so only its latest valid snapshot is retained. Codex SDK usage is incremental per turn, so review and repair turns are summed before goals are combined.
- The action includes non-empty PR-level comments and review bodies from human and bot reviewers other than the authenticated PAT identity. An inline thread is included when it has non-workflow content, including replies to this action's prior inline comments. The complete selected thread is preserved, including this action's root finding when a non-workflow reply selects that thread, so the finding and all replies remain together.
- The briefing includes the PR body, same-repository linked issue bodies referenced by `#123`, `owner/repository#123`, or same-origin issue URLs (up to 20), changed-file metadata, and a bounded prior-discussion index. Body, issue, comment, and review text is secret-redacted and treated as untrusted evidence, never as instructions. A prior explanation suppresses a repeated finding only when the current checkout supports it; contradictory or outdated explanations must be addressed in the new finding.
- Each goal must read the briefing to completion. `read_pr_diff` reads the complete diff or exact changed paths on demand; `read_repository_file` reads any exact tracked path at the merge base or head; `list_repository_files` lists tracked names; and `search_repository` runs a fixed-revision Git search. `read_pr_conversation` is optional, and `read_pr_threads` retrieves complete selected threads from the index. A located submission is rejected until prior inline discussion for that path has been read.
- The fixed Git diff uses merge-base attributes so pull-request changes cannot hide text as binary. Pages are bounded by bytes, tool results are capped before delivery, and each goal retains at most 256 MiB across unfinished fixed Git query snapshots; a goal is not required to consume a monolithic diff or every conversation body. Bash and other write or execution tools remain unavailable.
- The action does not reread live refs or conversation before publishing. Every review and summary describes the captured base, head, files, and conversation; a workflow consumer can use `concurrency.cancel-in-progress` when it wants newer events to supersede an active run.
- A first `SIGINT`, `SIGTERM`, or Windows `SIGBREAK` starts graceful cancellation across bootstrap, GitHub API/Git work, context capture, diff generation, and executor sessions. Cancellation stops new goals and writes, and cleanup still runs. A GitHub write accepted immediately before cancellation cannot be undone.
- The action does not add comment-event triggers. Replies affect the next pull request update, workflow rerun, or separately configured dispatch that invokes the action.
- Binary file contents are not reviewed and do not block completion or otherwise-qualified automatic approval. Binary change metadata remains visible in the changed-file list and text diff marker.
- A goal must submit a schema-validated result through the internal `submit_review` MCP tool. The review prompt can be followed by at most five same-session repair attempts.
- The action writes the full secret-redacted system prompt, review and repair user prompts, assistant text, Claude `/goal`, and internal review-output validation errors to the GitHub Actions log. Long messages use numbered chunks so the redacted content remains reconstructable. Session initialization, completion, turns, and repairs are logged with bounded lifecycle details. Context file tool results log an omission marker instead of page contents; hidden model reasoning is not logged.
- Findings use four severities: Critical for credible immediate compromise, irreversible data loss, or broad outage; High for serious impact on a reachable path; Moderate for bounded impact or a less likely trigger; and Low for a limited-impact but actionable defect. Informational observations, style preferences, and nits are omitted.
- Findings are sorted by severity, deduplicated across goals, and limited to 25 inline comments. Each comment uses a severity marker, a short impact statement, and a short fix. Every verified inline finding also includes a default-collapsed prompt that an AI coding agent can use to validate and address it; the prompt is generated from the finding and verified location rather than authored by the review model. A location that is not an added line in the pull request diff is moved into the review body without the prompt.
- Public reviews never include review prompts, model summaries, goal errors, or goal provenance. A complete review with no findings posts only a friendly success message. A partial review reports the completed-check count and rerun guidance; full secret-redacted diagnostics remain in the GitHub Actions log.
- If a goal cannot read the briefing or selected evidence within its model context or provider limits, that goal fails instead of claiming complete coverage. Claude also fails when it reaches its effective `max-turns`. GitHub's changed-file API still limits review metadata to 3,000 files.
- When interaction is enabled, a partial review is posted as a comment and the action fails. If every goal fails, no review is posted and the action fails.
- In summary-only mode, every finding is included in the run summary rather than split between body and inline destinations. The summary is capped below GitHub's 1 MiB per-step limit and omits only whole findings when needed.
- If GitHub rejects an approval, the action retries once as a comment review.
- Review bodies are capped at approximately 60 KB. No report artifact is uploaded.

## Security and release model

The action is compiled TypeScript and runs on Node 24 or newer. It does not use Docker. Reference the action with an exact stable or release-candidate tag such as `v1.0.0` or `v1.0.1-rc.0` for reproducible behavior, or use a major alias such as `v1` or `v1-prerelease` to receive the latest stable or prerelease release in that major line. Branches and commit SHAs are not supported. Major aliases are annotated, moving Git tags with no GitHub Release of their own; the bootstrap resolves each alias to its exact compatible release before downloading and verifying the platform runtime. Supported bundles are Linux glibc x64/arm64, Windows x64/arm64, and macOS x64/arm64.

The immutable-snapshot and graceful-cancellation changes are targeted for `v1.1.4-rc.0`; workflows currently pinned to `@v1-prerelease` should receive them when that prerelease becomes the alias target.

Releases are started manually from `main` through the `Release runtime bundles` workflow. Choose the `prerelease` channel with an `X.Y.Z-rc.N` version to create a GitHub prerelease, or choose the `stable` channel with an `X.Y.Z` version to promote the latest matching RC. Stable promotion requires that RC tag to be an ancestor with an identical Git tree and reuses its exact verified assets without rebuilding them. Published versions are never replaced, RC numbers cannot be skipped, each stable version requires an RC, and a new patch, minor, or major line advances exactly one component while resetting lower components.

Intermediate GitHub Actions artifacts used to assemble a prerelease are retained for one day. They are separate from the assets attached to a published GitHub Release, which remain available under the release. Self-hosted runners avoid GitHub-hosted runner minutes, but Actions artifact storage is still subject to the repository owner's GitHub plan and billing, so it should not be assumed to have zero cost.

The workflow creates and verifies the exact Git tag before publishing its release, so it cannot attach built assets to a racing tag at another commit. After the exact release is published, a separate idempotent job updates `vN` for stable releases or `vN-prerelease` for prereleases to an annotated tag that records the exact release tag. If alias publication fails, the exact release remains usable and the alias job can be rerun. If exact publication fails after tag creation, the orphan tag deliberately blocks retries until an administrator inspects and removes it.

For example, dispatch a prerelease from `main` with:

```bash
gh workflow run release.yml \
  --repo markhuangai/ai-pr-reviewer \
  --ref main \
  -f channel=prerelease \
  -f version=1.0.0-rc.0
```

The lockfile and release workflow enforce the project's supply-chain policy:

- every locked npm dependency must be at least 168 hours old before installation;
- exact lockfile versions, integrity hashes, npm signature checks, lifecycle-script disabling, and no runtime package installation;
- `npm audit --audit-level=high` blocks vulnerable releases;
- consumers may pin exact immutable action release tags for reproducibility or choose a documented major alias for automatic updates;
- a candidate with a vulnerable dependency is not promoted while its fix is younger than seven days.

CI also runs CodeQL JavaScript/TypeScript analysis for pull requests targeting `main` and pushes to `main`. The CodeQL job scans without installing dependencies or executing project build scripts.

Secrets are passed to the selected SDK through its API-key mechanism. Reviewer subprocesses receive no GitHub PAT, GitHub token, or action runtime token. Codex runs with approval policy `never`, a read-only sandbox, shell/web/apps/hooks/memories/plugins/skills/subagents disabled, a host-owned instructions file, and an authenticated loopback MCP server inside a per-goal `CODEX_HOME` that is removed afterward. The parent action process retains the PAT for GitHub API calls and isolated cross-repository fetches.

## Development

Node 24+, npm 12, and Git 2.43+ are required. Dependencies must be installed with lifecycle scripts disabled:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run test:coverage
npm run build
npm run bundle:bootstrap
```

Repository CI and release jobs run on the ephemeral self-hosted `docker-runner` label without Docker access. RC releases use npm's target OS and CPU selection to package both SDKs' prebuilt native dependencies for each supported platform, record the RC and stable tags plus both SDK and native CLI versions in each manifest, verify archive checksums, and publish those assets. Stable releases promote the matching RC archives byte for byte after source verification. No container build is required.

## License

MIT
