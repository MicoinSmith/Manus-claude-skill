#!/usr/bin/env node
/**
 * Manus API v2 CLI helper.
 *
 * Zero dependencies, Node 18+ (uses the built-in fetch / AbortSignal.timeout).
 * Handles the awkward part of the Manus API: tasks are asynchronous, so a
 * created task has no output until it actually finishes.
 */

import { readFileSync, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = (process.env.MANUS_API_BASE_URL || "https://api.manus.ai").replace(/\/+$/, "");
const API_KEY = process.env.MANUS_API_KEY || process.env.MANUS_MCP_API_KEY || "";

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 5_000;
const MAX_PAGES = 20;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
/** The API rejects executable and script types outright. */
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  ".exe",
  ".sh",
  ".bat",
  ".dmg",
  ".cmd",
  ".com",
  ".msi",
  ".scr",
  ".ps1",
]);

const USAGE = `manus — Manus API v2 helper

Usage:
  manus create --prompt <text> [options]   Create a task, print its id
  manus run    --prompt <text> [options]   Create, wait for completion, print result
  manus status <task_id>                   Print status and metadata (non-blocking)
  manus wait   <task_id> [--timeout-sec N] Block until the task actually finishes
  manus result <task_id> [--verbose]       Print the task output
  manus send   <task_id> --prompt <text>   Follow-up turn on an existing task
  manus list   [--limit N]                 List tasks
  manus stop   <task_id>                   Stop a running task
  manus credits                            Show available credits
  manus upload <path>                      Upload a file now, print its file_id

Options for create/run:
  --profile <standard|lite|max>            Agent profile (default: standard)
  --locale <en|zh-CN|ja>                   Output language
  --title <text>                           Custom title
  --visibility <private|team|public>       Sharing (default: private)
  --interactive                            Let the agent ask clarifying questions
  --connector <id>                         Connector id, repeatable
  --project <project_id>                   Attach to a project
  --schema <file.json>                     Structured output JSON Schema
  --attach <path>                          Upload a local file and attach it, repeatable
  --file-id <id>                           Attach an already-uploaded file, repeatable
  --json                                   Print raw JSON instead of text

Environment:
  MANUS_API_KEY        required (MANUS_MCP_API_KEY also accepted)
  MANUS_API_BASE_URL   optional, default https://api.manus.ai
`;

function fail(message, code = 1) {
  process.stderr.write(`manus: ${message}\n`);
  process.exit(code);
}

function note(message) {
  process.stderr.write(`manus: ${message}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Node's fetch ignores HTTP_PROXY / HTTPS_PROXY. Node 24+ can honour them via
 * --use-env-proxy, so re-exec ourselves once when a proxy is configured.
 * Without this a proxied network fails with an opaque "fetch failed".
 */
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

function ensureProxySupport() {
  if (process.env.MANUS_PROXY_BOOTSTRAPPED === "1") return;
  if (process.env.NODE_USE_ENV_PROXY === "1") return;
  if (!PROXY_ENV_KEYS.some((key) => process.env[key])) return;

  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isFinite(major) || major < 24) {
    note(
      "a proxy is configured but Node < 24 cannot honour it for fetch — " +
        "upgrade to Node 24+, or unset the proxy variables"
    );
    return;
  }

  const result = spawnSync(process.execPath, ["--use-env-proxy", ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, MANUS_PROXY_BOOTSTRAPPED: "1", NODE_USE_ENV_PROXY: "1" },
  });
  process.exit(result.status ?? 1);
}

async function api(path, { method = "GET", query, body } = {}) {
  if (!API_KEY) {
    fail("MANUS_API_KEY is not set. Export your Manus API key first.");
  }

  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "x-manus-api-key": API_KEY,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      fail(`request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
    }
    const cause = error?.cause?.message ? ` (${error.cause.message})` : "";
    fail(`network error on ${method} ${path}: ${error?.message ?? error}${cause}`);
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data.ok === false) {
    const err = data?.error ?? {};
    fail(
      `${method} ${path} failed [HTTP ${response.status}]` +
        `${err.code ? ` ${err.code}` : ""}: ${err.message ?? text.slice(0, 300)}`
    );
  }

  return data;
}

/**
 * Decide whether polling should stop.
 * `stopped` is NOT sufficient on its own — background jobs may still be running.
 */
