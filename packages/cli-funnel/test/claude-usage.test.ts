import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFunnel } from "../src/funnel.js";
import { readUsage } from "../src/providers/claude/index.js";
import { fakeNodeCli } from "./fake-cli.js";

// Lets one test look for a CLI that is not installed, on a machine that has it.
let hidden = false;
vi.mock("../src/util/process.js", async (original) => {
  const real = await original<typeof import("../src/util/process.js")>();
  return { ...real, resolveBinary: (...args: Parameters<typeof real.resolveBinary>) => (hidden ? undefined : real.resolveBinary(...args)) };
});

// A fake `claude` for `rateLimits`. FAKE_USAGE says what it does with the request: `answer` replies with the recorded
// get-usage.json, `error` replies with an error, `exit` exits without a reply, `hang` never replies. It logs argv, the
// request and one env value.
const FAKE_USAGE_CLAUDE = `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.319 (Claude Code)"); process.exit(0); }
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, n));
    buf = buf.slice(n + 1);
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, request: m, marker: process.env.FAKE_MARKER ?? null }) + "\\n");
    const mode = process.env.FAKE_USAGE;
    if (mode === "exit") process.exit(3);
    if (mode === "hang") continue;
    const reply = mode === "error"
      ? { type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Unsupported control request subtype: get_usage" } }
      : JSON.parse(fs.readFileSync(process.env.FAKE_FIXTURE, "utf8"));
    if (mode !== "error") reply.response.request_id = m.request_id;
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\\n" + JSON.stringify(reply) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

describe("claude rateLimits (fake CLI)", () => {
  let dir: string;
  const logged = () => readFileSync(join(dir, "log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const mode = (m: string) => {
    process.env.FAKE_USAGE = m;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-claude-usage-"));
    process.env.CLI_FUNNEL_CLAUDE_BIN = fakeNodeCli(join(dir, "claude"), FAKE_USAGE_CLAUDE);
    process.env.FAKE_LOG = join(dir, "log");
    process.env.FAKE_FIXTURE = fileURLToPath(new URL("./fixtures/claude/get-usage.json", import.meta.url));
    mode("answer");
  });

  afterEach(() => {
    hidden = false;
    for (const k of ["CLI_FUNNEL_CLAUDE_BIN", "FAKE_LOG", "FAKE_FIXTURE", "FAKE_USAGE"]) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends get_usage with no model turn and maps the answer, through funnel.rateLimits", async () => {
    const usage = await createFunnel().rateLimits("claude", { env: { FAKE_MARKER: "from-options" } });
    expect(usage).toEqual({
      provider: "claude",
      plan: "max",
      primary: { usedPercent: 23, windowMinutes: 300, resetsAt: "2026-11-10T00:40:00.921Z" },
      secondary: { usedPercent: 6, windowMinutes: 10080, resetsAt: "2026-11-12T14:00:00.921Z" },
    });
    const [call, ...rest] = logged();
    expect(rest).toEqual([]);
    expect(call.request).toMatchObject({ type: "control_request", request: { subtype: "get_usage", skip_behaviors: true } });
    // Nothing of the user's starts, and nothing is saved. No user message was written.
    expect(call.args).toEqual(expect.arrayContaining(["--tools", "--strict-mcp-config", "--setting-sources", "--no-session-persistence", "--input-format", "stream-json"]));
    expect(call.marker).toBe("from-options");
  });

  it("says unsupported when the CLI answers with an error, exits first or does not answer", async () => {
    mode("error");
    await expect(readUsage()).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("Unsupported control request subtype") });
    mode("exit");
    await expect(readUsage()).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("exited (3) without an answer") });
    mode("hang");
    await expect(readUsage({}, 300)).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("did not answer") });
  });

  it("stops the process on abort and says aborted", async () => {
    mode("hang");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await expect(readUsage({ signal: ac.signal })).rejects.toMatchObject({ code: "aborted" });
  });

  it("says not-installed when there is no binary", async () => {
    hidden = true;
    await expect(readUsage()).rejects.toMatchObject({ code: "not-installed" });
  });
});
