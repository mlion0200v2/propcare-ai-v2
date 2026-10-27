/**
 * What the manager receives from a model-led conversation: the summary
 * (English, built by code from the ticket fields, never written by the
 * model) and the diagnosis block (from the card and cause the model chose).
 */
import { cardByKey } from "@/assistant/cards";
import { diagnosisText, type DiagnosisView } from "@/assistant/sops/diagnosis-view";
import type { ChatState } from "./types";

/** The trade when no card fits. */
const CATEGORY_TRADE: Record<string, string> = {
  plumbing: "plumber",
  electrical: "electrician",
  hvac: "HVAC technician",
  appliance: "appliance technician",
  structural: "handyperson",
  pest_control: "pest control",
  locksmith: "locksmith",
  roofing: "roofer",
  painting: "painter",
  flooring: "flooring installer",
  landscaping: "landscaper",
  general: "handyperson",
  other: "handyperson",
};

function media(count: number): string | null {
  return count > 0 ? `${count} photo${count === 1 ? "" : "s"}/video${count === 1 ? "" : "s"} from the tenant` : null;
}

export function chatDiagnosis(chat: ChatState, mediaCount: number): DiagnosisView {
  const t = chat.ticket;
  const card = chat.card ? cardByKey(chat.card) : null;
  const cause = card?.causes.find((c) => c.id === chat.cause) ?? null;
  const evidence = [t.severity ? `How bad: ${t.severity}` : null, ...t.facts, ...t.tried.map((x) => `Tried: ${x}`), media(mediaCount)].filter(
    (x): x is string => Boolean(x)
  );
  return {
    procedure: card?.title ?? `General assessment: ${t.issue ?? "see the tenant's description"}`,
    confidence: card ? chat.confidence : "low",
    causes: cause ? [{ label: cause.label, evidence: t.facts.slice(0, 3) }] : [],
    evidence,
    modelSerial: t.brand_model && !/^(unknown|not asked)$/i.test(t.brand_model) ? t.brand_model : null,
    parts: cause?.parts ?? [],
    trade: cause?.trade ?? CATEGORY_TRADE[t.category] ?? "handyperson",
    visit: cause && cause.visit_minutes[1] > 0 ? `${cause.visit_minutes[0]}–${cause.visit_minutes[1]} min` : null,
    identify: card?.identify ?? [],
    managerOnly: card?.route_to_manager ?? false,
  };
}

export function chatManagerSummary(input: { description: string; chat: ChatState; mediaCount: number; escalation?: string | null; timestamp: string }): string {
  const { chat, mediaCount } = input;
  const t = chat.ticket;
  const category = t.category.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  const list = (title: string, xs: string[]) => (xs.length ? [title, ...xs.map((x) => `  - ${x}`), ""] : []);
  return [
    `MAINTENANCE REQUEST — ${category}`,
    "",
    `Issue: ${t.issue ?? input.description}`,
    `Tenant's words: ${input.description}`,
    `Location in the unit: ${t.location ?? "Not given"}`,
    `Started: ${t.started ?? "Not given"}`,
    `How bad: ${t.severity ?? "Not given"}`,
    ...(t.equipment ? [`Equipment: ${[t.equipment, t.brand_model].filter(Boolean).join(", ")}`] : []),
    `Urgency: ${chat.urgency}`,
    ...(input.escalation ? [`ESCALATED: ${input.escalation}`] : []),
    "",
    ...list("Details:", t.facts),
    ...list("Tried by the tenant:", t.tried),
    ...list("Safe steps suggested to the tenant:", chat.steps),
    `Media: ${media(mediaCount) ?? "None uploaded"}`,
    "",
    diagnosisText(chatDiagnosis(chat, mediaCount)),
    "",
    `Submitted: ${input.timestamp}`,
  ].join("\n");
}
