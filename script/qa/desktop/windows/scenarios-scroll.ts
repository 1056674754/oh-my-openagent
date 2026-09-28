// Scroll-direction scenarios: the engine's semantic scroll contract (positive `dy` moves the view
// toward the end of the content, negative toward the start) on a real Win32 EDIT, for background
// (posted WM_MOUSEWHEEL) and foreground (SendInput) delivery. The EDIT's first visible line comes
// from the independent observer (EM_GETFIRSTVISIBLELINE), never from the engine.
import { readFileSync } from "node:fs"

import { asObject, type Engine, errorCode, type Reply } from "./engine"
import { SCROLL_DOCUMENT } from "./fixtures"
import { firstVisibleLine, type Observation, observeUntil } from "./observer"
import { type Scenario, type ScenarioContext, verdict, withEngine } from "./scenario-kit"
import { bringToFront } from "./scenarios-delivery"

/** Wheel notches per request; the EDIT scrolls SPI_GETWHEELSCROLLLINES (3 by default) lines per notch. */
const SCROLL_STEPS = 3

type DeliveryMode = "background" | "foreground"

async function scrollBy(engine: Engine, at: Record<string, string | number | null>, dy: number, mode: DeliveryMode): Promise<Reply> {
  return engine.exec("scroll", { ...at, dx: 0, dy, opts: { deliveryMode: mode } })
}

function lineMoved(ids: readonly string[], document: string, from: number): Promise<Observation> {
  return observeUntil(ids, (seen) => firstVisibleLine(seen, document) !== from)
}

function scrollDirection(mode: DeliveryMode): Scenario {
  return {
    name: `scroll-direction-${mode}`,
    run: (context: ScenarioContext) =>
      withEngine(context, async (engine) => {
        await engine.activate()
        const document = await context.workspace.scrollWindow(engine, mode)
        const front = await context.workspace.notepad(engine, `scroll-${mode}-front`)
        const ids = [document.id, front.id]
        const frame = asObject(await engine.result("capture", { target: document.id }))
        const at = {
          target: document.id,
          x: Math.floor(Number(frame.width) / 2),
          y: Math.floor(Number(frame.height) / 2),
          frameId: typeof frame.frameId === "string" ? frame.frameId : null,
        }
        const before = await bringToFront(engine, front, [document.id])
        const start = firstVisibleLine(before, document.id)
        const down = await scrollBy(engine, at, SCROLL_STEPS, mode)
        const middle = await lineMoved(ids, document.id, start)
        const afterPositive = firstVisibleLine(middle, document.id)
        const up = await scrollBy(engine, at, -SCROLL_STEPS, mode)
        const after = await lineMoved(ids, document.id, afterPositive)
        const afterNegative = firstVisibleLine(after, document.id)
        return verdict({
          checks: [
            ["front-raised-before", String(before.foreground) === front.id],
            ["document-opens-mid-content", start === SCROLL_DOCUMENT.firstVisibleLine],
            ["positive-dy-succeeded", down.error === undefined],
            ["positive-dy-moves-toward-end", afterPositive > start],
            ["negative-dy-succeeded", up.error === undefined],
            ["negative-dy-moves-toward-start", afterNegative >= 0 && afterNegative < afterPositive],
            ["negative-dy-returns-to-start", afterNegative === start],
            [mode === "background" ? "foreground-unchanged" : "front-restored", after.foreground === before.foreground],
          ],
          facts: {
            target: document.id,
            targetClass: before.windows[document.id]?.class ?? null,
            deliveryMode: mode,
            steps: SCROLL_STEPS,
            point: { x: at.x, y: at.y },
            cursorAfterPositiveDy: middle.cursor,
            cursorWindowAfterPositiveDy: middle.raw.cursorWindow ?? null,
            hostEvents: readFileSync(document.eventLog, "utf8").split("\n").filter((line) => line !== ""),
            firstVisibleLine: { before: start, afterPositiveDy: afterPositive, afterNegativeDy: afterNegative },
            positiveDyError: errorCode(down) ?? null,
            negativeDyError: errorCode(up) ?? null,
          },
          before,
          after,
        })
      }),
  }
}

export const scrollDirectionBackground = scrollDirection("background")
export const scrollDirectionForeground = scrollDirection("foreground")
