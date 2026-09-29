import { ACCESS_LEVELS, FunnelError, type ModelInfo, type Provider, type Selection } from "./types.js";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Throws FunnelError("invalid-selection") when the selection asks for something the provider cannot do. */
export function validateSelection(selection: Selection, provider: Provider, models?: ModelInfo[]): void {
  const bad = (msg: string) => {
    throw new FunnelError(msg, "invalid-selection");
  };
  if (selection.provider !== provider.id) bad(`Selection is for ${selection.provider}, not ${provider.id}.`);
  if (!ACCESS_LEVELS.includes(selection.access)) bad(`Unknown access level "${selection.access}".`);
  const hasMachineAccess = provider.capabilities.access.length > 0;
  if (hasMachineAccess && !provider.capabilities.access.includes(selection.access)) {
    bad(`${provider.displayName} cannot enforce access "${selection.access}". Supported: ${provider.capabilities.access.join(", ")}.`);
  }
  if (hasMachineAccess && (!isAbsolute(selection.cwd) || !existsSync(selection.cwd) || !statSync(selection.cwd).isDirectory())) {
    bad(`cwd must be an existing absolute directory: ${selection.cwd}`);
  }
  const { capabilities: cap } = provider;
  if (selection.effort && !cap.effort) bad(`${provider.displayName} has no effort setting.`);
  if (selection.fast && !cap.fast) bad(`${provider.displayName} has no fast mode.`);
  if (selection.contextWindow && !cap.contextWindow) bad(`${provider.displayName} has no context window setting.`);
  if (!selection.model) bad("model is required.");
  const model = models?.find((m) => m.id === selection.model);
  if (models && !model) bad(`Unknown model "${selection.model}" for ${provider.displayName}. Call funnel.models() for the list.`);
  if (model) {
    if (selection.effort && !model.efforts.some((e) => e.id === selection.effort)) {
      bad(`${model.id} does not support effort "${selection.effort}".`);
    }
    if (selection.fast && !model.fast) bad(`${model.id} has no fast tier.`);
    if (selection.contextWindow && !model.contextWindows.includes(selection.contextWindow)) {
      bad(`${model.id} does not offer a ${selection.contextWindow} token context window.`);
    }
  }
}
