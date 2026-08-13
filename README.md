# AI PR Reviewer

This repository contains a Docker-free JavaScript GitHub Action for reviewing pull requests in any repository. A small, checked-in Node 24 bootstrap verifies and downloads a platform runtime from this repository's GitHub Release. Consumers do not install npm packages, run Python, or build a container.

Each review prompt runs one isolated Claude Agent SDK session. Sessions use automatic compaction, read-only repository tools (`Read`, `Glob`, and `Grep`), and any explicitly configured HTTP MCP servers. Their validated findings are deterministically merged, deduplicated, and posted as one GitHub pull request review.

## Consumer workflow

The action expects a pull request event and a full-history checkout so the reviewer can inspect the repository and its history. A PAT is required because the action creates the review through the GitHub API.

Run the action against a pristine checkout containing no tracked modifications, untracked files, or ignored files and directories. Run it before setup or build steps, or remove every artifact those steps create before starting the review.

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

      - uses: markhuangai/ai-pr-reviewer@v1.0.0
        with:
          github-pat: ${{ secrets.PR_REVIEW_PAT }}
          ai-base-url: ${{ secrets.AI_BASE_URL }}
          ai-secret: ${{ secrets.AI_SECRET }}
          model: claude-sonnet-4-5
          review-prompts: |
            Check changed code for correctness and regressions.
            Check authentication, authorization, and secret-handling paths.
            Check tests and failure handling for the changed behavior.
```

Use `@v1` for the newest stable release in major version 1, or `@v1-prerelease` for the newest version-1 release candidate. Use an exact tag when the workflow must remain pinned:

```yaml
- uses: markhuangai/ai-pr-reviewer@v1
- uses: markhuangai/ai-pr-reviewer@v1-prerelease
- uses: markhuangai/ai-pr-reviewer@v1.0.0
- uses: markhuangai/ai-pr-reviewer@v1.0.0-rc.0
```

`pull_request_target` runs the checked-in workflow from the base branch and makes secrets available for fork pull requests. Review the security implications for your repository before enabling it. For same-repository pull requests, `pull_request` is usually preferable. Never interpolate untrusted pull request text into shell commands.

## Inputs

| Input            | Required | Default   | Notes                                                                                                  |
| ---------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `github-pat`     | yes      |           | Fine-grained PAT with pull request review write access in the target repository.                       |
| `ai-base-url`    | yes      |           | HTTP(S) Anthropic Messages API-compatible endpoint.                                                    |
| `ai-secret`      | yes      |           | API key or auth token for that endpoint.                                                               |
| `ai-auth-mode`   | no       | `api-key` | `api-key` sets `ANTHROPIC_API_KEY`; `auth-token` sets `ANTHROPIC_AUTH_TOKEN`.                          |
| `model`          | yes      |           | Model name understood by the endpoint.                                                                 |
| `review-prompts` | yes      |           | JSON array or one goal per non-empty line; each goal gets its own session.                             |
| `parallel-count` | no       | `5`       | Integer from 1 to 10; limits concurrently running goal sessions.                                       |
| `max-turns`      | no       | `50`      | Integer from 2 to 100 per goal session, including `/goal`, diff reading, and output repair.            |
| `auto-approve`   | no       | `false`   | An approval is attempted only when every goal completes and no finding is Moderate, High, or Critical. |
| `mcp-servers`    | no       | empty     | Strict YAML mapping of HTTP MCP servers. Stdio and SSE transports are rejected.                        |

The action infers the repository, pull request number, base SHA, and head SHA from the pull request event. It skips a duplicate review when the same head and configuration marker already exist.

## HTTP MCP configuration

Only the Claude Agent SDK HTTP transport is accepted. Unknown keys, duplicate YAML keys, URL credentials, non-HTTPS URLs, and unsupported transports fail input validation. Header values are never written to logs or the review marker; only header names participate in the marker identity.

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
        permission_policy: always_allow
```

