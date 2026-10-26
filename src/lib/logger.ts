/**
 * Phase 2A — Minimal structured logging for triage.
 *
 * Each triage API call logs a JSON line with trace_id, ticket_id,
 * state, action, and latency. Structured for easy grep / parsing.
 */

export interface TriageLogEntry {
  trace_id: string;
  ticket_id: string;
  triage_state: string;
  action: string;
  latency_ms: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export function logTriageStep(entry: TriageLogEntry): void {
  console.log(
    JSON.stringify({
      level: "info",
      service: "triage",
      ...entry,
    })
  );
}

export function logError(
  context: string,
  error: unknown,
  metadata?: Record<string, unknown>
): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(
    JSON.stringify({
      level: "error",
      service: "triage",
      context,
      message,
      ...(stack ? { stack } : {}),
      ...metadata,
      timestamp: new Date().toISOString(),
    })
  );
}

export function logWarn(
  context: string,
  message: string,
  metadata?: Record<string, unknown>
): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      service: "triage",
      context,
      message,
      ...metadata,
      timestamp: new Date().toISOString(),
    })
  );
}
