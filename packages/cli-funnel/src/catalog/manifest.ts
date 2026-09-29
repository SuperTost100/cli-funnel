import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CliProviderId, ModelInfo, ProviderId } from "../types.js";

/** A manifest entry. Same as ModelInfo minus fields the loader fills in. */
export type ManifestModel = Omit<ModelInfo, "provider" | "source"> & {
  /** Hide the model on CLIs older than this version. */
  minCliVersion?: string;
};

export interface ModelManifest {
  schemaVersion: 1;
  updated: string;
  providers: Record<CliProviderId, ManifestModel[]>;
}

// Source files sit two levels below the package root, bundled files one.
const bundledDir = [new URL("../../data/models/", import.meta.url), new URL("../data/models/", import.meta.url)].find((u) =>
  existsSync(fileURLToPath(u)),
) ?? new URL("../../data/models/", import.meta.url);
const PROVIDER_IDS: CliProviderId[] = ["claude", "codex", "agent", "antigravity"];
let bundled: ModelManifest | undefined;
let remote: { url: string; at: number; data: ModelManifest } | undefined;

export async function loadBundledManifest(): Promise<ModelManifest> {
  if (bundled) return bundled;
  const providers = {} as ModelManifest["providers"];
  for (const id of PROVIDER_IDS) {
    providers[id] = JSON.parse(await readFile(fileURLToPath(new URL(`${id}.json`, bundledDir)), "utf8"));
  }
  bundled = { schemaVersion: 1, updated: "bundled", providers };
  return bundled;
}

/**
 * Returns the remote manifest when `url` is set and reachable, else the bundled one.
 * The remote copy lets model lists update without an npm release. It is cached for an hour.
 */
export async function loadManifest(url?: string): Promise<ModelManifest> {
  if (!url) return loadBundledManifest();
  if (remote && remote.url === url && Date.now() - remote.at < 3_600_000) return remote.data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = (await res.json()) as ModelManifest;
      if (data.schemaVersion === 1) {
        remote = { url, at: Date.now(), data };
        return data;
      }
    }
  } catch {
    /* offline is fine, fall back to the bundled copy */
  }
  return loadBundledManifest();
}

export function fromManifest(
  manifest: ModelManifest,
  provider: ProviderId,
  cliVersion?: string,
  compare?: (a: string, b: string) => number,
): ModelInfo[] {
  return ((manifest.providers as Partial<Record<ProviderId, ManifestModel[]>>)[provider] ?? [])
    .filter((m) => !m.minCliVersion || !cliVersion || !compare || compare(cliVersion, m.minCliVersion) >= 0)
    .map(({ minCliVersion: _min, ...m }) => ({ ...m, provider, source: "manifest" as const }));
}

/** Live CLI entries win over manifest entries with the same id. Manifest-only entries stay. */
export function mergeModels(live: ModelInfo[], fromFile: ModelInfo[]): ModelInfo[] {
  const seen = new Set(live.map((m) => m.id));
  return [...live, ...fromFile.filter((m) => !seen.has(m.id))];
}
