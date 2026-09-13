import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/**
 * Local team-orchestration authority.
 *
 * Paperclip's normal agent lifecycle routes are board-only (and wake is
 * self-only). This installation delegates those operations to a small set of
 * stable autonomous principals (Zane by default, plus any ids listed in
 * PAPERCLIP_TEAM_ORCHESTRATOR_AGENT_IDS).
 *
 * Wake authority is additionally granted along the org chart: an agent may
 * wake any agent that reports to it, directly or transitively, inside the
 * same company (see canAgentWakeAgent). Pause/resume stay orchestrator-only.
 * Keep the check server-side; filtering tool schemas is only a usability
 * layer, not an authorization boundary.
 */
export const TEAM_ORCHESTRATOR_AGENT_ID =
  process.env.PAPERCLIP_TEAM_ORCHESTRATOR_AGENT_ID?.trim()
  || "6fa7b823-647c-4b52-b8ae-268f078f3d46";

const TEAM_ORCHESTRATOR_AGENT_IDS: ReadonlySet<string> = new Set([
  TEAM_ORCHESTRATOR_AGENT_ID,
  ...(process.env.PAPERCLIP_TEAM_ORCHESTRATOR_AGENT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
]);

const WAKE_CHAIN_MAX_DEPTH = 10;

export function isTeamOrchestratorAgentId(agentId: string | null | undefined): boolean {
  return Boolean(agentId) && TEAM_ORCHESTRATOR_AGENT_IDS.has(agentId as string);
}

type WakeTarget = { id: string; companyId: string; reportsTo: string | null };

/**
 * May `actorAgentId` start a run for `target`?
 *
 * Allowed when the actor is the target itself, a team orchestrator, or a
 * manager of the target somewhere up its `reportsTo` chain. The chain walk is
 * company-scoped, so a hop that leaves the company (or dangles) denies.
 * Callers must already have run assertCompanyAccess for the target's company.
 */
export async function canAgentWakeAgent(
  db: Db,
  actorAgentId: string | null | undefined,
  target: WakeTarget,
): Promise<boolean> {
  if (!actorAgentId) return false;
  if (actorAgentId === target.id) return true;
  if (isTeamOrchestratorAgentId(actorAgentId)) return true;
  if (!target.reportsTo) return false;
  if (target.reportsTo === actorAgentId) return true;

  const rows = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.companyId, target.companyId));
  const reportsToById = new Map<string, string | null>(rows.map((row) => [row.id, row.reportsTo]));

  let cursor: string | null = target.reportsTo;
  for (let depth = 0; cursor && depth < WAKE_CHAIN_MAX_DEPTH; depth += 1) {
    if (cursor === actorAgentId) return true;
    if (!reportsToById.has(cursor)) return false;
    cursor = reportsToById.get(cursor) ?? null;
  }
  return false;
}
