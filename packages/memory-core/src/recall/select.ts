// Recall candidate selection: scores recall documents against the planned
// queries with the FTS-lite AND-semantics scorer and keeps the best hit per
// path. matchScore is reused over a description+body haystack (the SearchDocument
// projection does not fit recall files, so the haystack is composed directly).

import { matchScoreNormalized, normalizeText, parseQuery } from "../search"
import { rankRecallDocumentsBm25, tokenizeRecallText } from "./bm25"
import type { RecallDocument } from "./provider"

export interface RecallCandidate {
  readonly path: string
  readonly description: string
  readonly excerpt: string
  readonly score: number
}

/** Excerpt window length. Internal, deliberately not a config knob. */
const EXCERPT_CHARS = 200

/**
 * Normalized `description\nbody` per document object. RecallCorpusCache hands out the same document
 * objects for as long as HEAD has not moved, so this memo is naturally per corpus revision and a
 * moved HEAD (fresh objects) drops it. Composing and normalizing the haystack per document per
 * QUERY was ~20ms per query pass at a 4.2MB corpus (#8335); the scores it feeds are unchanged.
 */
const NORMALIZED_HAYSTACKS = new WeakMap<RecallDocument, string>()

function normalizedHaystack(document: RecallDocument): string {
  const cached = NORMALIZED_HAYSTACKS.get(document)
  if (cached !== undefined) return cached
  const haystack = normalizeText(`${document.description}\n${document.body}`)
  NORMALIZED_HAYSTACKS.set(document, haystack)
  return haystack
}

/** `substring`: FTS-lite AND scorer (default). `bm25`: OR-scored BM25 with CJK bigrams (see bm25.ts). */
export type RecallRanker = "substring" | "bm25"

export interface SelectRecallOptions {
  readonly maxItems: number
  /** Paths already surfaced earlier in the session; they never repeat. */
  readonly surfaced: ReadonlySet<string>
  /** Additional paths to skip, such as memories already visible in the transcript. Empty when omitted. */
  readonly excludePaths?: ReadonlySet<string>
  /** Candidate ranking; `substring` when omitted. */
  readonly ranker?: RecallRanker
}

export function selectRecallCandidates(
  documents: readonly RecallDocument[],
  queries: readonly string[],
  options: SelectRecallOptions,
): RecallCandidate[] {
  const maxItems = Math.max(0, options.maxItems)
  const parsedQueries = queries.map(parseQuery).filter((query) => query.terms.length > 0 || query.phrases.length > 0)
  if (maxItems === 0 || parsedQueries.length === 0) return []
  if (options.ranker === "bm25") return selectBm25Candidates(documents, queries, options, maxItems)

  const queryTerms = collectQueryTerms(parsedQueries)
  const scored: RecallCandidate[] = []
  for (const document of documents) {
    if (options.surfaced.has(document.path) || options.excludePaths?.has(document.path)) continue

    const haystack = normalizedHaystack(document)
    let best: number | null = null
    for (const parsed of parsedQueries) {
      const score = matchScoreNormalized(haystack, parsed)
      if (score === null) continue
      if (best === null || score < best) best = score
    }
    if (best === null) continue

    scored.push({
      path: document.path,
      description: document.description,
      excerpt: buildExcerpt(document.body, queryTerms),
      score: best,
    })
  }

  return scored
    .sort((left, right) => left.score - right.score || left.path.localeCompare(right.path))
    .slice(0, maxItems)
}

/**
 * BM25 path. The score keeps the RecallCandidate contract (ascending, lower is better) as
 * 1 / (1 + bm25), and the excerpt centers on the first query token the body actually contains, so a
 * bigram hit inside a longer Korean word still anchors the window.
 */
function selectBm25Candidates(
  documents: readonly RecallDocument[],
  queries: readonly string[],
  options: SelectRecallOptions,
  maxItems: number,
): RecallCandidate[] {
  // One-character tokens (a lone CJK syllable, a version digit) match almost anywhere and would drag the window.
  const queryTokens = [...new Set(queries.flatMap(tokenizeRecallText))].filter((token) => Array.from(token).length > 1)
  const candidates: RecallCandidate[] = []
  for (const { document, score } of rankRecallDocumentsBm25(documents, queries)) {
    if (options.surfaced.has(document.path) || options.excludePaths?.has(document.path)) continue
    candidates.push({
      path: document.path,
      description: document.description,
      excerpt: buildExcerpt(document.body, queryTokens),
      score: 1 / (1 + score),
    })
    if (candidates.length === maxItems) break
  }
  return candidates
}

function collectQueryTerms(
  parsedQueries: readonly { terms: readonly string[]; phrases: readonly string[] }[],
): string[] {
  const terms: string[] = []
  for (const parsed of parsedQueries) {
    terms.push(...parsed.terms)
    for (const phrase of parsed.phrases) terms.push(...phrase.split(/\s+/).filter(Boolean))
  }
  return terms
}

/**
 * Excerpt is a body region centered on the first query-term match, or the body
 * head when no query term matches the body. Whitespace is collapsed to single
 * spaces and the result never exceeds EXCERPT_CHARS.
 */
function buildExcerpt(body: string, terms: readonly string[]): string {
  const normalized = body.replace(/\s+/g, " ").trim()
  if (normalized === "") return ""

  const lowered = normalized.toLowerCase()
  let matchIndex = -1
  let matchLength = 0
  for (const term of terms) {
    const needle = normalizeText(term)
    if (needle === "") continue
    const index = lowered.indexOf(needle)
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
      matchIndex = index
      matchLength = needle.length
    }
  }
  if (matchIndex < 0) return normalized.slice(0, EXCERPT_CHARS)

  const start = Math.max(0, matchIndex - Math.floor((EXCERPT_CHARS - matchLength) / 2))
  const end = Math.min(normalized.length, start + EXCERPT_CHARS)
  const clampedStart = Math.max(0, end - EXCERPT_CHARS)
  return normalized.slice(clampedStart, end).trim()
}
