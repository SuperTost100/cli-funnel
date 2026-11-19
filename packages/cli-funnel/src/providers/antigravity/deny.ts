/**
 * The texts that say a tool call was refused at access `none`, and the one test that tells a refusal from a failure.
 * Only text that cli-funnel or agy writes counts. A tool's own output never does, so a tool that failed with a line
 * that merely starts like a refusal is not counted as refused.
 */

/** What the deny hook tells the model, and agy repeats in its refusal. */
export const DENY_REASON = "Tools are disabled. Answer in text only.";

/**
 * What the deny hook of a run with MCP servers tells the model: where its tools are, so it does not stop at the first
 * refusal. No character here may mean something to `cmd.exe` (`<`, `>`, `&`, `|`, `^`, `%`): on Windows the hook is an
 * `echo` of this text, and the hook self-test on a Windows runner refused it with `<server>` in it.
 */
export const DENY_REASON_WITH_MCP = "Tools are disabled except your MCP tools. Call those by their own names, which start with mcp_, not through call_mcp_tool.";

/** The reason of every hook cli-funnel writes. */
export const DENY_REASONS: readonly string[] = [DENY_REASON, DENY_REASON_WITH_MCP];

/** The text of a refused call that we denied through `session/request_permission`. */
export const PERMISSION_DENIED = "denied permission: cli-funnel does not approve tool calls on this transport.";

/**
 * The hook's refusal as a whole: agy's own message (`tool call denied by pre-tool hook: <reason>`, which the print
 * transport reports) and the shorter one the ACP mapper writes for a call that failed in the shape of a refusal.
 */
export const HOOK_REFUSAL_TEXTS: readonly string[] = DENY_REASONS.flatMap((reason) => [`tool call denied by pre-tool hook: ${reason}`, `denied by pre-tool hook: ${reason}`]);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The error of a `tool.end` that counts as a refusal at `none`: after the mapper's `denied: `, one of these texts exactly. */
export const AGY_REFUSAL = new RegExp(`^denied: (?:${[...HOOK_REFUSAL_TEXTS, PERMISSION_DENIED].map(escape).join("|")})$`);
