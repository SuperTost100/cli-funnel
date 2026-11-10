// Checks that every flag or subcommand cli-funnel depends on still shows up in the CLI's help output, and that the
// Codex app-server still takes the params providerOptions uses. The flag list is in drift-checks.mjs. Skips CLIs that
// are not installed, unless DRIFT_REQUIRE names them (comma-separated ids), in which case a missing CLI counts as a
// failure. Exits 1 when something disappeared.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { CHECKS } from "./drift-checks.mjs";

const required = (process.env.DRIFT_REQUIRE ?? "").split(",").map((s) => s.trim()).filter(Boolean);

let missing = 0;
const report = (what, where) => {
  console.log(`  MISSING ${what} in ${where}`);
  missing++;
};

/** Codex providerOptions become app-server params and config keys, not flags. Reads them from the generated schema. */
function checkCodexSchema() {
  const dir = mkdtempSync(join(tmpdir(), "cli-funnel-drift-"));
  try {
    const res = spawnSync("codex", ["app-server", "generate-json-schema", "--out", dir], { encoding: "utf8" });
    if (res.status !== 0) return report("generate-json-schema output", "codex app-server");
    const start = JSON.parse(readFileSync(join(dir, "v2", "ThreadStartParams.json"), "utf8"));
    for (const key of ["ephemeral", "approvalPolicy", "config"]) if (!start.properties?.[key]) report(key, "ThreadStartParams");
    const policies = JSON.stringify(start.definitions?.AskForApproval ?? {});
    for (const p of ["untrusted", "on-request", "never"]) if (!policies.includes(`"${p}"`)) report(`approval policy ${p}`, "AskForApproval");
    // Live sessions and the one-off calls: thread/list, thread/fork, account/rateLimits/read, feedback/upload and turn/interrupt.
    const schema = (name) => JSON.parse(readFileSync(join(dir, "v2", `${name}.json`), "utf8"));
    const list = schema("ThreadListParams");
    for (const key of ["cwd", "searchTerm", "limit", "cursor", "sortKey"]) if (!list.properties?.[key]) report(key, "ThreadListParams");
    if (!list.definitions?.ThreadSortKey?.enum?.includes("updated_at")) report("sort key updated_at", "ThreadSortKey");
    const fork = schema("ThreadForkParams");
    for (const key of ["threadId", "excludeTurns"]) if (!fork.properties?.[key]) report(key, "ThreadForkParams");
    if (!schema("ThreadForkResponse").properties?.thread) report("thread", "ThreadForkResponse");
    const threads = schema("ThreadListResponse");
    for (const key of ["data", "nextCursor"]) if (!threads.properties?.[key]) report(key, "ThreadListResponse");
    const thread = threads.definitions?.Thread?.properties ?? {};
    for (const key of ["id", "name", "preview", "cwd", "createdAt", "updatedAt", "forkedFromId"]) if (!thread[key]) report(key, "Thread");
    if (!schema("GetAccountRateLimitsResponse").properties?.rateLimits) report("rateLimits", "GetAccountRateLimitsResponse");
    for (const key of ["threadId", "turnId"]) if (!schema("TurnInterruptParams").properties?.[key]) report(key, "TurnInterruptParams");
    for (const key of ["classification", "reason", "threadId", "includeLogs"]) if (!schema("FeedbackUploadParams").properties?.[key]) report(key, "FeedbackUploadParams");
    if (!schema("FeedbackUploadResponse").properties?.threadId) report("threadId", "FeedbackUploadResponse");
    const methods = readFileSync(join(dir, "ClientRequest.json"), "utf8");
    for (const m of ["thread/list", "thread/fork", "account/rateLimits/read", "feedback/upload", "turn/interrupt", "turn/steer", "account/login/start", "account/read", "config/read"]) if (!methods.includes(`"${m}"`)) report(m, "ClientRequest");
    const bundle = JSON.parse(readFileSync(join(dir, "codex_app_server_protocol.v2.schemas.json"), "utf8"));
    if (!bundle.definitions?.Config?.properties?.web_search) report("web_search", "Config");
    const modes = bundle.definitions?.WebSearchMode?.enum ?? [];
    for (const m of ["disabled", "cached", "indexed", "live"]) if (!modes.includes(m)) report(`web search mode ${m}`, "WebSearchMode");
    // Agent features: questions, plans, file changes, the API key login and the account type.
    const defs = bundle.definitions ?? {};
    const top = (name) => JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
    const serverRequests = readFileSync(join(dir, "ServerRequest.json"), "utf8");
    for (const m of ["item/tool/requestUserInput", "mcpServer/elicitation/request"]) if (!serverRequests.includes(`"${m}"`)) report(m, "ServerRequest");
    const question = top("ToolRequestUserInputParams").definitions?.ToolRequestUserInputQuestion?.properties ?? {};
    for (const key of ["id", "header", "question", "isOther", "isSecret", "options"]) if (!question[key]) report(key, "ToolRequestUserInputQuestion");
    if (!top("ToolRequestUserInputResponse").properties?.answers) report("answers", "ToolRequestUserInputResponse");
    for (const key of ["plan", "explanation"]) if (!defs.TurnPlanUpdatedNotification?.properties?.[key]) report(key, "TurnPlanUpdatedNotification");
    for (const s of ["pending", "inProgress", "completed"]) if (!defs.TurnPlanStepStatus?.enum?.includes(s)) report(`plan step status ${s}`, "TurnPlanStepStatus");
    for (const key of ["path", "kind"]) if (!defs.FileUpdateChange?.properties?.[key]) report(key, "FileUpdateChange");
    if (!JSON.stringify(defs.PatchChangeKind ?? {}).includes('"move_path"')) report("move_path", "PatchChangeKind");
    for (const s of ["completed", "failed", "declined"]) if (!defs.PatchApplyStatus?.enum?.includes(s)) report(`patch status ${s}`, "PatchApplyStatus");
    if (!JSON.stringify(defs.LoginAccountParams ?? {}).includes('"apiKey"')) report("apiKey login", "LoginAccountParams");
    if (!defs.GetAccountResponse?.properties?.account) report("account", "GetAccountResponse");
    if (!defs.CliAuthCredentialsStoreMode?.enum?.includes("ephemeral")) report("ephemeral", "CliAuthCredentialsStoreMode");
    // Feature names cli-funnel switches. Codex ignores an unknown or removed key with a warning, so a rename would
    // show up as a warning on every run. TOOL_FEATURES is read from the source, so the list is kept in one place.
    const tools = readFileSync(new URL("../packages/cli-funnel/src/providers/codex/tools.ts", import.meta.url), "utf8");
    const names = [...(tools.match(/TOOL_FEATURES = \[([^\]]*)\]/)?.[1].match(/"(\w+)"/g) ?? []).map((n) => n.slice(1, -1)), "view_image", "default_mode_request_user_input"];
    const features = spawnSync("codex", ["features", "list"], { encoding: "utf8" });
    const stages = new Map((features.stdout ?? "").split("\n").map((l) => l.trim().split(/\s{2,}/)).filter((c) => c.length > 1).map((c) => [c[0], c[1]]));
    if (features.status !== 0 || !stages.size) report("feature list", "codex features list");
    else for (const n of names) if (!stages.has(n) || stages.get(n) === "removed") report(`feature ${n}`, "codex features list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Antigravity subagent transcripts are read from `<brain>/<conversation id>/.system_generated/logs/transcript.jsonl`,
 * and their tool calls are `PLANNER_RESPONSE` steps. agy has no command that prints the layout, so the binary is
 * searched for the names, in 16 MB pieces so a large binary is never read whole.
 */
function checkAgyTranscript(bin) {
  const dir = (process.env.PATH ?? "").split(delimiter).find((d) => d && existsSync(join(d, bin)));
  if (!dir) return report("the agy binary on PATH", "transcript check");
  const needles = [".system_generated", "transcript.jsonl", "PLANNER_RESPONSE", "brain"].map((n) => Buffer.from(n));
  const found = new Set();
  const fd = openSync(realpathSync(join(dir, bin)), "r");
  try {
    const size = 16 * 1024 * 1024;
    const overlap = Math.max(...needles.map((n) => n.length));
    const buf = Buffer.alloc(size + overlap);
    let kept = 0;
    for (;;) {
      const read = readSync(fd, buf, kept, size, null);
      if (!read) break;
      const chunk = buf.subarray(0, kept + read);
      for (const n of needles) if (chunk.includes(n)) found.add(n.toString());
      kept = Math.min(overlap, chunk.length);
      chunk.copy(buf, 0, chunk.length - kept);
    }
  } finally {
    closeSync(fd);
  }
  for (const n of needles) if (!found.has(n.toString())) report(n.toString(), "the agy binary (subagent transcripts)");
}

for (const [id, { bin, help }] of Object.entries(CHECKS)) {
  const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (version.error) {
    if (required.includes(id)) {
      console.log(`${id}: MISSING, "${bin}" is not installed but DRIFT_REQUIRE lists it`);
      missing++;
    } else {
      console.log(`${id}: not installed, skipped (its flags were not checked)`);
    }
    continue;
  }
  console.log(`${id}: ${(version.stdout + version.stderr).trim().split("\n")[0]}`);
  for (const [args, needles] of help) {
    const out = spawnSync(bin, args, { encoding: "utf8" });
    const text = out.stdout + out.stderr;
    for (const needle of needles) if (!text.includes(needle)) report(needle, `"${bin} ${args.join(" ")}"`);
  }
  if (id === "codex") checkCodexSchema();
  if (id === "antigravity") checkAgyTranscript(bin);
}
process.exit(missing ? 1 : 0);
