import { fromManifest, loadManifest } from "../../catalog/manifest.js";
import type { ApprovalDecision, AuthStatus, FunnelEvent, ModelInfo, Provider, ProviderContext, RunInput } from "../../types.js";
import { Channel } from "../../util/channel.js";
import { exec, spawnStream } from "../../util/process.js";
import { detectInstallation, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { requireMachine } from "../../selection.js";
import { planAccess } from "./access.js";
import { toApprovalRequest, toReply, type ServerRequest } from "./approvals.js";
import { parseLoginStatus } from "./auth.js";
import { Translator } from "./events.js";
import { parseCatalog } from "./models.js";
import { RpcClient } from "./rpc.js";
import { threadOptions } from "./options.js";
import { noToolsConfig } from "./tools.js";
import { openCodexSession } from "./live.js";

export const BINARY = "codex";
const TESTED_RANGE = { min: "0.150.0" };

async function authStatus(): Promise<AuthStatus> {
  const path = findBinary(BINARY);
  if (!path) return { loggedIn: false, detail: "codex is not installed." };
  const res = await exec(path, ["login", "status"], { timeoutMs: 15_000 });
  return parseLoginStatus(res.stdout + res.stderr);
}

async function models(ctx?: ProviderContext): Promise<ModelInfo[]> {
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
  return fromManifest(await loadManifest(ctx?.manifestUrl), "codex");
}

export const INITIALIZE_PARAMS = {
  clientInfo: { name: "cli-funnel", title: null, version: "0.1.0" },
  capabilities: { experimentalApi: false, requestAttestation: false },
};

/** Settings for `thread/start` and `thread/resume`, with `providerOptions.codex` applied. */
export async function threadSettings(path: string, input: RunInput) {
  const sel = input.selection;
  const machine = requireMachine(sel);
  const plan = planAccess(machine.access);
  const extra = threadOptions(input);
  return {
    model: sel.model,
    cwd: sel.cwd,
    approvalPolicy: extra.approvalPolicy ?? plan.approvalPolicy,
    approvalsReviewer: plan.approvalsReviewer,
    sandbox: plan.sandbox,
    ...(sel.fast ? { serviceTier: "priority" } : {}),
    ...(input.system ? { developerInstructions: input.system } : {}),
    ...(sel.access === "none" ? { config: await noToolsConfig(path, machine.cwd, input.env) } : {}),
    ...(sel.access !== "none" && Object.keys(extra.config).length ? { config: extra.config } : {}),
  };
}

/** Params only `thread/start` takes. `thread/resume` refuses them, so `threadOptions` rejects them with a session id. */
export const threadStartParams = (input: RunInput) => threadOptions(input).start;

/** Params for `turn/start`: the prompt, its images, and the per-turn settings. */
export function turnParams(input: RunInput, threadId: string) {
  return {
    threadId,
    input: [
      ...(input.attachments ?? []).map((a) => ({ type: "image", url: `data:${a.mediaType};base64,${a.data}` })),
      { type: "text", text: input.prompt, text_elements: [] },
    ],
    ...(input.selection.effort ? { effort: input.selection.effort } : {}),
    ...(input.responseSchema ? { outputSchema: input.responseSchema.schema } : {}),
  };
}

/**
 * The answer to one approval request. Levels below `supervised` answer without asking. Otherwise `push` gets the
 * `approval.request` event and the caller's `onApproval` decides.
 */
export async function decideApproval(
  req: ServerRequest,
  input: RunInput,
  items: Map<string, unknown>,
  push: (e: FunnelEvent) => void,
): Promise<ApprovalDecision> {
  const access = input.selection.access;
  if (access === "none") return "deny";
  if (req.method === "item/fileChange/requestApproval" && planAccess(requireMachine(input.selection).access).autoAllowFileChanges) return "allow";
  if (access === "full") return "allow";
  const request = toApprovalRequest(req, items);
  if (!request) return "deny";
  push({ type: "approval.request", request });
  if (!input.onApproval) return "deny";
  try {
    return await input.onApproval(request);
  } catch {
    return "deny";
  }
}

async function* run(input: RunInput): AsyncGenerator<FunnelEvent> {
  const path = findBinary(BINARY);
  if (!path) {
    yield { type: "error", message: "codex is not installed.", code: "not-installed" };
    return;
  }
  const sel = input.selection;
  requireMachine(sel);
  // Refuses options that would widen access before a process starts.
  const start = threadStartParams(input);
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
    proc.kill();
  };

  const decide = (req: ServerRequest) => decideApproval(req, input, translator?.items ?? new Map(), (e) => out.push(e));

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
      await rpc.request("initialize", INITIALIZE_PARAMS);
      rpc.notify("initialized");
      const settings = await threadSettings(path, input);
      const started = input.sessionId
        ? await rpc.request("thread/resume", { threadId: input.sessionId, ...settings })
        : await rpc.request("thread/start", { ...settings, ...start });
      threadId = started.thread.id as string;
      translator = new Translator(threadId);
      out.push({ type: "session", sessionId: threadId, model: started.model });
      const res = await rpc.request("turn/start", turnParams(input, threadId));
      turnId ??= res?.turn?.id;
    } catch (e) {
      finish([{ type: "error", message: e instanceof Error ? e.message : String(e), code: "cli-failed" }]);
    }
  })();

  try {
    yield* out;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    proc.kill();
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
  login: (options) =>
    // `codex login` opens the browser itself; the device-code flow only prints the page.
    spawnLogin(BINARY, options?.device ? ["login", "--device-auth"] : ["login"], authStatus, {
      signal: options?.signal,
      opensBrowser: !options?.device,
    }),
  logout: () => runLogout(BINARY, ["logout"]),
  update: () => runUpdate(BINARY, ["update"]),
  models,
  run,
  openSession: openCodexSession,
};
