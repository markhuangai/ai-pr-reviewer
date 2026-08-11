import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { encoding: "utf8" });
const paths = stdout.split("\0").filter(Boolean);
const patterns = [
  { name: "private key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub token", expression: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "GitHub fine-grained token", expression: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "AWS access key", expression: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Anthropic key", expression: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
];
const findings = [];
for (const path of paths) {
  if (/\.(png|jpg|jpeg|gif|ico|zip|gz|tgz|woff2?)$/i.test(path)) continue;
  const text = await readFile(path, "utf8").catch(() => "");
  for (const pattern of patterns)
    if (pattern.expression.test(text)) findings.push(`${pattern.name}: ${path}`);
}
if (findings.length > 0) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Secret scan checked ${paths.length} tracked files.`);
}
