function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSecret(value: string, secret: string): string {
  if (secret.length < 8 && /^[A-Za-z0-9]+$/u.test(secret)) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, "g");
    return value.replace(pattern, "[REDACTED]");
  }
  return value.split(secret).join("[REDACTED]");
}

export function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => redactSecret(result, secret), value);
}