export function classify(task) {
  const status = task?.status;

  if (status === "error") return { done: true, reason: "error" };
  if (status === "waiting") return { done: true, reason: "waiting" };
  if (status === "stopped") {
    if (task.has_running_background_jobs === true) {
      return { done: false, reason: "stopped, background jobs still running" };
    }
    if (task.has_running_background_jobs === undefined) {
      note("has_running_background_jobs is absent — state unknown, treating task as finished");
    }
    return { done: true, reason: "stopped" };
  }
  return { done: false, reason: status ?? "unknown" };
}

async function getTask(taskId) {
  const data = await api("/v2/task.detail", { query: { task_id: taskId } });
  return data.task ?? data;
}

async function waitForCompletion(taskId, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let previous = "";

  while (Date.now() < deadline) {
    const task = await getTask(taskId);
    const { done, reason } = classify(task);

    if (reason !== previous) {
      note(reason);
      previous = reason;
    }

    if (done) return { task, reason };

    await sleep(intervalMs);
  }

  fail(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for task ${taskId}`);
}

export function eventText(event) {
  return event?.content ?? event?.payload?.content ?? event?.text ?? null;
}

async function fetchResult(taskId, { verbose = false } = {}) {
  const events = [];
  let cursor;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await api("/v2/task.listMessages", {
      query: {
        task_id: taskId,
        order: "asc",
        limit: 200,
        cursor,
        ...(verbose ? { verbose: true } : {}),
      },
    });

    events.push(...(data.messages ?? []));
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  const assistant = events.filter((event) => event.type === "assistant_message");
  const finals = assistant.filter((event) => event.delivery_kind === "result");
  const chosen = finals.length > 0 ? finals : assistant.slice(-1);

  return {
    text: chosen.map(eventText).filter(Boolean).join("\n\n---\n\n").trim(),
    structured: events
      .filter((event) => event.type === "structured_output_result")
      .map((event) => event.structured_output ?? event.payload ?? null)
      .filter(Boolean),
    errors: events
      .filter((event) => event.type === "error_message")
      .map(eventText)
      .filter(Boolean),
    eventCount: events.length,
  };
}

export function parseFlags(argv) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const [rawKey, inlineValue] = token.slice(2).split("=");
    if (inlineValue !== undefined) {
      addFlag(flags, rawKey, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      addFlag(flags, rawKey, next);
      i++;
    } else {
      addFlag(flags, rawKey, true);
    }
  }

  return { flags, positional };
}

function addFlag(flags, key, value) {
  flags[key] = key in flags ? [].concat(flags[key], value) : value;
}

export function asArray(value) {
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Infer the account tier from a usage.availableCredits payload. The API never
 * names a plan: `refresh_interval` / `max_refresh_credits` are present only for
 * personal accounts, and `pro_monthly_credits` is 0 for non-VIP.
 */
export function describeAccount(payload) {
  const credits = payload?.data ?? payload ?? {};
  const isPersonal =
    credits.refresh_interval !== undefined || credits.max_refresh_credits !== undefined;

  return {
    kind: isPersonal ? "personal" : "team-or-enterprise",
    vip: Number(credits.pro_monthly_credits ?? 0) > 0,
    ...(isPersonal
      ? {
          refreshInterval: credits.refresh_interval,
          refreshCredits: credits.refresh_credits,
          maxRefreshCredits: credits.max_refresh_credits,
        }
      : {}),
  };
}

/**
 * The API silently downgrades free personal accounts to `lite` whatever
 * `agent_profile` was requested, so a task can run weaker than asked for without
 * any error. Returns the profile actually in use when it differs, else null.
 */
export function profileDowngrade(requested, actual) {
  if (!requested || !actual) return null;
  const want = String(requested);
  if (want === "standard") {
    return /-(lite|max)$/.test(actual) ? actual : null;
  }
  return actual.endsWith(`-${want}`) ? null : actual;
}

/**
 * Build a message.content value. Manus accepts either a plain string or an array
 * of ContentPart objects; files are referenced as {type: "file", file_id}.
 */
export function buildContent(prompt, fileIds = []) {
  if (fileIds.length === 0) return prompt;
  return [
    { type: "text", text: prompt },
    ...fileIds.map((fileId) => ({ type: "file", file_id: fileId })),
  ];
}

/**
 * Upload one local file with the two-step v2 flow: create a file record, then
 * PUT the bytes to the presigned URL it returns (which expires in 3 minutes).
 * Returns the file_id to reference from message.content.
 */
async function uploadFile(filePath) {
  const name = basename(filePath);

  if (BLOCKED_UPLOAD_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    fail(`cannot attach ${name}: the API rejects executable and script types`);
  }

  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    fail(`cannot read --attach ${filePath}: ${error?.message ?? error}`);
  }
  if (!info.isFile()) fail(`--attach ${filePath} is not a regular file`);
  if (info.size > MAX_UPLOAD_BYTES) {
    fail(`--attach ${filePath} is ${info.size} bytes, over the 512 MB per-file limit`);
  }

  const created = await api("/v2/file.upload", { method: "POST", body: { filename: name } });
  const fileId = created.file?.id;
  const uploadUrl = created.upload_url;
  if (!fileId || !uploadUrl) fail(`file.upload returned no usable id or url for ${name}`);

  const bytes = await readFile(filePath);
  let response;
  try {
    response = await fetch(uploadUrl, {
      method: "PUT",
      body: bytes,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    fail(`upload of ${name} failed: ${error?.message ?? error}`);
  }
  if (!response.ok) fail(`upload of ${name} failed [HTTP ${response.status}]`);

  return fileId;
}

async function uploadAttachments(paths) {
  const ids = [];
  for (const filePath of paths) {
    ids.push(await uploadFile(filePath));
    note(`attached ${basename(filePath)}`);
  }
  return ids;
}

/** Already-uploaded ids first, then anything that needs uploading now. */
async function resolveFileIds(flags) {
  const existing = asArray(flags["file-id"]).map(String);
  const uploaded = await uploadAttachments(asArray(flags.attach));
  return [...existing, ...uploaded];
}

function buildCreateBody(flags, fileIds = []) {
  const prompt = flags.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    fail("--prompt is required and must be a non-empty string");
  }

  const message = { content: buildContent(prompt, fileIds) };
  const connectors = asArray(flags.connector);
  if (connectors.length > 0) message.connectors = connectors;

  const body = { message };
  if (flags.project) body.project_id = String(flags.project);
  if (flags.locale) body.locale = String(flags.locale);
  if (flags.title) body.title = String(flags.title);
  if (flags.visibility) body.share_visibility = String(flags.visibility);
  if (flags.profile) body.agent_profile = String(flags.profile);
  if (flags.interactive) body.interactive_mode = true;

  if (flags.schema) {
    try {
      body.structured_output_schema = JSON.parse(readFileSync(String(flags.schema), "utf8"));
    } catch (error) {
      fail(`could not read --schema file: ${error?.message ?? error}`);
    }
  }

  return body;
}

function requireTaskId(positional, command) {
  const taskId = positional[0];
  if (!taskId) fail(`${command} requires a <task_id>`);
  return taskId;
}

function printTaskSummary(created) {
  const lines = [
    `task_id:  ${created.task_id}`,
    `task_url: ${created.task_url}`,
  ];
  if (created.task_title) lines.push(`title:    ${created.task_title}`);
  if (created.share_url) lines.push(`share_url: ${created.share_url}`);
  process.stdout.write(lines.join("\n") + "\n");
}

function numberFlag(flags, name, fallback) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`--${name} must be a positive number`);
  return value;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  ensureProxySupport();

  const { flags, positional } = parseFlags(rest);
  const asJson = Boolean(flags.json);

  switch (command) {
    case "create": {
      const fileIds = await resolveFileIds(flags);
      const created = await api("/v2/task.create", { method: "POST", body: buildCreateBody(flags, fileIds) });
      if (asJson) process.stdout.write(JSON.stringify(created, null, 2) + "\n");
      else printTaskSummary(created);
      return;
    }

    case "run": {
      const fileIds = await resolveFileIds(flags);
      const created = await api("/v2/task.create", { method: "POST", body: buildCreateBody(flags, fileIds) });
      note(`created ${created.task_id}`);

      const { task, reason } = await waitForCompletion(created.task_id, {
        timeoutMs: numberFlag(flags, "timeout-sec", DEFAULT_WAIT_MS / 1000) * 1000,
        intervalMs: numberFlag(flags, "interval-sec", DEFAULT_INTERVAL_MS / 1000) * 1000,
      });

      const downgraded = profileDowngrade(flags.profile, task?.agent_profile);
      if (downgraded) {
        note(
          `requested agent_profile "${flags.profile}" but the task runs as "${downgraded}" — ` +
            "free personal accounts are downgraded to lite"
        );
      }

      const result = await fetchResult(created.task_id, { verbose: Boolean(flags.verbose) });

      if (asJson) {
        process.stdout.write(JSON.stringify({ task, created, ...result }, null, 2) + "\n");
        return;
      }

      if (reason === "error") {
        fail(`task ended with an error: ${result.errors.join("; ") || "no error message returned"}`);
      }
      if (reason === "waiting") {
        note("agent is waiting for human input — reply in the Manus webapp or use `send`");
      }
      if (result.structured.length > 0) {
        process.stdout.write(
          "--- structured output ---\n" + JSON.stringify(result.structured, null, 2) + "\n"
        );
      }
      process.stdout.write((result.text || "(no output text)") + "\n");
      return;
    }

    case "status": {
      const task = await getTask(requireTaskId(positional, "status"));
      if (asJson) process.stdout.write(JSON.stringify(task, null, 2) + "\n");
      else {
        process.stdout.write(
          [
            `status:    ${task.status}`,
            `title:     ${task.title ?? "(none)"}`,
            `task_url:  ${task.task_url ?? ""}`,
            `agent profile: ${task.agent_profile ?? "unknown"}`,
            `background jobs running: ${task.has_running_background_jobs ?? "unknown"}`,
            `credits used: ${task.credit_usage ?? 0}`,
          ].join("\n") + "\n"
        );
      }
      return;
    }

    case "wait": {
      const { task, reason } = await waitForCompletion(requireTaskId(positional, "wait"), {
        timeoutMs: numberFlag(flags, "timeout-sec", DEFAULT_WAIT_MS / 1000) * 1000,
        intervalMs: numberFlag(flags, "interval-sec", DEFAULT_INTERVAL_MS / 1000) * 1000,
      });
      if (task?.agent_profile) note(`agent profile: ${task.agent_profile}`);
      if (reason === "waiting") note("agent is waiting for human input");
      if (reason === "error") fail("task ended with an error");
      if (asJson) process.stdout.write(JSON.stringify(task, null, 2) + "\n");
      else process.stdout.write(`finished: ${reason}\n`);
      return;
    }

    case "result": {
      const taskId = requireTaskId(positional, "result");
      const result = await fetchResult(taskId, { verbose: Boolean(flags.verbose) });
      if (asJson) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      else process.stdout.write((result.text || "(no output yet)") + "\n");
      return;
    }

    case "send": {
      const taskId = requireTaskId(positional, "send");
      const prompt = flags.prompt;
      if (typeof prompt !== "string" || prompt.length === 0) fail("--prompt is required");
      const fileIds = await resolveFileIds(flags);
      const sent = await api("/v2/task.sendMessage", {
        method: "POST",
        body: { task_id: taskId, message: { content: buildContent(prompt, fileIds) } },
      });
      process.stdout.write(JSON.stringify(sent, null, 2) + "\n");
      return;
    }

    case "list": {
      const listed = await api("/v2/task.list", {
        query: { limit: numberFlag(flags, "limit", 20) },
      });
      process.stdout.write(JSON.stringify(listed, null, 2) + "\n");
      return;
    }

    case "stop": {
      const stopped = await api("/v2/task.stop", {
        method: "POST",
        body: { task_id: requireTaskId(positional, "stop") },
      });
      process.stdout.write(JSON.stringify(stopped, null, 2) + "\n");
      return;
    }

    case "upload": {
      const filePath = positional[0];
      if (!filePath) fail("upload requires a <path>");
      const fileId = await uploadFile(filePath);
      if (asJson) {
        process.stdout.write(JSON.stringify({ file_id: fileId, path: filePath }, null, 2) + "\n");
      } else {
        process.stdout.write(`file_id: ${fileId}\n`);
      }
      return;
    }

    case "credits": {
      const payload = await api("/v2/usage.availableCredits");
      const credits = payload?.data ?? payload ?? {};
      const account = describeAccount(payload);

      if (asJson) {
        process.stdout.write(JSON.stringify({ ...payload, account }, null, 2) + "\n");
        return;
      }

      const lines = [
        `account:       ${account.kind}${account.vip ? " (VIP)" : " (non-VIP)"}`,
        `total credits: ${credits.total_credits ?? "?"}`,
        `free credits:  ${credits.free_credits ?? "?"}`,
      ];
      if (account.refreshInterval) {
        lines.push(
          `refresh:       ${account.refreshCredits ?? 0} / ${account.maxRefreshCredits ?? "?"}` +
            ` per ${account.refreshInterval}`
        );
      }
      if (account.kind === "personal" && !account.vip) {
        lines.push(
          "note:          free personal accounts run tasks as lite regardless of --profile"
        );
      }
      process.stdout.write(lines.join("\n") + "\n");
      return;
    }

    default:
      fail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => fail(error?.stack ?? String(error)));
}
