#!/usr/bin/env bun
// Recall ranker quality benchmark (memory.recall.ranker).
//
// Replays a synthetic, fictional memory corpus (English, Korean and code-switched queries, each with
// the gold note paths that answer it) through the real recall pipeline: planRecallQueries() on the
// query as a single user message, then selectRecallCandidates() once per ranker. It reports hit rate
// at 1/2/5 (2 is the default memory.recall.max_items), MRR, queries with no candidate at all, and the
// median selection time. The bm25 index is built once per document array (one corpus revision), so the
// per-query times are warm; the one-time cold build is reported separately.
//
// Usage: bun packages/omo-senpi/scripts/qa/recall-ranker-bench.mjs [--json]

import { readFileSync } from "node:fs"

import { planRecallQueries, selectRecallCandidates } from "@oh-my-opencode/memory-core"

const RANKERS = ["substring", "bm25"]
const DEPTH = 5

const fixture = JSON.parse(readFileSync(new URL("./fixtures/recall-ranker-corpus.json", import.meta.url), "utf8"))
const documents = fixture.documents

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function evaluate(ranker, queries) {
  let hit1 = 0
  let hit2 = 0
  let hit5 = 0
  let reciprocal = 0
  let empty = 0
  const timings = []
  for (const query of queries) {
    const gold = new Set(query.gold)
    const started = performance.now()
    const candidates = selectRecallCandidates(documents, planRecallQueries([query.text]), {
      maxItems: DEPTH,
      surfaced: new Set(),
      ranker,
    })
    timings.push(performance.now() - started)
    if (candidates.length === 0) empty += 1
    const rank = candidates.findIndex((candidate) => gold.has(candidate.path))
    if (rank === 0) hit1 += 1
    if (rank >= 0 && rank < 2) hit2 += 1
    if (rank >= 0 && rank < 5) hit5 += 1
    if (rank >= 0) reciprocal += 1 / (rank + 1)
  }
  const count = queries.length
  const ratio = (value) => Number((value / count).toFixed(3))
  return {
    queries: count,
    "R@1": ratio(hit1),
    "R@2": ratio(hit2),
    "R@5": ratio(hit5),
    MRR: ratio(reciprocal),
    empty,
    medianMs: Number(median(timings).toFixed(3)),
  }
}

function coldIndexBuildMs() {
  const started = performance.now()
  selectRecallCandidates([...documents], ["index"], { maxItems: 1, surfaced: new Set(), ranker: "bm25" })
  return Number((performance.now() - started).toFixed(3))
}

const coldBuildMs = coldIndexBuildMs()
const slices = [["all", fixture.queries], ...["en", "ko", "mixed"].map((lang) => [lang, fixture.queries.filter((query) => query.lang === lang)])]
const results = slices.flatMap(([slice, queries]) => RANKERS.map((ranker) => ({ slice, ranker, ...evaluate(ranker, queries) })))

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ documents: documents.length, bm25ColdIndexBuildMs: coldBuildMs, results }, null, 2))
} else {
  console.log(`corpus: ${documents.length} synthetic notes, ${fixture.queries.length} queries; bm25 cold index build ${coldBuildMs} ms`)
  console.log("| slice | ranker | queries | R@1 | R@2 | R@5 | MRR | no candidate | median ms |")
  console.log("|---|---|---|---|---|---|---|---|---|")
  for (const row of results) {
    console.log(`| ${row.slice} | ${row.ranker} | ${row.queries} | ${row["R@1"]} | ${row["R@2"]} | ${row["R@5"]} | ${row.MRR} | ${row.empty} | ${row.medianMs} |`)
  }
}
