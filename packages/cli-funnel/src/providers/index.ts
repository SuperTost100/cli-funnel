import type { Provider, ProviderId } from "../types.js";
import { claudeProvider } from "./claude/index.js";
import { codexProvider } from "./codex/index.js";
import { agentProvider } from "./agent/index.js";
import { antigravityProvider } from "./antigravity/index.js";
import { createApiProviders } from "./api.js";

export const PROVIDERS: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
  agent: agentProvider,
  antigravity: antigravityProvider,
  ...createApiProviders(),
};
