import { describe, expect, it } from "vitest";
import { mergeModels } from "../src/catalog/manifest.js";
import type { ModelInfo } from "../src/types.js";

const model = (id: string, source: ModelInfo["source"]): ModelInfo => ({ id, name: id, provider: "codex", efforts: [], contextWindows: [], fast: false, source });

describe("mergeModels", () => {
  it("marks live entries as cli and manifest-only entries as manifest", () => {
    const merged = mergeModels([model("a", "cli"), model("b", "cli")], [model("b", "manifest"), model("gone", "manifest")]);
    expect(merged.map((m) => [m.id, m.source])).toEqual([["a", "cli"], ["b", "cli"], ["gone", "manifest"]]);
  });

  it("keeps the live entry when both name the same id", () => {
    const live = { ...model("a", "cli"), name: "Live name" };
    expect(mergeModels([live], [{ ...model("a", "manifest"), name: "File name" }])).toEqual([live]);
  });

  it("marks everything manifest when there is no live list", () => {
    expect(mergeModels([], [model("a", "manifest")]).every((m) => m.source === "manifest")).toBe(true);
  });
});
