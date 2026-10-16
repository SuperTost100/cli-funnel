import type { RunInput } from "../../types.js";
import { bool, invalidOption, oneOf, optionsFor, requireAccess } from "../options.js";
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
