import { describe, expect, it } from "vitest";
import { createFunnel } from "../src/funnel.js";

describe("feedback support across providers", () => {
  const funnel = createFunnel({ openaiCompatible: [{ id: "lab", name: "Lab", baseUrl: "http://127.0.0.1:1/v1" }] });

  it("gives every vendor a sourced manual channel and model servers none", () => {
    const vendors = ["claude", "codex", "agent", "antigravity", "anthropic-api", "openai-api", "gemini-api"] as const;
    for (const id of vendors) {
      const channel = funnel.feedbackSupport(id).channel;
      expect(channel, id).toBeDefined();
      expect(channel!.sources.length, id).toBeGreaterThan(0);
      for (const url of [channel!.url, ...channel!.sources]) if (url) expect(url, id).toMatch(/^https:\/\//);
      expect(channel!.url ?? channel!.email ?? channel!.note, id).toBeTruthy();
    }
    expect(funnel.feedbackSupport("ollama")).toEqual({ provider: "ollama", send: false });
    expect(funnel.feedbackSupport("openai-compatible:lab")).toEqual({ provider: "openai-compatible:lab", send: false });
  });

  it("sends only through Codex", () => {
    const senders = Object.keys(funnel.providers).filter((id) => funnel.feedbackSupport(id as never).send);
    expect(senders).toEqual(["codex"]);
  });

  it("refuses a bad report before it looks at the provider's channel", async () => {
    await expect(funnel.sendFeedback("ollama", { classification: "bad" as never })).rejects.toMatchObject({ code: "invalid-selection" });
    expect(await funnel.sendFeedback("ollama", { classification: "bad_result" })).toEqual({ provider: "ollama", sent: false });
  });
});
