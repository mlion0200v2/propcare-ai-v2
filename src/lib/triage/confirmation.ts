/**
 * Parse the tenant's reply to "Here's your report summary — does this look right?"
 *
 * Pure, deterministic. Submitting the ticket is the irreversible step, so a
 * reply only counts as confirmation when it is affirmative AND contains no
 * negation or correction cue ("not right", "no, it's the bathroom",
 * "looks good but…"). Anything else is treated as a correction.
 */

const AFFIRMATIVE =
  /\b(yes|yeah|yep|yup|looks good|look good|looks great|looks right|correct|confirm(ed)?|that'?s right|that is right|right|good|submit( it)?|send( it)?|perfect|all good|sounds good|ok|okay|sure)\b/;

const NEGATION_OR_CORRECTION =
  /\b(no|nope|nah|not|never|isn'?t|is not|aren'?t|wasn'?t|don'?t|do not|doesn'?t|does not|wrong|incorrect|inaccurate|mistake|change|fix|edit|update|actually|but|except|however|instead|wait|hold on|missing|forgot)\b/;

export function isSummaryConfirmation(reply: string, confirmButton?: string): boolean {
  if (confirmButton === "confirm") return true;

  const text = reply
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .trim();
  if (!text) return false;
  if (NEGATION_OR_CORRECTION.test(text)) return false;
  return AFFIRMATIVE.test(text);
}
