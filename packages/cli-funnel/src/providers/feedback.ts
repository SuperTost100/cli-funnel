import { FEEDBACK_CLASSIFICATIONS, FunnelError, type FeedbackChannel, type FeedbackReport } from "../types.js";

/**
 * The vendors' manual reporting channels, checked on 2026-11-09. Only Codex has a headless path (`feedback/upload`).
 * The others take reports in their own app, on a web form or by email. See docs/feedback.md for the sources.
 */
export const FEEDBACK_CHANNELS = {
  anthropic: {
    url: "https://claude.com/form/anthropic-content-reporting",
    email: "usersafety@anthropic.com",
    note: "The form takes content that breaks Anthropic's usage policies or the law. The address takes safety issues, with enough detail to replicate them.",
    sources: ["https://support.claude.com/en/articles/7996906"],
  },
  openai: {
    url: "https://openai.com/form/report-content/",
    note: "Takes content that breaks OpenAI's terms or the law.",
    sources: ["https://help.openai.com/en/articles/10245791"],
  },
  cursor: {
    url: "https://forum.cursor.com/c/bug-report/6",
    email: "hi@cursor.com",
    note: "Include the request id of the run.",
    sources: ["https://cursor.com/help/troubleshooting/reporting-bugs", "https://cursor.com/abuse"],
  },
  antigravity: {
    note: "Antigravity takes feedback only inside its app: Settings, in the bottom left, then Provide Feedback.",
    sources: ["https://codelabs.developers.google.com/getting-started-google-antigravity"],
  },
  google: {
    url: "https://support.google.com/code/contact/cloud_platform_report",
    note: "Google documents this form for inappropriate or inaccurate output from Gemini on Vertex AI. The Gemini API docs name no channel of their own.",
    sources: ["https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/responsible-ai"],
  },
} satisfies Record<string, FeedbackChannel>;

/** Refuses a report the vendor would misfile. Codex accepts any classification and files unknown ones as "other". */
export function checkFeedbackReport(report: FeedbackReport): void {
  if (!(FEEDBACK_CLASSIFICATIONS as readonly unknown[]).includes(report?.classification)) {
    throw new FunnelError(`classification must be one of ${FEEDBACK_CLASSIFICATIONS.join(", ")}.`, "invalid-selection");
  }
  if (report.sessionId !== undefined && (typeof report.sessionId !== "string" || !report.sessionId)) {
    throw new FunnelError("sessionId must be a non-empty string.", "invalid-selection");
  }
  if (report.reason !== undefined && typeof report.reason !== "string") throw new FunnelError("reason must be a string.", "invalid-selection");
  if (report.includeLogs !== undefined && typeof report.includeLogs !== "boolean") {
    throw new FunnelError("includeLogs must be true or false.", "invalid-selection");
  }
}
