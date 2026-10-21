/**
 * SOP-driven intake: ask only the selected SOP's questions, one at a
 * time, skipping slots already known (from the IssueFrame or the first
 * message), and work out the likely cause from the answers. Pure.
 *
 * Slots are either frame slots (equipment, symptom, substance, room,
 * onset, status), kept in step with the stored IssueFrame, or SOP slots
 * (part, timing, amount, electrical_near…), stored on the intake.
 */
import type { IssueFrame } from "@/lib/understanding/frame";
import type { UnitProfile } from "@/lib/units/profile";
import type { Cause, IntakeOption, IntakeQuestion, Sop } from "./schema";
import { NOT_A_SOURCE, scopeOptions } from "./scope";

export const FRAME_SLOTS = ["equipment", "symptom", "substance", "room", "onset", "status"] as const;

export interface IntakeAnswer {
  value: string;
  label: string;
}

/** Stored on gathered.sop. */
export interface IntakeState {
  issue_key: string;
  title: string;
  confidence: "high" | "low";
  answers: Record<string, IntakeAnswer>;
  /** Question ids already asked (never asked twice). */
  asked: string[];
  /** Frame slot values when last updated (for option filters). */
  slots: Record<string, string>;
  complete: boolean;
  /** The leading cause once an answer points somewhere (null before that). */
  cause: (Cause & { refine_to?: string }) | null;
  /** Ranked causes with the evidence, parts and trade (manager/vendor only). */
  diagnosis?: Diagnosis | null;
  /** The unit's fixtures and their rooms (for the scope rule), copied at the start. */
  fixtures?: { name: string; room?: string }[];
}

const NOT_SURE = "not_sure";

export function frameSlots(frame: IssueFrame): Record<string, string> {
  return Object.fromEntries(FRAME_SLOTS.map((s) => [s, frame[s]]));
}

export function startIntake(sop: Sop, frame: IssueFrame, confidence: "high" | "low", profile?: UnitProfile | null): IntakeState {
  return {
    issue_key: sop.issue_key,
    title: sop.title,
    confidence,
    answers: {},
    asked: [],
    slots: frameSlots(frame),
    complete: false,
    cause: null,
    fixtures: profile?.fixtures.map((f) => ({ name: f.name, room: f.room })) ?? [],
  };
}

function profileOf(state: IntakeState): UnitProfile {
  return { rooms: [], fixtures: (state.fixtures ?? []).map((f) => ({ name: f.name, room: f.room })) };
}

/** Values for conditions: answers first, then the frame. */
function values(state: IntakeState): Record<string, string> {
  const v: Record<string, string> = { ...state.slots };
  for (const [slot, a] of Object.entries(state.answers)) v[slot] = a.value;
  return v;
}

function holds(condition: Record<string, string[]> | undefined, v: Record<string, string>): boolean {
  if (!condition) return true;
  return Object.entries(condition).every(([slot, allowed]) => allowed.includes(v[slot] ?? "unknown"));
}

/**
 * The question as it can be asked now, through the scope rule (src/lib/sops/scope.ts):
 * null when it doesn't fit what's known. Every question and option goes through here.
 */
export function scopedQuestion(question: IntakeQuestion, state: IntakeState) {
  const v = values(state);
  const frame = { equipment: v.equipment ?? "unknown", substance: v.substance ?? "unknown", room: v.room ?? "unknown" };
  return scopeOptions(frame, profileOf(state), question);
}

/** Options that make sense now: the SOP's own conditions, then the scope rule (no shower for a fridge). */
export function optionsFor(question: IntakeQuestion, state: IntakeState): IntakeOption[] {
  const v = values(state);
  const scoped = scopedQuestion(question, state);
  if (!scoped) return [];
  return scoped.options.filter((o) => holds(o.only_if, v));
}

/** Is the slot already known? Frame slots count when the frame has them. */
export function isFilled(slot: string, state: IntakeState, known: { room?: boolean } = {}): boolean {
  if (state.answers[slot]) return true;
  if (slot === "room") return !!known.room;
  // Water on the floor or a pipe: where it comes from is still the question.
  if (slot === "equipment") return !NOT_A_SOURCE.has(state.slots.equipment ?? "unknown");
  if ((FRAME_SLOTS as readonly string[]).includes(slot)) return (state.slots[slot] ?? "unknown") !== "unknown";
  return false;
}

/** The next question to ask, or null when the intake is done. */
export function nextIntakeQuestion(sop: Sop, state: IntakeState, known: { room?: boolean } = {}): IntakeQuestion | null {
  const v = values(state);
  for (const q of sop.intake_questions) {
    if (state.asked.includes(q.id) || isFilled(q.slot, state, known) || !holds(q.only_if, v)) continue;
    if (!scopedQuestion(q, state)) continue; // out of scope (water questions for grease…)
    // A question whose only option left is "Not sure" isn't worth asking (free text excepted).
    if (q.options.length > 0 && optionsFor(q, state).every((o) => o.value === NOT_SURE)) continue;
    return q;
  }
  return null;
}

/** The option a free-text answer (or a first message) means, if any. */
export function matchOption(question: IntakeQuestion, state: IntakeState, text: string): IntakeOption | null {
  const options = optionsFor(question, state);
  const t = text.trim().toLowerCase();
  const exact = options.find((o) => o.label.toLowerCase() === t || o.value === t);
  if (exact) return exact;
  return options.find((o) => o.match && new RegExp(o.match, "i").test(text)) ?? null;
}

