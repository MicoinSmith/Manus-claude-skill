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

Then activate it in your running session (no restart needed):

```
/reload-plugins
```

### Give it an API key

Get one from the Manus webapp developer settings (up to 50 per account, shown
only once). Then pick **one** of these:

```bash
export MANUS_API_KEY="your-manus-api-key"
```

```json
// ~/.claude/settings.json
{
  "env": {
    "MANUS_API_KEY": "your-manus-api-key"
  }
}
```

> **Use the `settings.json` form if you launch Claude Code from the desktop app
> or an IDE.** A shell `export` only reaches Claude Code when it was started
> *from that same shell*; the desktop app and IDE extensions do not inherit
> your shell environment, so the skill would find no key. `settings.json` works
> in every launch mode.

`MANUS_MCP_API_KEY` is also accepted, for anyone migrating from the older MCP
server.

### Check it worked

```bash
claude plugin list          # should list manus-claude-skill
```

Then ask Claude to run something on Manus — for example *"use Manus to check my
credits"*, or `/manus-claude-skill:manus`.

## The helper

Everything goes through `skills/manus/scripts/manus.mjs` (Node 18+).

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
node "$MANUS" upload ./report.pdf        # → file_id, reusable for 48h
```

## Attaching files

A Manus task can only read what you give it. Uploads are **on demand** — the
helper never sweeps a directory or uploads anything you did not name:

```bash
node "$MANUS" run  --prompt "Summarise this report" --attach ./report.pdf
node "$MANUS" run  --prompt "Compare these" --attach ./a.csv --attach ./b.csv
node "$MANUS" send <task_id> --prompt "Now chart it" --attach ./data.xlsx
```

`--attach` is repeatable and works on `create`, `run`, and `send`. To reuse one
upload across several tasks, upload it once and pass the id:

```bash
node "$MANUS" upload ./report.pdf              # → file_id: file-abc123
node "$MANUS" create --prompt "..." --file-id file-abc123
```

Limits: 512 MB per file, 10 GB per account, files are deleted after 48 hours,
and executable/script types are rejected. The helper validates locally first.

`run` is the common case — it creates, polls, and prints the result.

Useful `create` flags: `--profile standard|lite|max`, `--locale`, `--title`,
`--visibility private|team|public`, `--interactive`, `--connector <id>`,
`--project <project_id>`, `--schema <file.json>`.

> **Account level matters.** Free personal accounts are downgraded to `lite`
> server-side no matter what `--profile` asks for, so `--profile max` silently
> does nothing. `run` warns when that happens and `status` reports the profile a
> task actually used. `credits` infers your account kind from the API response.

## License

MIT — see [LICENSE](LICENSE).
