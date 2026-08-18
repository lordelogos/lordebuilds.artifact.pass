import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { sourceSha256 } from "./publication-commitment.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(new URL("..", import.meta.url).pathname);
const canonicalRoot = resolve(repositoryRoot, "plugins/artifactpass");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "artifact-share-agent-hosts-"));

const run = async (command, args, environment) => execute(command, args, {
  cwd: repositoryRoot,
  env: { ...process.env, ...environment },
  maxBuffer: 8 * 1024 * 1024,
});

const digest = async (path) => sourceSha256(await readFile(path));

const schemaTypes = (schema) => {
  if (typeof schema?.type === "string") return [schema.type];
  if (Array.isArray(schema?.type)) return [...schema.type].sort();
  if (schema !== null && typeof schema === "object" && "const" in schema) {
    if (schema.const === null) return ["null"];
    if (Number.isInteger(schema.const)) return ["integer"];
    return [typeof schema.const];
  }
  if (Array.isArray(schema?.anyOf)) {
    return schema.anyOf.flatMap((option) => schemaTypes(option)).sort();
  }
  return [];
};

const assertObjectSchema = (host, tool, direction, schema, expected) => {
  const properties = schema?.properties ?? {};
  const actualProperties = Object.keys(properties).sort();
  const expectedProperties = Object.keys(expected.properties).sort();
  const actualRequired = [...(schema?.required ?? [])].sort();
  if (
    schema?.type !== "object" ||
    JSON.stringify(actualProperties) !== JSON.stringify(expectedProperties) ||
    JSON.stringify(actualRequired) !== JSON.stringify([...expected.required].sort())
  ) {
    throw new Error(`${host} negotiated an incomplete ${direction} schema for ${tool}`);
  }
  for (const [property, types] of Object.entries(expected.properties)) {
    if (JSON.stringify(schemaTypes(properties[property])) !== JSON.stringify([...types].sort())) {
      throw new Error(`${host} negotiated the wrong ${direction} type for ${tool}.${property}`);
    }
  }
};

const portableFiles = async () => {
  const entries = await readdir(canonicalRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(canonicalRoot, resolve(entry.parentPath, entry.name)))
    .filter((path) =>
      path === ".mcp.json" ||
      path === "plugin-metadata.json" ||
      path === "dist/cli.mjs" ||
      /^skills\/[a-z0-9-]+\/SKILL\.md$/u.test(path)
    )
    .sort();
};

const assertPortableBytes = async (host, installedRoot, files) => {
  for (const file of files) {
    const [canonical, installed] = await Promise.all([
      digest(resolve(canonicalRoot, file)),
      digest(resolve(installedRoot, file)),
    ]);
    if (canonical !== installed) {
      throw new Error(`${host} installed different portable package bytes for ${file}`);
    }
  }
};

const assertRuntimeConformance = async (host, installedRoot, resolvedServer) => {
  const configuration = JSON.parse(await readFile(resolve(installedRoot, ".mcp.json"), "utf8"));
  const server = resolvedServer ?? configuration.mcpServers?.artifactpass;
  if (server?.command !== "node" || !Array.isArray(server.args)) {
    throw new Error(`${host} installed an invalid ArtifactPass MCP configuration`);
  }
  const unrelatedWorkingDirectory = resolve(temporaryRoot, `${host.toLowerCase().replaceAll(" ", "-")}-cwd`);
  await mkdir(unrelatedWorkingDirectory);
  const configuredWorkingDirectory = server.cwd === undefined
    ? unrelatedWorkingDirectory
    : server.cwd.startsWith("/")
      ? server.cwd
      : resolve(installedRoot, server.cwd);
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: configuredWorkingDirectory,
    env: {
      ...inheritedEnvironment,
      ARTIFACTPASS_BASE_URL: "https://artifacts.example.test",
      ARTIFACTPASS_TOKEN: `as_${"t".repeat(43)}`,
      ARTIFACTPASS_WORKSPACE_ROOTS: temporaryRoot,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "artifactpass-host-conformance", version: "0.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(["publish_artifact", "read_artifact"])) {
      throw new Error(`${host} did not negotiate the portable ArtifactPass MCP tools`);
    }
    const expectedSchemas = {
      publish_artifact: {
        input: {
          required: ["path"],
          properties: {
            path: ["string"], canonical_source_path: ["string"],
            expires_in_seconds: ["integer"],
          },
        },
        output: {
          required: ["protocol_version", "manifest", "share_url"],
          properties: {
            protocol_version: ["number"], manifest: ["object"], share_url: ["string"],
          },
        },
      },
      read_artifact: {
        input: {
          required: ["share_url"],
          properties: {
            share_url: ["string"], cursor: ["string"], max_bytes: ["integer"],
            representation: ["string"],
          },
        },
        output: {
          required: [
            "content_trust", "safety_boundary", "manifest", "representation", "encoding",
            "byte_offset", "byte_length", "total_size", "sha256", "data", "next_cursor",
          ],
          properties: {
            content_trust: ["string"], safety_boundary: ["string"],
            manifest: ["object"], representation: ["string"], encoding: ["string"],
            byte_offset: ["integer"], byte_length: ["integer"], total_size: ["integer"],
            sha256: ["string"], data: ["string"], text: ["string"],
            next_cursor: ["null", "string"], exact_source_url: ["string"],
            safety_notice: ["string"],
          },
        },
      },
    };
    for (const tool of listed.tools) {
      const expected = expectedSchemas[tool.name];
      if (expected === undefined) throw new Error(`${host} negotiated an unexpected tool`);
      assertObjectSchema(host, tool.name, "input", tool.inputSchema, expected.input);
      assertObjectSchema(host, tool.name, "output", tool.outputSchema, expected.output);
    }
    const validation = await client.callTool({
      name: "read_artifact",
      arguments: { share_url: `https://foreign.example/a/${"s".repeat(43)}` },
    });
    if (
      validation.isError !== true ||
      JSON.stringify(validation.content) !== JSON.stringify([{
        type: "text",
        text: "Artifact Share URL must use the configured deployment origin",
      }])
    ) {
      throw new Error(`${host} did not invoke the installed MCP safety boundary`);
    }
  } finally {
    await client.close();
  }
};

