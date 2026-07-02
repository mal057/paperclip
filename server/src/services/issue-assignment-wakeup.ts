import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  // Pump-sole-driver isolation (single local GPU). When the external serial
  // pump is the ONLY thing allowed to start agent runs, Paperclip must NOT
  // auto-wake an assignee on assignment/creation: that bypasses the pump and
  // spawns concurrent orchestrators (the 2026-06-28 churn cascade — Zane
  // delegates a child ticket -> assignee auto-woken -> 2nd orchestrator).
  // Default behavior is unchanged; fully reversible by unsetting the env.
  if (process.env.PAPERCLIP_DISABLE_ASSIGNMENT_WAKE === "1") {
    logger.info(
      {
        issueId: input.issue.id,
        assigneeAgentId: input.issue.assigneeAgentId,
        mutation: input.mutation,
      },
      "assignment wake suppressed (PAPERCLIP_DISABLE_ASSIGNMENT_WAKE=1; pump is sole driver)",
    );
    return;
  }

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
