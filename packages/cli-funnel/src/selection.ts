import { ACCESS_LEVELS, FunnelError, PROVIDER_OPTION_IDS, type AccessLevel, type ModelInfo, type Provider, type Selection } from "./types.js";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** The `cwd` and `access` of a selection for a provider that runs on the machine. Throws `invalid-selection` when either is missing. */
export function requireMachine(selection: Selection): { cwd: string; access: AccessLevel } {
  const { cwd, access } = selection;
  if (!cwd || !access) throw new FunnelError(`${selection.provider} needs both cwd and access in the selection.`, "invalid-selection");
  return { cwd, access };
}

/** Throws FunnelError("invalid-selection") when the selection asks for something the provider cannot do. */
export function validateSelection(selection: Selection, provider: Provider, models?: ModelInfo[]): void {
  const bad = (msg: string) => {
    throw new FunnelError(msg, "invalid-selection");
  };
  if (selection.provider !== provider.id) bad(`Selection is for ${selection.provider}, not ${provider.id}.`);
  const { access, cwd } = selection;
  if (access !== undefined && !ACCESS_LEVELS.includes(access)) bad(`Unknown access level "${access}".`);
  // Providers that list no access levels (Ollama, the API providers) have no machine: cwd and access mean nothing.
  const hasMachineAccess = provider.capabilities.access.length > 0;
  if (hasMachineAccess) {
    if (!access) bad(`${provider.displayName} needs an access level. Supported: ${provider.capabilities.access.join(", ")}.`);
    else if (!provider.capabilities.access.includes(access)) {
      bad(`${provider.displayName} cannot enforce access "${access}". Supported: ${provider.capabilities.access.join(", ")}.`);
    }
    if (!cwd || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      bad(`cwd must be an existing absolute directory: ${cwd ?? "(missing)"}`);
    }
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

/** Throws FunnelError("invalid-selection") for `providerOptions` keyed by an id that takes no options. Providers check the values. */
export function validateProviderOptions(options: unknown): void {
  if (options === undefined) return;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new FunnelError("providerOptions must be an object keyed by provider id.", "invalid-selection");
  }
  const unknown = Object.keys(options).filter((k) => !(PROVIDER_OPTION_IDS as readonly string[]).includes(k));
  if (unknown.length) {
    throw new FunnelError(`${unknown.join(", ")} takes no providerOptions. Only ${PROVIDER_OPTION_IDS.join(", ")} do.`, "invalid-selection");
  }
}
