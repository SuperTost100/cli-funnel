import { readNDJSON } from "../../util/ndjson.js";
import { compareVersions } from "../../util/process.js";
import { FunnelError, type AuthStatus, type FunnelEvent, type Installation, type ModelInfo, type Provider, type RunInput } from "../../types.js";
import { runWithHistory } from "../history.js";
import { mapChatLine, normalizeBaseUrl, parseTags } from "./parser.js";

export interface OllamaOptions {
  /** Server URL. Defaults to `OLLAMA_HOST`, then `http://127.0.0.1:11434`. */
  baseUrl?: string;
  /** Sent as a Bearer token, for a server behind a proxy that checks one. */
  apiKey?: string;
}

const TESTED = { min: "0.35.0" };
const PROBE_MS = 2000;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Base64 images without a `data:` prefix. */
  images?: string[];
}

export function userMessage(input: RunInput): ChatMessage {
  const images = input.attachments?.map((a) => a.data);
  return { role: "user", content: input.prompt, ...(images?.length ? { images } : {}) };
}

export function chatBody(input: RunInput, messages: ChatMessage[]): Record<string, unknown> {
  return {
    model: input.selection.model,
    // The system message is sent on every call and never stored in the session history.
    messages: input.system ? [{ role: "system", content: input.system }, ...messages] : messages,
    stream: true,
    ...(input.responseSchema ? { format: input.responseSchema.schema } : {}),
    ...(input.maxOutputTokens ? { options: { num_predict: input.maxOutputTokens } } : {}),
  };
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return String(JSON.parse(text).error ?? text);
  } catch {
    return text;
  }
}

/** A local or remote Ollama server, reached over its native HTTP API. Nothing is spawned. */
export function createOllamaProvider(options: OllamaOptions = {}): Provider {
  const base = () => normalizeBaseUrl(options.baseUrl ?? process.env.OLLAMA_HOST ?? "127.0.0.1:11434");
  const headers = (json = false): Record<string, string> => ({
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    ...(json ? { "content-type": "application/json" } : {}),
  });
  const get = (path: string, timeoutMs = PROBE_MS * 5) => fetch(`${base()}${path}`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
  const notRunning = () => `Ollama is not running at ${base()}. Start it with \`ollama serve\`, or set OLLAMA_HOST.`;

  async function detect(): Promise<Installation> {
    const res = await get("/api/version", PROBE_MS).catch(() => undefined);
    if (!res) return { installed: false, testedRange: TESTED, detail: notRunning() };
    if (res.status === 401 || res.status === 403) return { installed: true, path: base(), testedRange: TESTED };
    const version = res.ok ? ((await res.json().catch(() => ({}))) as { version?: unknown }).version : undefined;
    if (typeof version !== "string") return { installed: false, testedRange: TESTED, detail: `${base()} does not answer like an Ollama server.` };
    return { installed: true, path: base(), version, testedRange: TESTED, withinTestedRange: compareVersions(version, TESTED.min) >= 0 };
  }

  async function authStatus(): Promise<AuthStatus> {
    const res = await get("/api/tags", PROBE_MS).catch(() => undefined);
    if (!res) return { loggedIn: false, detail: notRunning() };
    if (res.status === 401 || res.status === 403) return { loggedIn: false, detail: `${base()} refused the request. Check the apiKey passed to createFunnel({ ollama }).` };
    return res.ok ? { loggedIn: true, method: options.apiKey ? "API key" : "Local server" } : { loggedIn: false, detail: `Ollama returned ${res.status}.` };
  }

  async function models(): Promise<ModelInfo[]> {
    const res = await get("/api/tags").catch(() => undefined);
    if (!res) throw new FunnelError(notRunning(), "not-installed");
    if (!res.ok) throw new FunnelError(`Ollama returned ${res.status}: ${await errorText(res)}`, "cli-failed");
    return parseTags(await res.json());
  }

  async function* chat(input: RunInput, messages: ChatMessage[]): AsyncGenerator<FunnelEvent> {
    const cancelled: FunnelEvent = { type: "done", text: "", finishReason: "cancelled" };
    let finished = false;
    try {
      const res = await fetch(`${base()}/api/chat`, { method: "POST", signal: input.signal, headers: headers(true), body: JSON.stringify(chatBody(input, messages)) });
      if (!res.ok) return yield { type: "error", message: `Ollama ${res.status}: ${await errorText(res)}`, code: "cli-failed" };
      for await (const line of readNDJSON(res)) {
        for (const e of mapChatLine(line)) {
          if (e.type === "done" || e.type === "error") finished = true;
          yield e;
        }
      }
    } catch (err) {
      if (input.signal?.aborted) return yield cancelled;
      return yield { type: "error", message: finished ? String(err) : `${notRunning()} ${String(err)}`, code: "cli-failed" };
    }
    if (!finished) yield { type: "error", message: "Ollama closed the stream before the answer finished.", code: "cli-failed" };
  }

  return {
    id: "ollama",
    displayName: "Ollama",
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
          yield { type: "error" as const, message: "Ollama needs no sign-in. Start the server with `ollama serve`." };
        },
        sendCode() {},
        cancel() {},
      };
    },
    logout: async () => {
      throw new FunnelError("Ollama has no sign-in, so there is nothing to sign out of.", "unsupported");
    },
    update: async () => ({ changed: false, output: "Update Ollama with its own installer or package manager." }),
    models,
    run: (input) => runWithHistory(input, userMessage(input), (text): ChatMessage => ({ role: "assistant", content: text }), (messages) => chat(input, messages)),
  };
}
