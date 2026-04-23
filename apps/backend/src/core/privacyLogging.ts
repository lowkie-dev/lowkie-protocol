import { envBool } from "./utils";

const REDACTED = "[redacted]";

export function logSensitiveDataEnabled(): boolean {
  return envBool("LOWKIE_LOG_SENSITIVE_DATA", false);
}

export function redactValue(value: string): string {
  return logSensitiveDataEnabled() ? value : REDACTED;
}

export function redactAmountSol(amountSol: number | string): string {
  return logSensitiveDataEnabled() ? `${amountSol} SOL` : REDACTED;
}

export function redactDenominationSummary(
  summary: string,
  noteCount: number,
): string {
  return logSensitiveDataEnabled()
    ? `[${summary}]`
    : `[${noteCount} note(s) redacted]`;
}

export function redactStepLabel(label: string): string {
  return logSensitiveDataEnabled() ? label : REDACTED;
}

export function redactErrorMessage(message: string): string {
  return logSensitiveDataEnabled()
    ? message
    : "Sensitive transfer details redacted";
}
