import { FunnelError, type AccessLevel, type AuthStatus, type Capabilities, type FunnelEvent, type Provider, type RunInput } from "../../types.js";
import { detectInstallation, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { fromManifest, loadManifest, mergeModels } from "../../catalog/manifest.js";
import { compareVersions, exec, spawnStream } from "../../util/process.js";
import { parseClaudeMessage } from "./parser.js";

const BIN = "claude";
const TESTED_RANGE = { min: "2.1.0" };

const PERMISSION_MODE: Record<AccessLevel, string> = {
  supervised: "manual",
  "accept-edits": "acceptEdits",
  auto: "auto",
  full: "bypassPermissions",
};

const capabilities: Capabilities = {
  access: ["supervised", "accept-edits", "auto", "full"],
  effort: true,
  contextWindow: false,
  fast: false,
  resume: true,
  approvals: true,
};

export function buildArgs(input: RunInput): string[] {
  const { selection } = input;
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", selection.model,
    "--permission-mode", PERMISSION_MODE[selection.access],
  ];
  if (selection.effort) args.push("--effort", selection.effort);
  // Without this flag the CLI denies anything that needs a prompt instead of asking.
  if (selection.access !== "full" && input.onApproval) args.push("--permission-prompt-tool", "stdio");
  if (input.sessionId) args.push("--resume", input.sessionId);
  return args;
}

async function* run(input: RunInput): AsyncGenerator<FunnelEvent> {
  const bin = findBinary(BIN);
  if (!bin) throw new FunnelError("Claude Code is not installed.", "not-installed");
  if (input.selection.access === "supervised" && !input.onApproval) {
    throw new FunnelError('Access "supervised" needs an onApproval handler.', "invalid-selection");
  }
  const proc = spawnStream(bin, buildArgs(input), { cwd: input.selection.cwd, env: input.env, signal: input.signal, closeStdin: false });
  proc.write(JSON.stringify({ type: "user", message: { role: "user", content: input.prompt } }));

  let finished = false;
  try {
    for await (const raw of proc.lines) {
      const msg = raw as Record<string, any>;
      if (msg.type === "control_request") {
        const req = msg.request ?? {};
        if (req.subtype !== "can_use_tool") {
          proc.write(JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unsupported request" } }));
          continue;
        }
        const request = { id: String(req.tool_use_id ?? msg.request_id), tool: String(req.tool_name), input: req.input, description: req.description };
        yield { type: "approval.request", request };
        const decision = await input.onApproval!(request);
        const response = decision === "allow" ? { behavior: "allow", updatedInput: req.input } : { behavior: "deny", message: "Denied by the user." };
        proc.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } }));
        continue;
      }
      for (const e of parseClaudeMessage(raw)) {
        if (e.type === "done" || e.type === "error") finished = true;
        yield e;
      }
      if (msg.type === "result") proc.closeStdin();
    }
  } finally {
    if (!finished) proc.child.kill("SIGTERM");
  }
  if (finished) return;
  await proc.exited;
  if (input.signal?.aborted) yield { type: "done", text: "", finishReason: "cancelled" };
  else yield { type: "error", message: proc.stderr().trim() || "Claude Code exited without a result.", code: "cli-failed" };
}

async function authStatus(): Promise<AuthStatus> {
  const bin = findBinary(BIN);
  if (!bin) return { loggedIn: false, detail: "Claude Code is not installed." };
  const res = await exec(bin, ["auth", "status"], { timeoutMs: 15_000 });
  try {
    const j = JSON.parse(res.stdout);
    return { loggedIn: j.loggedIn === true, method: j.authMethod, account: j.email, plan: j.subscriptionType };
  } catch {
    return { loggedIn: false, detail: (res.stderr || res.stdout).trim() || undefined };
  }
}

export const claudeProvider: Provider = {
  id: "claude",
  displayName: "Claude Code",
  binary: BIN,
  capabilities,
  detect: () => detectInstallation(BIN, TESTED_RANGE),
  authStatus,
  login: (options) => spawnLogin(BIN, ["auth", "login"], authStatus, { signal: options?.signal }),
  logout: () => runLogout(BIN, ["auth", "logout"]),
  update: () => runUpdate(BIN, ["update"]),
  async models() {
    const [manifest, install] = await Promise.all([loadManifest(), claudeProvider.detect()]);
    return mergeModels([], fromManifest(manifest, "claude", install.version, compareVersions));
  },
  run,
};