try {
  const codexHome = resolve(temporaryRoot, "codex");
  await mkdir(codexHome);
  const codexEnvironment = { CODEX_HOME: codexHome };
  await run("codex", ["plugin", "marketplace", "add", repositoryRoot, "--json"], codexEnvironment);
  const codexInstall = JSON.parse((await run(
    "codex",
    ["plugin", "add", "artifactpass@artifactpass", "--json"],
    codexEnvironment,
  )).stdout);
  if (typeof codexInstall.installedPath !== "string") {
    throw new Error("Codex did not report an installed plugin path");
  }

  const claudeHome = resolve(temporaryRoot, "claude");
  await mkdir(claudeHome);
  const claudeEnvironment = { CLAUDE_CONFIG_DIR: claudeHome };
  await run(
    "claude",
    ["plugin", "marketplace", "add", repositoryRoot, "--scope", "user"],
    claudeEnvironment,
  );
  await run(
    "claude",
    ["plugin", "install", "artifactpass@artifactpass", "--scope", "user"],
    claudeEnvironment,
  );
  const claudePlugins = JSON.parse((await run(
    "claude",
    ["plugin", "list", "--json"],
    claudeEnvironment,
  )).stdout);
  const claudeInstall = claudePlugins.find((plugin) =>
    plugin.id === "artifactpass@artifactpass"
  );
  if (typeof claudeInstall?.installPath !== "string") {
    throw new Error("Claude Code did not report an installed plugin path");
  }

  const files = await portableFiles();
  await Promise.all([
    assertPortableBytes("Codex", codexInstall.installedPath, files),
    assertPortableBytes("Claude Code", claudeInstall.installPath, files),
  ]);
  const codexMcpServers = JSON.parse((await run(
    "codex",
    ["mcp", "list", "--json"],
    codexEnvironment,
  )).stdout);
  const codexServer = codexMcpServers.find((server) => server.name === "artifactpass")?.transport;
  const claudeConfiguration = JSON.parse(await readFile(
    resolve(claudeInstall.installPath, ".claude-plugin/mcp.json"),
    "utf8",
  ));
  const claudeDeclaredServer = claudeConfiguration.mcpServers?.artifactpass;
  const claudeServer = {
    ...claudeDeclaredServer,
    args: claudeDeclaredServer?.args?.map((argument) =>
      argument.replaceAll("${CLAUDE_PLUGIN_ROOT}", claudeInstall.installPath)
    ),
  };
  await Promise.all([
    assertRuntimeConformance("Codex", codexInstall.installedPath, codexServer),
    assertRuntimeConformance("Claude Code", claudeInstall.installPath, claudeServer),
  ]);
  const codexPrompt = (await run(
    "codex",
    ["debug", "prompt-input", "ArtifactPass skill inventory check"],
    codexEnvironment,
  )).stdout;
  if (
    !codexPrompt.includes("artifactpass:read-shared-artifact") ||
    !codexPrompt.includes("artifactpass:share-artifact")
  ) {
    throw new Error("Codex did not expose both installed ArtifactPass skills to the model");
  }
  const claudeDetails = (await run(
    "claude",
    ["plugin", "details", "artifactpass@artifactpass"],
    claudeEnvironment,
  )).stdout;
  if (
    !claudeDetails.includes("Skills (2)") ||
    !claudeDetails.includes("read-shared-artifact") ||
    !claudeDetails.includes("share-artifact")
  ) {
    throw new Error("Claude Code did not expose both installed ArtifactPass skills");
  }
  const claudeMcpResult = await run(
    "claude",
    ["mcp", "list"],
    {
      ...claudeEnvironment,
      ARTIFACTPASS_BASE_URL: "https://artifacts.example.test",
      ARTIFACTPASS_TOKEN: `as_${"t".repeat(43)}`,
      ARTIFACTPASS_WORKSPACE_ROOTS: temporaryRoot,
    },
  );
  const claudeMcpStatus = `${claudeMcpResult.stdout}\n${claudeMcpResult.stderr}`;
  if (!/plugin:artifactpass:artifactpass:.*Connected/iu.test(claudeMcpStatus)) {
    throw new Error(`Claude Code did not launch the installed ArtifactPass MCP server: ${claudeMcpStatus.trim()}`);
  }

  process.stdout.write(
    `Agent host conformance passed: Codex and Claude Code installed and launched the same ${files.length}-file portable MCP and Agent Skills package.\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
