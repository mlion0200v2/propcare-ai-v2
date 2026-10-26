/**
 * Pick the SOP for what the tenant described.
 *
 * 1. Metadata filter: the SOP's applies_to must allow the frame's
 *    equipment, symptom and substance (an empty list allows anything).
 * 2. Rank: specific matches, keywords in the message, an optional vector
 *    similarity (Pinecone, live) and the SOP's priority.
 * Null (generic questions) when nothing passes or the frame is too vague.
 */
import type { IssueFrame } from "@/assistant/understanding/frame";
import { loadCatalog } from "./catalog";
import { generalIssueKey, isGeneralSop } from "./general";
import type { Sop } from "./schema";

export interface SopChoice {
  sop: Sop;
  score: number;
  /** "high": a clear winner on specific evidence. "low": a guess (still used, but noted). */
  confidence: "high" | "low";
  runnerUp: string | null;
}

const CJK = /[㐀-鿿]/;

function keywordHits(keywords: string[], text: string): number {
  let hits = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (CJK.test(k) ? text.includes(k) : new RegExp(`(^|[^\\p{L}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(e?s)?($|[^\\p{L}])`, "u").test(text)) hits++;
  }
  return hits;
}

function allows(list: string[], value: string): boolean {
  return list.length === 0 || list.includes(value);
}

export function scoreSop(sop: Sop, frame: IssueFrame, text: string, vectorScore = 0): number | null {
  if (!sop.selectable) return null;
  const a = sop.applies_to;
  if (!allows(a.equipment, frame.equipment) || !allows(a.symptoms, frame.symptom) || !allows(a.substances, frame.substance)) return null;
  let score = 0;
  if (frame.equipment !== "unknown" && a.equipment.includes(frame.equipment)) score += 3;
  if (frame.symptom !== "unknown" && a.symptoms.includes(frame.symptom)) score += 2;
  if (frame.substance !== "unknown" && a.substances.includes(frame.substance)) score += 0.5;
  score += Math.min(keywordHits(sop.keywords, text), 3) * 0.8;
  score += Math.min(keywordHits(sop.strong_keywords, text), 2) * 1.5;
  score += vectorScore * 2;
  score += sop.priority * 0.3;
  // For an emergency, prefer the emergency procedure (no heat in winter over a furnace check).
  if (sop.severity === "emergency" && frame.severity === "emergency") score += 3;
  return score;
}

export function selectSop(
  frame: IssueFrame,
  message: string,
  options: { vectorScores?: Record<string, number>; catalog?: Sop[] } = {}
): SopChoice | null {
  // Too vague to pick a procedure: generic questions first.
  if (frame.symptom === "unknown" && frame.equipment === "unknown") return null;
  const text = message.normalize("NFKC").toLowerCase();
  const catalog = options.catalog ?? loadCatalog();
  const ranked = catalog
    .filter((sop) => !isGeneralSop(sop))
    .map((sop) => ({ sop, score: scoreSop(sop, frame, text, options.vectorScores?.[sop.issue_key] ?? 0) }))
    .filter((r): r is { sop: Sop; score: number } => r.score !== null)
    .sort((x, y) => y.score - x.score);
  const best = ranked[0];
  if (!best || best.score < 2) {
    // No written SOP fits: the equipment's general one, when the equipment is known.
    const general = frame.equipment !== "unknown" ? catalog.find((s) => s.issue_key === generalIssueKey(frame.equipment)) : undefined;
    return general ? { sop: general, score: 0, confidence: "low", runnerUp: best?.sop.issue_key ?? null } : null;
  }
  const second = ranked[1];
  const specific = frame.symptom !== "unknown" && (frame.equipment !== "unknown" || frame.symptom === "pests" || best.score >= 4);
  return {
    sop: best.sop,
    score: Math.round(best.score * 100) / 100,
    confidence: specific && (!second || best.score - second.score >= 0.5) ? "high" : "low",
    runnerUp: second?.sop.issue_key ?? null,
  };
}
