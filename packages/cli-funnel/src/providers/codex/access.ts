import { FunnelError, type AccessLevel, type AccessReduced } from "../../types.js";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** From the policy that asks most to the one that asks least. */
export const POLICIES: readonly ApprovalPolicy[] = ["untrusted", "on-request", "never"];
/** From the narrowest sandbox to the widest. */
const SANDBOXES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
/** The sandbox names in the `sandbox.type` of a `thread/start` answer. */
const SANDBOX_TYPES: Record<string, SandboxMode> = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };

export interface AccessPlan {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  approvalsReviewer: "user" | "auto_review";
  /** Whether file change approvals are answered without asking the caller. */
  autoAllowFileChanges: boolean;
}

export function planAccess(access: AccessLevel): AccessPlan {
  switch (access) {
    case "none":
      // Read-only sandbox, and every approval is answered "deny" without asking the caller.
      return { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user", autoAllowFileChanges: false };
    case "supervised":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write", approvalsReviewer: "user", autoAllowFileChanges: false };
    case "accept-edits":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write", approvalsReviewer: "user", autoAllowFileChanges: true };
    case "auto":
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review", autoAllowFileChanges: false };
    case "full":
      return { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user", autoAllowFileChanges: true };
  }
}

/** The `sandbox` key of the app-server's `thread/start` and `thread/resume` for the run: `sandbox: true` keeps `full` in `workspace-write`. */
export function sandboxFor(access: AccessLevel, sandbox: boolean | undefined): SandboxMode {
  const mode = planAccess(access).sandbox;
  return sandbox && mode === "danger-full-access" ? "workspace-write" : mode;
}

/** The `writable_roots` of `sandbox_workspace_write` in the answer to `config/read`, as the user's config sets them. */
export function configWritableRoots(res: unknown): string[] {
  const roots = (res as { config?: { sandbox_workspace_write?: { writable_roots?: unknown } | null } } | null)?.config?.sandbox_workspace_write?.writable_roots;
  return Array.isArray(roots) ? roots.filter((r): r is string => typeof r === "string") : [];
}

/**
 * Compares what `thread/start` or `thread/resume` asked for with what the answer says the thread started with. A
 * requirements file or managed config can force a narrower sandbox or another approval policy without failing the
 * request. `warnings` are the `configWarning` summaries received so far, which give the reason.
 *
 * Returns the narrower sandbox, or undefined when the sandbox is as asked, or when the answer has no sandbox type this
 * code knows. Throws `cli-failed` when Codex asks for approval less often than the level needs: at `supervised` every
 * tool call must reach `onApproval`, and a forced `never` would run commands without asking. A policy that asks more
 * often is fine, and an answer with no known policy is ignored.
 */
export function startedAccess(
  access: AccessLevel,
  asked: { sandbox: SandboxMode; approvalPolicy: ApprovalPolicy },
  answer: { sandbox?: { type?: unknown }; approvalPolicy?: unknown },
  warnings: readonly string[],
): AccessReduced | undefined {
  const policy = POLICIES.find((p) => p === answer.approvalPolicy);
  if (policy && POLICIES.indexOf(policy) > POLICIES.indexOf(asked.approvalPolicy)) {
    const why = warnings.find((w) => w.includes("approval_policy"));
    throw new FunnelError(
      `Codex started with approval policy "${policy}", but access "${access}" needs "${asked.approvalPolicy}" or one that asks more often.${why ? ` Codex said: ${why}` : ""}`,
      "cli-failed",
    );
  }
  const type = answer.sandbox?.type;
  const started = typeof type === "string" ? SANDBOX_TYPES[type] : undefined;
  if (!started || SANDBOXES.indexOf(started) >= SANDBOXES.indexOf(asked.sandbox)) return undefined;
  const reason = warnings.filter((w) => w.includes("sandbox_mode") || w.includes("permission_profile")).join(" ");
  return { access, expected: asked.sandbox, started, ...(reason ? { reason } : {}) };
}
