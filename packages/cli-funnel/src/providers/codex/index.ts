import { readFileSync } from "node:fs";
import { manifestModels } from "../../catalog/manifest.js";
import type { AuthStatus, FunnelEvent, ModelInfo, Provider, ProviderContext, RunInput } from "../../types.js";
import { exec } from "../../util/process.js";
import { detectInstallation, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { parseLoginStatus } from "./auth.js";
import { parseCatalog } from "./models.js";
import { openCodexSession } from "./live.js";
import { forkThread, listThreads, rateLimits } from "./threads.js";

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
  return manifestModels("codex", ctx?.manifestUrl);
}

/** This package's version. Source files sit three levels below the package root, bundled files one or two. */
function packageVersion(): string | undefined {
  for (const rel of ["../../../package.json", "../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      if (pkg.name === "cli-funnel") return pkg.version;
    } catch {
      /* not at this level */
    }
  }
  return undefined;
}

export const INITIALIZE_PARAMS = {
  clientInfo: { name: "cli-funnel", title: null, version: packageVersion() ?? "0.0.0" },
  capabilities: { experimentalApi: false, requestAttestation: false },
};

/** One turn on a session of its own, so a run and a live session share one code path. */
async function* run(input: RunInput): AsyncGenerator<FunnelEvent> {
  const session = await openCodexSession(input);
  try {
    yield* session.turn(input);
  } finally {
    session.close();
  }
}

export const codexProvider: Provider = {
  id: "codex",
  displayName: "Codex",
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
    mcpServers: ["http", "stdio"],
    apiKey: true,
    plan: true,
    fileChanges: true,
    questions: true,
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
  listThreads,
  forkThread,
  rateLimits,
};
