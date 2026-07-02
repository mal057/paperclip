import { z } from "zod";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { isTeamOrchestratorAgentId } from "./team-orchestrator.js";

export const handoffIssueSchema = z.object({
  targetAgentId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2_000),
  evidence: z.string().trim().min(1).max(16_000),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export interface HandoffIssue {
  id: string;
  companyId: string;
  identifier?: string | null;
  status: string;
  assigneeAgentId: string | null;
  parentAssigneeAgentId?: string | null;
}

export interface HandoffAgent {
  id: string;
  companyId: string;
  name: string;
  status: string;
  reportsTo?: string | null;
}

export interface PriorIssueHandoff {
  fromAgentId: string;
  toAgentId: string;
  idempotencyKey: string;
}

export interface IssueHandoffPolicyInput {
  issue: HandoffIssue | null;
  actor: HandoffAgent | null;
  target: HandoffAgent | null;
  priorHandoff?: PriorIssueHandoff | null;
  duplicateIdempotencyKey?: boolean;
}

export function validateIssueHandoffPolicy(input: IssueHandoffPolicyInput): void {
  const { issue, actor, target } = input;
  if (!issue) throw notFound("Issue not found");
  if (!actor) throw forbidden("Authenticated agent not found");
  if (!target || target.companyId !== issue.companyId) throw notFound("Target agent not found");
  if (actor.companyId !== issue.companyId) throw forbidden("Issue is outside the caller's company");
  if (issue.assigneeAgentId !== actor.id) {
    throw forbidden("Only the current issue assignee can hand off this issue");
  }
  if (!["in_progress", "in_review", "todo", "blocked"].includes(issue.status)) {
    throw conflict(`Issue status ${issue.status} cannot be handed off`);
  }
  if (actor.id === target.id) throw unprocessable("Self-handoff is not allowed");
  if (input.duplicateIdempotencyKey) {
    throw conflict("Duplicate issue handoff request");
  }

  const targetIsOrchestrator = isTeamOrchestratorAgentId(target.id);
  const isAdjacentInOrg =
    actor.reportsTo === target.id
    || target.reportsTo === actor.id;
  const isParentIssueOwner = issue.parentAssigneeAgentId === target.id;
  if (!targetIsOrchestrator && !isAdjacentInOrg && !isParentIssueOwner) {
    throw forbidden(
      "Target is not an authorized next participant in this issue workflow",
    );
  }

  const prior = input.priorHandoff;
  if (
    prior
    && prior.fromAgentId === target.id
    && prior.toAgentId === actor.id
    && !targetIsOrchestrator
  ) {
    throw conflict("Circular issue handoff is not allowed");
  }
}

export interface CommittedIssueHandoff {
  issueId: string;
  companyId: string;
  issueIdentifier?: string | null;
  fromAgentId: string;
  toAgentId: string;
  targetName: string;
  status: string;
  commentId: string;
  idempotencyKey: string;
}

export interface IssueHandoffWake {
  id?: string | null;
  status?: string | null;
}

export async function coordinateIssueHandoff(input: {
  commit: () => Promise<CommittedIssueHandoff>;
  wake: (handoff: CommittedIssueHandoff) => Promise<IssueHandoffWake | null>;
  recordWakeFailure?: (
    handoff: CommittedIssueHandoff,
    error: unknown,
  ) => Promise<void>;
}) {
  const handoff = await input.commit();
  try {
    const run = await input.wake(handoff);
    if (!run) {
      throw conflict("Issue handoff wake request was skipped");
    }
    if (!run.id) {
      throw conflict("Issue handoff wake response did not include a run identifier");
    }
    return {
      handoff,
      wake: {
        runId: run.id,
        status: run.status ?? "queued",
      },
    };
  } catch (error) {
    await input.recordWakeFailure?.(handoff, error).catch(() => {});
    const status = error instanceof HttpError ? error.status : 503;
    const message = error instanceof Error ? error.message : "Issue handoff wake failed";
    throw new HttpError(status, message, {
      handoff,
      wake: {
        status: "failed",
        error: message,
      },
    });
  }
}
