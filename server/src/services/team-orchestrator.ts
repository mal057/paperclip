/**
 * Local team-orchestration authority.
 *
 * Paperclip's normal agent lifecycle routes are board-only (and wake is
 * self-only). This installation delegates those operations to one stable
 * autonomous principal: Zane. Keep the check server-side; filtering tool
 * schemas is only a usability layer, not an authorization boundary.
 */
export const TEAM_ORCHESTRATOR_AGENT_ID =
  process.env.PAPERCLIP_TEAM_ORCHESTRATOR_AGENT_ID?.trim()
  || "6fa7b823-647c-4b52-b8ae-268f078f3d46";

export function isTeamOrchestratorAgentId(agentId: string | null | undefined): boolean {
  return Boolean(agentId) && agentId === TEAM_ORCHESTRATOR_AGENT_ID;
}
