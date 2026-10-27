/**
 * The model-led conversation's state, kept in AssistantState.chat. Its
 * presence is what marks a conversation as model-led; conversations started
 * on the scripted path finish there.
 */

export const TICKET_CATEGORIES = [
  "plumbing",
  "electrical",
  "hvac",
  "appliance",
  "structural",
  "pest_control",
  "locksmith",
  "roofing",
  "painting",
  "flooring",
  "landscaping",
  "general",
  "other",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** What the manager needs, in English, whatever language the tenant writes in. */
export interface TicketFields {
  /** One line: what is wrong ("Kitchen sink drain pipe leaks when draining"). */
  issue: string | null;
  location: string | null;
  started: string | null;
  /** How bad it is now ("slow drip, contained in a bowl"). */
  severity: string | null;
  equipment: string | null;
  brand_model: string | null;
  /** What the tenant has tried, and what happened. */
  tried: string[];
  /** Anything else a tradesperson should know. */
  facts: string[];
  category: TicketCategory;
}

export interface ChatMessage {
  role: "tenant" | "assistant";
  text: string;
}

export interface ChatState {
  messages: ChatMessage[];
  ticket: TicketFields;
  /** Cards offered to the model (issue keys), best first. */
  cards: string[];
  /** The card the model is following, or null when none fits. */
  card: string | null;
  /** The likely cause on that card (ticket only). */
  cause: string | null;
  confidence: "high" | "medium" | "low";
  urgency: "low" | "medium" | "high";
  /** Safe steps suggested so far (English). */
  steps: string[];
  /** Photos were asked for once already. */
  asked_photos: boolean;
  /** Tap options for the tenant's next answer. */
  options: string[];
  /** Lines the advice filter removed from the model's replies (for review). */
  removed: string[];
  /** Model calls that failed in a row. */
  failures?: number;
  /** Knowledge-base similarity found on the first message, per issue key. */
  vector?: Record<string, number>;
}

export function emptyTicket(): TicketFields {
  return { issue: null, location: null, started: null, severity: null, equipment: null, brand_model: null, tried: [], facts: [], category: "general" };
}