/**
 * Fill SOP slots the first message already answers ("leaks under the sink
 * when I drain it" → part and timing). Frame slots come from the frame.
 */
export function prefillFromMessage(sop: Sop, state: IntakeState, message: string): IntakeState {
  const next = { ...state, answers: { ...state.answers } };
  for (const q of sop.intake_questions) {
    if ((FRAME_SLOTS as readonly string[]).includes(q.slot) || next.answers[q.slot] || !q.prefill) continue;
    // Electrical safety and amounts are always asked: a first message rarely settles them.
    if (q.slot === "electrical_near" || q.slot === "amount") continue;
    const o = matchOption(q, next, message);
    if (o && o.value !== NOT_SURE && !o.emergency) next.answers[q.slot] = { value: o.value, label: o.label };
  }
  return withCause(sop, next);
}

export interface AnswerResult {
  state: IntakeState;
  /** A frame slot the answer set (the caller updates the stored frame). */
  frameUpdate: { slot: string; value: string } | null;
  /** The answer escalates (water near electrics…). */
  emergency: string | null;
}

/** Record an answer to `question` (by tap label or free text). */
export function answerIntake(sop: Sop, state: IntakeState, question: IntakeQuestion, text: string): AnswerResult {
  const next: IntakeState = { ...state, answers: { ...state.answers }, asked: [...state.asked, question.id] };
  const option = matchOption(question, next, text);
  const answer: IntakeAnswer = option ? { value: option.value, label: option.label } : { value: text.trim().slice(0, 200), label: text.trim().slice(0, 200) };
  next.answers[question.slot] = answer;
  let frameUpdate: AnswerResult["frameUpdate"] = null;
  if ((FRAME_SLOTS as readonly string[]).includes(question.slot) && option && option.value !== NOT_SURE) {
    next.slots = { ...next.slots, [question.slot]: option.value };
    frameUpdate = { slot: question.slot, value: option.value };
  }
  return { state: withCause(sop, next), frameUpdate, emergency: option?.emergency ?? null };
}

export interface RankedCause {
  id: string;
  label: string;
  score: number;
  candidate_parts: string[];
  trade: string;
  visit_minutes: [number, number];
  /** "question: answer" lines that point to it. */
  evidence: string[];
}

export interface Diagnosis {
  /** Top causes, most likely first (at most 3). */
  ranked: RankedCause[];
  /**
   * high: a diagnostic answer clearly separates the top cause (2+ points ahead);
   * medium: ahead by 1; low: no diagnostic answers yet, or a tie.
   */
  confidence: "high" | "medium" | "low";
  /** How many diagnostic questions got a real answer (not "not sure"). */
  answered: number;
}

function shortQuestion(q: IntakeQuestion): string {
  return q.question.replace(/\s*\(.*\)\s*$/, "").replace(/\?$/, "");
}

/** Rank the SOP's causes: prior, +2 for each answer that rules a cause in, −2 for each that rules it out. */
export function diagnose(sop: Sop, state: IntakeState): Diagnosis | null {
  if (sop.causes.length === 0) return null;
  const score: Record<string, number> = Object.fromEntries(sop.causes.map((c) => [c.id, c.prior]));
  const evidence: Record<string, string[]> = Object.fromEntries(sop.causes.map((c) => [c.id, []]));
  let answered = 0;
  for (const q of sop.intake_questions) {
    const a = state.answers[q.slot];
    if (!a || a.value === NOT_SURE) continue;
    const o = q.options.find((x) => x.value === a.value);
    if (!o || (!o.rules_in?.length && !o.rules_out?.length)) continue;
    answered++;
    for (const id of o.rules_in ?? []) if (id in score) {
      score[id] += 2;
      evidence[id].push(`${shortQuestion(q)}: ${a.label}`);
    }
    for (const id of o.rules_out ?? []) if (id in score) score[id] -= 2;
  }
  const ranked = sop.causes
    .map((c) => ({ id: c.id, label: c.label, score: score[c.id], candidate_parts: c.candidate_parts, trade: c.trade, visit_minutes: c.visit_minutes, evidence: evidence[c.id] }))
    .sort((x, y) => y.score - x.score)
    .slice(0, 3);
  const margin = ranked.length > 1 ? ranked[0].score - ranked[1].score : ranked[0].score;
  const confidence = answered === 0 ? "low" : margin >= 2 ? "high" : margin >= 1 ? "medium" : "low";
  return { ranked, confidence, answered };
}

/** Diagnosis, and the leading cause once an answer points somewhere. */
export function withCause(sop: Sop, state: IntakeState): IntakeState {
  const diagnosis = diagnose(sop, state);
  const top = diagnosis && diagnosis.answered > 0 ? sop.causes.find((c) => c.id === diagnosis.ranked[0].id) ?? null : null;
  return { ...state, diagnosis, cause: top };
}

/** Readable "question: answer" lines for the summary and work order. */
export function intakeLines(sop: Sop, state: IntakeState): string[] {
  return sop.intake_questions
    .filter((q) => state.answers[q.slot] && !(FRAME_SLOTS as readonly string[]).includes(q.slot))
    .map((q) => `${q.question.replace(/\s*\(.*\)\s*$/, "").replace(/\?$/, "")}: ${state.answers[q.slot].label}`);
}
