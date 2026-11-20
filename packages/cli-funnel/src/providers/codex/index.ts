import { manifestModels } from "../../catalog/manifest.js";
import type { AuthStatus, FunnelEvent, ModelInfo, Provider, ProviderContext, RunInput } from "../../types.js";
import { exec } from "../../util/process.js";
import { packageVersion } from "../../util/package-version.js";
import { detectInstallation, findBinary, runLogout, runUpdate, spawnLogin } from "../base.js";
import { accountStatus, parseLoginStatus } from "./auth.js";
import { FEEDBACK_CHANNELS } from "../feedback.js";
import { parseCatalog } from "./models.js";
import { openCodexSession } from "./live.js";
import { forkThread, listThreads, rateLimits, readAccount, sendFeedback } from "./threads.js";

export const BINARY = "codex";
const TESTED_RANGE = { min: "0.150.0" };

/**
 * The oldest Codex that keeps `folderConfig: "ignore"` as promised. The `untrusted` entries in the thread config drop
 * the folder's `.codex/config.toml` layer and `skills/list` returns the folder's skills with their scope and path on
 * 0.150.0, 0.158.0 and 0.166.0 (tried against each). 0.150.0 is also the release in which an untrusted project stops
 * supplying its `AGENTS.md`. Earlier releases were not tried.
 */
const FOLDER_CONFIG_MIN = "0.150.0";

async function authStatus(): Promise<AuthStatus> {
  const path = findBinary(BINARY);
  if (!path) return { loggedIn: false, detail: "codex is not installed." };
  // The app-server knows the account and plan. When it fails, times out or knows neither, the login status text answers.
  const account = await readAccount().then(accountStatus, () => undefined);
  if (account) return account;
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
  feedbackChannel: FEEDBACK_CHANNELS.openai,
  capabilities: {
    access: ["none", "supervised", "accept-edits", "auto", "full"],
    effort: true,
    contextWindow: false,
    fast: true,
    resume: true,
    ephemeral: true,
    approvals: true,
    images: true,
    system: "native",
    schema: "native",
    mcpServers: ["http", "stdio"],
    mcpServersAtNone: ["http", "stdio"],
    apiKey: true,
    plan: true,
    fileChanges: true,
    questions: true,
    sandbox: true,
    folderConfig: ["ignore"],
    folderConfigMinVersion: FOLDER_CONFIG_MIN,
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
  sendFeedback,
};
