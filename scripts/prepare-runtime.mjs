import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const [
  destination = "release",
  asset = "runtime-unknown.tar.gz",
  releaseTag = "v1",
  sourceCommit = "unknown",
] = process.argv.slice(2);
const sdkPackage = JSON.parse(
  await readFile("node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8"),
);
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
