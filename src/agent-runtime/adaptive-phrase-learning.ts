export interface RankedAdaptivePhrase {
  phrase: string;
  ngram_size: number;
  chi_square: number;
  top_frequency_pct: number;
  bottom_frequency_pct: number;
  top_hits: number;
  bottom_hits: number;
}

export interface AdaptivePhraseOptions {
  maxPhrases?: number;
  maxNgramSize?: number;
  minChiSquare?: number;
}

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'before', 'but', 'by', 'can', 'for',
  'from', 'here', 'if', 'in', 'into', 'is', 'it', 'let', 'lets', 'many', 'more',
  'of', 'on', 'or', 'our', 'please', 'that', 'the', 'this', 'to', 'we', 'with',
  'you', 'your'
]);

export function extractRankedAdaptivePhrases(
  topScripts: string[],
  bottomScripts: string[],
  options: AdaptivePhraseOptions = {}
): RankedAdaptivePhrase[] {
  const maxPhrases = options.maxPhrases ?? 10;
  const maxNgramSize = options.maxNgramSize ?? 4;
  const minChiSquare = options.minChiSquare ?? 3.84;
  if (topScripts.length === 0 || bottomScripts.length === 0) return [];

  const topPhraseSets = topScripts.map((script) => extractPhraseSet(script, maxNgramSize));
  const bottomPhraseSets = bottomScripts.map((script) => extractPhraseSet(script, maxNgramSize));
  const candidates = new Set<string>();
  topPhraseSets.forEach((set) => set.forEach((phrase) => candidates.add(phrase)));

  const ranked: RankedAdaptivePhrase[] = [];
  candidates.forEach((phrase) => {
    const topHits = countContaining(topPhraseSets, phrase);
    const bottomHits = countContaining(bottomPhraseSets, phrase);
    const topRate = topHits / topPhraseSets.length;
    const bottomRate = bottomHits / bottomPhraseSets.length;
    if (topRate <= bottomRate) return;

    const chiSquare = chiSquared2x2({
      top_hit: topHits,
      top_miss: topPhraseSets.length - topHits,
      bottom_hit: bottomHits,
      bottom_miss: bottomPhraseSets.length - bottomHits
    });
    if (chiSquare < minChiSquare) return;

    ranked.push({
      phrase,
      ngram_size: phrase.split(/\s+/).filter(Boolean).length,
      chi_square: chiSquare,
      top_frequency_pct: topRate * 100,
      bottom_frequency_pct: bottomRate * 100,
      top_hits: topHits,
      bottom_hits: bottomHits
    });
  });

  return ranked
    .sort((a, b) =>
      b.chi_square - a.chi_square ||
      b.ngram_size - a.ngram_size ||
      b.top_frequency_pct - a.top_frequency_pct ||
      a.phrase.length - b.phrase.length
    )
    .slice(0, maxPhrases);
}

function extractPhraseSet(content: string, maxNgramSize: number): Set<string> {
  const phrases = new Set<string>();
  content
    .split(/[\n.!?。！？；;]+/u)
    .map((segment) => tokenize(segment))
    .forEach((tokens) => addPhrasesForTokens(tokens, maxNgramSize, phrases));
  return phrases;
}

function addPhrasesForTokens(tokens: string[], maxNgramSize: number, phrases: Set<string>): void {
  for (let n = 1; n <= maxNgramSize; n += 1) {
    for (let i = 0; i <= tokens.length - n; i += 1) {
      const slice = tokens.slice(i, i + n);
      if (slice.every((token) => ENGLISH_STOP_WORDS.has(token))) continue;
      const phrase = slice.join(' ').trim();
      if (phrase.length < 3) continue;
      phrases.add(phrase);
    }
  }
}

function tokenize(content: string): string[] {
  const normalized = content
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '');
  const segments = normalized.match(/[\p{L}\p{N}%]+/gu) ?? [];
  const tokens: string[] = [];
  segments.forEach((segment) => {
    if (isCjk(segment)) {
      for (let i = 0; i < segment.length - 1; i += 1) {
        tokens.push(segment.slice(i, i + 2));
      }
      if (segment.length >= 2) tokens.push(segment);
      return;
    }
    if (segment.length >= 2 && !ENGLISH_STOP_WORDS.has(segment)) {
      tokens.push(segment);
    }
  });
  return tokens;
}

function isCjk(value: string): boolean {
  return /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+$/u.test(value);
}

function countContaining(sets: Set<string>[], phrase: string): number {
  return sets.filter((set) => set.has(phrase)).length;
}

function chiSquared2x2(table: {
  top_hit: number;
  top_miss: number;
  bottom_hit: number;
  bottom_miss: number;
}): number {
  const total = table.top_hit + table.top_miss + table.bottom_hit + table.bottom_miss;
  if (total === 0) return 0;
  const rowTop = table.top_hit + table.top_miss;
  const rowBottom = table.bottom_hit + table.bottom_miss;
  const colHit = table.top_hit + table.bottom_hit;
  const colMiss = table.top_miss + table.bottom_miss;
  return (
    contribution(table.top_hit, (rowTop * colHit) / total) +
    contribution(table.top_miss, (rowTop * colMiss) / total) +
    contribution(table.bottom_hit, (rowBottom * colHit) / total) +
    contribution(table.bottom_miss, (rowBottom * colMiss) / total)
  );
}

function contribution(observed: number, expected: number): number {
  if (expected <= 0) return 0;
  const corrected = Math.max(Math.abs(observed - expected) - 0.5, 0);
  return (corrected * corrected) / expected;
}
