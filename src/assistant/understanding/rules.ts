/**
 * Rules fast path and safety net for understanding. No network.
 *
 * Maps tenant words onto the taxonomy with typo tolerance (Latin words:
 * edit distance 1 for 5–8 letters, 2 for 9+, same first letter, and never
 * for a word that is itself a known term), joined/hyphenated forms
 * ("rangehood", "range hod"), and substring matching for Chinese. Used
 * directly when the model is unavailable or slow, and always merged with
 * the model's frame. Deterministic emergency rules (incl. French and
 * Chinese) run here.
 */
import { detectEmergency } from "@/assistant/triage/emergency";
import { emptyFrame, withUnknowns, type IssueFrame } from "./frame";
import {
  EQUIPMENT_LEXICON, SYMPTOM_LEXICON, SUBSTANCE_LEXICON, ROOM_LEXICON, ONSET_LEXICON, STATUS_LEXICON,
  EQUIPMENT_ROOM,
  type Equipment, type Symptom, type Substance, type Room, type Onset, type Status,
} from "./taxonomy";

const CJK = /[㐀-鿿]/;

function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    // French elision: l'évier → l évier, d'eau → d eau
    .replace(/\b(l|d|j|n|m|s|c|qu)'(?=[aeiouyhàâéèêëîïôûù])/g, "$1 ")
    // Possessive / contraction 's: ceiling's → ceiling
    .replace(/'s\b/g, "")
    // "next door" is a neighbour, not a door
    .replace(/\bnext door\b/g, "nextdoor")
    .replace(/[^\p{L}\p{N}'/㐀-鿿]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Damerau–Levenshtein distance, capped (returns cap+1 when larger). */
export function editDistance(a: string, b: string, cap = 2): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length][b.length];
}

/** Every single word that is itself a term somewhere: never "corrected" into another. */
const KNOWN_WORDS = new Set<string>(
  [EQUIPMENT_LEXICON, SYMPTOM_LEXICON, SUBSTANCE_LEXICON, ROOM_LEXICON]
    .flatMap((lex) => Object.values(lex) as string[][])
    .flat()
    .filter((p) => !CJK.test(p) && !/[\s-]/.test(p))
    .map((p) => stripAccents(p))
);

function tokenMatches(token: string, word: string): "exact" | "fuzzy" | null {
  const t = stripAccents(token);
  const w = stripAccents(word);
  if (t === w) return "exact";
  if (/\d/.test(w) || w.length < 5 || t[0] !== w[0] || KNOWN_WORDS.has(t)) return null;
  const allowed = w.length >= 9 ? 2 : 1;
  return editDistance(t, w, allowed) <= allowed ? "fuzzy" : null;
}

interface Hit {
  value: string;
  score: number; // longer phrases and exact matches score higher
  exact: boolean;
  /** Character offset in the normalised text (for "which was said first"). */
  pos: number;
  /** Token span (Latin), or the CJK phrase. */
  start: number;
  length: number;
  cjk?: string;
}

function tokenOffsets(tokens: string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const t of tokens) {
    offsets.push(at);
    at += t.length + 1;
  }
  return offsets;
}

/** Every match of every phrase in a lexicon. */
function findHits<T extends string>(text: string, tokens: string[], lexicon: Record<T, string[]>, fuzzyJoins = false): Hit[] {
  const hits: Hit[] = [];
  const offsets = tokenOffsets(tokens);
  const push = (value: string, phrase: string, exact: boolean, start: number, length: number, pos: number, cjk?: string) =>
    hits.push({ value, score: phrase.length * (exact ? 1 : 0.8), exact, pos, start, length, cjk });
  for (const [value, phrases] of Object.entries(lexicon) as [T, string[]][]) {
    for (const phrase of phrases) {
      if (CJK.test(phrase)) {
        const at = text.indexOf(phrase);
        if (at >= 0) push(value, phrase, true, -1, 0, at, phrase);
        continue;
      }
      const words = phrase.split(/[\s-]+/);
      const joined = words.join("");
      // Joined or split forms: "range hood" ↔ "rangehood", "door bell" ↔ "doorbell";
      // one typo allowed only for equipment names ("range hod"), never across
      // a word gap into a single word ("door fell" isn't "doorbell").
      for (let i = 0; i < tokens.length; i++) {
        for (const span of words.length > 1 ? [1, 2] : [2]) {
          if (i + span > tokens.length) continue;
          const candidate = tokens.slice(i, i + span).join("");
          if (candidate === joined) push(value, phrase, true, i, span, offsets[i]);
          else if (fuzzyJoins && words.length > 1 && !joined.includes("'") && candidate[0] === joined[0] && editDistance(candidate, joined, 1) <= 1)
            push(value, phrase, false, i, span, offsets[i]);
        }
      }
      // Consecutive tokens, each exact or within typo tolerance
      for (let i = 0; i + words.length <= tokens.length; i++) {
        let exact = true;
        let ok = true;
        for (let k = 0; k < words.length; k++) {
          const m = tokenMatches(tokens[i + k], words[k]);
          if (!m) {
            ok = false;
            break;
          }
          if (m === "fuzzy") exact = false;
        }
        if (ok) push(value, phrase, exact, i, words.length, offsets[i]);
      }
    }
  }
  return hits;
}

function best(hits: Hit[]): Hit | null {
  return hits.reduce<Hit | null>((b, h) => (!b || h.score > b.score ? h : b), null);
}

function findBest<T extends string>(text: string, tokens: string[], lexicon: Record<T, string[]>): Hit | null {
  return best(findHits(text, tokens, lexicon));
}

/** All values of a lexicon mentioned (exact or typo-tolerant). */
function findAll<T extends string>(text: string, tokens: string[], lexicon: Record<T, string[]>): Set<T> {
  return new Set(findHits(text, tokens, lexicon).map((h) => h.value as T));
}

const SYMPTOM_PRIORITY: Symptom[] = [
  "sparking", "draft", "leaking", "clogged", "no_hot_water", "no_water", "no_heat", "not_cooling", "beeping", "tripping",
  "running", "stuck", "pests", "mold", "smell", "noisy", "damaged", "broken", "not_working",
];
const SUBSTANCE_PRIORITY: Substance[] = ["gas", "smoke", "sewage", "grease", "oil", "water"];

/** Things that leak (or hold) water. A range hood doesn't (grease) — ask. */
const WATER_FIXTURES = new Set<Equipment>([
  "kitchen_sink", "bathroom_sink", "sink", "faucet", "toilet", "tub_shower", "pipe", "drain",
  "water_heater", "dishwasher", "washer", "fridge", "ceiling", "wall", "floor", "roof", "ac", "window",
  "garbage_disposal", "furnace", "gutter", "heat_pump",
]);
/** Where water ends up, not where it comes from: a named fixture wins. */
const SURFACES = new Set<Equipment>(["ceiling", "wall", "floor"]);
/** Things with power: "broken" means it doesn't work. */
const POWERED = new Set<Equipment>([
  "range_hood", "stove_oven", "microwave", "fridge", "dishwasher", "garbage_disposal", "washer", "dryer",
  "water_heater", "light", "outlet", "switch", "furnace", "baseboard_heater", "thermostat", "ac",
  "bathroom_fan", "intercom", "smoke_alarm", "co_alarm", "heat_pump", "elevator", "garage_door",
]);
const HEAT_APPLIANCES = new Set<Equipment>(["stove_oven", "dryer", "microwave"]);

const EMERGENCY_MULTILINGUAL: RegExp[] = [
  /煤气味|燃气味|闻到煤气|闻到燃气|漏气|着火|起火|失火|冒烟|火花|触电|一氧化碳|水管爆|爆管|到处都是水|淹水|污水倒灌|粪水|返臭水/,
  /\b(odeur de gaz|fuite de gaz|ça sent le gaz|ca sent le gaz|feu|incendie|fumée épaisse|étincelles|electrocut|monoxyde)\b/i,
  /\b(alarme|détecteur|avertisseur) (de fumée|incendie)\b[^.!?]{0,30}\bsonne\w*\b[^.!?]{0,20}\b(sans arrêt|toujours|fort)\b/i,
];

export function rulesFrame(message: string): IssueFrame {
  const frame = emptyFrame();
  const text = normalise(message);
  const tokens = text.split(" ").filter(Boolean);

  // Equipment: the best match; a fixture named before a ceiling/wall (or
  // anywhere, for the floor) is the subject: "shower leaks onto the floor".
  const eqHits = findHits(text, tokens, EQUIPMENT_LEXICON, true);
  let eq = best(eqHits);
  if (eq && SURFACES.has(eq.value as Equipment)) {
    const fixture = best(eqHits.filter((h) => !SURFACES.has(h.value as Equipment)));
    if (fixture && (eq.value === "floor" || fixture.pos < eq.pos)) eq = fixture;
  }
  let equipment: Equipment = (eq?.value as Equipment) ?? "unknown";
  const mentioned = new Set(eqHits.map((h) => h.value as Equipment));

  // The equipment's own words aren't symptoms, substances or rooms
  // ("smoke detector" isn't smoke; 抽油烟机 contains 烟; "kitchen sink").
  let restText = text;
  let restTokens = tokens;
  if (eq?.cjk) {
    restText = text.split(eq.cjk).join(" ");
  } else if (eq && eq.start >= 0) {
    restTokens = tokens.filter((_, i) => i < eq!.start || i >= eq!.start + eq!.length);
    restText = restTokens.join(" ");
  }

  // Room: the first one mentioned
  const roomHit = findHits(restText, restTokens, ROOM_LEXICON).reduce<Hit | null>(
    (first, h) => (!first || h.pos < first.pos || (h.pos === first.pos && h.score > first.score) ? h : first),
    null
  );
  const roomFromAll = roomHit ? null : findHits(text, tokens, ROOM_LEXICON).reduce<Hit | null>((b, h) => (!b || h.score > b.score ? h : b), null);
  let room: Room = (roomHit?.value as Room) ?? (roomFromAll?.value as Room) ?? "unknown";

  // Compose: "sink" + room → kitchen/bathroom sink; "exhaust fan" in a kitchen → range hood;
  // a drain is the shower's or the sink's when they're named.
  if (equipment === "drain" && mentioned.has("tub_shower")) equipment = "tub_shower";
  if (equipment === "drain" && mentioned.has("sink")) equipment = "sink";
  if (equipment === "sink" && room === "kitchen") equipment = "kitchen_sink";
  if (equipment === "sink" && room === "bathroom") equipment = "bathroom_sink";
  if (equipment === "bathroom_fan" && (room === "kitchen" || /\b(stove|cook|cooking|grease|oven)\b/.test(text))) equipment = "range_hood";
  // A bare "fan": the bathroom's or the kitchen's, by room.
  if (equipment === "unknown" && /\bfans?\b|ventilateur/.test(text)) {
    if (room === "bathroom") equipment = "bathroom_fan";
    else if (room === "kitchen" || /\b(stove|cook|cooking)\b/.test(text)) equipment = "range_hood";
  }

  // Symptom: the most specific mentioned
  const symptoms = findAll(restText, restTokens, SYMPTOM_LEXICON);
  if ((symptoms.has("not_cooling") && !["fridge", "ac", "unknown"].includes(equipment))) symptoms.delete("not_cooling");
  let symptom: Symptom = SYMPTOM_PRIORITY.find((s) => symptoms.has(s as never)) ?? "unknown";

  // Tripping is the breaker's (or a GFCI outlet's); "popping noises" elsewhere are noise.
  if (symptom === "tripping" && !["breaker", "outlet", "unknown"].includes(equipment) && !mentioned.has("breaker")) {
    symptoms.delete("tripping");
    symptom = SYMPTOM_PRIORITY.find((s) => symptoms.has(s as never)) ?? "unknown";
  }
  // A power outage is the panel's
  if (equipment === "unknown" && /\b(no power|power is out|power out|power outage|lost power)\b|没电|停电/.test(text)) equipment = "breaker";
  if (symptom === "tripping" && equipment !== "outlet" && (mentioned.has("breaker") || equipment === "unknown")) equipment = "breaker";
  if (equipment === "smoke_alarm" || equipment === "co_alarm") {
    if (symptoms.has("beeping") || symptom === "noisy" || symptom === "unknown" || symptom === "running") symptom = "beeping";
  }
  if (equipment === "toilet" && symptoms.has("running")) symptom = "running";
  if (equipment === "toilet" && /\boverflow/.test(text)) symptom = "clogged";
  // Drains and gutters that overflow or pool are blocked.
  if ((equipment === "drain" || equipment === "gutter") && symptom === "leaking" && /\b(overflow\w*|pool\w*|block\w*|clog\w*|déborde\w*)\b|堵/.test(text)) symptom = "clogged";
  // Water pooling on a balcony is its drain.
  if (equipment === "unknown" && /\b(balcony|deck|patio)\b|阳台/.test(text) && /\b(pool\w*|drain\w*|clog\w*)\b/.test(text)) {
    equipment = "drain";
    symptom = "clogged";
  }
  // Overflowing bins are a missed pickup.
  if (equipment === "garbage" && symptom === "leaking") symptom = "not_working";
  if (equipment === "faucet" && symptom === "running") symptom = "leaking";
  if (equipment === "garbage_disposal" && (symptom === "noisy" || /\b(hum|hums|humming|buzz|buzzes|buzzing)\b/.test(text))) symptom = "stuck";
  if ((equipment === "fridge" || equipment === "ac") && (symptoms.has("not_cooling") || symptom === "no_heat")) symptom = "not_cooling";
  if (equipment === "ac" && (symptom === "not_working" || symptom === "broken")) symptom = "not_cooling";
  if (HEAT_APPLIANCES.has(equipment) && symptom === "no_heat") symptom = "not_working";
  if ((equipment === "furnace" || equipment === "baseboard_heater") && ["not_working", "broken", "not_cooling"].includes(symptom)) symptom = "no_heat";
  if (POWERED.has(equipment) && symptom === "broken" && !/\b(fell|came) off\b|\bsnapped\b|\bcracked\b/.test(text)) symptom = "not_working";
  if (equipment === "light" && symptom === "unknown" && /\bout\b/.test(restText)) symptom = "not_working";
  // "No hot water" is the water heater's, whatever tap or shower it was noticed at.
  let equipmentInferred = false;
  if (symptom === "no_hot_water" && equipment !== "water_heater") {
    equipment = "water_heater";
    equipmentInferred = true;
    if (!roomHit) room = "unknown";
  }
  // Pests are about the pests, not the wall or window they're near (garbage rooms aside).
  if (symptom === "pests" && equipment !== "garbage") equipment = "unknown";

  // Substance: explicit first; oil at a hood or stove is grease
  const substances = findAll(restText, restTokens, SUBSTANCE_LEXICON);
  let substance: Substance = SUBSTANCE_PRIORITY.find((s) => substances.has(s as never)) ?? "unknown";
  if (substance === "oil" && (equipment === "range_hood" || equipment === "stove_oven")) substance = "grease";
  // Water said, nothing else: it's leaking. Smoke/gas/sewage said: it's a smell.
  if (symptom === "unknown" && substance === "water") symptom = "leaking";
  if (symptom === "unknown" && (substance === "smoke" || substance === "gas" || substance === "sewage")) symptom = "smell";
  // Substance is what leaks, backs up or smells; "water pressure" isn't a leak.
  if (substance === "water" && !["leaking", "clogged", "running", "damaged", "unknown"].includes(symptom)) substance = "unknown";
  if (symptom === "no_hot_water" || symptom === "no_water") substance = "none";
  let substanceConfidence = substance === "unknown" ? 0 : 0.9;
  if (substance === "unknown") {
    if ((symptom === "leaking" || symptom === "clogged" || symptom === "running") && WATER_FIXTURES.has(equipment)) {
      substance = "water";
      substanceConfidence = 0.6;
    } else if (symptom === "leaking" && equipment === "unknown") {
      substance = "water";
      substanceConfidence = 0.5;
    } else if (symptom !== "unknown" && symptom !== "leaking" && symptom !== "smell") {
      substance = "none";
      substanceConfidence = 0.6;
    }
  }
  if (equipment === "co_alarm" && substance === "none" && !/\b(chirp|chirps|chirping|low battery|battery)\b/.test(text)) substance = "gas";

  // Room from the equipment when not said
  let roomConfidence = roomHit ? (roomHit.exact ? 0.9 : 0.7) : 0;
  if (room === "unknown" && equipment !== "unknown" && EQUIPMENT_ROOM[equipment]) {
    room = EQUIPMENT_ROOM[equipment]!;
    roomConfidence = 0.7;
  }

  const onsetHit = findBest(text, tokens, ONSET_LEXICON);
  const statusHit = findBest(text, tokens, STATUS_LEXICON);

  frame.equipment = equipment;
  frame.symptom = symptom;
  frame.substance = substance;
  frame.room = room;
  frame.onset = (onsetHit?.value as Onset) ?? "unknown";
  frame.status = (statusHit?.value as Status) ?? (symptom === "running" ? "ongoing" : "unknown");
  frame.confidence = {
    equipment: equipmentInferred ? 0.6 : eq ? (eq.exact ? 0.9 : 0.7) : 0,
    symptom: symptom === "unknown" ? 0 : 0.8,
    substance: substanceConfidence,
    room: roomConfidence,
    onset: onsetHit ? 0.8 : 0,
    status: statusHit ? 0.8 : symptom === "running" ? 0.6 : 0,
  };

  // Severity: deterministic emergency rules always apply
  const emergency =
    detectEmergency(message) !== null ||
    EMERGENCY_MULTILINGUAL.some((p) => p.test(message)) ||
    substance === "gas" ||
    symptom === "sparking" ||
    (equipment === "co_alarm" && !/\b(chirp|chirps|chirping|low battery|battery)\b/.test(text));
  frame.severity = emergency
    ? "emergency"
    : substance === "sewage" || /\b(flood|flooding|spreading|everywhere)\b/.test(text) || symptom === "no_heat"
      ? "high"
      : symptom === "beeping" || symptom === "noisy"
        ? "low"
        : "medium";

  return withUnknowns(frame);
}

/** Every piece of equipment a text names ("when the shower or toilet is used" → tub_shower, toilet). */
export function mentionedEquipment(text: string): Set<Equipment> {
  const t = normalise(text);
  const hits = findHits(t, t.split(" ").filter(Boolean), EQUIPMENT_LEXICON);
  // "heater" inside "water heater" is the water heater, not a second appliance.
  const inside = (a: Hit, b: Hit) =>
    a !== b && a.value !== b.value && (a.cjk ? !!b.cjk && b.cjk.includes(a.cjk) && b.cjk !== a.cjk : a.start >= b.start && a.start + a.length <= b.start + b.length && a.length < b.length);
  return new Set(hits.filter((h) => !hits.some((o) => inside(h, o))).map((h) => h.value as Equipment));
}

/** The room a text names, if any ("Main bathroom (hallway)" → bathroom). */
export function mentionedRoom(text: string): Room | null {
  const t = normalise(text);
  return (findBest(t, t.split(" ").filter(Boolean), ROOM_LEXICON)?.value as Room) ?? null;
}