The MCP service can provide context, but it cannot grant the reviewer write access to the checkout. The action passes only explicitly configured HTTP servers and enables `strictMcpConfig`, so project `.mcp.json`, user settings, plugins, stdio servers, and SSE servers are ignored.

## Review behavior

- Each configured prompt starts one isolated Claude Agent SDK session with Claude Code's `/goal` Stop hook; the full review prompt follows in that same session.
- Goal sessions run concurrently up to `parallel-count`. After every goal finishes, their results are synthesized and deduplicated into one review.
- The action streams one immutable merge-base-to-head Git text diff outside the checkout. Diff attributes are read from the merge base so pull-request changes cannot hide text as binary. Every goal reads the complete diff through its own ordered, bounded internal reader before `submit_review` is accepted; there is no fixed aggregate character limit.
- Binary file contents are not reviewed and do not block completion or otherwise-qualified automatic approval. Binary change metadata remains visible in the changed-file list and text diff marker.
- A goal must submit a schema-validated result through the internal `submit_review` MCP tool. The review prompt can be followed by at most five same-session repair attempts.
- The action writes the full secret-redacted system prompt, `/goal`, review and repair user prompts, assistant text, and internal review-output validation errors to the GitHub Actions log. Long messages use numbered chunks so the redacted content remains reconstructable. Session initialization and completion, goal iterations, turn results, repairs, and automatic compaction attempts and boundaries are logged explicitly with bounded lifecycle details. Provider, session, configured external MCP, and ordinary successful tool results remain bounded previews; hidden model reasoning is not logged.
- Findings use four severities: Critical for credible immediate compromise, irreversible data loss, or broad outage; High for serious impact on a reachable path; Moderate for bounded impact or a less likely trigger; and Low for a limited-impact but actionable defect. Informational observations, style preferences, and nits are omitted.
- Findings are sorted by severity, deduplicated across goals, and limited to 25 inline comments. A location that is not an added line in the pull request diff is moved into the review body.
- Public reviews never include review prompts, model summaries, goal errors, or goal provenance. A complete review with no findings posts only a friendly success message. A partial review reports the completed-check count and rerun guidance; full secret-redacted diagnostics remain in the GitHub Actions log.
- If a goal cannot read the text diff to completion within its model context, provider limits, or configured `max-turns`, that goal fails instead of claiming complete coverage. GitHub's changed-file API still limits review metadata to 3,000 files.
- A partial review is posted as a comment and the action fails. If every goal fails, no review is posted and the action fails.
- If GitHub rejects an approval, the action retries once as a comment review.
- Review bodies are capped at approximately 60 KB. No report artifact is uploaded.

## Security and release model

The action is compiled TypeScript and runs on Node 24 or newer. It does not use Docker. Reference the action with an exact stable or release-candidate tag such as `v1.0.0` or `v1.0.1-rc.0` for reproducible behavior, or use a major alias such as `v1` or `v1-prerelease` to receive the latest stable or prerelease release in that major line. Branches and commit SHAs are not supported. Major aliases are annotated, moving Git tags with no GitHub Release of their own; the bootstrap resolves each alias to its exact compatible release before downloading and verifying the platform runtime. Supported bundles are Linux glibc x64/arm64, Windows x64/arm64, and macOS x64/arm64.

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

Secrets are passed to the AI SDK only through its authentication environment variables. The Claude reviewer subprocess receives no GitHub PAT, GitHub token, or action runtime token, and its built-in tools are read-only; the parent action process retains the PAT only for the GitHub API call.

## Development

Node 24+, npm 12, and Git 2.43+ are required. Dependencies must be installed with lifecycle scripts disabled:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run test:coverage
npm run build
npm run bundle:bootstrap
```

Repository CI and release jobs run on the ephemeral self-hosted `docker-runner` label without Docker access. RC releases use npm's target OS and CPU selection to package the SDK's prebuilt native dependency for each supported platform, record the RC and stable tags plus SDK and native CLI versions in each manifest, verify archive checksums, and publish those assets. Stable releases promote the matching RC archives byte for byte after source verification. No container build is required.

## License

MIT
