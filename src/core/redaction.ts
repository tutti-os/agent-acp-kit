export function redactSecrets(
  input: string,
  secrets: string[],
): string {
  return secrets.reduce((value, secret) => {
    if (!secret) {
      return value;
    }
    return value.split(secret).join("[REDACTED]");
  }, input);
}
