import { FunnelError, type FeedbackReport, type Limit, type ListThreadsOptions, type ProcessOptions, type RateLimits, type ThreadInfo, type ThreadPage, type UsageWindow } from "../../types.js";
import { spawnStream } from "../../util/process.js";
import { findBinary, stderrTail } from "../base.js";
import { checkFeedbackReport } from "../feedback.js";
import { snapshotLimit } from "./events.js";
import { BINARY, INITIALIZE_PARAMS } from "./index.js";
import { RpcClient } from "./rpc.js";

type Json = Record<string, any>;

const CALL_TIMEOUT_MS = 30_000;
// With logs, Codex gathers its log database, the saved conversation and a diagnostics report before it uploads.
const FEEDBACK_TIMEOUT_MS = 120_000;
// `account/read` answers about 260 ms after `initialize`. `authStatus` falls back to `codex login status` when it takes longer.
const ACCOUNT_TIMEOUT_MS = 3_000;

/** A `Thread` from `thread/list` or `thread/fork`. Times are Unix seconds on the wire. */
export function parseThread(t: Json): ThreadInfo {
  return {
    provider: "codex",
    sessionId: String(t.id),
    title: (typeof t.name === "string" && t.name) || (typeof t.preview === "string" ? t.preview : ""),
    ...(typeof t.cwd === "string" ? { cwd: t.cwd } : {}),
    createdAt: Number(t.createdAt) * 1000,
    updatedAt: Number(t.updatedAt) * 1000,
    ...(typeof t.forkedFromId === "string" ? { forkedFrom: t.forkedFromId } : {}),
  };
}

/** The result of `thread/list`. */
export function parseThreadPage(result: Json): ThreadPage {
  const data: Json[] = Array.isArray(result?.data) ? result.data : [];
  return { threads: data.map(parseThread), ...(typeof result?.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}) };
}

function window(w: Json | null | undefined): UsageWindow | undefined {
  if (!w || typeof w.usedPercent !== "number") return undefined;
  return {
    usedPercent: w.usedPercent,
    ...(typeof w.windowDurationMins === "number" ? { windowMinutes: w.windowDurationMins } : {}),
    ...(typeof w.resetsAt === "number" ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() } : {}),
  };
}

/** The result of `account/rateLimits/read`. `limit` is set when a window is full, by the rule the `limit` event uses. */
export function parseRateLimits(result: Json): RateLimits {
  const snapshot: Json | undefined = result?.rateLimits;
  const reached = snapshotLimit(snapshot)[0];
  const limit: Limit | undefined = reached && { kind: reached.kind, detail: reached.detail, ...(reached.resetAt ? { resetAt: reached.resetAt } : {}) };
  const primary = window(snapshot?.primary);
  const secondary = window(snapshot?.secondary);
  return {
    provider: "codex",
    ...(typeof snapshot?.planType === "string" ? { plan: snapshot.planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(limit ? { limit } : {}),
  };
}

/** Starts `codex app-server`, makes one request and stops it. For calls that need no running turn. */
async function call(method: string, params: unknown, options: ProcessOptions = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<Json> {
  const path = findBinary(BINARY);
  if (!path) throw new FunnelError("codex is not installed.", "not-installed");
  const proc = spawnStream(path, ["app-server"], { env: options.env, signal: options.signal });
  // Nothing here answers server requests, so any that arrive are refused.
  const rpc = new RpcClient(proc, {
    notification() {},
    request: (id) => rpc.respond(id, { error: { code: -32601, message: "cli-funnel does not answer requests here." } }),
    closed() {},
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const answer = (async () => {
      await rpc.request("initialize", INITIALIZE_PARAMS);
      rpc.notify("initialized");
      return (await rpc.request(method, params)) as Json;
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Codex did not answer ${method} in time.`)), timeoutMs);
    });
    return await Promise.race([answer, timeout]);
  } catch (e) {
    if (options.signal?.aborted) throw new FunnelError("The request was aborted.", "aborted");
    const err = stderrTail(proc.stderr());
    throw new FunnelError(`${method} failed: ${e instanceof Error ? e.message : String(e)}${err ? ` ${err}` : ""}`, "cli-failed");
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

export async function listThreads(options: ListThreadsOptions = {}): Promise<ThreadPage> {
  const result = await call(
    "thread/list",
    {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.search ? { searchTerm: options.search } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      // Newest first, by the last message rather than by the day the thread started.
      sortKey: "updated_at",
    },
    options,
  );
  return parseThreadPage(result);
}

/** `thread/fork` copies the saved history into a new thread. Codex writes it to disk before it answers. */
export async function forkThread(sessionId: string, options: ProcessOptions = {}): Promise<string> {
  const result = await call("thread/fork", { threadId: sessionId, excludeTurns: true }, options);
  const id = result?.thread?.id;
  if (typeof id !== "string") throw new FunnelError("thread/fork answered without a thread id.", "cli-failed");
  return id;
}

/** The answer to `account/read` without a token refresh. It holds the account's email, so callers keep only what they need. */
export async function readAccount(timeoutMs = ACCOUNT_TIMEOUT_MS): Promise<Json> {
  return call("account/read", { refreshToken: false }, {}, timeoutMs);
}

export async function rateLimits(options: ProcessOptions = {}): Promise<RateLimits> {
  return parseRateLimits(await call("account/rateLimits/read", null, options));
}

/** The params of `feedback/upload`. Blank reasons and unset fields stay out. */
export function feedbackParams(report: FeedbackReport): Json {
  checkFeedbackReport(report);
  const reason = report.reason?.trim();
  return {
    classification: report.classification,
    ...(reason ? { reason } : {}),
    ...(report.sessionId ? { threadId: report.sessionId } : {}),
    includeLogs: report.includeLogs === true,
  };
}

/** The result of `feedback/upload`. `threadId` is the id Codex filed the report under. */
export function parseFeedback(result: Json): string {
  const id = result?.threadId;
  if (typeof id !== "string" || !id) throw new FunnelError("feedback/upload answered without a report id.", "cli-failed");
  return id;
}

/**
 * `feedback/upload` sends the report to OpenAI, the same request the TUI's `/feedback` makes. After a timeout or an
 * exit before the answer, the report may still have reached OpenAI, so a retry can send it twice.
 */
export async function sendFeedback(report: FeedbackReport, options: ProcessOptions = {}): Promise<string> {
  const params = feedbackParams(report);
  return parseFeedback(await call("feedback/upload", params, options, FEEDBACK_TIMEOUT_MS));
}
