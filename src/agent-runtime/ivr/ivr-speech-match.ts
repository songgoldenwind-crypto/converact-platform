/**
 * Map speech recognition text to menu digits via configured aliases.
 */

export function matchSpeechToDigit(
  speechResult: string,
  aliases: Array<{ digit: string; phrases: string[] }>
): string | null {
  const normalized = speechResult.trim().toLowerCase();
  for (const a of aliases) {
    for (const p of a.phrases) {
      if (normalized.includes(p.trim().toLowerCase())) return a.digit;
    }
  }
  return null;
}
