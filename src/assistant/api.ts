/**
 * The assistant's contract: one call per tenant message, `turn(request)`.
 *
 * Channels (the web chat today; email and voice later) send the tenant's
 * message with contact details removed, the conversation state from last
 * time, and non-sensitive facts about the home. They get back the reply,
 * tap options, the new state to store, and what to do with the ticket.
 * The assistant keeps nothing between calls and never sees tenant data;
 * the app owns tickets, photos, emergency alerts and email.
 *
 * See docs/assistant-service.md. In-process today; the same types become
 * the HTTP API (POST /v1/turn) when the assistant runs as its own service.
 */
import type { DiagnosisView } from "./sops/diagnosis-view";
import type { PropertyContext } from "./property";
import type { ChatState } from "./chat/types";
import type { PendingSafetyCheck } from "./safety/gate";
import type { EmergencyKind } from "./triage/emergency";
import type { TriageClassification, TriageStateName, TroubleshootingStep } from "./triage/types";

/** Where the conversation is (also the ticket's triage_state). */
export type Phase = TriageStateName;

export type Channel = "web" | "email" | "voice";

/** Limits the chat enforces on uploads; the photo prompt quotes them. */
export const MEDIA_LIMITS = { maxVideoSeconds: 60, maxUploadMb: 25 } as const;

/** The whole conversation so far. The channel stores it and sends it back. */
export interface AssistantState extends TriageClassification {
  v: 1;
  phase: Phase;
  /** The tenant's first message (contact details removed). */
  description: string;
  /** Tap options and notes for the current question. */
  ui: { options: string[]; notes: string[] };
  /** The safety gate asked a confirming question and is waiting for the answer. */
  safety_check?: PendingSafetyCheck | null;
  /** Dangers the tenant has said aren't there (a smell from the hot water only): not asked again. */
  safety_cleared?: EmergencyKind[];
  /** Set when the model leads the conversation (./chat); absent on the scripted path. */
  chat?: ChatState | null;
}

export interface TurnRequest {
  /** An opaque id for the conversation (for logs only; not the ticket id). */
  conversation: string;
  /** The tenant's message, contact details already removed. May be empty for a button press. */
  message: string;
  /** A button instead of typing: skip photos / photos added / confirm the summary. */
  action?: "skip_photos" | "photos_added" | "confirm_summary";
  /** null for the first message of a conversation. */
  state: AssistantState | null;
  property: PropertyContext;
  media: {
    count: number;
    /**
     * Reserved for photo diagnosis (not used yet): short-lived links to the
     * photos the tenant added, with nothing else about them.
     */
    images?: { url: string; mime_type: string }[];
  };
  channel: Channel;
}

/** What the app should do with the ticket after this turn. */
export interface TicketUpdate {
  /** ticket_category value. */
  category?: string;
  troubleshooting_steps?: TroubleshootingStep[];
  priority?: "medium" | "high" | "emergency";
  /** Mark the ticket escalated (the app sets this server-side). */
  escalate?: boolean;
  /** Flag the ticket's safety assessment as an emergency. */
  flag_emergency?: boolean;
  /** Set when the report is submitted: the manager's summary (with the diagnosis). */
  manager_summary?: string;
  diagnosis?: DiagnosisView | null;
  /** Email the manager now: "summary" (submitted) or "urgent" (escalated). */
  notify_manager?: "summary" | "urgent";
}

export interface TurnResponse {
  /** What to show or say to the tenant. */
  reply: string;
  /** Tap answers for the next question (empty when free text is expected). */
  options: string[];
  /** Short notes to show above the input ("Your water shut-off is…"). */
  notes: string[];
  phase: Phase;
  /** Store this; send it back next turn. */
  state: AssistantState;
  /**
   * Danger detected: the reply is safety advice. The app alerts the manager
   * and adds whether it reached them (the assistant can't know).
   */
  emergency: { kind: string; phrase: string } | null;
  ticket: TicketUpdate;
  /** The conversation is over (submitted or escalated). */
  done: boolean;
}
