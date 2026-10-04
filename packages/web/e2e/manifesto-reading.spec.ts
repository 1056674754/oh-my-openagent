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

// The lit frontier: the deepest viewport Y (from the top) that is fully readable. A word counts as
// lit once its gradient fill has completed (`background-position-x` has swept to 0%). The reveal is
// a continuous window, so every word above the frontier is lit and every word below is at the floor.
function litFrontier(): number {
  let frontier = 0
  for (const word of Array.from(document.querySelectorAll<HTMLElement>(".lit-read .lit-word"))) {
    const positionX = Number.parseFloat(getComputedStyle(word).backgroundPositionX)
    if (positionX <= 0.5) {
      frontier = Math.max(frontier, word.getBoundingClientRect().bottom)
    }
  }
  return frontier
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
          expect(await page.evaluate(firstProgress)).toBe(
            variant === "timeline" ? "scroll" : "observer",
          )
          const blockCount = await page.evaluate(
            () => document.querySelectorAll(".lit-read").length,
          )
          expect(blockCount).toBeGreaterThan(4)

          const maxY = await page.evaluate(
            () => document.documentElement.scrollHeight - innerHeight,
          )
          let sawMid = false
          let previousFrontier = -1
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
            const frontier = await page.evaluate(litFrontier)
            // Per-word geometry: already-revealed text stays lit, so the lit frontier is monotonic
            // scrolling down (reading never un-lights).
            expect(frontier, `scrollY ${y}`).toBeGreaterThanOrEqual(previousFrontier - 1)
            previousFrontier = frontier
            // Once the reader has scrolled a screen, the lit region reaches well into the upper
            // viewport: the top of the screen is always fully readable.
            if (y > viewport.height) {
              expect(frontier, `scrollY ${y} readable screenful`).toBeGreaterThan(
                viewport.height * 0.4,
              )
            }
            if (frontier > viewport.height * 0.4 && frontier < viewport.height * 0.98) {
              sawMid = true
            }
          }
          expect(sawMid).toBe(true)

          // The reading floor is crisp: unrevealed words are never blurred (review H2).
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
          expect(blur).toEqual(["none"])

          // TALL-block contract: while scrolling through the tallest reading block at normal speed,
          // no already-revealed word goes dim again (per-word geometry keeps revealed text lit).
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
          if (tallest) {
            const litStates = new Map<string, boolean>()
            const startY = Math.max(0, Math.round(tallest.top - viewport.height))
            const endY = Math.min(maxY, Math.round(tallest.top + tallest.height))
            for (let y = startY; y <= endY; y += 60) {
              await page.evaluate(scrollSecret, y)
              await page.evaluate(
                () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
              )
              const lit = await page.evaluate(() =>
                Array.from(document.querySelectorAll<HTMLElement>(".lit-read .lit-word")).map(
                  (word, index) => ({
                    key: `${index}:${(word.textContent ?? "").slice(0, 8)}`,
                    lit: Number.parseFloat(getComputedStyle(word).backgroundPositionX) <= 0.5,
                  }),
                ),
              )
              for (const { key, lit: isLit } of lit) {
                if (litStates.get(key) === true) {
                  expect(isLit, `revealed word re-dimmed at scrollY ${y}: ${key}`).toBe(true)
                } else {
                  litStates.set(key, isLit)
                }
              }
            }
          }

          // Scrolled to the very bottom, everything is lit.
          await page.evaluate(scrollSecret, maxY)
          const endFrontier = await page.evaluate(litFrontier)
          const docHeight = await page.evaluate(() => document.documentElement.scrollHeight)
          expect(endFrontier).toBeGreaterThan(docHeight - viewport.height * 2)
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
      })
    })
  }
}
