# manus-claude-skill

Run and manage **Manus AI tasks** from Claude Code — create a task, poll the
asynchronous run to completion, and retrieve its output.

Manus tasks are asynchronous: creating one returns a `task_id` and nothing
more. This skill handles the polling and result retrieval, so you get the actual
output in a single step instead of a `task_id` that goes nowhere.

## Install

```bash
claude plugin marketplace add https://github.com/MicoinSmith/Manus-claude-skill
claude plugin install manus-claude-skill@manus-claude-skill
```

Then set your API key:

```bash
export MANUS_API_KEY="your-manus-api-key"
```

`MANUS_MCP_API_KEY` is also accepted, for anyone migrating from the older
MCP server.

Restart Claude Code, then just ask it to run something on Manus.

## The helper

Everything goes through `skills/manus/scripts/manus.mjs` — zero dependencies,
Node 18+ (uses the built-in `fetch`).

```bash
MANUS="skills/manus/scripts/manus.mjs"

node "$MANUS" run    --prompt "Research the top 5 competitors of X and write a brief"
node "$MANUS" create --prompt "..."      # → task_id, task_url
node "$MANUS" wait   <task_id>           # block until the task genuinely finishes
node "$MANUS" result <task_id>           # print the output
node "$MANUS" status <task_id>           # status + metadata, non-blocking
node "$MANUS" send   <task_id> --prompt "..."   # follow-up turn
node "$MANUS" list   --limit 20
node "$MANUS" stop   <task_id>
node "$MANUS" credits
```

`run` is the common case — it creates, polls, and prints the result.

Useful `create` flags: `--profile standard|lite|max`, `--locale`, `--title`,
`--visibility private|team|public`, `--interactive`, `--connector <id>`,
`--project <project_id>`, `--schema <file.json>`.

## Why this exists

Manus tasks are asynchronous, and the API has traps that make naive polling
wrong — most notably, a task reporting `status: "stopped"` may still have
background jobs running. The helper implements the correct completion logic,
so prefer `run`/`wait` over hand-rolling a polling loop. The three traps are
documented in [skills/manus/SKILL.md](skills/manus/SKILL.md).

## API

Targets the **current Manus API v2**: base `https://api.manus.ai`, auth via the
`x-manus-api-key` header, `{ok, request_id, ...}` response envelope.

> The older v1 API (`/v1/tasks`, `API_KEY` header, `{prompt, mode}` body) is
> **deprecated** and incompatible. This project does not use it.

## Proxy support

Node's `fetch` ignores `HTTP_PROXY` / `HTTPS_PROXY`. The helper detects a
configured proxy and re-execs itself with `--use-env-proxy` on Node 24+; on
older Node it prints a clear warning instead of failing with an opaque
`fetch failed`.

## Development

```bash
npm test    # node --test
```

## License

MIT — see [LICENSE](LICENSE).
