---
name: manus
description: Create and manage Manus AI tasks — submit a prompt, poll the asynchronous task to completion, and retrieve its output. Use when the user asks to run something on Manus, delegate a long-running or web-browsing task to Manus, follow up on a Manus task, or fetch a Manus task's result. Also use when the user mentions Manus task IDs, task URLs (manus.im/app/...), or Manus credits.
---

# Manus AI Tasks

Manus runs **asynchronous** tasks. You submit a prompt, get a `task_id` back
immediately, and the agent works in the background — sometimes for minutes.
**You must poll for completion and then fetch the messages to get the result.**
A task that has merely been created has no output yet.

## Setup

The helper needs an API key. Check it is present before anything else:

```bash
[ -n "$MANUS_API_KEY" ] && echo "key present" || echo "MANUS_API_KEY MISSING"
```

Get a key from the Manus webapp developer settings (up to 50 per account, shown
only once). `MANUS_MCP_API_KEY` is also accepted for backwards compatibility.

## The helper

All calls go through `scripts/manus.mjs` (zero dependencies, Node 18+). Locate
it once, then reuse `$MANUS` for every command:

```bash
MANUS=$(find ~/.claude/plugins -path "*skills/manus/scripts/manus.mjs" 2>/dev/null | head -1)
[ -z "$MANUS" ] && MANUS="skills/manus/scripts/manus.mjs"
[ -f "$MANUS" ] || echo "helper not found — is the manus-skill plugin installed?"
```

If you are working inside the manus-skill repo itself, `skills/manus/scripts/manus.mjs`
resolves directly.

## Workflow: run a task and get the result

**One command does the whole thing** — do not hand-roll a polling loop:

```bash
node "$MANUS" run --prompt "Research the top 5 competitors of X and write a brief"
```

This creates the task, polls until it is actually finished, and prints the
final output. Use it by default.

To control the two halves separately:

```bash
node "$MANUS" create --prompt "..."        # → prints task_id, task_url
node "$MANUS" wait <task_id>               # blocks until done
node "$MANUS" result <task_id>             # prints the output text
```

## Checking on an existing task

When the user gives you a task ID or a `manus.im/app/<task_id>` URL, extract the
ID and run:

```bash
node "$MANUS" status <task_id>   # status + metadata, non-blocking
node "$MANUS" result <task_id>   # output text (works even if still running)
```

## Following up on a task

Manus tasks are multi-turn. To continue an existing task, use `send` — do **not**
create a new task, or you lose the agent's context:

```bash
node "$MANUS" send <task_id> --prompt "Now turn that into a slide outline"
```

## Listing tasks

```bash
node "$MANUS" list --limit 20
```

## Reading the status correctly — important

`task.detail` returns one of four statuses: `running`, `stopped`, `waiting`, `error`.

- **`stopped` does NOT mean the task is finished.** A task can be `stopped`
  while background jobs are still working. Always check
  `has_running_background_jobs`:
  - `true` → still working, keep polling
  - `false` → genuinely done
  - **field absent → unknown**, do not treat it as `false`
- **`waiting` means the agent is paused and needs human input or confirmation.**
  Polling will not resolve it. Surface this to the user and tell them to reply
  in the Manus webapp (at `task_url`) or use `send` to answer.
- **`error` is terminal and unrecoverable.** Report the failure; do not retry
  blindly with the same prompt.

The `run` and `wait` commands already implement this logic. Trust them over
your own reading of the status.

## API reference (v2)

Base URL `https://api.manus.ai`. Every request needs **exactly one** auth header:

| Method | Header |
|---|---|
| API key | `x-manus-api-key: <key>` |
| OAuth2 | `Authorization: Bearer <token>` |

> Note: v1 used a different base path (`/v1/tasks`), a different header
> (`API_KEY`), and a different body shape (`{prompt, mode}`). v2 is not
> compatible and v1 is deprecated. Use v2 paths only.

All responses are wrapped: success has `ok: true` plus a `request_id`; failures
have `ok: false` and `error: {code, message}`. Error codes: `unauthenticated`,
`invalid_argument`, `not_found`, `permission_denied`, `rate_limited`, `internal`.

Endpoints used by this skill:

| Endpoint | Method | Purpose |
|---|---|---|
| `/v2/task.create` | POST | Create a task. Body requires `message: {content}` |
| `/v2/task.detail` | GET | Status + metadata. Query `task_id` |
| `/v2/task.listMessages` | GET | Conversation + output. Query `task_id`, `order`, `limit` |
| `/v2/task.sendMessage` | POST | Follow-up turn on an existing task |
| `/v2/task.list` | GET | List tasks |
| `/v2/task.stop` | POST | Stop a running task |

`message.content` is a plain string or an array of content parts; text is capped
at roughly 5,000 estimated tokens per request.

## Useful `task.create` options

| Flag | Maps to | Notes |
|---|---|---|
| `--profile <standard\|lite\|max>` | `agent_profile` | Default `standard`. `max` is slower but strongest |
| `--locale <en\|zh-CN\|ja>` | `locale` | Defaults to the account locale |
| `--title <text>` | `title` | Otherwise auto-generated |
| `--visibility <private\|team\|public>` | `share_visibility` | Default `private`; non-private returns `share_url` |
| `--interactive` | `interactive_mode` | Agent may pause to ask clarifying questions |
| `--connector <id>` (repeatable) | `message.connectors` | Pre-configured connectors only |
| `--project <project_id>` | `project_id` | Applies the project's instruction |
| `--schema <file.json>` | `structured_output_schema` | Forces machine-readable output |

With `--schema`, the result also comes back as a `structured_output_result`
event, which the helper prints separately.

## Cost and time

Tasks consume Manus credits and the strong profiles take real time. Before
launching something large or ambiguous, confirm the prompt with the user. If
`credits` matter, check the balance first:

```bash
node "$MANUS" credits
```

## Common mistakes

- Creating a new task to follow up instead of using `send` — loses context.
- Treating `stopped` as done without checking `has_running_background_jobs`.
- Reporting a result before the task has finished — you will print an empty or
  partial output.
- Polling `waiting` forever — it needs human input, not more time.
- Using v1 paths (`/v1/tasks`, `API_KEY` header) — deprecated and incompatible.
