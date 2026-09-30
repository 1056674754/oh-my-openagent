// Recall BM25 ranking: the alternative to the FTS-lite substring scorer that strategy.ts picks for
// CJK queries or corpora, and one half of the hybrid strategy for large corpora. Okapi BM25 over `description\nbody`, with a tokenizer
// that splits CJK runs (Hangul, Han, Kana) into character bigrams so an inflected Korean query word
// still meets the stored stem it shares a prefix with, without a morphological analyzer. Terms are OR-scored
// and idf-weighted, so a rare planner term outranks a common one instead of the earliest substring
// position deciding the order.
//
// Approach adapted from birkin-mnemosyne (https://github.com/ashmoonori-afk/birkin-mnemosyne),
// a zero-dependency BM25 memory store with Korean-aware bigram tokenization.

import { stemEnglishToken } from "./english-stem"
import type { RecallDocument } from "./provider"

const K1 = 1.5
const B = 0.75

// U+30FC (the Katakana-Hiragana prolonged sound mark) is Script=Common but belongs inside Kana runs.
export const CJK_CLASS = "\\p{Script=Hangul}\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30fc"
const TOKEN_PATTERN = new RegExp(`[${CJK_CLASS}]+|(?:(?![${CJK_CLASS}])[\\p{L}\\p{M}\\p{N}])+`, "gu")
const CJK_RUN = new RegExp(`^[${CJK_CLASS}]+$`, "u")

export interface RankedRecallDocument {
  readonly document: RecallDocument
  /** BM25 score; higher is better. Always positive for returned entries. */
  readonly score: number
}

interface RecallBm25Index {
  readonly termFrequencies: readonly ReadonlyMap<string, number>[]
  readonly lengths: readonly number[]
  readonly documentFrequency: ReadonlyMap<string, number>
  readonly averageLength: number
}

/**
 * NFKC-normalized, lowercased tokens: non-CJK letter/digit words as-is, CJK runs as the whole run plus
 * its character bigrams when the run is longer than two characters. NFKC composes NFD Hangul (common in
 * text pasted from macOS file names) and folds full-width Latin, so both sides meet on one form. A lone
 * CJK character emits no bigram, so it only matches an identical lone token, never a longer word.
 */
export function tokenizeRecallText(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.normalize("NFKC").toLowerCase().matchAll(TOKEN_PATTERN)) {
    const token = match[0]
    tokens.push(token)
    const characters = Array.from(token)
    if (characters.length > 2 && CJK_RUN.test(token)) {
      for (let index = 0; index + 1 < characters.length; index += 1) {
        tokens.push(`${characters[index]}${characters[index + 1]}`)
      }
    }
  }
  return tokens
}

/** Index and query terms: the tokens with English suffixes folded, so both sides meet on one form. */
export function recallTerms(text: string): string[] {
  return tokenizeRecallText(text).map(stemEnglishToken)
}

/**
 * One index per document array. RecallCorpusCache hands out the same array for as long as HEAD has
 * not moved, so the index is built once per corpus revision and a moved HEAD (a fresh array) drops it.
 * The array must not be mutated after it is first ranked: an in-place change keeps the stale index.
 */
const INDEXES = new WeakMap<readonly RecallDocument[], RecallBm25Index>()

function indexFor(documents: readonly RecallDocument[]): RecallBm25Index {
  const cached = INDEXES.get(documents)
  if (cached !== undefined) return cached

  const termFrequencies: Map<string, number>[] = []
  const lengths: number[] = []
  const documentFrequency = new Map<string, number>()
  for (const document of documents) {
    const frequencies = new Map<string, number>()
    const tokens = recallTerms(`${document.description}\n${document.body}`)
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    for (const token of frequencies.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    termFrequencies.push(frequencies)
    lengths.push(tokens.length)
  }
  const totalLength = lengths.reduce((sum, length) => sum + length, 0)
  const index: RecallBm25Index = {
    termFrequencies,
    lengths,
    documentFrequency,
    averageLength: documents.length === 0 ? 0 : totalLength / documents.length,
  }
  INDEXES.set(documents, index)
  return index
}

/**
 * Documents sharing at least one token with the queries, best first; ties break on path. Queries are
 * planner output, so quoted phrases are scored as their individual words.
 */
export function rankRecallDocumentsBm25(
  documents: readonly RecallDocument[],
  queries: readonly string[],
): RankedRecallDocument[] {
  const queryTerms = [...new Set(queries.flatMap(recallTerms))]
  if (queryTerms.length === 0 || documents.length === 0) return []

  const index = indexFor(documents)
  const averageLength = index.averageLength > 0 ? index.averageLength : 1
  const ranked: RankedRecallDocument[] = []
  documents.forEach((document, position) => {
    const frequencies = index.termFrequencies[position]
    const length = index.lengths[position] ?? 0
    if (frequencies === undefined) return
    let score = 0
    for (const term of queryTerms) {
      const frequency = frequencies.get(term)
      if (frequency === undefined) continue
      const documentFrequency = index.documentFrequency.get(term) ?? 0
      const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
      score += (idf * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * length) / averageLength))
    }
    if (score > 0) ranked.push({ document, score })
  })

  return ranked.sort((left, right) => right.score - left.score || left.document.path.localeCompare(right.document.path))
}
