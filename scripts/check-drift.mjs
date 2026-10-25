// Checks that every flag or subcommand cli-funnel depends on still shows up in the CLI's help output, and that the
// Codex app-server still takes the params providerOptions uses. The flag list is in drift-checks.mjs. Skips CLIs that
// are not installed, unless DRIFT_REQUIRE names them (comma-separated ids), in which case a missing CLI counts as a
// failure. Exits 1 when something disappeared.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    // Live sessions and the thread calls: thread/list, thread/fork, account/rateLimits/read and turn/interrupt.
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
    const methods = readFileSync(join(dir, "ClientRequest.json"), "utf8");
    for (const m of ["thread/list", "thread/fork", "account/rateLimits/read", "turn/interrupt", "turn/steer", "account/login/start", "account/read"]) if (!methods.includes(`"${m}"`)) report(m, "ClientRequest");
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
}
process.exit(missing ? 1 : 0);
