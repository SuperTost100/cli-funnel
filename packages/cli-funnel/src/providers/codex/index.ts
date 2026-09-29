import { fromManifest, loadBundledManifest } from "../../catalog/manifest.js";
import type { ApprovalDecision, AuthStatus, FunnelEvent, ModelInfo, Provider, RunInput } from "../../types.js";
import { Channel } from "../../util/channel.js";
import { exec, spawnStream } from "../../util/process.js";
import { detectInstallation, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { planAccess } from "./access.js";
import { toApprovalRequest, toReply, type ServerRequest } from "./approvals.js";
import { parseLoginStatus } from "./auth.js";
import { Translator } from "./events.js";
import { parseCatalog } from "./models.js";
import { RpcClient } from "./rpc.js";
import { noToolsConfig } from "./tools.js";

const BINARY = "codex";
const TESTED_RANGE = { min: "0.150.0" };

async function authStatus(): Promise<AuthStatus> {
  const path = findBinary(BINARY);
  if (!path) return { loggedIn: false, detail: "codex is not installed." };
  const res = await exec(path, ["login", "status"], { timeoutMs: 15_000 });
  return parseLoginStatus(res.stdout + res.stderr);
}

async function models(): Promise<ModelInfo[]> {
  const path = findBinary(BINARY);
  if (path) {
    try {
      const res = await exec(path, ["debug", "models"], { timeoutMs: 20_000 });
      const live = res.code === 0 ? parseCatalog(res.stdout) : [];
      if (live.length) return live;
    } catch {
      /* fall back to the bundled list */
    }
  }
  return fromManifest(await loadBundledManifest(), "codex");
}

async function* run(input: RunInput): AsyncGenerator<FunnelEvent> {
  const path = findBinary(BINARY);
  if (!path) {
    yield { type: "error", message: "codex is not installed.", code: "not-installed" };
    return;
  }
  const sel = input.selection;
  const plan = planAccess(sel.access);
  const out = new Channel<FunnelEvent>();
  const proc = spawnStream(path, ["app-server"], { cwd: sel.cwd, env: input.env });
  let translator: Translator | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let finished = false;

  const finish = (events: FunnelEvent[]) => {
    if (finished) return;
    finished = true;
    for (const e of events) out.push(e);
    out.end();
    proc.child.kill("SIGTERM");
  };

  const decide = async (req: ServerRequest): Promise<ApprovalDecision> => {
    if (sel.access === "none") return "deny";
    if (req.method === "item/fileChange/requestApproval" && plan.autoAllowFileChanges) return "allow";
    if (sel.access === "full") return "allow";
    const request = toApprovalRequest(req, translator?.items ?? new Map());
    if (!request) return "deny";
    out.push({ type: "approval.request", request });
    if (!input.onApproval) return "deny";
    try {
      return await input.onApproval(request);
    } catch {
      return "deny";
    }
  };

  const rpc = new RpcClient(proc, {
    notification(method, params) {
      if (!translator || finished) return;
      if (method === "turn/started" && params?.threadId === threadId) turnId = params.turn?.id;
      const t = translator.handle(method, params);
      if (t.finished) finish(t.events);
      else for (const e of t.events) out.push(e);
    },
    request(id, method, params) {
      const req: ServerRequest = { id, method, params: params ?? {} };
      if (!toApprovalRequest(req, translator?.items ?? new Map())) {
        rpc.respond(id, toReply(req, "deny"));
        return;
      }
      void decide(req).then((d) => rpc.respond(id, toReply(req, d)));
    },
    closed() {
      const err = proc.stderr().trim().split("\n").slice(-3).join(" ");
      finish([{ type: "error", message: `Codex app-server exited early.${err ? ` ${err}` : ""}` }]);
    },
  });

  const onAbort = () => {
    if (finished) return;
    if (threadId && turnId) {
      rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      setTimeout(() => finish([{ type: "done", text: "", finishReason: "cancelled" }]), 5000).unref();
    } else {
      finish([{ type: "done", text: "", finishReason: "cancelled" }]);
    }
  };
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });

  void (async () => {
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "cli-funnel", title: null, version: "0.1.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      rpc.notify("initialized");
      const settings = {
        model: sel.model,
        cwd: sel.cwd,
        approvalPolicy: plan.approvalPolicy,
        approvalsReviewer: plan.approvalsReviewer,
        sandbox: plan.sandbox,
        ...(sel.fast ? { serviceTier: "priority" } : {}),
        ...(input.system ? { developerInstructions: input.system } : {}),
        ...(sel.access === "none" ? { config: await noToolsConfig(path, sel.cwd) } : {}),
      };
      const started = input.sessionId
        ? await rpc.request("thread/resume", { threadId: input.sessionId, ...settings })
        : await rpc.request("thread/start", settings);
      threadId = started.thread.id as string;
      translator = new Translator(threadId);
      out.push({ type: "session", sessionId: threadId, model: started.model });
      const res = await rpc.request("turn/start", {
        threadId,
        input: [
          ...(input.attachments ?? []).map((a) => ({ type: "image", url: `data:${a.mediaType};base64,${a.data}` })),
          { type: "text", text: input.prompt, text_elements: [] },
        ],
        ...(sel.effort ? { effort: sel.effort } : {}),
        ...(input.responseSchema ? { outputSchema: input.responseSchema.schema } : {}),
      });
      turnId ??= res?.turn?.id;
    } catch (e) {
      finish([{ type: "error", message: e instanceof Error ? e.message : String(e), code: "cli-failed" }]);
    }
  })();

  try {
    yield* out;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    proc.child.kill("SIGTERM");
  }
}

export const codexProvider: Provider = {
  id: "codex",
  displayName: "Codex",
  binary: BINARY,
  capabilities: {
    access: ["none", "supervised", "accept-edits", "auto", "full"],
    effort: true,
    contextWindow: false,
    fast: true,
    resume: true,
    approvals: true,
    images: true,
    system: "native",
    schema: "native",
  },
  detect: () => detectInstallation(BINARY, TESTED_RANGE),
  authStatus,
  login: (options) => spawnLogin(BINARY, ["login", "--device-auth"], authStatus, { signal: options?.signal }),
  logout: () => runLogout(BINARY, ["logout"]),
  update: () => runUpdate(BINARY, ["update"]),
  models,
  run,
};
