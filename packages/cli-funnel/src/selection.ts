import { ACCESS_LEVELS, FOLDER_CONFIGS, FunnelError, PROVIDER_OPTION_IDS, type AccessLevel, type Installation, type ModelInfo, type Provider, type Selection } from "./types.js";
import { compareVersions } from "./util/process.js";
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

/**
 * Checks `RunInput.folderConfig` against what the provider can honour. A provider without machine access reads no
 * folder, so every value is a no-op there. `load` needs nothing. A value the provider honours still needs a CLI at or
 * above `capabilities.folderConfigMinVersion`, and a CLI whose version could not be read is refused too, since the
 * option promises that the folder's config stays out.
 */
export function checkFolderConfig(value: unknown, provider: Provider, install: Installation): void {
  if (value === undefined) return;
  if (!FOLDER_CONFIGS.includes(value as never)) {
    throw new FunnelError(`folderConfig must be one of ${FOLDER_CONFIGS.join(", ")}.`, "invalid-selection");
  }
  if (value === "load" || provider.capabilities.access.length === 0) return;
  const honoured = provider.capabilities.folderConfig ?? [];
  if (honoured.includes(value as never)) return underMinVersion(String(value), provider, install);
  const offers = honoured.length ? `It takes ${["load", ...honoured].map((v) => `"${v}"`).join(", ")}.` : `It loads whatever the folder carries.`;
  throw new FunnelError(`${provider.displayName} cannot run with folderConfig "${String(value)}". ${offers}`, "unsupported");
}

function underMinVersion(value: string, provider: Provider, install: Installation): void {
  const min = provider.capabilities.folderConfigMinVersion;
  if (!min) return;
  const name = `${provider.displayName}${install.version ? ` ${install.version}` : ""}`;
  if (!install.version) {
    throw new FunnelError(`${name} has no readable version, so cli-funnel cannot tell whether it keeps folderConfig "${value}" as promised. It needs ${min} or newer.`, "unsupported");
  }
  if (compareVersions(install.version, min) < 0) {
    throw new FunnelError(`${name} is too old for folderConfig "${value}". It needs ${min} or newer.`, "unsupported");
  }
}
