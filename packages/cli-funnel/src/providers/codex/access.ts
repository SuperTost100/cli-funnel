import type { AccessLevel } from "../../types.js";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface AccessPlan {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  approvalsReviewer: "user" | "auto_review";
  /** Whether file change approvals are answered without asking the caller. */
  autoAllowFileChanges: boolean;
}

export function planAccess(access: AccessLevel): AccessPlan {
  switch (access) {
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
