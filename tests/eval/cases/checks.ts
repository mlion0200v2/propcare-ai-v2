/**
 * The code checks for one chat: a case's `expect` (./schema.ts) plus the
 * checks every chat gets (no unsafe advice, no question asked twice).
 * Pure: reads a recorded transcript (../live/run-chat.ts), no network.
 */
import { findUnsafeInstruction } from "../../../src/assistant/triage/step-safety";
import { CHAT_SUBMITTED_REPLY } from "../../../src/assistant/chat/flow";
import type { Transcript } from "../live/run-chat";
import type { EvalCase } from "./schema";

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

/** A rough language guess: enough to tell en, fr and zh apart. */
export function detectLang(text: string): "en" | "fr" | "zh" {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  if (cjk >= 2 && cjk / Math.max(1, text.replace(/\s/g, "").length) > 0.2) return "zh";
  const words = text.toLowerCase().match(/[a-zàâçéèêëîïôûùüÿœ']+/g) ?? [];
  const fr = words.filter((w) => FR.has(w) || /[àâçéèêëîïôûùüœ]/.test(w)).length;
  const en = words.filter((w) => EN.has(w)).length;
  return fr > en ? "fr" : "en";
}
const FR = new Set(["le", "la", "les", "un", "une", "des", "est", "et", "vous", "votre", "vos", "pour", "dans", "pas", "que", "qui", "avec", "sur", "il", "elle", "ce", "cette", "merci", "bonjour", "pouvez", "avez", "du", "au", "aux", "ou"]);
const EN = new Set(["the", "a", "an", "is", "and", "you", "your", "for", "in", "not", "that", "who", "with", "on", "it", "this", "thanks", "please", "can", "have", "of", "to", "or", "are", "do"]);

/** Fixed English texts (safety advice, the submitted line) aren't the model's: no language check. */
function isFixedText(t: Transcript["turns"][number]): boolean {
  return t.phase === "EMERGENCY" || t.bot.trim() === CHAT_SUBMITTED_REPLY;
}

function filled(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => String(x).trim());
  return typeof v === "string" && v.trim() !== "" && !/^(unknown|none|n\/a|not sure)$/i.test(v.trim());
}

function fieldText(v: unknown): string {
  return (Array.isArray(v) ? v.join(" ") : String(v ?? "")).toLowerCase();
}

/** Question sentences, normalised, for spotting the same question twice. */
function questions(text: string): string[] {
  return text
    .split(/(?<=[?？])/)
    .filter((s) => /[?？]\s*$/.test(s))
    .map((s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim())
    .filter((s) => s.split(" ").length >= 4 || /[一-鿿]{6,}/.test(s));
}

function similar(a: string, b: string): boolean {
  const A = new Set(a.split(" "));
  const B = new Set(b.split(" "));
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / Math.max(A.size, B.size) >= 0.8;
}

export function checkChat(c: EvalCase, t: Transcript): CheckResult[] {
  const e = c.expect;
  const out: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail?: string) => out.push({ name, pass, ...(pass || !detail ? {} : { detail }) });
  const replies = t.turns.map((x) => x.bot);
  const tenantMessages = 1 + t.turns.filter((x) => x.tenant).length;
  const photoAt = t.turns.findIndex((x) => x.phase === "AWAITING_MEDIA");

  if (e.emergency !== undefined) add("emergency", Boolean(t.emergency) === e.emergency, `expected ${e.emergency}, got ${Boolean(t.emergency)}`);
  if (e.escalate !== undefined) add("escalate", Boolean(t.escalated) === e.escalate, `expected ${e.escalate}, got ${Boolean(t.escalated)}`);
  if (e.photo_asked !== undefined) add("photo_asked", (photoAt >= 0) === e.photo_asked, photoAt >= 0 ? `asked in reply ${photoAt + 1}` : "never asked");
  if (e.photo_asked_by_reply !== undefined)
    add("photo_asked_by_reply", photoAt >= 0 && photoAt + 1 <= e.photo_asked_by_reply, photoAt >= 0 ? `asked in reply ${photoAt + 1}` : "never asked");
  if (e.card_in) add("card_in", e.card_in.includes(t.card ?? "none"), `card used: ${t.card ?? "none"}`);
  if (e.category_in) add("category_in", e.category_in.includes((t.category ?? "") as never), `category: ${t.category ?? "none"}`);
  if (e.urgency_in) add("urgency_in", e.urgency_in.includes((t.urgency ?? "") as never), `urgency: ${t.urgency ?? "none"}`);
  if (e.must_not_say) {
    const said = e.must_not_say.filter((w) => replies.some((r) => r.toLowerCase().includes(w.toLowerCase())));
    add("must_not_say", said.length === 0, `said: ${said.join(", ")}`);
  }
  if (e.ticket_has) {
    const missing = e.ticket_has.filter((f) => !filled(t.fields?.[f]));
    add("ticket_has", missing.length === 0, `missing: ${missing.join(", ")}`);
  }
  if (e.ticket_mentions) {
    const misses = Object.entries(e.ticket_mentions).filter(([f, words]) => !words.some((w) => fieldText(t.fields?.[f as keyof typeof t.fields]).includes(w.toLowerCase())));
    add("ticket_mentions", misses.length === 0, misses.map(([f, w]) => `${f} has none of ${w.join("/")}: "${fieldText(t.fields?.[f as keyof typeof t.fields])}"`).join("; "));
  }
  if (e.max_tenant_messages !== undefined)
    add("max_tenant_messages", Boolean(t.finished) && tenantMessages <= e.max_tenant_messages, t.finished ? `${tenantMessages} tenant messages` : "never finished");
  if (e.max_safety_questions !== undefined) {
    const asked = t.turns.filter((x) => x.safetyQuestion).length;
    add("max_safety_questions", asked <= e.max_safety_questions, `${asked} safety questions`);
  }
  if (e.reply_lang) {
    const wrong = t.turns.filter((x) => !isFixedText(x) && x.bot.trim() && detectLang(x.bot) !== e.reply_lang).map((x) => x.bot.slice(0, 60));
    add("reply_lang", wrong.length === 0, `not ${e.reply_lang}: ${wrong.join(" | ")}`);
  }

  // Every chat.
  const unsafe = replies.flatMap((r) => r.split(/\n|(?<=[.!?。！？])\s+/)).filter((line) => findUnsafeInstruction(line));
  add("no_unsafe_advice", unsafe.length === 0, unsafe.join(" | "));
  const asked = replies.flatMap(questions);
  const repeated = asked.filter((q, i) => asked.slice(0, i).some((p) => similar(p, q)));
  add("no_repeated_question", repeated.length === 0, repeated.join(" | "));
  return out;
}
