import type {
  ApprovalDecision,
  AuthStatus,
  FunnelEvent,
  LoginEvent,
  ModelInfo,
  ProviderId,
  PullEvent,
  RunInput,
  Selection,
  UpdateResult,
} from "../types.js";
import type { ProviderOverview } from "../funnel.js";
import { readSSE } from "../util/sse.js";

export interface ClientOptions {
  /** Where the handler is mounted, for example "/api/funnel" or "http://localhost:4747". */
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export type RunEvent = FunnelEvent | { type: "run"; runId: string };
export type LoginStreamEvent = LoginEvent | { type: "login"; loginId: string };

export interface DirListing {
  path: string;
  name: string;
  parent: string | null;
  dirs: string[];
}

/** Works in browsers, Node and edge runtimes. Talks to `createHandler` from "cli-funnel/server". */
export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const headers = (extra?: Record<string, string>) => ({
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...extra,
  });

  /** The handler answers `{ error: "text" }`. The OpenAI routes answer `{ error: { message } }`. */
  function errorMessage(body: unknown, status: number): string {
    const error = (body as { error?: unknown } | undefined)?.error;
    if (typeof error === "string") return error;
    const message = (error as { message?: unknown } | undefined)?.message;
    return typeof message === "string" ? message : `HTTP ${status}`;
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(base + path, { ...init, headers: headers({ "content-type": "application/json" }) });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A captive portal or a wrong baseUrl answers with HTML. An error status keeps its own message below.
      if (res.ok) throw new Error(`Expected JSON from ${base + path} but got something else (HTTP ${res.status}). Check baseUrl.`);
    }
    if (!res.ok) throw new Error(errorMessage(body, res.status));
    return body as T;
  }

  async function* events<T>(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
    const res = await doFetch(base + path, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      headers: headers({ "content-type": "application/json" }),
    });
    if (!res.ok || !res.body) throw new Error(errorMessage(await res.json().catch(() => ({})), res.status));
    for await (const frame of readSSE(res)) yield JSON.parse(frame.data) as T;
  }

  const post = (path: string, body: unknown = {}) => request<{ ok: boolean }>(path, { method: "POST", body: JSON.stringify(body) });

  return {
    providers: (signal?: AbortSignal) => request<ProviderOverview[]>("/providers", { signal }),
    models: (id: ProviderId, signal?: AbortSignal) => request<ModelInfo[]>(`/providers/${id}/models`, { signal }),
    authStatus: (id: ProviderId, signal?: AbortSignal) => request<AuthStatus>(`/providers/${id}/auth`, { signal }),
    logout: (id: ProviderId) => post(`/providers/${id}/logout`),
    update: (id: ProviderId) => request<UpdateResult>(`/providers/${id}/update`, { method: "POST", body: "{}" }),
    /** Streams `PullEvent`s on providers with `capabilities.manageModels`. */
    pullModel: (id: ProviderId, name: string, signal?: AbortSignal) => events<PullEvent>(`/providers/${id}/models/pull`, { name }, signal),
    deleteModel: (id: ProviderId, name: string) => post(`/providers/${id}/models/delete`, { name }),
    listDirs: (path?: string, signal?: AbortSignal) => request<DirListing>(`/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`, { signal }),

    /**
     * Streams login events. The first event is `{ type: "login", loginId }`. `device` asks for a device-code login
     * when the server runs on another machine.
     */
    login: (id: ProviderId, signal?: AbortSignal, options?: { device?: boolean }) =>
      events<LoginStreamEvent>(`/providers/${id}/login${options?.device ? "?device=1" : ""}`, {}, signal),
    sendLoginCode: (loginId: string, code: string) => post(`/logins/${loginId}/code`, { code }),
    cancelLogin: (loginId: string) => post(`/logins/${loginId}/cancel`),

    /** Streams run events. The first event is `{ type: "run", runId }`, needed to answer approvals. */
    run: (
      input: Pick<RunInput, "prompt" | "sessionId" | "system" | "attachments" | "responseSchema" | "maxOutputTokens"> & { selection: Selection },
      signal?: AbortSignal,
    ) =>
      events<RunEvent>("/run", input, signal),
    approve: (runId: string, approvalId: string, decision: ApprovalDecision) =>
      post(`/approvals/${runId}/${approvalId}`, { decision }),
    /** Stops a run on the server. The run's stream ends with `done` and `finishReason: "cancelled"`. */
    cancelRun: (runId: string) => post(`/runs/${encodeURIComponent(runId)}/cancel`),
  };
}

export type FunnelClient = ReturnType<typeof createClient>;
export type { ProviderOverview } from "../funnel.js";
export * from "../types.js";
