import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(path.join(tmpdir(), "agent-acp-kit-consumer-"));

try {
  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", fixture], {
    cwd: root,
    encoding: "utf8",
  });
  const packResult = JSON.parse(packOutput)[0];
  const tarball = path.join(fixture, packResult.filename);
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "agent-acp-kit-consumer",
      private: true,
      type: "module",
    }),
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", tarball, "typescript@5.9.3", "@types/node@22.19.19"],
    {
      cwd: fixture,
      stdio: "inherit",
    },
  );
  writeFileSync(
    path.join(fixture, "type-smoke.ts"),
    `
import type { AgentRunInput, DetectedProvider } from "@tutti-os/agent-acp-kit";
import type { TuttiAgentPermissionMode } from "@tutti-os/agent-acp-kit/tutti/contracts";

export function composerPermissionToRun(
  mode: TuttiAgentPermissionMode,
): AgentRunInput["permission"] {
  return { modeId: mode.id, semantic: mode.semantic };
}
export function selectable(provider: DetectedProvider): boolean {
  return provider.supported && provider.authState === "ok";
}
`,
  );
  execFileSync(
    path.join(fixture, "node_modules/.bin/tsc"),
    [
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "type-smoke.ts",
    ],
    { cwd: fixture, stdio: "inherit" },
  );
  writeFileSync(
    path.join(fixture, "smoke.mjs"),
    `
import {
  createGenericAcpProvider,
  createLocalAgentRuntime,
} from "@tutti-os/agent-acp-kit";
import {
  loadTuttiAgentCatalog,
  loadTuttiAgentSkillContext,
  projectTuttiCliChildProcess,
  redactTuttiCliChildProcessText,
} from "@tutti-os/agent-acp-kit/tutti";
import { isTuttiAgentCatalog } from "@tutti-os/agent-acp-kit/tutti/contracts";
import { createFakeAcpPeerScript } from "@tutti-os/agent-acp-kit/testing";

const peer = createFakeAcpPeerScript({
  updates: [{ sessionUpdate: "text_delta", content: { text: "packed-ok" } }],
});
const packedProvider = createGenericAcpProvider({
  providerId: "packed",
  displayName: "Packed",
  command: process.execPath,
  args: ["-e", peer],
});
const runtime = createLocalAgentRuntime({
  providers: [{
    ...packedProvider,
    detect: async () => ({
      authState: "ok",
      executablePath: process.execPath,
      supported: true,
      version: process.version,
    }),
  }],
});
const detectContext = {
  managedAgentInvocation: { credential: "packed-secret", cwd: process.cwd() },
  redactionSecrets: ["packed-existing"],
};
const projection = projectTuttiCliChildProcess({
  baseEnv: {
    TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL: "ambient-canonical",
    TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL: "ambient-legacy",
  },
  detectContext,
});
if (projection.env.TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL) {
  throw new Error("canonical ambient credential was not removed");
}
if (projection.env.TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL !== "packed-secret") {
  throw new Error("request credential projection failed");
}
if (!Object.isFrozen(projection.env) || !projection.redactionSecrets.includes("packed-secret")) {
  throw new Error("projection immutability/redaction failed");
}
if (redactTuttiCliChildProcessText("value=packed-secret", projection.redactionSecrets) !== "value=[REDACTED]") {
  throw new Error("packed redaction helper failed");
}
const catalog = await loadTuttiAgentCatalog({
  detectContext,
  runtime,
  runTuttiCli: async (_args, options) => {
    if (options.env.TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL !== "packed-secret") {
      throw new Error("packed facade lost detectContext");
    }
    return ({
    schemaVersion: 1,
    defaultAgentTargetId: "local:packed",
    agents: [{
      id: "local:packed",
      name: "Packed",
      provider: "packed",
      availability: { status: "available", reasonCode: "", detail: "" },
    }],
    });
  },
});
if (!isTuttiAgentCatalog(catalog)) throw new Error("catalog contract failed");
const detected = await runtime.detect();
if (detected[0]?.provider !== "packed" || detected[0]?.supported !== true || "result" in detected[0]) {
  throw new Error("flat runtime detection contract failed");
}
const standaloneSkills = await loadTuttiAgentSkillContext({
  env: {},
  agentTargetId: "local:packed",
});
if (standaloneSkills.source !== "standalone") throw new Error("skill auto fallback failed");
const events = [];
for await (const event of runtime.run({
  runId: "packed-run",
  provider: "packed",
  cwd: process.cwd(),
  prompt: "hello",
})) events.push(event);
if (!events.some((event) => event.type === "text_delta" && event.text === "packed-ok")) {
  throw new Error("packed ACP runtime failed");
}
console.log(JSON.stringify({ ok: true, agents: catalog.agents.length, events: events.length }));
`,
  );
  execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: fixture,
    stdio: "inherit",
  });
  const packageJson = JSON.parse(
    readFileSync(path.join(fixture, "node_modules/@tutti-os/agent-acp-kit/package.json"), "utf8"),
  );
  console.log(`packed consumer verified @tutti-os/agent-acp-kit@${packageJson.version}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
