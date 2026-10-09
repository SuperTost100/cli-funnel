#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createFunnel } from "../funnel.js";
import { createHandler } from "../server/handler.js";
import { serveNode } from "../server/node.js";
import { fileHistory } from "../providers/history.js";
import type { OpenAICompatibleEndpoint } from "../providers/openai-compatible.js";
import { ACCESS_LEVELS, type AccessLevel, type ProviderId } from "../types.js";

const HELP = `cli-funnel <command>

  doctor                       Show which CLIs are installed, logged in, and within the tested version range
  models <provider>            List models with effort levels, context sizes and fast tier
  login <provider>             Sign in through the provider's own login flow
  logout <provider>            Sign out
  update <provider>            Run the CLI's own updater
  pull <provider> <model>      Download a model (Ollama)
  rm <provider> <model>        Delete a downloaded model (Ollama)
  run <provider> <model> <prompt>
       [--effort x] [--fast] [--context tokens] [--cwd dir] [--access ${ACCESS_LEVELS.join("|")}]
       [--system text] [--session id] [--max-tokens n]
                               Prints a session id on stderr. Pass it to --session to continue.
  serve [--port 4747] [--host 127.0.0.1] [--cwd dir] [--access level] [--token secret]
                               HTTP API, SSE streaming and OpenAI-compatible /v1 endpoints

Providers: claude, codex, agent, antigravity, anthropic-api, openai-api, gemini-api, ollama

OpenAI-compatible servers come from CLI_FUNNEL_OPENAI_COMPATIBLE, a JSON list such as
  [{"id":"lmstudio","name":"LM Studio","baseUrl":"http://127.0.0.1:1234/v1"}]
Each one becomes the provider openai-compatible:<id>.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    effort: { type: "string" },
    fast: { type: "boolean" },
    context: { type: "string" },
    cwd: { type: "string" },
    access: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    token: { type: "string" },
    json: { type: "boolean" },
    system: { type: "string" },
    session: { type: "string" },
    "max-tokens": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

function openaiCompatible(): OpenAICompatibleEndpoint[] | undefined {
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
const funnel = createFunnel({ openaiCompatible: openaiCompatible(), history: fileHistory(sessions) });
const [command, providerArg, ...rest] = positionals;
const out = (s: string) => process.stdout.write(s + "\n");
const provider = (): ProviderId => {
  if (!providerArg || !(providerArg in funnel.providers)) {
    out(`Pick a provider: ${Object.keys(funnel.providers).join(", ")}`);
    process.exit(2);
  }
  return providerArg as ProviderId;
};

async function main() {
  if (!command || values.help) return out(HELP);

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
    await funnel.logout(provider());
    return out("Signed out.");
  }

  if (command === "update") {
    const r = await funnel.update(provider());
    return out(r.changed ? `Updated ${r.from} -> ${r.to}` : `Already current${r.to ? " (" + r.to + ")" : ""}.`);
  }

  if (command === "pull") {
    const [model] = rest;
    if (!model) return out("Usage: cli-funnel pull <provider> <model>");
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
    if (!model) return out("Usage: cli-funnel rm <provider> <model>");
    await funnel.deleteModel(provider(), model);
    return out(`Deleted ${model}.`);
  }

  if (command === "run") {
    const [model, ...words] = rest;
    if (!model || !words.length) return out("Usage: cli-funnel run <provider> <model> <prompt>");
    const access = (values.access ?? "accept-edits") as AccessLevel;
    const rl = access === "supervised" ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
    const stream = funnel.stream({
      selection: {
        provider: provider(),
        model,
        effort: values.effort,
        fast: values.fast,
        contextWindow: values.context ? Number(values.context) : undefined,
        cwd: values.cwd ?? process.cwd(),
        access,
      },
      prompt: words.join(" "),
      system: values.system,
      sessionId: values.session,
      maxOutputTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
      onApproval: async (r) => {
        const answer = await rl!.question(`\nAllow ${r.tool} ${JSON.stringify(r.input).slice(0, 200)}? [y/N] `);
        return answer.trim().toLowerCase().startsWith("y") ? "allow" : "deny";
      },
    });
    for await (const e of stream) {
      if (e.type === "text.delta") process.stdout.write(e.text);
      else if (e.type === "tool.start") process.stderr.write(`\n[tool] ${e.name}\n`);
    }
    const result = await stream.result;
    process.stdout.write("\n");
    if (result.sessionId) process.stderr.write(`session ${result.sessionId}\n`);
    if (values.json) out(JSON.stringify(result, null, 2));
    rl?.close();
    return;
  }

  if (command === "serve") {
    const handler = createHandler(funnel, {
      token: values.token,
      fsRoots: [homedir(), values.cwd ?? process.cwd()],
      openai: { cwd: values.cwd ?? process.cwd(), access: (values.access as AccessLevel) ?? "accept-edits" },
    });
    const host = values.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" && host !== "localhost" && !values.token) {
      out("Refusing to listen on a public address without --token.");
      process.exit(2);
    }
    const { url } = await serveNode(handler, { port: values.port ? Number(values.port) : 4747, host });
    out(`cli-funnel listening on ${url}`);
    out(`OpenAI-compatible base URL: ${url}/v1   (model ids look like claude/claude-sonnet-5)`);
    return;
  }

  out(HELP);
  process.exitCode = 2;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
