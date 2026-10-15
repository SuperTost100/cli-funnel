import { useEffect, useRef } from "react";
import type { ApprovalDecision, ApprovalRequest } from "cli-funnel/client";

export interface ApprovalPromptProps {
  request: ApprovalRequest;
  onDecide: (id: string, decision: ApprovalDecision) => void;
  className?: string;
}

/** The approve button for supervised runs. Render one per entry in `useRun().approvals`. */
export function ApprovalPrompt({ request, onDecide, className }: ApprovalPromptProps) {
  const allow = useRef<HTMLButtonElement>(null);
  // Move focus into the prompt so keyboard and screen reader users notice it, and give it back when it closes.
  useEffect(() => {
    const before = document.activeElement;
    allow.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, []);
  const detail = typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2);
  return (
    <div className={`cf cf-approval ${className ?? ""}`} role="alertdialog" aria-label={`Approve ${request.tool}`}>
      <strong>{request.tool}</strong>
      {request.description && <p>{request.description}</p>}
      <pre className="cf-mono">{detail}</pre>
      <div className="cf-row">
        <button ref={allow} type="button" className="cf-primary" onClick={() => onDecide(request.id, "allow")}>
          Allow
        </button>
        <button type="button" onClick={() => onDecide(request.id, "deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
