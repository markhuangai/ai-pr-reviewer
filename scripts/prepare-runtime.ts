import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readPackage(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw) as unknown;
  if (!isRecord(value)) throw new Error("Package metadata is invalid.");
  return value;
}

export interface PreparedRuntime {
  readonly asset: string;
  readonly bundle: string;
}

export async function prepareRuntime(
  args: readonly string[] = [],
  cwd = process.cwd(),
): Promise<PreparedRuntime> {
  const [
    destination = "release",
    asset = "runtime-unknown.tar.gz",
    artifactTag = "v0.0.0-rc.0",
    stableTag = "v0.0.0",
    sourceCommit = "unknown",
    rawTargetOs = process.platform,
    rawTargetCpu = process.arch,
    targetLibc = process.platform === "linux" ? "glibc" : "",
  ] = args;
  const artifactMatch =
    /^(v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))-rc\.(?:0|[1-9][0-9]*)$/.exec(
      artifactTag,
    );
  if (!artifactMatch?.[1] || artifactMatch[1] !== stableTag) {
    throw new Error("Runtime artifact and stable tags must be a matching RC/stable version pair.");
  }
  const target = `${rawTargetOs}/${rawTargetCpu}/${targetLibc}`;
  const supportedTargets = new Set([
    "darwin/arm64/",
    "darwin/x64/",
    "linux/arm64/glibc",
    "linux/x64/glibc",
    "win32/arm64/",
    "win32/x64/",
  ]);
  if (!supportedTargets.has(target)) throw new Error(`Unsupported runtime target: ${target}.`);
  const sdkPackage = readPackage(
    await readFile(join(cwd, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8"),
  );
  if (typeof sdkPackage.version !== "string") {
    throw new Error("Claude Agent SDK package metadata has no version.");
  }
  const expectedAsset = `runtime-${rawTargetOs}-${rawTargetCpu}.tar.gz`;
  if (asset !== expectedAsset) {
    throw new Error(`Runtime asset ${asset} does not match target ${rawTargetOs}/${rawTargetCpu}.`);
  }
  const platformSuffix = `${rawTargetOs}-${rawTargetCpu}`;
  const platformPackage = readPackage(
    await readFile(
      join(cwd, `node_modules/@anthropic-ai/claude-agent-sdk-${platformSuffix}/package.json`),
      "utf8",
    ),
  );
  if (
    platformPackage.version !== sdkPackage.version ||
    !isStringArray(platformPackage.os) ||
    !platformPackage.os.includes(rawTargetOs) ||
    !isStringArray(platformPackage.cpu) ||
    !platformPackage.cpu.includes(rawTargetCpu) ||
    (targetLibc !== "" &&
      (!isStringArray(platformPackage.libc) || !platformPackage.libc.includes(targetLibc)))
  ) {
    throw new Error(
      `Claude SDK native package does not match target ${rawTargetOs}/${rawTargetCpu}.`,
    );
  }
  const bundle = join(resolve(cwd, destination), "bundle");
  await mkdir(join(bundle, "runtime"), { recursive: true });
  await cp(join(cwd, "build/index.js"), join(bundle, "index.js"));
  await cp(join(cwd, "build/lib"), join(bundle, "lib"), { recursive: true });
  await cp(join(cwd, "build/runtime"), join(bundle, "runtime"), { recursive: true });
  await cp(join(cwd, "node_modules"), join(bundle, "node_modules"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(
    join(bundle, "package.json"),
    `${JSON.stringify({ type: "module", engines: { node: ">=24" } }, null, 2)}\n`,
  );
  await writeFile(
    join(bundle, "runtime/manifest.json"),
    `${JSON.stringify(
      {
        artifactTag,
        stableTag,
        asset,
        nodeMajor: 24,
        sdkVersion: sdkPackage.version,
        cliVersion: sdkPackage.claudeCodeVersion ?? "unknown",
        sourceCommit,
      },
      null,
      2,
    )}\n`,
  );
  return { asset, bundle };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const result = await prepareRuntime(process.argv.slice(2));
  console.log(`Prepared ${result.bundle} for ${result.asset}.`);
}
