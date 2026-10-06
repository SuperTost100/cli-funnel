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
  const base = options.baseUrl.replace(/\/$/, "");
  const headers = (extra?: Record<string, string>) => ({
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...extra,
  });

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(base + path, { ...init, headers: headers({ "content-type": "application/json" }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    return body as T;
  }

  async function* events<T>(path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<T> {
    const res = await doFetch(base + path, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
      headers: headers({ "content-type": "application/json" }),
    });
    if (!res.ok || !res.body) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 2);
        if (line.startsWith("data:")) yield JSON.parse(line.slice(5).trim()) as T;
      }
    }
  }

  const post = (path: string, body: unknown = {}) => request<{ ok: boolean }>(path, { method: "POST", body: JSON.stringify(body) });

  return {
    providers: () => request<ProviderOverview[]>("/providers"),
    models: (id: ProviderId) => request<ModelInfo[]>(`/providers/${id}/models`),
    authStatus: (id: ProviderId) => request<AuthStatus>(`/providers/${id}/auth`),
    logout: (id: ProviderId) => post(`/providers/${id}/logout`),
    update: (id: ProviderId) => request<UpdateResult>(`/providers/${id}/update`, { method: "POST", body: "{}" }),
    /** Streams `PullEvent`s on providers with `capabilities.manageModels`. */
    pullModel: (id: ProviderId, name: string, signal?: AbortSignal) => events<PullEvent>(`/providers/${id}/models/pull`, { name }, signal),
    deleteModel: (id: ProviderId, name: string) => post(`/providers/${id}/models/delete`, { name }),
    listDirs: (path?: string) => request<DirListing>(`/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),

    /** Streams login events. The first event is `{ type: "login", loginId }`. */
    login: (id: ProviderId, signal?: AbortSignal) => events<LoginStreamEvent>(`/providers/${id}/login`, {}, signal),
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
  };
}

export type FunnelClient = ReturnType<typeof createClient>;
export type { ProviderOverview } from "../funnel.js";
export * from "../types.js";
