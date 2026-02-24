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
