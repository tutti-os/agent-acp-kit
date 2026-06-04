import { redactSecrets } from "../core/redaction.js";

export class StderrBuffer {
  private value = "";

  constructor(
    private readonly maxChars = 16_000,
    private readonly secrets: string[] = [],
  ) {}

  append(chunk: string) {
    this.value = `${this.value}${this.redact(chunk)}`.slice(-this.maxChars);
  }

  clear() {
    this.value = "";
  }

  tail() {
    return this.value;
  }

  redact(chunk: string) {
    return redactSecrets(chunk, this.secrets);
  }
}
