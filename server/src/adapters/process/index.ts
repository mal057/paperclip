import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const processAdapter: ServerAdapterModule = {
  type: "process",
  // Local first-party agents run on this generic adapter and call back into the
  // Paperclip API (handoff_issue, comments, status). They need the per-run,
  // company-scoped agent JWT injected as PAPERCLIP_API_KEY, exactly like the
  // dedicated *-local adapters. Without this the server mints no token and the
  // spawned orchestrator runs unauthenticated (handoff 403, comments attributed
  // to local-board).
  supportsLocalAgentJwt: true,
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# process agent configuration

Adapter: process

Core fields:
- command (string, required): command to execute
- args (string[] | string, optional): command arguments
- cwd (string, optional): absolute working directory
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds
`,
};
