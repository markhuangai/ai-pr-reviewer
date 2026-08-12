# AI pull request reviewer

This repository contains a Docker-free JavaScript GitHub Action for reviewing pull requests in any repository. A small, checked-in Node 24 bootstrap verifies and downloads a platform runtime from this repository's GitHub Release. Consumers do not install npm packages, run Python, or build a container.

Each review prompt runs one isolated Claude Agent SDK session. Sessions use automatic compaction, read-only repository tools (`Read`, `Glob`, and `Grep`), and any explicitly configured HTTP MCP servers. Their validated findings are deterministically merged, deduplicated, and posted as one GitHub pull request review.

## Consumer workflow

The action expects a pull request event and a full-history checkout so the reviewer can inspect the repository and its history. A PAT is required because the action creates the review through the GitHub API.

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

      - uses: markhuangai/ai-pr-reviewer@v1
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

`pull_request_target` runs the checked-in workflow from the base branch and makes secrets available for fork pull requests. Review the security implications for your repository before enabling it. For same-repository pull requests, `pull_request` is usually preferable. Never interpolate untrusted pull request text into shell commands.

## Inputs

| Input            | Required | Default   | Notes                                                                                                |
| ---------------- | -------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `github-pat`     | yes      |           | Fine-grained PAT with pull request review write access in the target repository.                     |
| `ai-base-url`    | yes      |           | HTTP(S) Anthropic Messages API-compatible endpoint.                                                  |
| `ai-secret`      | yes      |           | API key or auth token for that endpoint.                                                             |
| `ai-auth-mode`   | no       | `api-key` | `api-key` sets `ANTHROPIC_API_KEY`; `auth-token` sets `ANTHROPIC_AUTH_TOKEN`.                        |
| `model`          | yes      |           | Model name understood by the endpoint.                                                               |
| `review-prompts` | yes      |           | JSON array or one goal per non-empty line; each goal gets its own session.                           |
| `parallel-count` | no       | `5`       | Integer from 1 to 10.                                                                                |
| `max-turns`      | no       | `50`      | Integer from 2 to 100 per goal session, including the initial `/goal` setup turn.                    |
| `auto-approve`   | no       | `false`   | An approval is attempted only when every goal completes and no finding is Medium, High, or Critical. |
| `mcp-servers`    | no       | empty     | Strict YAML mapping of HTTP MCP servers. Stdio and SSE transports are rejected.                      |

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
- A goal must submit a schema-validated result through the internal `submit_review` MCP tool. The review prompt can be followed by at most five same-session repair attempts.
- Findings are sorted by severity, deduplicated across goals, and limited to 25 inline comments. A location that is not an added line in the pull request diff is moved into the review body.
- Changed-file patches are ordered with deleted files first and bounded as a complete set; if any diff is unavailable or exceeds the budget, every goal fails closed instead of producing a complete or approving review.
- A partial review is posted as a comment and the action fails. If every goal fails, no review is posted and the action fails.
- If GitHub rejects an approval, the action retries once as a comment review.
- Review bodies are capped at approximately 60 KB. No report artifact is uploaded.

## Security and release model

The action is compiled TypeScript and runs on Node 24 or newer. It does not use Docker. The bootstrap downloads one platform-specific runtime bundle from the `runtime-v1` GitHub Release, verifies its SHA-256 digest, validates the bundle manifest, and starts the bundled Node runtime. After publishing the runtime assets, the release workflow advances the consumer-facing `v1` branch. Supported bundles are Linux glibc x64/arm64, Windows x64/arm64, and macOS x64/arm64.

The lockfile and release workflow enforce the project's supply-chain policy:

- every locked npm dependency must be at least 168 hours old before installation;
- exact lockfile versions, integrity hashes, npm signature checks, lifecycle-script disabling, and no runtime package installation;
- `npm audit --audit-level=high` blocks vulnerable releases;
- workflows use readable major action versions whose current releases run on Node 24;
- a candidate with a vulnerable dependency is not promoted while its fix is younger than seven days.

CI also runs CodeQL JavaScript/TypeScript analysis for every pull request and push to `main`. The CodeQL job scans without installing dependencies or executing project build scripts.

Secrets are passed to the AI SDK only through its authentication environment variables. The Claude reviewer subprocess receives no GitHub PAT, GitHub token, or action runtime token, and its built-in tools are read-only; the parent action process retains the PAT only for the GitHub API call.

## Development

Node 24+ and npm 12 are required. Dependencies must be installed with lifecycle scripts disabled:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run test:coverage
npm run build
npm run bundle:bootstrap
```

Repository CI and release jobs run on the ephemeral self-hosted `docker-runner` label without Docker access. The release workflow uses npm's target OS and CPU selection to package the SDK's prebuilt native dependency for each supported platform, records the SDK and native CLI versions in each manifest, verifies archive checksums, and publishes the assets to the selected release. No container build is required.

## License

MIT
