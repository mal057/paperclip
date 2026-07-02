import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import {
  coordinateIssueHandoff,
  handoffIssueSchema,
  validateIssueHandoffPolicy,
  type CommittedIssueHandoff,
  type HandoffAgent,
  type HandoffIssue,
} from "../services/issue-handoff.js";
import { TEAM_ORCHESTRATOR_AGENT_ID } from "../services/team-orchestrator.js";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const REVIEWER_ID = "22222222-2222-4222-8222-222222222222";
const UNRELATED_ID = "33333333-3333-4333-8333-333333333333";

function issue(overrides: Partial<HandoffIssue> = {}): HandoffIssue {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    identifier: "DXD-1",
    status: "in_progress",
    assigneeAgentId: WORKER_ID,
    parentAssigneeAgentId: null,
    ...overrides,
  };
}

function agent(
  id: string,
  overrides: Partial<HandoffAgent> = {},
): HandoffAgent {
  return {
    id,
    companyId: "company-1",
    name: id === WORKER_ID ? "Worker" : "Reviewer",
    status: "idle",
    reportsTo: null,
    ...overrides,
  };
}

function committed(): CommittedIssueHandoff {
  return {
    issueId: issue().id,
    companyId: "company-1",
    issueIdentifier: "DXD-1",
    fromAgentId: WORKER_ID,
    toAgentId: REVIEWER_ID,
    targetName: "Reviewer",
    status: "todo",
    commentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    idempotencyKey: "handoff-test-1",
  };
}

describe("issue handoff policy", () => {
  it("allows the current assignee to hand off to an adjacent reviewer", () => {
    expect(() => validateIssueHandoffPolicy({
      issue: issue(),
      actor: agent(WORKER_ID, { reportsTo: REVIEWER_ID }),
      target: agent(REVIEWER_ID),
    })).not.toThrow();
  });

  it("allows a worker to return its issue to Zane", () => {
    expect(() => validateIssueHandoffPolicy({
      issue: issue(),
      actor: agent(WORKER_ID),
      target: agent(TEAM_ORCHESTRATOR_AGENT_ID, { name: "Zane" }),
      priorHandoff: {
        fromAgentId: TEAM_ORCHESTRATOR_AGENT_ID,
        toAgentId: WORKER_ID,
        idempotencyKey: "zane-to-worker",
      },
    })).not.toThrow();
  });

  it.each([
    ["unassigned issue", issue({ assigneeAgentId: UNRELATED_ID }), agent(WORKER_ID), agent(REVIEWER_ID)],
    ["missing actor", issue(), null, agent(REVIEWER_ID)],
    ["missing target", issue(), agent(WORKER_ID), null],
    ["cross-company target", issue(), agent(WORKER_ID), agent(REVIEWER_ID, { companyId: "company-2" })],
    ["terminal issue", issue({ status: "done" }), agent(WORKER_ID), agent(REVIEWER_ID)],
  ])("rejects %s", (_label, candidateIssue, actor, target) => {
    expect(() => validateIssueHandoffPolicy({
      issue: candidateIssue,
      actor,
      target,
    })).toThrow(HttpError);
  });

  it("rejects self-handoff and unrelated targets", () => {
    expect(() => validateIssueHandoffPolicy({
      issue: issue(),
      actor: agent(WORKER_ID),
      target: agent(WORKER_ID),
    })).toThrow("Self-handoff");

    expect(() => validateIssueHandoffPolicy({
      issue: issue(),
      actor: agent(WORKER_ID),
      target: agent(UNRELATED_ID),
    })).toThrow("not an authorized next participant");
  });

  it("rejects duplicate and circular handoffs", () => {
    expect(() => validateIssueHandoffPolicy({
      issue: issue(),
      actor: agent(WORKER_ID, { reportsTo: REVIEWER_ID }),
      target: agent(REVIEWER_ID),
      duplicateIdempotencyKey: true,
    })).toThrow("Duplicate issue handoff");

    expect(() => validateIssueHandoffPolicy({
      issue: issue(),
      actor: agent(WORKER_ID, { reportsTo: REVIEWER_ID }),
      target: agent(REVIEWER_ID),
      priorHandoff: {
        fromAgentId: REVIEWER_ID,
        toAgentId: WORKER_ID,
        idempotencyKey: "reviewer-to-worker",
      },
    })).toThrow("Circular issue handoff");
  });

  it("requires one UUID target, reason, evidence, and idempotency key", () => {
    expect(handoffIssueSchema.safeParse({
      targetAgentId: REVIEWER_ID,
      reason: "Implementation is ready for review",
      evidence: "pytest: 12 passed",
      idempotencyKey: "worker-review-1",
    }).success).toBe(true);

    expect(handoffIssueSchema.safeParse({
      targetAgentIds: [REVIEWER_ID, UNRELATED_ID],
      reason: "bulk handoff",
      evidence: "some evidence",
      idempotencyKey: "bulk-review-1",
    }).success).toBe(false);

    expect(handoffIssueSchema.safeParse({
      targetAgentId: REVIEWER_ID,
      reason: "",
      evidence: "",
      idempotencyKey: "short",
    }).success).toBe(false);
  });
});

describe("issue handoff wake sequencing", () => {
  it("commits first and wakes exactly one target with a visible run id", async () => {
    const order: string[] = [];
    const commit = vi.fn(async () => {
      order.push("commit");
      return committed();
    });
    const wake = vi.fn(async (handoff: CommittedIssueHandoff) => {
      order.push(`wake:${handoff.toAgentId}`);
      return { id: "run-1", status: "queued" };
    });

    await expect(coordinateIssueHandoff({ commit, wake })).resolves.toEqual({
      handoff: committed(),
      wake: { runId: "run-1", status: "queued" },
    });
    expect(order).toEqual(["commit", `wake:${REVIEWER_ID}`]);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("propagates paused/conflict wake failures with committed handoff details", async () => {
    const recordWakeFailure = vi.fn(async () => undefined);
    const wake = vi.fn(async () => {
      throw new HttpError(409, "Agent is not invokable", { status: "paused" });
    });

    try {
      await coordinateIssueHandoff({
        commit: async () => committed(),
        wake,
        recordWakeFailure,
      });
      throw new Error("Expected handoff to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(409);
      expect((error as HttpError).details).toMatchObject({
        handoff: { issueId: issue().id, toAgentId: REVIEWER_ID },
        wake: { status: "failed", error: "Agent is not invokable" },
      });
    }
    expect(recordWakeFailure).toHaveBeenCalledTimes(1);
  });

  it("treats skipped or malformed queue responses as failures", async () => {
    await expect(coordinateIssueHandoff({
      commit: async () => committed(),
      wake: async () => null,
    })).rejects.toMatchObject({ status: 409 });

    await expect(coordinateIssueHandoff({
      commit: async () => committed(),
      wake: async () => ({ status: "queued" }),
    })).rejects.toMatchObject({ status: 409 });
  });
});
