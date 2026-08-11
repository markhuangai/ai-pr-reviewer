import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

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

const [
  destination = "release",
  asset = "runtime-unknown.tar.gz",
  releaseTag = "runtime-v1",
  sourceCommit = "unknown",
  rawTargetOs = process.platform,
  rawTargetCpu = process.arch,
  targetLibc = process.platform === "linux" ? "glibc" : "",
] = process.argv.slice(2);
const target = `${rawTargetOs}/${rawTargetCpu}/${targetLibc}`;
const supportedTargets = new Set([
  "darwin/arm64/",
  "darwin/x64/",
  "linux/arm64/glibc",
  "linux/arm64/musl",
  "linux/x64/glibc",
  "linux/x64/musl",
  "win32/arm64/",
  "win32/x64/",
]);
if (!supportedTargets.has(target)) throw new Error(`Unsupported runtime target: ${target}.`);
const sdkPackage = readPackage(
  await readFile("node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8"),
);
if (typeof sdkPackage.version !== "string") {
  throw new Error("Claude Agent SDK package metadata has no version.");
}
const expectedAsset = `runtime-${rawTargetOs}-${rawTargetCpu}.tar.gz`;
if (asset !== expectedAsset) {
  throw new Error(`Runtime asset ${asset} does not match target ${rawTargetOs}/${rawTargetCpu}.`);
}
const platformSuffix =
  rawTargetOs === "linux" && targetLibc === "musl"
    ? `${rawTargetOs}-${rawTargetCpu}-musl`
    : `${rawTargetOs}-${rawTargetCpu}`;
const platformPackage = readPackage(
  await readFile(
    `node_modules/@anthropic-ai/claude-agent-sdk-${platformSuffix}/package.json`,
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
const bundle = `${destination}/bundle`;
await mkdir(`${bundle}/runtime`, { recursive: true });
await cp("build/index.js", `${bundle}/index.js`);
await cp("build/lib", `${bundle}/lib`, { recursive: true });
await cp("build/runtime", `${bundle}/runtime`, { recursive: true });
await cp("node_modules", `${bundle}/node_modules`, { recursive: true, dereference: false });
await writeFile(
  `${bundle}/package.json`,
  `${JSON.stringify({ type: "module", engines: { node: ">=24" } }, null, 2)}\n`,
);
await writeFile(
  `${bundle}/runtime/manifest.json`,
  `${JSON.stringify(
    {
      releaseTag,
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
console.log(`Prepared ${bundle} for ${asset}.`);
