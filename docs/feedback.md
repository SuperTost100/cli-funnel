# Feedback reports

`funnel.sendFeedback(provider, report)` sends a report about a result to the vendor, the same way the CLI's own feedback command does. Only Codex has a headless path for it. Every other provider resolves with `sent: false` and the vendor's manual channel, and nothing leaves the machine.

Use it behind a "Report this result" control. Store policies such as Microsoft Store policy 11.16 ask apps that show generated content to offer one.

## Check what a provider supports

`funnel.feedbackSupport(provider)` answers without starting a process, so a UI can pick the right control before the user clicks.

```ts
funnel.feedbackSupport("codex");
// { provider: "codex", send: true, channel: { url: "https://openai.com/form/report-content/", ... } }
funnel.feedbackSupport("claude");
// { provider: "claude", send: false, channel: { url: "https://claude.com/form/anthropic-content-reporting", email: "usersafety@anthropic.com", ... } }
funnel.feedbackSupport("ollama");
// { provider: "ollama", send: false }
```

`send: true` means `sendFeedback` uploads the report. `channel` is where a person reports by hand, with `url`, `email`, a `note` on what it takes or where to find it, and `sources`, the vendor pages that name it. Codex has both: the upload and OpenAI's form.

## Send a report

```ts
const result = await funnel.sendFeedback("codex", {
  classification: "bad_result",
  sessionId,
  reason: "It invented a function that does not exist.",
  includeLogs: true,
});
if (result.sent) show(`Sent. Report id ${result.reportId}`);
else if (result.channel) openReportPage(result.channel);
```

| Field | Meaning |
| --- | --- |
| `classification` | One of `bug`, `bad_result`, `good_result`, `safety_check`, `other`. Required. Anything else throws `invalid-selection` before a process starts. |
| `sessionId` | The session the report is about. On Codex it is the thread id. |
| `reason` | The user's own words. Blank text is left out. |
| `includeLogs` | Off by default. On Codex it uploads the CLI's logs, a diagnostics report and, with `sessionId`, the saved conversation. Ask the user before turning it on. |

The third argument takes `env` and `signal`, like the other one-off calls. Pass `env: { CODEX_HOME: dir }` when the session lives in another Codex home.

> [!WARNING]
> A Codex report reaches OpenAI. Do not send one from a test. The tests in this repo run against a fake app-server.

## Codex

`sendFeedback` starts a short-lived `codex app-server`, sends `feedback/upload` and stops it. These are the params the TUI's `/feedback` sends:

| Report field | `feedback/upload` param |
| --- | --- |
| `classification` | `classification` |
| `reason` | `reason` |
| `sessionId` | `threadId` |
| `includeLogs` | `includeLogs` |

The answer's `threadId` becomes `reportId`. Codex sets it to the reported thread id, or to `no-active-thread-<uuid>` without a session. The TUI's `/feedback` puts the same id in the issue link it shows. The call waits up to two minutes, because Codex gathers logs and a diagnostics report before the upload. A Codex error, such as `sending feedback is disabled by configuration` or more than three uploads at once, comes back as `FunnelError` with code `cli-failed`. A timeout or a Codex exit before the answer does not prove the report was not sent, so do not retry on your own: let the user decide.

The five classifications are the ones Codex itself uses:

- [`codex-rs/tui/src/bottom_pane/feedback_view.rs`](https://github.com/openai/codex/blob/e54a5713caf331f42a6eef0166186df5f7563c29/codex-rs/tui/src/bottom_pane/feedback_view.rs#L37-L45) maps the TUI's categories to these strings.
- [`codex-rs/feedback/src/lib.rs`](https://github.com/openai/codex/blob/e54a5713caf331f42a6eef0166186df5f7563c29/codex-rs/feedback/src/lib.rs#L985-L993) files any other string as "Other".
- [`codex-rs/app-server-protocol/src/protocol/v2/feedback.rs`](https://github.com/openai/codex/blob/e54a5713caf331f42a6eef0166186df5f7563c29/codex-rs/app-server-protocol/src/protocol/v2/feedback.rs) defines the params and the response.

## Channels by provider

Checked on 2026-11-09. None of these vendors documents a headless path other than Codex's.

| Provider | Path | Channel | Source |
| --- | --- | --- | --- |
| Codex | headless, `feedback/upload` | Also [OpenAI's report form](https://openai.com/form/report-content/) | [openai/codex](https://github.com/openai/codex/blob/e54a5713caf331f42a6eef0166186df5f7563c29/codex-rs/app-server-protocol/src/protocol/v2/feedback.rs), [OpenAI help](https://help.openai.com/en/articles/10245791) |
| Claude Code | manual | [Anthropic's content form](https://claude.com/form/anthropic-content-reporting), `usersafety@anthropic.com` for safety issues, `/feedback` in the interactive terminal or a GitHub issue for bugs | [Claude help center](https://support.claude.com/en/articles/7996906), [troubleshooting](https://code.claude.com/docs/en/troubleshooting) |
| Cursor Agent | manual | [Cursor forum, Bug Reports](https://forum.cursor.com/c/bug-report/6), `hi@cursor.com`, with the request id | [Reporting bugs](https://cursor.com/help/troubleshooting/reporting-bugs), [Cursor abuse page](https://cursor.com/abuse) |
| Antigravity | manual | In the app: Settings, then Provide Feedback | [Getting started codelab](https://codelabs.developers.google.com/getting-started-google-antigravity) |
| Anthropic API | manual | [Anthropic's content form](https://claude.com/form/anthropic-content-reporting), `usersafety@anthropic.com` for safety issues | [Claude help center](https://support.claude.com/en/articles/7996906) |
| OpenAI API | manual | [OpenAI's report form](https://openai.com/form/report-content/) | [OpenAI help](https://help.openai.com/en/articles/10245791) |
| Gemini API | manual | [Google Cloud's report form](https://support.google.com/code/contact/cloud_platform_report), and ratings on logged calls in AI Studio for the project owner | [Vertex AI responsible AI](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/responsible-ai), [Gemini API logs](https://aistudio.google.com/docs/logs-policy) |
| Ollama | none | The server's operator or the model's publisher | |
| OpenAI-compatible | none | The server's operator or the model's publisher | |

Why the others stay manual:

- **Claude Code**: `/feedback` and `/bug` open a dialog with a consent screen in the interactive terminal, and `claude --help` has no feedback subcommand. The [commands page](https://code.claude.com/docs/en/commands) and the [data usage page](https://code.claude.com/docs/en/data-usage) document no endpoint.
- **Cursor Agent**: `/feedback <message>` is an interactive [slash command](https://cursor.com/docs/cli/reference/slash-commands). The docs do not say it works with `-p`, and testing it would send a real report.
- **Antigravity**: `agy --help` lists no feedback subcommand. Its feedback box is part of the interactive app.
- **Gemini API**: the project owner can rate logged calls in AI Studio's Logs and Datasets page, when billing and logging are on for the project. That is not a channel for the app's users, so cli-funnel returns the Cloud form Google documents for Gemini on Vertex AI and names AI Studio in the note.
- **Anthropic, OpenAI and Gemini APIs**: none has a documented feedback endpoint.

The channels live in `packages/cli-funnel/src/providers/feedback.ts`. Update them there when a vendor changes its pages.
