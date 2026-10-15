import { readNDJSON } from "../../util/ndjson.js";
import { redactErrors } from "../../util/redact.js";
import { compareVersions } from "../../util/process.js";
import { FunnelError, type AuthStatus, type FunnelEvent, type Installation, type ModelInfo, type Provider, type PullEvent, type RunInput } from "../../types.js";
import { runWithHistory } from "../history.js";
import { mapChatLine, mapPullLine, normalizeBaseUrl, parseTags, thinkValue } from "./parser.js";

export interface OllamaOptions {
  /** Server URL. Defaults to `OLLAMA_HOST`, then `http://127.0.0.1:11434`. */
  baseUrl?: string;
  /** Sent as a Bearer token, for a server behind a proxy that checks one. */
  apiKey?: string;
  /** How long the server keeps a model loaded after a run, for every run. A duration such as `"30m"`, seconds as a number, or `-1` for good. A run can override it with `ollama.keepAlive`. Without it the server's own default applies, 5 minutes unless configured. */
  keepAlive?: string | number;
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

/** The `options` object of a chat request. Entries the caller passes in `ollama.options` come last and win. */
function requestOptions(input: RunInput): Record<string, unknown> {
  const { sampling } = input;
  return {
    ...(input.selection.contextWindow ? { num_ctx: input.selection.contextWindow } : {}),
    ...(input.maxOutputTokens ? { num_predict: input.maxOutputTokens } : {}),
    ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    ...(sampling?.topP !== undefined ? { top_p: sampling.topP } : {}),
    ...(sampling?.stop?.length ? { stop: sampling.stop } : {}),
    ...(sampling?.seed !== undefined ? { seed: sampling.seed } : {}),
    ...input.ollama?.options,
  };
}

export function chatBody(input: RunInput, messages: ChatMessage[], keepAlive?: string | number): Record<string, unknown> {
  const options = requestOptions(input);
  const keep = input.ollama?.keepAlive ?? keepAlive;
  return {
    model: input.selection.model,
    // The system message is sent on every call and never stored in the session history.
    messages: input.system ? [{ role: "system", content: input.system }, ...messages] : messages,
    stream: true,
    ...(input.responseSchema ? { format: input.responseSchema.schema } : {}),
    ...(input.selection.effort ? { think: thinkValue(input.selection.effort) } : {}),
    ...(keep !== undefined ? { keep_alive: keep } : {}),
    ...(Object.keys(options).length ? { options } : {}),
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
    // The first line that was not JSON. A proxy error page looks like this, and it is what the user needs to see.
    let raw: string | undefined;
    try {
      const res = await fetch(`${base()}/api/chat`, { method: "POST", signal: input.signal, headers: headers(true), body: JSON.stringify(chatBody(input, messages, options.keepAlive)) });
      if (!res.ok) return yield { type: "error", message: `Ollama ${res.status}: ${await errorText(res)}`, code: "cli-failed" };
      for await (const line of readNDJSON(res)) {
        if (line && typeof line === "object" && "__raw" in line) {
          raw ??= String(line.__raw).slice(0, 200);
          continue;
        }
        for (const e of mapChatLine(line)) {
          if (e.type === "done" || e.type === "error") finished = true;
          yield e;
        }
        // Stop at the terminal event. A proxy may hold the connection open, and returning cancels the body.
        if (finished) return;
      }
    } catch (err) {
      if (input.signal?.aborted) return yield cancelled;
      return yield { type: "error", message: finished ? String(err) : `${notRunning()} ${String(err)}`, code: "cli-failed" };
    }
    if (raw) yield { type: "error", message: `Ollama sent a line that is not JSON: ${raw}`, code: "cli-failed" };
    else yield { type: "error", message: "Ollama closed the stream before the answer finished.", code: "stream-truncated" };
  }

  async function* pullModel(name: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<PullEvent> {
    try {
      const res = await fetch(`${base()}/api/pull`, { method: "POST", signal: opts.signal, headers: headers(true), body: JSON.stringify({ model: name, stream: true }) });
      if (!res.ok) return yield { type: "error", message: `Ollama ${res.status}: ${await errorText(res)}` };
      for await (const line of readNDJSON(res)) {
        const e = mapPullLine(line);
        if (!e) continue;
        yield e;
        if (e.type !== "progress") return;
      }
    } catch (err) {
      if (opts.signal?.aborted) return;
      return yield { type: "error", message: `${notRunning()} ${String(err)}` };
    }
    if (!opts.signal?.aborted) yield { type: "error", message: "Ollama closed the stream before the pull finished." };
  }

  async function deleteModel(name: string): Promise<void> {
    const res = await fetch(`${base()}/api/delete`, { method: "DELETE", headers: headers(true), body: JSON.stringify({ model: name }) }).catch(() => undefined);
    if (!res) throw new FunnelError(notRunning(), "not-installed");
    if (res.status === 404) throw new FunnelError(`${name} is not on the Ollama server.`, "invalid-selection");
    if (!res.ok) throw new FunnelError(`Ollama ${res.status}: ${await errorText(res)}`, "cli-failed");
  }

  return {
    id: "ollama",
    displayName: "Ollama",
    binary: "http",
    capabilities: {
      access: [],
      effort: true,
      contextWindow: true,
      fast: false,
      resume: true,
      approvals: false,
      images: true,
      system: "native",
      schema: "native",
      sampling: true,
      manageModels: true,
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
    pullModel,
    deleteModel,
    run: (input) =>
      redactErrors(
        runWithHistory(input, userMessage(input), (text): ChatMessage => ({ role: "assistant", content: text }), (messages) => chat(input, messages)),
        [options.apiKey],
      ),
  };
}
