import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../adapters/process/execute.js";
import { processAdapter } from "../adapters/process/index.js";

type CapturePayload = {
  paperclipEnvKeys: string[];
  apiKey: string;
  runId: string;
};

async function writeFakeProcessCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
const payload = {
  paperclipEnvKeys: Object.keys(process.env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort(),
  apiKey: process.env.PAPERCLIP_API_KEY || "",
  runId: process.env.PAPERCLIP_RUN_ID || "",
};
if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(payload), "utf8");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

const baseAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Process Agent",
  adapterType: "process",
  adapterConfig: {},
};

const baseRuntime = {
  sessionId: null,
  sessionParams: null,
  sessionDisplayId: null,
  taskKey: null,
};

describe("process adapter", () => {
  it("declares local-agent JWT support so the server mints a token", () => {
    expect(processAdapter.supportsLocalAgentJwt).toBe(true);
  });

  it("injects PAPERCLIP_API_KEY (from authToken) and PAPERCLIP_RUN_ID", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-execute-"));
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await writeFakeProcessCommand(commandPath);
    try {
      const result = await execute({
        runId: "run-123",
        agent: baseAgent,
        runtime: baseRuntime,
        config: {
          command: commandPath,
          cwd: root,
          env: { PAPERCLIP_TEST_CAPTURE_PATH: capturePath },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.paperclipEnvKeys).toEqual(
        expect.arrayContaining([
          "PAPERCLIP_AGENT_ID",
          "PAPERCLIP_API_KEY",
          "PAPERCLIP_API_URL",
          "PAPERCLIP_COMPANY_ID",
          "PAPERCLIP_RUN_ID",
        ]),
      );
      expect(capture.apiKey).toBe("run-jwt-token");
      expect(capture.runId).toBe("run-123");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("lets an explicit config.env PAPERCLIP_API_KEY win over the run JWT", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-process-execute-explicit-"));
    const commandPath = path.join(root, "agent");
    const capturePath = path.join(root, "capture.json");
    await writeFakeProcessCommand(commandPath);
    try {
      const result = await execute({
        runId: "run-456",
        agent: baseAgent,
        runtime: baseRuntime,
        config: {
          command: commandPath,
          cwd: root,
          env: {
            PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            PAPERCLIP_API_KEY: "operator-supplied-key",
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.apiKey).toBe("operator-supplied-key");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
