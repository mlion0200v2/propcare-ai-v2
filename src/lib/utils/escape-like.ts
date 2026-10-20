/**
 * Escape a user-supplied string for use inside a Postgres LIKE / ILIKE pattern,
 * so `%`, `_` and `\` match literally instead of acting as wildcards.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
