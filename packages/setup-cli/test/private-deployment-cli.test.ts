import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parsePrivateDeploymentWizardArguments,
  runPrivateDeploymentWizard,
  type PrivateDeploymentPrompt,
} from "../src/private-deployment/deploy-wizard";
import { readPrivateDeploymentState } from "../src/private-deployment/deployment-state";

const deploymentId = "33333333-3333-4333-8333-333333333333";
const secondDeploymentId = "44444444-4444-4444-8444-444444444444";
const cliVersion = "0.1.0-rc.12";
const instant = new Date("2026-09-01T17:00:00.000Z");

const temporaryRoot = async (): Promise<string> => {
  const root = resolve(tmpdir(), `artifactpass-wizard-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
};

const promptWith = (answers: readonly string[]): { prompt: PrivateDeploymentPrompt; output: string[] } => {
  const queue = [...answers];
  const output: string[] = [];
  return {
    prompt: {
      interactive: true,
      question: async () => queue.shift() ?? "save",
      write: (message) => output.push(message),
    },
    output,
  };
};

describe("private deployment CLI contract", () => {
  it("parses resume, lifecycle, and machine-readable controls strictly", () => {
    expect(parsePrivateDeploymentWizardArguments(["--resume", deploymentId, "--status", "--json"]))
      .toEqual({
        resume: deploymentId,
        createNew: false,
        nonInteractive: false,
        status: true,
        abandon: false,
        json: true,
      });
    expect(() => parsePrivateDeploymentWizardArguments(["--new", "--resume", deploymentId]))
      .toThrow("Choose --new or --resume");
    expect(() => parsePrivateDeploymentWizardArguments(["--abandon"]))
      .toThrow("requires --resume");
    expect(() => parsePrivateDeploymentWizardArguments(["--mystery"]))
      .toThrow("Unknown private deployment option");
  });

  it("starts the plain-language wizard and saves choices before authorization", async () => {
    const root = await temporaryRoot();
    const interaction = promptWith(["1", "1", "1"]);
    const result = await runPrivateDeploymentWizard(
      parsePrivateDeploymentWizardArguments(["--new"]),
      {
        root,
        cliVersion,
        createId: () => deploymentId,
        now: () => instant,
        prompt: interaction.prompt,
      },
    );
    expect(result.action).toBe("authorization-required");
    expect(result.resume_command).toBe(`pnpm dlx artifactpass deploy --resume ${deploymentId}`);
    expect(interaction.output.join("\n")).toContain("Cloudflare handles your account, plan, payment method, domain, and company login");
    expect(await readPrivateDeploymentState(root, deploymentId, cliVersion)).toMatchObject({
      registrar_authority_confirmed: true,
      sign_in_mode: "email-code",
      stage: "authorization-required",
      status: "incomplete",
    });
  });

  it("resumes the same machine-level record without depending on the current folder", async () => {
    const root = await temporaryRoot();
    await runPrivateDeploymentWizard(parsePrivateDeploymentWizardArguments(["--new"]), {
      root,
      cliVersion,
      createId: () => deploymentId,
      now: () => instant,
      prompt: promptWith(["1", "1", "2"]).prompt,
    });
    const resumed = await runPrivateDeploymentWizard(
      parsePrivateDeploymentWizardArguments(["--resume", deploymentId]),
      { root, cliVersion, now: () => instant, prompt: promptWith([]).prompt },
    );
    expect(resumed.deployment).toMatchObject({ deployment_id: deploymentId, sign_in_mode: "company-login" });
    expect(resumed.action).toBe("authorization-required");
  });

  it("offers the only incomplete record or allows a separate deployment", async () => {
    const root = await temporaryRoot();
    await runPrivateDeploymentWizard(parsePrivateDeploymentWizardArguments(["--new"]), {
      root,
      cliVersion,
      createId: () => deploymentId,
      now: () => instant,
      prompt: promptWith(["save"]).prompt,
    });
    const result = await runPrivateDeploymentWizard(parsePrivateDeploymentWizardArguments([]), {
      root,
      cliVersion,
      createId: () => secondDeploymentId,
      now: () => instant,
      prompt: promptWith(["2", "save"]).prompt,
    });
    expect(result.deployment?.deployment_id).toBe(secondDeploymentId);
    expect(result.action).toBe("saved");
  });

  it("supports status and explicit local abandonment without deleting remote resources", async () => {
    const root = await temporaryRoot();
    await runPrivateDeploymentWizard(parsePrivateDeploymentWizardArguments(["--new"]), {
      root,
      cliVersion,
      createId: () => deploymentId,
      now: () => instant,
      prompt: promptWith(["save"]).prompt,
    });
    const status = await runPrivateDeploymentWizard(parsePrivateDeploymentWizardArguments(["--status"]), {
      root,
      cliVersion,
      now: () => instant,
      prompt: promptWith([]).prompt,
    });
    expect(status.deployments).toHaveLength(1);
    const abandoned = await runPrivateDeploymentWizard(
      parsePrivateDeploymentWizardArguments(["--resume", deploymentId, "--abandon"]),
      { root, cliVersion, now: () => instant, prompt: promptWith([]).prompt },
    );
    expect(abandoned.deployment?.status).toBe("abandoned");
    expect(abandoned.message).toContain("Cloudflare resources were not deleted");
  });

  it("fails closed when a non-interactive run does not identify existing explicit input", async () => {
    await expect(runPrivateDeploymentWizard(
      parsePrivateDeploymentWizardArguments(["--non-interactive"]),
      { root: await temporaryRoot(), cliVersion, prompt: promptWith([]).prompt },
    )).rejects.toThrow("requires --resume");
  });
});
