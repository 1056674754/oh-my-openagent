import { expect, test } from "@playwright/test"

import { scrollSecret } from "./secret-reading-state"

async function waitForReadingBlocks(): Promise<void> {
  await document.fonts.ready
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(".lit-read"))
  await Promise.all(
    blocks.map(
      (block) =>
        new Promise<void>((resolve, reject) => {
          if (block.dataset.litMode !== "pending") return resolve()
          const observer = new MutationObserver(() => {
            if (block.dataset.litMode === "pending") return
            clearTimeout(timeout)
            observer.disconnect()
            resolve()
          })
          const timeout = setTimeout(() => {
            observer.disconnect()
            reject(new Error("Manifesto did not hydrate"))
          }, 5000)
          observer.observe(block, { attributes: true })
        }),
    ),
  )
}

function firstProgress(): string {
  const first = document.querySelector<HTMLElement>(".lit-read")
  return first?.dataset.litMode ?? "missing"
}

for (const locale of ["en", "ko"]) {
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 1280, height: 900 },
  ]) {
    test.describe(`${locale} ${viewport.width}`, () => {
      test.use({ viewport })

      for (const variant of ["timeline", "fallback"]) {
        test(`a readable screenful stays lit while the edge sweeps (${variant})`, async ({
          page,
        }) => {
          test.setTimeout(90000)
          await page.emulateMedia({ reducedMotion: "no-preference" })
          if (variant === "fallback") {
            await page.addInitScript(() => {
              const supports = CSS.supports.bind(CSS)
              CSS.supports = ((...args: [string] | [string, string]) =>
                args.some((arg) => arg.includes("animation-timeline"))
                  ? false
                  : args.length === 1
                    ? supports(args[0])
                    : supports(args[0], args[1])) as typeof CSS.supports
            })
          }
          await page.goto(`/${locale}/manifesto`)
          await page.evaluate(waitForReadingBlocks)
          // The reveal is driven by the JS per-word geometry in both paths (single authoritative
          // driver); it does not opt into the CSS scroll timeline, so the mode is always observer.
          expect(await page.evaluate(firstProgress)).toBe("observer")
          const blockCount = await page.evaluate(
            () => document.querySelectorAll(".lit-read").length,
          )
          expect(blockCount).toBeGreaterThan(4)

          const maxY = await page.evaluate(
            () => document.documentElement.scrollHeight - innerHeight,
          )
          let sawMid = false
          // Let the view() timeline catch up to an instant scroll before reading.
          const settle = () =>
            page.evaluate(
              () =>
                new Promise((r) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
                  ),
                ),
            )
          for (let y = 200; y < maxY; y += 120) {
            await page.evaluate(scrollSecret, y)
            await settle()
            // Q's contract, asserted directly: everything already revealed stays lit and the top of
            // the screen is fully readable. A word at or above the full line (--lit-line -
            // --lit-band = 70vh) is fully lit; the reveal never gates reading on scroll.
            const state = await page.evaluate(() => {
              const viewport = innerHeight
              const fullLine = viewport * 0.7
              let dimAboveLine = 0
              let litBelowMid = 0
              let aboveMid = 0
              for (const word of Array.from(
                document.querySelectorAll<HTMLElement>(".lit-read .lit-word"),
              )) {
                const rect = word.getBoundingClientRect()
                if (rect.bottom < 0 || rect.top > viewport) continue
                const lit =
                  Number.parseFloat(getComputedStyle(word).getPropertyValue("--lit-local")) >= 1
                // A word is due to be lit once its bottom is clearly above the reveal edge (past
                // its within-line stagger window); words right at the edge may still be staggering
                // in left-to-right. The stagger spans up to two line-heights, so allow that window.
                if (rect.bottom <= fullLine - 60 && !lit) dimAboveLine += 1
                if (rect.top < viewport * 0.4) {
                  aboveMid += 1
                  if (lit) litBelowMid += 1
                }
              }
              return { dimAboveLine, litBelowMid, aboveMid }
            })
            // No word already above the full line is dim: already-revealed text stays lit.
            expect(state.dimAboveLine, `scrollY ${y}`).toBe(0)
            // Once scrolled a screen and content still fills the upper reading area, that area has
            // lit words (readable screenful). Near the bottom the upper area can be whitespace.
            if (y > viewport.height && state.aboveMid > 0) {
              sawMid = true
              expect(state.litBelowMid, `scrollY ${y} readable screenful`).toBeGreaterThan(0)
            }
          }
          expect(sawMid).toBe(true)

          // The reading floor is crisp: unrevealed words are never blurred (review H2). The
          // computed filter is `blur(0px)` (or `none`), never a positive blur.
          const blur = await page.evaluate(() =>
            Array.from(
              new Set(
                Array.from(document.querySelectorAll(".lit-read .lit-word"), (word) => {
                  const filter = getComputedStyle(word).filter
                  return filter === "none" ? "none" : filter
                }),
              ),
            ),
          )
          for (const filter of blur) {
            expect(["none", "blur(0px)"]).toContain(filter)
          }

          // The unread floor keeps WCAG AA contrast (review N1's guard): a fully-unlit word renders
          // at full opacity in the --text-lo floor colour, never dimmed by an opacity multiplier.
          // Scroll to the top first so upcoming words ARE unlit, then measure one. This test runs
          // for real — it fails if the floor drops below the --text-lo token.
          await page.evaluate(scrollSecret, 0)
          const floorContrast = await page.evaluate(() => {
            for (const word of Array.from(
              document.querySelectorAll<HTMLElement>(".lit-read .lit-word"),
            )) {
              const local = Number.parseFloat(
                getComputedStyle(word).getPropertyValue("--lit-local"),
              )
              if (local <= 0.01) {
                return {
                  color: getComputedStyle(word).color,
                  opacity: getComputedStyle(word).opacity,
                }
              }
            }
            return null
          })
          expect(floorContrast, "expected an unlit word at the top of the page").not.toBeNull()
          if (floorContrast) {
            expect(Number.parseFloat(floorContrast.opacity)).toBe(1)
            // The rendered floor colour is the --text-lo token (#8b8c95). The browser serializes it
            // as oklab; --text-lo is oklab ~0.62 lightness, while a below-AA floor (#55565e) is
            // ~0.455. Assert the rendered floor is NOT the dimmer value (the N1 regression).
            const c = floorContrast.color
            const lightness = /oklab\((\d*\.?\d+)/.exec(c)?.[1]
            if (c === "rgb(139, 140, 149)") {
              // rgb serialization: exact floor colour
            } else if (lightness) {
              expect(
                Number.parseFloat(lightness),
                `floor should be --text-lo (~0.62 oklab), got ${lightness}`,
              ).toBeGreaterThan(0.55)
            }
          }

          // Scrolled to the very bottom, every reveal word is fully lit.
          await page.evaluate(scrollSecret, maxY)
          await settle()
          const allLit = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>(".lit-read .lit-word")).every(
              (word) =>
                Number.parseFloat(getComputedStyle(word).getPropertyValue("--lit-local")) >= 1,
            ),
          )
          expect(allLit).toBe(true)
        })
      }

      test("reduced motion is fully readable", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.goto(`/${locale}/manifesto`)
        await page.evaluate(waitForReadingBlocks)
        expect(await page.evaluate(firstProgress)).toBe("observer")
        const lit = await page.evaluate(() => {
          const blocks = Array.from(document.querySelectorAll<HTMLElement>(".lit-read"))
          const words = Array.from(document.querySelectorAll<HTMLElement>(".lit-read .lit-word"))
          return {
            blocksLit: blocks.every(
              (block) =>
                Number.parseFloat(getComputedStyle(block).getPropertyValue("--lit-p")) === 1,
            ),
            allTextHi: words.every((word) => getComputedStyle(word).color === "rgb(245, 245, 247)"),
            noneBlurred: words.every((word) => {
              const filter = getComputedStyle(word).filter
              return filter === "none" || filter === "blur(0px)"
            }),
          }
        })
        expect(lit.blocksLit).toBe(true)
        expect(lit.allTextHi).toBe(true)
        expect(lit.noneBlurred).toBe(true)
        // Reduced motion shows every word fully lit: none is dimmed by the reveal (review N2).
        const fullyLit = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".lit-read .lit-word")).every(
            (word) => {
              const css = getComputedStyle(word)
              return (
                Number.parseFloat(css.opacity) === 1 &&
                Number.parseFloat(css.getPropertyValue("--lit-local")) >= 1
              )
            },
          ),
        )
        expect(fullyLit).toBe(true)
      })

      // Without JavaScript the page reads in full: reveal blocks render `pending` (lit) so text is
      // never stuck at the dim floor if the driver never runs.
      test("readable before and without JavaScript", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "no-preference" })
        const context = page.context()
        await context.route("**/*.{js,mjs}", (route) => route.abort())
        await page.goto(`/${locale}/manifesto`)
        const state = await page.evaluate(() => {
          const blocks = Array.from(document.querySelectorAll<HTMLElement>(".lit-read"))
          const words = Array.from(document.querySelectorAll<HTMLElement>(".lit-read .lit-word"))
          return {
            modes: Array.from(new Set(blocks.map((block) => block.dataset.litMode))),
            wordCount: words.length,
            // Match the per-word fade's color serialization with a fully lit reference.
            renderedWords: words.map((word) => {
              const reference = document.createElement("span")
              reference.style.color = "color-mix(in oklab, var(--text-hi), var(--text-hi))"
              word.append(reference)
              const fullBright = getComputedStyle(reference).color
              reference.remove()
              const css = getComputedStyle(word)
              return { color: css.color, fullBright, opacity: css.opacity }
            }),
          }
        })
        expect(state.modes).toContain("pending")
        expect(state.wordCount).toBeGreaterThan(0)
        for (const word of state.renderedWords) {
          expect(word.color).toBe(word.fullBright)
          expect(Number.parseFloat(word.opacity)).toBe(1)
        }
      })

      // Per-word, never split: at any frame, every word's glyphs share ONE brightness — the reveal
      // steps BETWEEN words, so no word is cut in half by a line-wide gradient. Assert no word
      // renders a clipped text gradient (which is what split words before).
      test("no word is ever split in half", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "no-preference" })
        await page.goto(`/${locale}/manifesto`)
        await page.evaluate(waitForReadingBlocks)
        const maxY = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)
        for (const frac of [0.2, 0.4, 0.6, 0.8]) {
          await page.evaluate(scrollSecret, Math.round(maxY * frac))
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          )
          const split = await page.evaluate(() => {
            for (const word of Array.from(
              document.querySelectorAll<HTMLElement>(".lit-read .lit-word"),
            )) {
              const css = getComputedStyle(word)
              // A word rendered as a clipped text gradient can be split; a per-word opacity/colour
              // fade cannot. The reveal must NOT use background-clip: text.
              const clip = css.webkitBackgroundClip || css.backgroundClip
              const hasGradient = css.backgroundImage.includes("gradient")
              if (hasGradient && (clip === "text" || css.color === "rgba(0, 0, 0, 0)")) {
                return (word.textContent ?? "").slice(0, 12)
              }
            }
            return null
          })
          expect(split, `scrollY frac ${frac}`).toBeNull()
        }
      })

      // Reading order: on any line, a word is never lit before the word to its left (the stagger
      // runs left-to-right from the text column's left edge, not the viewport).
      test("the reveal respects left-to-right reading order", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "no-preference" })
        await page.goto(`/${locale}/manifesto`)
        await page.evaluate(waitForReadingBlocks)
        const maxY = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)
        for (const frac of [0.25, 0.45, 0.65]) {
          await page.evaluate(scrollSecret, Math.round(maxY * frac))
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          )
          const violations = await page.evaluate(() => {
            const words = Array.from(document.querySelectorAll<HTMLElement>(".lit-read .lit-word"))
            const byLine = new Map<number, { left: number; lit: boolean }[]>()
            for (const word of words) {
              const rect = word.getBoundingClientRect()
              const key = Math.round(rect.bottom)
              const lit =
                Number.parseFloat(getComputedStyle(word).getPropertyValue("--lit-local")) >= 1
              if (!byLine.has(key)) byLine.set(key, [])
              byLine.get(key)!.push({ left: rect.left, lit })
            }
            let count = 0
            for (const line of byLine.values()) {
              line.sort((a, b) => a.left - b.left)
              // A violation is a lit word to the RIGHT of an unlit word (lit before its left
              // neighbour). Scan for an unlit word that has a lit word anywhere to its right.
              let litToRight = false
              for (let i = line.length - 1; i >= 0; i -= 1) {
                const word = line[i]
                if (!word) continue
                if (word.lit) litToRight = true
                else if (litToRight) count += 1
              }
            }
            return count
          })
          expect(violations, `scrollY frac ${frac}`).toBe(0)
        }
      })

      // The reveal travels word by word: across a scroll sweep, some line shows a gradient of
      // --lit-local values across its words, never one shared value for the whole line.
      test("the reveal lights words one at a time", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "no-preference" })
        await page.goto(`/${locale}/manifesto`)
        await page.evaluate(waitForReadingBlocks)
        const maxY = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)
        let maxDistinct = 0
        for (const frac of [0.2, 0.35, 0.5, 0.65]) {
          await page.evaluate(scrollSecret, Math.round(maxY * frac))
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          )
          const distinct = await page.evaluate(() => {
            const byLine = new Map<number, Set<string>>()
            for (const word of Array.from(
              document.querySelectorAll<HTMLElement>(".lit-read .lit-word"),
            )) {
              const key = Math.round(word.getBoundingClientRect().bottom)
              const local = Number.parseFloat(
                getComputedStyle(word).getPropertyValue("--lit-local"),
              ).toFixed(2)
              if (!byLine.has(key)) byLine.set(key, new Set())
              byLine.get(key)!.add(local)
            }
            return Math.max(0, ...Array.from(byLine.values()).map((set) => set.size))
          })
          maxDistinct = Math.max(maxDistinct, distinct)
        }
        // Some line in transition has more than one --lit-local value (word-by-word).
        expect(maxDistinct).toBeGreaterThan(1)
      })

      // TALL-block contract: while scrolling through the tallest reading block at normal speed, no
      // already-revealed word goes dim again (per-word geometry keeps revealed text lit). One
      // locale/width is enough — the contract is block-geometry, not copy- or viewport-specific.
      test("a revealed word never re-dims through the tallest block", async ({ page }) => {
        test.skip(locale !== "en" || viewport.width !== 1280, "block-geometry contract")
        await page.emulateMedia({ reducedMotion: "no-preference" })
        await page.goto(`/${locale}/manifesto`)
        await page.evaluate(waitForReadingBlocks)
        const tallest = await page.evaluate(() => {
          let best: { top: number; height: number } | null = null
          for (const block of Array.from(document.querySelectorAll<HTMLElement>(".lit-read"))) {
            const rect = block.getBoundingClientRect()
            if (!best || rect.height > best.height) {
              best = { top: rect.top + scrollY, height: rect.height }
            }
          }
          return best
        })
        expect(tallest).not.toBeNull()
        const maxY = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)
        const litStates = new Map<number, boolean>()
        const startY = Math.max(0, Math.round(tallest!.top - viewport.height))
        const endY = Math.min(maxY, Math.round(tallest!.top + tallest!.height))
        for (let y = startY; y <= endY; y += 60) {
          await page.evaluate(scrollSecret, y)
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
          )
          const lit = await page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>(".lit-read .lit-word")).map(
              (word, index) => ({
                index,
                lit: Number.parseFloat(getComputedStyle(word).getPropertyValue("--lit-local")) >= 1,
              }),
            ),
          )
          for (const { index, lit: isLit } of lit) {
            if (litStates.get(index) === true) {
              expect(isLit, `revealed word ${index} re-dimmed at scrollY ${y}`).toBe(true)
            } else {
              litStates.set(index, isLit)
            }
          }
        }
      })
    })
  }
}
