import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Funnel } from "../funnel.js";
import { createCwdGuard } from "../util/fs-roots.js";
import { ACCESS_LEVELS, type AccessLevel, type ProviderId, type RunInput, type RunResult } from "../types.js";

/** Protocol revisions this server speaks, newest first. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface McpServerOptions {
  funnel: Funnel;
  /** Highest access level a `run` may ask for. A run above it is refused, not lowered. Default "none". */
  maxAccess?: AccessLevel;
  /** Folders a run may use as its project folder. Default: the home directory. */
  fsRoots?: string[];
  /** Project folder for runs that do not name one. Default: the server's working directory. */
  cwd?: string;
  /** Version reported in `serverInfo`. */
  version?: string;
  /** Diagnostics. The stdio transport never writes them to stdout, so point this at stderr. */
  log?: (message: string) => void;
}

type Id = string | number;
interface Request {
  jsonrpc: "2.0";
  id?: Id | null;
  method: string;
  params?: Record<string, unknown>;
}
interface Response {
  jsonrpc: "2.0";
  id: Id | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const selectionSchema = {
  type: "object",
  description: "Which provider and model to run. Get both from list_providers and list_models.",
  properties: {
    provider: { type: "string", description: "Provider id, for example claude, codex, agent, antigravity, ollama." },
    model: { type: "string", description: "Concrete model id from list_models." },
    effort: { type: "string", description: "Effort level the model offers, for example high." },
    contextWindow: { type: "number", description: "Context size in tokens, when the model offers a choice." },
    fast: { type: "boolean", description: "Use the model's fast tier, when it has one." },
    cwd: {
      type: "string",
      description: "Absolute project folder. Default: the server's working directory. Must be inside the folders the server allows.",
    },
    access: {
      type: "string",
      enum: [...ACCESS_LEVELS],
      description:
        'What the agent may do on the machine. Default "none" (text only). A level above the server\'s --max-access is refused. "supervised" is not available over MCP.',
    },
  },
  required: ["provider", "model"],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "list_providers",
    title: "List providers",
    description:
      "List the providers this server can run: which are installed and signed in, and which access levels each can enforce. Call this before run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_models",
    title: "List models",
    description: "List the models of one provider, with the effort levels, context sizes and fast tier each offers.",
    inputSchema: {
      type: "object",
      properties: { provider: { type: "string", description: "Provider id from list_providers." } },
      required: ["provider"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "run",
    title: "Run a prompt",
    description:
      "Run one prompt on a provider and model and return the final answer. Waits until the run ends, with no streaming. Costs the user's subscription or API credit.",
    inputSchema: {
      type: "object",
      properties: {
        selection: selectionSchema,
        prompt: { type: "string", description: "The prompt." },
        system: { type: "string", description: "Instructions for the whole run." },
        responseSchema: {
          type: "object",
          description: "Ask for a JSON answer. The result carries it in structured.",
          properties: {
            name: { type: "string" },
            schema: { type: "object", description: "A JSON Schema. Codex and Anthropic need additionalProperties: false on every object." },
          },
          required: ["schema"],
          additionalProperties: false,
        },
      },
      required: ["selection", "prompt"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

/** A problem the caller can fix. It becomes an `isError` tool result, not a protocol error. */
class ToolFailure extends Error {}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function textResult(value: string, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

/**
 * An MCP server over the funnel. `handle` takes one decoded JSON-RPC message and returns the reply, or nothing for a
 * notification. `serveStdio` wires it to newline-delimited JSON on a pair of streams.
 */
export function createMcpServer(options: McpServerOptions) {
  const { funnel } = options;
  const maxAccess = options.maxAccess ?? "none";
  const rank = (a: string) => ACCESS_LEVELS.indexOf(a as AccessLevel);
  const cwdAllowed = createCwdGuard(options.fsRoots);
  const defaultCwd = options.cwd ?? process.cwd();
  const log = options.log ?? (() => {});
  const inFlight = new Map<Id, AbortController>();
  let version: string = MCP_VERSIONS[0];

  /** A text block for every client, plus structuredContent from revision 2025-06-18 on. */
  const structured = (value: Record<string, unknown>, summary = JSON.stringify(value)) =>
    version >= "2025-06-18" ? { ...textResult(summary), structuredContent: value } : textResult(summary);

  const providerOf = (id: unknown): ProviderId => {
    if (typeof id !== "string" || !(id in funnel.providers)) {
      throw new ToolFailure(`Unknown provider "${String(id)}". Providers: ${Object.keys(funnel.providers).join(", ")}.`);
    }
    return id as ProviderId;
  };

  async function run(args: Record<string, unknown>, signal: AbortSignal): Promise<RunResult> {
    const { selection, prompt, system, responseSchema } = args;
    if (!isObject(selection)) throw new ToolFailure("selection must be an object with provider and model.");
    if (typeof prompt !== "string" || !prompt) throw new ToolFailure("prompt must be a non-empty string.");
    if (system !== undefined && typeof system !== "string") throw new ToolFailure("system must be a string.");
    if (responseSchema !== undefined && !(isObject(responseSchema) && isObject(responseSchema.schema))) {
      throw new ToolFailure("responseSchema must be an object with a schema object.");
    }
    const provider = providerOf(selection.provider);
    if (typeof selection.model !== "string" || !selection.model) throw new ToolFailure("selection.model must be a non-empty string.");

    const access = selection.access ?? "none";
    if (typeof access !== "string" || rank(access) < 0) {
      throw new ToolFailure(`Unknown access level "${String(access)}". Levels: ${ACCESS_LEVELS.join(", ")}.`);
    }
    if (access === "supervised") {
      throw new ToolFailure('Access "supervised" needs a way to ask the user for approval, and this server has none yet. Use "none" or a higher level.');
    }
    if (rank(access) > rank(maxAccess)) {
      throw new ToolFailure(
        `Access "${access}" is above this server's --max-access "${maxAccess}". Ask for "${maxAccess}" or lower, or restart the server with a higher --max-access.`,
      );
    }
    const cwd = selection.cwd ?? defaultCwd;
    if (typeof cwd !== "string" || !cwdAllowed(cwd)) {
      throw new ToolFailure("cwd does not exist or is outside the allowed folders. Start the server with --fs-root to allow more.");
    }

    const input: RunInput = {
      selection: {
        provider,
        model: selection.model,
        effort: typeof selection.effort === "string" ? selection.effort : undefined,
        contextWindow: typeof selection.contextWindow === "number" ? selection.contextWindow : undefined,
        fast: typeof selection.fast === "boolean" ? selection.fast : undefined,
        cwd,
        access: access as AccessLevel,
      },
      prompt,
      system,
      responseSchema: responseSchema as RunInput["responseSchema"],
      signal,
    };
    return funnel.run(input);
  }

  async function callTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    try {
      if (name === "list_providers") {
        const rows = await funnel.overview();
        const providers = rows.map((r) => ({
          id: r.id,
          name: r.displayName,
          installed: r.installation.installed,
          version: r.installation.version,
          loggedIn: r.auth?.loggedIn,
          access: r.capabilities.access,
        }));
        return structured({ providers, maxAccess });
      }
      if (name === "list_models") return structured({ models: await funnel.models(providerOf(args.provider)) });
      const result = await run(args, signal);
      return structured({ ...result }, result.text || (result.structured !== undefined ? JSON.stringify(result.structured) : ""));
    } catch (err) {
      if (!(err instanceof ToolFailure)) log(`tool ${name} failed: ${message(err)}`);
      return textResult(message(err), true);
    }
  }

  async function dispatch(req: Request): Promise<unknown> {
    const params = req.params ?? {};
    switch (req.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        version = (MCP_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : MCP_VERSIONS[0];
        return {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "cli-funnel", title: "cli-funnel", version: options.version ?? "0.0.0" },
          instructions: `Runs prompts on the user's Claude Code, Codex, Cursor Agent, Antigravity or local model setup. Call list_providers, then list_models, then run. Access is capped at "${maxAccess}".`,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(name)}`);
        const args = params.arguments ?? {};
        if (!isObject(args)) throw new RpcError(INVALID_PARAMS, "arguments must be an object.");
        const controller = new AbortController();
        const id = req.id!;
        inFlight.set(id, controller);
        try {
          return await callTool(name, args, controller.signal);
        } finally {
          inFlight.delete(id);
        }
      }
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${req.method}`);
    }
  }

  return {
    /** Handles one decoded message. Resolves to the reply, or undefined for a notification. */
    async handle(msg: unknown): Promise<Response | undefined> {
      if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
        // A reply to a request we never sent gets no answer. Anything else is not JSON-RPC.
        if (isObject(msg) && ("result" in msg || "error" in msg)) return undefined;
        return { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid JSON-RPC request." } };
      }
      const req = msg as unknown as Request;
      if (req.id === undefined || req.id === null) {
        if (req.method === "notifications/cancelled") {
          const id = req.params?.requestId;
          if (typeof id === "string" || typeof id === "number") inFlight.get(id)?.abort();
        }
        return undefined;
      }
      try {
        return { jsonrpc: "2.0", id: req.id, result: await dispatch(req) };
      } catch (err) {
        if (err instanceof RpcError) return { jsonrpc: "2.0", id: req.id, error: { code: err.code, message: err.message } };
        log(`${req.method} failed: ${message(err)}`);
        return { jsonrpc: "2.0", id: req.id, error: { code: INTERNAL_ERROR, message: message(err) } };
      }
    },
    /** Aborts every run still in flight. */
    abortAll() {
      for (const c of inFlight.values()) c.abort();
    },
    parseError: (): Response => ({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error." } }),
  };
}

export type McpServer = ReturnType<typeof createMcpServer>;

/**
 * Serves `server` over newline-delimited JSON-RPC, the MCP stdio transport. Only protocol messages go to `output`.
 * Resolves when `input` ends and every reply is written. Runs still going at that point are aborted, because the
 * client closing stdin means it is done with the server.
 */
export async function serveStdio(server: McpServer, input: Readable, output: Writable): Promise<void> {
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.write(JSON.stringify(server.parseError()) + "\n");
      continue;
    }
    // Not awaited: a long run must not hold back a ping or a cancel notification behind it.
    const task: Promise<void> = server.handle(parsed).then((res) => {
      if (res) output.write(JSON.stringify(res) + "\n");
      pending.delete(task);
    });
    pending.add(task);
  }
  server.abortAll();
  await Promise.all(pending);
}
