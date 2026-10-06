import { FunnelError, type AuthStatus, type Installation, type ModelInfo, type Provider, type ProviderId } from "../types.js";
import { chatUserContent, streamChatCompletions, type Msg } from "./api.js";
import { runWithHistory } from "./history.js";

/** One OpenAI-compatible server: LM Studio, llama.cpp server, vLLM, a hosted gateway. */
export interface OpenAICompatibleEndpoint {
  /** Lowercase letters, digits and dashes. The provider id becomes `openai-compatible:<id>`. */
  id: string;
  /** Shown in pickers, for example "LM Studio". */
  name: string;
  /** The base URL you would give an OpenAI SDK, usually ending in `/v1`. */
  baseUrl: string;
  /** Sent as a Bearer token. Leave it out for local servers that need none. */
  apiKey?: string;
  /** Model ids to offer when the server has no working `/models` endpoint. Ignored when it lists models. */
  models?: string[];
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const PROBE_MS = 2000;

export function openAICompatibleId(endpoint: Pick<OpenAICompatibleEndpoint, "id">): ProviderId {
  return `openai-compatible:${endpoint.id}`;
}

/** Ids are passed through as the server reports them. */
export function parseModelList(body: unknown, provider: ProviderId): ModelInfo[] {
  const data = (body as { data?: { id?: unknown }[] })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m) => typeof m.id === "string" && m.id)
    .map((m) => ({ id: m.id as string, name: m.id as string, provider, efforts: [], contextWindows: [], fast: false, source: "cli" as const }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function createOpenAICompatibleProvider(endpoint: OpenAICompatibleEndpoint): Provider {
  if (!ID.test(endpoint.id)) throw new FunnelError(`OpenAI-compatible id "${endpoint.id}" must use lowercase letters, digits and dashes.`, "invalid-selection");
  const id = openAICompatibleId(endpoint);
  const base = endpoint.baseUrl.trim().replace(/\/+$/, "");
  const headers = (): Record<string, string> => (endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {});
  const listing = (timeoutMs = PROBE_MS) => fetch(`${base}/models`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) }).catch(() => undefined);
  const notReachable = () => `${endpoint.name} is not reachable at ${base}.`;
  const configured = (): ModelInfo[] =>
    (endpoint.models ?? []).map((m) => ({ id: m, name: m, provider: id, efforts: [], contextWindows: [], fast: false, source: "manifest" as const }));

  async function detect(): Promise<Installation> {
    // Any HTTP answer means the server is up. Some servers have no /models route and answer 404.
    const res = await listing();
    return res ? { installed: true, path: base, testedRange: { min: "0" } } : { installed: false, testedRange: { min: "0" }, detail: notReachable() };
  }

  async function authStatus(): Promise<AuthStatus> {
    const res = await listing();
    if (!res) return { loggedIn: false, detail: notReachable() };
    if (res.status === 401 || res.status === 403) return { loggedIn: false, detail: `${endpoint.name} refused the request. Check its apiKey.` };
    return { loggedIn: true, method: endpoint.apiKey ? "API key" : "No key" };
  }

  async function models(): Promise<ModelInfo[]> {
    const res = await listing(PROBE_MS * 5);
    if (res?.status === 401 || res?.status === 403) throw new FunnelError(`${endpoint.name} refused the request. Check its apiKey.`, "not-logged-in");
    const listed = res?.ok ? parseModelList(await res.json().catch(() => undefined), id) : [];
    if (listed.length) return listed;
    if (endpoint.models?.length) return configured();
    if (!res) throw new FunnelError(notReachable(), "not-installed");
    throw new FunnelError(`${endpoint.name} lists no models at ${base}/models. Pass models: [...] for this endpoint.`, "cli-failed");
  }

  return {
    id,
    displayName: endpoint.name,
    binary: "http",
    capabilities: {
      access: [],
      effort: false,
      contextWindow: false,
      fast: false,
      resume: true,
      approvals: false,
      images: true,
      system: "native",
      schema: "native",
    },
    detect,
    authStatus,
    login() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "error" as const, message: `${endpoint.name} uses an API key from createFunnel({ openaiCompatible }), if it needs one.` };
        },
        sendCode() {},
        cancel() {},
      };
    },
    logout: async () => {
      throw new FunnelError(`Remove the apiKey for ${endpoint.name} from createFunnel({ openaiCompatible }) to sign out.`, "unsupported");
    },
    update: async () => ({ changed: false, output: `Update ${endpoint.name} with its own installer.` }),
    models,
    run(input) {
      const user: Msg = { role: "user", content: chatUserContent(input) };
      return runWithHistory(input, user, (text): Msg => ({ role: "assistant", content: text }), (messages) =>
        streamChatCompletions({ baseUrl: base, key: endpoint.apiKey, maxTokensField: "max_tokens", label: endpoint.name }, input, messages),
      );
    },
  };
}

/** Builds one provider per endpoint. Throws `invalid-selection` on a bad or repeated id. */
export function createOpenAICompatibleProviders(endpoints: OpenAICompatibleEndpoint[] = []): Record<ProviderId, Provider> {
  const out: Record<string, Provider> = {};
  for (const e of endpoints) {
    const p = createOpenAICompatibleProvider(e);
    if (out[p.id]) throw new FunnelError(`OpenAI-compatible id "${e.id}" is used twice.`, "invalid-selection");
    out[p.id] = p;
  }
  return out as Record<ProviderId, Provider>;
}
