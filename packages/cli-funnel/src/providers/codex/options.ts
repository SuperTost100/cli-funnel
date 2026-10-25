import type { RunInput } from "../../types.js";
import { bool, invalidOption, mcpServersFor, oneOf, optionsFor, requireAccess } from "../options.js";
import { requireMachine } from "../../selection.js";
import { planAccess, type ApprovalPolicy } from "./access.js";

/** From the policy that asks most to the one that asks least. */
const POLICIES: readonly ApprovalPolicy[] = ["untrusted", "on-request", "never"];
const WEB_SEARCH = ["disabled", "cached", "indexed", "live"] as const;

export interface CodexThreadOptions {
  /** Replaces the access plan's policy. */
  approvalPolicy?: ApprovalPolicy;
  /** Extra `thread/start` params. `thread/resume` takes none of them. */
  start: { ephemeral?: boolean };
  /** Config overrides in the dotted form `codex -c` takes. */
  config: Record<string, unknown>;
}

/** Checks `providerOptions.codex` and turns it into app-server params. Throws `invalid-selection` when an option would widen access. */
export function threadOptions(input: RunInput): CodexThreadOptions {
  const o = optionsFor(input, "codex", ["ephemeral", "webSearch", "approvalPolicy"]);
  const { access } = requireMachine(input.selection);
  const out: CodexThreadOptions = { start: {}, config: {} };

  const ephemeral = bool(o.ephemeral, "ephemeral");
  if (ephemeral !== undefined) {
    if (input.sessionId) invalidOption("ephemeral applies to new threads only. Leave it out when you pass sessionId.");
    out.start.ephemeral = ephemeral;
  }

  const search = oneOf(o.webSearch, "webSearch", WEB_SEARCH);
  // "live" fetches pages with nobody approving it, so it needs a level that runs without approvals.
  if (search === "live") requireAccess(access, ["auto", "full"], 'webSearch "live"');
  else if (search && search !== "disabled") requireAccess(access, ["supervised", "accept-edits", "auto", "full"], `webSearch "${search}"`);
  // At `none` the tool config already sets web_search to "disabled".
  if (search && access !== "none") out.config.web_search = search;

  const policy = oneOf(o.approvalPolicy, "approvalPolicy", POLICIES);
  if (policy) {
    const own = planAccess(access).approvalPolicy;
    if (POLICIES.indexOf(policy) > POLICIES.indexOf(own)) {
      invalidOption(`approvalPolicy "${policy}" asks less often than access "${access}" allows. Use "${own}" or a stricter policy.`);
    }
    out.approvalPolicy = policy;
  }
  return out;
}

/**
 * `RunInput.mcpServers` as config keys under `mcp_servers.<name>`, in the dotted form. Only the caller's names get
 * keys, so the servers in the user's config stay as they are. `autoApprove` sets the server's
 * `default_tools_approval_mode` to "approve", which Codex checks before it asks for an MCP tool approval.
 */
export function mcpConfig(input: RunInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, s] of mcpServersFor(input, ["http", "stdio"])) {
    const key = `mcp_servers.${name}`;
    if (s.type === "http") {
      out[`${key}.url`] = s.url;
      if (s.headers && Object.keys(s.headers).length) out[`${key}.http_headers`] = s.headers;
      if (s.autoApprove) out[`${key}.default_tools_approval_mode`] = "approve";
    } else {
      out[`${key}.command`] = s.command;
      if (s.args) out[`${key}.args`] = s.args;
      if (s.env && Object.keys(s.env).length) out[`${key}.env`] = s.env;
    }
    if (s.toolTimeoutSec !== undefined) out[`${key}.tool_timeout_sec`] = s.toolTimeoutSec;
  }
  return out;
}

/**
 * Config for the agent features of the contract, in the dotted form.
 * - Codex 0.164 registers its `update_plan` tool only with `tools.update_plan.enabled`, so plans are switched on at
 *   every level but `none`, where tools stay off.
 * - The model offers `request_user_input` outside plan mode only with the `default_mode_request_user_input` feature.
 *   It is switched on when the caller passes `onQuestion`. Asking the user touches nothing on the machine, so every
 *   level takes it.
 * - The caller's MCP servers. `mcpServersFor` refuses them at `none`, and stdio servers below `full`.
 */
export function agentConfig(input: RunInput): Record<string, unknown> {
  const { access } = requireMachine(input.selection);
  return {
    ...(access !== "none" ? { "tools.update_plan.enabled": true } : {}),
    ...(input.onQuestion ? { "features.default_mode_request_user_input": true } : {}),
    ...mcpConfig(input),
  };
}
