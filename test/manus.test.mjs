import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  asArray,
  buildContent,
  classify,
  describeAccount,
  eventText,
  parseFlags,
  profileDowngrade,
} from "../skills/manus/scripts/manus.mjs";

describe("classify", () => {
  test("running is not done", () => {
    assert.equal(classify({ status: "running" }).done, false);
  });

  test("stopped with background jobs still running is NOT done", () => {
    const result = classify({ status: "stopped", has_running_background_jobs: true });
    assert.equal(result.done, false);
  });

  test("stopped with no background jobs is done", () => {
    const result = classify({ status: "stopped", has_running_background_jobs: false });
    assert.equal(result.done, true);
    assert.equal(result.reason, "stopped");
  });

  test("stopped with the field absent is treated as done", () => {
    assert.equal(classify({ status: "stopped" }).done, true);
  });

  test("waiting is terminal but flagged for a human", () => {
    const result = classify({ status: "waiting" });
    assert.equal(result.done, true);
    assert.equal(result.reason, "waiting");
  });

  test("error is terminal", () => {
    assert.equal(classify({ status: "error" }).done, true);
    assert.equal(classify({ status: "error" }).reason, "error");
  });

  test("an unrecognised status keeps polling", () => {
    assert.equal(classify({ status: "something-new" }).done, false);
  });

  test("a missing task keeps polling", () => {
    assert.equal(classify(undefined).done, false);
    assert.equal(classify({}).done, false);
  });
});

describe("parseFlags", () => {
  test("parses --key value", () => {
    const { flags } = parseFlags(["--prompt", "hello world"]);
    assert.equal(flags.prompt, "hello world");
  });

  test("parses --key=value", () => {
    const { flags } = parseFlags(["--prompt=hello world"]);
    assert.equal(flags.prompt, "hello world");
  });

  test("a bare flag becomes true", () => {
    const { flags } = parseFlags(["--interactive"]);
    assert.equal(flags.interactive, true);
  });

  test("a repeated flag collects into an array", () => {
    const { flags } = parseFlags(["--connector", "gmail", "--connector", "notion"]);
    assert.deepEqual(flags.connector, ["gmail", "notion"]);
  });

  test("collects positional arguments", () => {
    const { positional } = parseFlags(["task123"]);
    assert.deepEqual(positional, ["task123"]);
  });

  test("does not consume a following flag as a value", () => {
    const { flags, positional } = parseFlags(["--interactive", "--prompt", "x"]);
    assert.equal(flags.interactive, true);
    assert.equal(flags.prompt, "x");
    assert.deepEqual(positional, []);
  });
});

describe("eventText", () => {
  test("reads top-level content", () => {
    assert.equal(eventText({ content: "a" }), "a");
  });

  test("falls back to payload.content", () => {
    assert.equal(eventText({ payload: { content: "b" } }), "b");
  });

  test("falls back to text", () => {
    assert.equal(eventText({ text: "c" }), "c");
  });

  test("returns null when there is no text", () => {
    assert.equal(eventText({}), null);
    assert.equal(eventText(undefined), null);
  });
});

describe("buildContent", () => {
  test("returns a plain string when nothing is attached", () => {
    assert.equal(buildContent("summarise the report"), "summarise the report");
    assert.equal(buildContent("summarise the report", []), "summarise the report");
  });

  test("builds a text part plus one file part per attachment", () => {
    assert.deepEqual(buildContent("summarise this", ["file_abc", "file_def"]), [
      { type: "text", text: "summarise this" },
      { type: "file", file_id: "file_abc" },
      { type: "file", file_id: "file_def" },
    ]);
  });
});

describe("describeAccount", () => {
  test("infers a personal account from the personal-only fields", () => {
    const account = describeAccount({
      total_credits: 1218,
      refresh_interval: "daily",
      refresh_credits: 288,
      max_refresh_credits: 300,
    });
    assert.equal(account.kind, "personal");
    assert.equal(account.vip, false);
    assert.equal(account.refreshInterval, "daily");
  });

  test("treats a non-zero pro_monthly_credits as VIP", () => {
    assert.equal(describeAccount({ pro_monthly_credits: 500, refresh_interval: "daily" }).vip, true);
  });

  test("reads through a data wrapper", () => {
    assert.equal(describeAccount({ ok: true, data: { refresh_interval: "daily" } }).kind, "personal");
  });

  test("reports team-or-enterprise when the personal fields are absent", () => {
    assert.equal(describeAccount({ total_credits: 10 }).kind, "team-or-enterprise");
  });

  test("does not crash on a missing payload", () => {
    assert.equal(describeAccount(undefined).kind, "team-or-enterprise");
  });
});

describe("profileDowngrade", () => {
  test("flags standard silently downgraded to lite", () => {
    assert.equal(profileDowngrade("standard", "manus-1.6-lite"), "manus-1.6-lite");
  });

  test("accepts standard running as plain manus-1.6", () => {
    assert.equal(profileDowngrade("standard", "manus-1.6"), null);
  });

  test("flags lite requested while standard actually ran", () => {
    assert.equal(profileDowngrade("lite", "manus-1.6"), "manus-1.6");
  });

  test("accepts lite running as lite", () => {
    assert.equal(profileDowngrade("lite", "manus-1.6-lite"), null);
  });

  test("returns null when either side is unknown", () => {
    assert.equal(profileDowngrade(undefined, "manus-1.6-lite"), null);
    assert.equal(profileDowngrade("standard", undefined), null);
  });
});

describe("asArray", () => {
  test("undefined becomes an empty array", () => {
    assert.deepEqual(asArray(undefined), []);
  });

  test("a bare flag (true) becomes an empty array", () => {
    assert.deepEqual(asArray(true), []);
  });

  test("a single value is wrapped", () => {
    assert.deepEqual(asArray("x"), ["x"]);
  });

  test("an array passes through", () => {
    assert.deepEqual(asArray(["x", "y"]), ["x", "y"]);
  });
});
