#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createFunnel } from "../funnel.js";
import { createMcpServer, serveStdio } from "../mcp/server.js";
import { jsonlRunLog } from "../run-log.js";
import { createHandler } from "../server/handler.js";
import { serveNode } from "../server/node.js";
import { fileHistory } from "../providers/history.js";
import type { OpenAICompatibleEndpoint } from "../providers/openai-compatible.js";
import { SERVE_TIMEOUT_SEC, readServeConfig, resolveServe, seconds } from "./serve-config.js";
import { UsageError, fromStdin, loadImages, loadSchema, parseOpts, renderRun, resolvePrompt } from "./run-input.js";
import { ACCESS_LEVELS, type AccessLevel, type ProviderId } from "../types.js";

const HELP = `cli-funnel <command>

  doctor                       Show which CLIs are installed, logged in, and within the tested version range
  models <provider>            List models with effort levels, context sizes and fast tier
  login <provider>             Sign in through the provider's own login flow
  logout <provider>            Sign out
  update <provider>            Run the CLI's own updater
  pull <provider> <model>      Download a model (Ollama)
  rm <provider> <model>        Delete a downloaded model (Ollama)
  run <provider> <model> [prompt | -]
       [--effort x] [--fast] [--context tokens] [--cwd dir] [--access ${ACCESS_LEVELS.join("|")}]
       [--system text] [--session id] [--max-tokens n] [--timeout seconds]
       [--image file]... [--schema file.json] [--json] [--quiet] [--opt key=value]...
                               Prints a session id on stderr. Pass it to --session to continue.
                               The prompt is read from stdin when it is - or missing and stdin is piped.
                               --image attaches a PNG, JPEG, WebP or GIF (repeatable).
                               --schema asks for JSON that matches the file and prints only that answer.
                               --json prints the full result as JSON on stdout and nothing else.
                               --quiet drops the stream and prints the final text once.
                               --timeout stops the run after that many seconds and exits 1.
                               Exits 1 when the run gives no text and does not finish with "stop".
                               --opt sets one providerOptions entry, for example --opt addDirs=/tmp/x.
                               JSON values are parsed. Repeat a key to build a list.
  serve [--port 4747] [--host 127.0.0.1] [--cwd dir] [--access level] [--token secret]
        [--config file.json] [--fs-root dir]... [--approval-timeout seconds] [--cors origin]
        [--log-jsonl file] [--log-content] [--timeout seconds]
        [--keep-alive] [--session-idle seconds] [--max-sessions n]
        [--max-concurrent n] [--max-queued n] [--queue-timeout seconds]
                               HTTP API, SSE streaming and OpenAI-compatible /v1 endpoints.
                               Flags beat the config file, the file beats the environment. See docs/serve.md.
                               --log-jsonl appends one line per run: ids, timing, usage, no text. --log-content adds the prompt and text.
                               --timeout stops each run after that many seconds, default ${SERVE_TIMEOUT_SEC}. 0 means no limit.
                               --keep-alive keeps Claude Code and Codex processes between turns and turns on /sessions.
                               --session-idle closes a live session after that many seconds idle (default 600).
                               --max-sessions caps live sessions (default 8). Both need --keep-alive.
                               --max-concurrent caps runs at the same time. Runs over it wait in a queue.
                               --max-queued caps the waiting runs (default 100, more get 429). --queue-timeout stops a wait after that many seconds.
                               Both need --max-concurrent. Per-provider caps go in the config file.
  mcp [--max-access ${ACCESS_LEVELS.join("|")}] [--fs-root dir]... [--cwd dir]
                               MCP server on stdio. Tools: list_providers, list_models, run.
                               --max-access caps what a run may ask for (default none).

Providers: claude, codex, agent, antigravity, anthropic-api, openai-api, gemini-api, ollama

OpenAI-compatible servers come from CLI_FUNNEL_OPENAI_COMPATIBLE, a JSON list such as
  [{"id":"lmstudio","name":"LM Studio","baseUrl":"http://127.0.0.1:1234/v1"}]
Each one becomes the provider openai-compatible:<id>.

Without a token, serve answers only localhost, IP addresses and tailscale serve. CLI_FUNNEL_TOKEN sets the token
without putting it in the process list. CLI_FUNNEL_ALLOWED_HOSTS adds host names, comma-separated.
".example.com" matches subdomains, "*" turns the check off.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    effort: { type: "string" },
    fast: { type: "boolean" },
    context: { type: "string" },
    cwd: { type: "string" },
    access: { type: "string" },
    "max-access": { type: "string" },
    "fs-root": { type: "string", multiple: true },
    port: { type: "string" },
    host: { type: "string" },
    token: { type: "string" },
    config: { type: "string" },
    "approval-timeout": { type: "string" },
    cors: { type: "string" },
    "log-jsonl": { type: "string" },
    "log-content": { type: "boolean" },
    "keep-alive": { type: "boolean" },
    "session-idle": { type: "string" },
    "max-sessions": { type: "string" },
    "max-concurrent": { type: "string" },
    "max-queued": { type: "string" },
    "queue-timeout": { type: "string" },
    json: { type: "boolean" },
    quiet: { type: "boolean" },
    image: { type: "string", multiple: true },
    schema: { type: "string" },
    system: { type: "string" },
    session: { type: "string" },
    "max-tokens": { type: "string" },
    timeout: { type: "string" },
    opt: { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  },
});

function usageExit(err: unknown): never {
  if (!(err instanceof UsageError)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}

function loadServeConfig() {
  try {
    return values.config ? readServeConfig(values.config) : {};
  } catch (err) {
    return usageExit(err);
  }
}
const serveConfig = loadServeConfig();

function resolveServeOrExit() {
  try {
    return resolveServe(values, serveConfig, process.env, { cwd: process.cwd(), home: homedir() });
  } catch (err) {
    return usageExit(err);
  }
}

function openaiCompatible(): OpenAICompatibleEndpoint[] | undefined {
  if (serveConfig.openaiCompatible) return serveConfig.openaiCompatible;
  const raw = process.env.CLI_FUNNEL_OPENAI_COMPATIBLE;
  if (!raw) return undefined;
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) return list;
  } catch {
    /* reported below */
  }
  process.stderr.write("CLI_FUNNEL_OPENAI_COMPATIBLE must be a JSON list of { id, name, baseUrl, apiKey?, models? }.\n");
  process.exit(2);
}

// Conversations with the API providers, Ollama and OpenAI-compatible servers, so --session works across commands.
const sessions = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "cli-funnel", "sessions");
const serveSettings = positionals[0] === "serve" ? resolveServeOrExit() : undefined;
// Keys and the server token never reach the log.
const logSecrets = [serveSettings?.token, ...(serveConfig.openaiCompatible ?? []).map((e) => e.apiKey), process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.GEMINI_API_KEY];
const runLog = serveSettings?.log && jsonlRunLog(serveSettings.log.file, { content: serveSettings.log.content, secrets: logSecrets });
const funnel = createFunnel({
  openaiCompatible: openaiCompatible(),
  sessions: serveSettings?.sessions,
  history: fileHistory(sessions),
  onEvent: runLog,
});
const [command, providerArg, ...rest] = positionals;
const out = (s: string) => process.stdout.write(s + "\n");
/** Prints a usage error on stderr and exits with 2. */
const usage = (s: string): never => {
  process.stderr.write(s + "\n");
  return process.exit(2);
};
/** `run --timeout` in milliseconds. */
const runTimeoutMs = (): number | undefined => {
  try {
    return values.timeout === undefined ? undefined : seconds("--timeout", values.timeout) * 1000;
  } catch (err) {
    return usageExit(err);
  }
};
const provider = (): ProviderId => {
  if (!providerArg || !(providerArg in funnel.providers)) return usage(`Pick a provider: ${Object.keys(funnel.providers).join(", ")}`);
  return providerArg as ProviderId;
};
const wholeNumber = (flag: string, raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) return usage(`--${flag} must be a whole number above 0, got "${raw}".`);
  return Number(raw);
};
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];

function packageVersion(): string | undefined {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return undefined;
  }
}

async function main() {
  if (values.help) return out(HELP);
  if (!command) return usage(HELP);

  if (command === "doctor") {
    const rows = await funnel.overview();
    if (values.json) return out(JSON.stringify(rows, null, 2));
    for (const r of rows) {
      const i = r.installation;
      const state = !i.installed
        ? "not installed"
        : `${i.version ?? "?"}${i.withinTestedRange === false ? " (outside tested range)" : ""}, ${r.auth?.loggedIn ? `logged in${r.auth.account ? " as " + r.auth.account : ""}` : "logged out"}`;
      out(`${r.displayName.padEnd(14)} ${state}`);
      out(`${"".padEnd(14)} access: ${r.capabilities.access.join(", ") || "none"}`);
    }
    return;
  }

  if (command === "models") {
    const models = await funnel.models(provider());
    if (values.json) return out(JSON.stringify(models, null, 2));
    for (const m of models) {
      const bits = [
        m.efforts.length ? `effort ${m.efforts.map((e) => e.id).join("/")}` : "",
        m.contextWindows.length ? `context ${m.contextWindows.map((c) => (c >= 1e6 ? c / 1e6 + "M" : c / 1e3 + "k")).join("/")}` : "",
        m.fast ? "fast" : "",
      ].filter(Boolean);
      out(`${m.id.padEnd(34)} ${m.name}${bits.length ? "  [" + bits.join(", ") + "]" : ""}`);
    }
    return;
  }

  if (command === "login") {
    const session = funnel.login(provider());
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for await (const e of session) {
      if (e.type === "open-url") out(`Open this link to sign in:\n  ${e.url}`);
      else if (e.type === "code-prompt") session.sendCode(await rl.question(`${e.message}\n> `));
      else if (e.type === "needs-terminal") out(`This provider signs in from a terminal. Run: ${e.command.join(" ")}`);
      else if (e.type === "done") out(`Signed in${e.status.account ? " as " + e.status.account : ""}.`);
      else if (e.type === "error") {
        out(e.message);
        process.exitCode = 1;
      }
    }
    rl.close();
    return;
  }

  if (command === "logout") {
    const id = provider();
    // Rejects when the CLI still reports a signed-in account afterwards.
    await funnel.logout(id);
    return out("Signed out.");
  }

  if (command === "update") {
    const r = await funnel.update(provider());
    return out(r.changed ? `Updated ${r.from} -> ${r.to}` : `Already current${r.to ? " (" + r.to + ")" : ""}.`);
  }

  if (command === "pull") {
    const [model] = rest;
    if (!model) return usage("Usage: cli-funnel pull <provider> <model>");
    let last = "";
    for await (const e of funnel.pullModel(provider(), model)) {
      if (e.type === "progress") {
        const pct = e.total ? ` ${Math.floor(((e.completed ?? 0) / e.total) * 100)}%` : "";
        const line = `${e.status}${pct}`;
        if (line !== last) process.stderr.write(`${line}\n`);
        last = line;
      } else if (e.type === "done") out(`Pulled ${model}.`);
      else {
        out(e.message);
        process.exitCode = 1;
      }
    }
    return;
  }

  if (command === "rm") {
    const [model] = rest;
    if (!model) return usage("Usage: cli-funnel rm <provider> <model>");
    await funnel.deleteModel(provider(), model);
    return out(`Deleted ${model}.`);
  }

  if (command === "run") {
    const [model, ...words] = rest;
    if (!model) return usage("Usage: cli-funnel run <provider> <model> [prompt | -]");
    const access = (values.access ?? "accept-edits") as AccessLevel;
    const contextWindow = wholeNumber("context", values.context);
    const maxOutputTokens = wholeNumber("max-tokens", values["max-tokens"]);
    // Approvals are asked on the terminal, and stdin is the prompt here.
    if (access === "supervised" && fromStdin(words)) return usage("--access supervised asks for approvals on the terminal. Pass the prompt as an argument instead of stdin.");
    let prompt: string, attachments, responseSchema, providerOptions;
    try {
      providerOptions = parseOpts(provider(), values.opt);
      prompt = await resolvePrompt(words, process.stdin);
      attachments = await loadImages(values.image);
      responseSchema = await loadSchema(values.schema);
    } catch (err) {
      if (err instanceof UsageError) return usage(err.message);
      throw err;
    }
    // Questions go to stderr so that stdout carries only the answer, or only the JSON with --json.
    const rl = access === "supervised" ? createInterface({ input: process.stdin, output: process.stderr }) : undefined;
    const stream = funnel.stream({
      selection: {
        provider: provider(),
        model,
        effort: values.effort,
        fast: values.fast,
        contextWindow,
        cwd: values.cwd ?? process.cwd(),
        access,
      },
      prompt,
      attachments,
      responseSchema,
      system: values.system,
      sessionId: values.session,
      maxOutputTokens,
      timeoutMs: runTimeoutMs(),
      providerOptions,
      // Without a terminal prompt the CLI denies tools that need approval on its own.
      onApproval: rl
        ? async (r) => {
            const answer = await rl.question(`\nAllow ${r.tool} ${JSON.stringify(r.input).slice(0, 200)}? [y/N] `);
            return answer.trim().toLowerCase().startsWith("y") ? "allow" : "deny";
          }
        : undefined,
    });
    const { result, structured } = await renderRun(stream, {
      json: values.json,
      quiet: values.quiet,
      schema: !!responseSchema,
      stdout: (s) => process.stdout.write(s),
      stderr: (s) => process.stderr.write(s),
    });
    rl?.close();
    if (!structured) process.exitCode = 1;
    if (result.timeout) {
      process.stderr.write(`Stopped after ${values.timeout} s (--timeout).\n`);
      process.exitCode = 1;
    }
    if (result.deniedActions.length) {
      process.stderr.write(`Denied: ${[...new Set(result.deniedActions)].join(", ")}. Use --access supervised to approve tools one by one.\n`);
    }
    if (!result.text && result.finishReason !== "stop") {
      process.stderr.write(`The run ended without text. Finish reason: ${result.finishReason}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "mcp") {
    const maxAccess = (values["max-access"] ?? "none") as AccessLevel;
    if (!ACCESS_LEVELS.includes(maxAccess)) {
      return usage(`--max-access must be one of ${ACCESS_LEVELS.join(", ")}.`);
    }
    const cwd = values.cwd ?? process.cwd();
    const server = createMcpServer({
      funnel,
      maxAccess,
      fsRoots: values["fs-root"]?.length ? values["fs-root"] : [homedir(), cwd],
      cwd,
      version: packageVersion(),
      log: (m) => process.stderr.write(`${m}\n`),
    });
    process.stderr.write(`cli-funnel MCP server on stdio, max access ${maxAccess}\n`);
    await serveStdio(server, process.stdin, process.stdout);
    return;
  }

  if (command === "serve") {
    const settings = serveSettings!;
    const { port, token } = settings;
    // [::1] is how an IPv6 address is written in a URL. The socket wants it without brackets.
    const host = settings.host.replace(/^\[(.*)\]$/, "$1");
    if (!LOCAL_HOSTS.includes(host) && !token) {
      return usage("Refusing to listen on a public address without a token. Pass --token, set CLI_FUNNEL_TOKEN or put token in the config file.");
    }
    let handler;
    try {
      handler = createHandler(funnel, settings.handler);
    } catch (err) {
      return usage(err instanceof Error ? err.message : String(err));
    }
    const { url } = await serveNode(handler, { port, host });
    if (runLog) {
      // The run log writes in the background. Ctrl-C or a service stop waits for the last lines, then exits with the
      // usual code for that signal. A second signal kills the process at once.
      for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
        process.once(signal, () => void runLog.flush().finally(() => process.exit(code)));
      }
    }
    out(`cli-funnel listening on ${url}`);
    out(`OpenAI-compatible base URL: ${url}/v1   (model ids look like claude/claude-sonnet-5)`);
    return;
  }

  usage(HELP);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
