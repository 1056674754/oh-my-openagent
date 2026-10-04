import { expect, test } from "@playwright/test"

import { scrollSecret } from "./secret-reading-state"

interface BlockState {
  readonly index: number
  readonly top: number
  readonly bottom: number
  readonly progress: number
}

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

function readBlocks(): { mode: string; blocks: BlockState[] } {
  const first = document.querySelector<HTMLElement>(".lit-read")
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(".lit-read"))
  return {
    mode: first?.dataset.litMode ?? "missing",
    blocks: blocks.map((block, index) => {
      const rect = block.getBoundingClientRect()
      return {
        index,
        top: rect.top,
        bottom: rect.bottom,
        progress: Number.parseFloat(getComputedStyle(block).getPropertyValue("--lit-p")),
      }
    }),
  }
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
          const initial = await page.evaluate(readBlocks)
          expect(initial.mode).toBe(variant === "timeline" ? "scroll" : "observer")
          expect(initial.blocks.length).toBeGreaterThan(4)

          const maxY = await page.evaluate(
            () => document.documentElement.scrollHeight - innerHeight,
          )
          let sawEdge = false
          let previousProgress: number[] = []
          // After an instant jump the CSS view() timeline's currentTime lags one rendering update
          // behind the fallback (which is synchronous); wait for every block to report the settled
          // progress the range math guarantees before asserting.
          const settleTimeline = () =>
            page.waitForFunction(
              () => {
                const vh = innerHeight
                for (const block of Array.from(
                  document.querySelectorAll<HTMLElement>(".lit-read"),
                )) {
                  const rect = block.getBoundingClientRect()
                  const p = Number.parseFloat(getComputedStyle(block).getPropertyValue("--lit-p"))
                  if (rect.bottom < 0 && p !== 1) return false
                  if (rect.top > vh && p !== 0) return false
                }
                return true
              },
              undefined,
              { timeout: 5000 },
            )
          for (let y = 200; y < maxY; y += 89) {
            await page.evaluate(scrollSecret, y)
            await settleTimeline()
            const { blocks } = await page.evaluate(readBlocks)
            // The reveal is monotonic scrolling down: no block's progress decreases.
            for (const block of blocks) {
              const previous = previousProgress[block.index]
              if (previous !== undefined) {
                expect(block.progress, `scrollY ${y} block ${block.index}`).toBeGreaterThanOrEqual(
                  previous - 1e-6,
                )
              }
            }
            previousProgress = blocks.map((block) => block.progress)
            const edge = blocks.find((block) => block.progress > 0 && block.progress < 1)
            if (edge) {
              sawEdge = true
              // A block the edge has fully passed (scrolled above the viewport) is fully revealed.
              for (const block of blocks) {
                if (block.bottom < 0) {
                  expect(block.progress, `scrollY ${y} block ${block.index}`).toBe(1)
                }
              }
              // The edge block is on screen: the reveal band lives in the lower viewport, so the
              // block being reached overlaps the viewport.
              expect(edge.top, `scrollY ${y}`).toBeLessThan(viewport.height)
              expect(edge.bottom, `scrollY ${y}`).toBeGreaterThan(0)
            }
          }
          expect(sawEdge).toBe(true)

          await page.evaluate(scrollSecret, maxY)
          const bottom = await page.evaluate(readBlocks)
          expect(bottom.blocks.every((block) => block.progress === 1)).toBe(true)

          await page.evaluate(scrollSecret, 0)
          const top = await page.evaluate(readBlocks)
          expect(top.blocks.filter((block) => block.progress === 0).length).toBeGreaterThan(0)
        })
      }

      test("reduced motion is fully readable", async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.goto(`/${locale}/manifesto`)
        await page.evaluate(waitForReadingBlocks)
        const state = await page.evaluate(readBlocks)
        expect(state.mode).toBe("observer")
        const colors = await page.evaluate(() =>
          Array.from(
            new Set(
              Array.from(document.querySelectorAll(".lit-read .lit-word"), (word) => {
                const css = getComputedStyle(word)
                return `${css.color}|${css.backgroundImage}|${css.filter}`
              }),
            ),
          ),
        )
        expect(colors).toHaveLength(1)
        expect(colors[0]).toContain("none|none")
      })
    })
  }
}
