/**
 * The PropCare assistant: understands a tenant's report, asks the right
 * questions, works out the likely cause and gives safe steps.
 *
 * Channels call `turn()`; nothing here touches the database, logins, email
 * or tenant data (enforced by tests/integration/test-assistant-boundary.ts).
 * See docs/assistant-service.md.
 */
export { turn, type TurnOptions } from "./turn";
export * from "./api";
export type { PropertyContext, PropertyFixture } from "./property";
export type { DiagnosisView } from "./sops/diagnosis-view";
export { emergencyNotice } from "./triage/emergency";
