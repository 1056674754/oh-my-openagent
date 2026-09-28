// Foreground pointer scenarios (#9095): the engine's SendInput click, drag and scroll must land in
// the target window even when another window covers the target point and the cursor starts parked
// over that other window. Two pointer hosts overlap; the front one covers the target's centre and the
// QA side parks the cursor over the front one before each request, so an engine that sends a button
// or wheel before the cursor reached the intended point delivers it to the front window. Every fact
// comes from the hosts' own event logs and the independent pointer probe, never from the engine.
import { asObject, type Engine, errorCode, type Json, type JsonObject, type Reply } from "./engine"
import {
  eventAt,
  HOST_FIRST_VISIBLE_LINE,
  hostEvents,
  inside,
  type MouseTrace,
  mouseTrace,
  type Point,
  type PointerHost,
  type PointerProbe,
  pointerEvents,
  pointerHost,
  probe,
  probeHostsUntil,
  rectCenter,
  type ScreenRect,
} from "./pointer-kit"
import { type Checks, type Scenario, type ScenarioContext, type ScenarioOutcome, withEngine } from "./scenario-kit"

// The front host covers the target's centre; STALE lies over the front host only.
const TARGET_RECT: ScreenRect = { left: 100, top: 100, right: 580, bottom: 460 }
const FRONT_RECT: ScreenRect = { left: 340, top: 240, right: 820, bottom: 600 }
const STALE: Point = { x: 700, y: 540 }
/** A logged point may sit a few pixels off the mapped one: DWM's invisible borders widen GetWindowRect. */
const POINT_TOLERANCE = 10
const SCROLL_DELTA = 300

interface Stage {
  readonly target: PointerHost
  readonly front: PointerHost
  readonly trace: MouseTrace
  readonly frame: { readonly id: string | null; readonly width: number; readonly height: number }
  readonly before: PointerProbe
}

async function stage(context: ScenarioContext, engine: Engine, tag: string): Promise<Stage> {
  await engine.activate()
  const target = await pointerHost(context, engine, `${tag}-target`, TARGET_RECT)
  const front = await pointerHost(context, engine, `${tag}-front`, FRONT_RECT)
  const captured = asObject(await engine.result("capture", { target: target.id }))
  await engine.exec("raiseWindow", { windowId: front.id })
  await probeHostsUntil([target, front], (seen) => seen.foreground === front.id)
  const before = await probe([target, front], STALE)
  const trace = await mouseTrace(context, tag)
  return {
    target,
    front,
    trace,
    frame: {
      id: typeof captured.frameId === "string" ? captured.frameId : null,
      width: Number(captured.width),
      height: Number(captured.height),
    },
    before,
  }
}

/** A point of the target's frame (fractions of its size) and where it lies on screen. */
function framePoint(state: Stage, fx: number, fy: number): { readonly frame: Point; readonly screen: Point } {
  const frame = { x: Math.floor(state.frame.width * fx), y: Math.floor(state.frame.height * fy) }
  const rect = state.before.hosts[state.target.id]?.rect ?? TARGET_RECT
  const screen = {
    x: Math.floor(rect.left + ((rect.right - rect.left) * frame.x) / state.frame.width),
    y: Math.floor(rect.top + ((rect.bottom - rect.top) * frame.y) / state.frame.height),
  }
  return { frame, screen }
}

function at(state: Stage, point: Point): JsonObject {
  return { target: state.target.id, x: point.x, y: point.y, frameId: state.frame.id }
}

function stagingChecks(state: Stage, point: Point): Checks {
  const { before, front, target } = state
  return [
    ["front-raised-before", before.foreground === front.id],
    ["target-point-covered-by-front", inside(before.hosts[front.id]?.rect ?? null, point)],
    ["stale-cursor-parked-over-front", before.cursorRoot === front.id],
    ["stale-cursor-off-target", !inside(before.hosts[target.id]?.rect ?? null, before.cursor)],
  ]
}

function restoreChecks(state: Stage, after: PointerProbe): Checks {
  return [
    ["front-restored", after.foreground === state.front.id],
    ["cursor-restored", after.cursor.x === state.before.cursor.x && after.cursor.y === state.before.cursor.y],
  ]
}

async function outcome(state: Stage, checks: Checks, facts: JsonObject, after: PointerProbe): Promise<ScenarioOutcome> {
  await state.trace.stop()
  const failed = checks.find(([, passed]) => !passed)
  const checkFacts: JsonObject = {}
  for (const [name, passed] of checks) checkFacts[name] = passed
  const events: Json = {
    target: hostEvents(state.target),
    front: hostEvents(state.front),
    // WM_MOUSEMOVE 200, WM_LBUTTONDOWN 201, WM_LBUTTONUP 202, WM_MOUSEWHEEL 20A.
    mouseTrace: state.trace.lines().slice(-200),
  }
  return {
    pass: failed === undefined,
    ...(failed === undefined ? {} : { reason: failed[0] }),
    facts: { ...facts, target: state.target.id, front: state.front.id, events, checks: checkFacts },
    observer: { before: state.before.raw, after: after.raw },
  }
}

function replyFacts(name: string, reply: Reply): JsonObject {
  return { [`${name}Error`]: errorCode(reply) ?? null, [`${name}Message`]: reply.error?.message ?? null }
}

export const foregroundClickLandsInTarget: Scenario = {
  name: "foreground-click-lands-in-target",
  run: (context) =>
    withEngine(context, async (engine) => {
      const state = await stage(context, engine, "click")
      const point = framePoint(state, 0.5, 0.5)
      const reply = await engine.exec("click", { ...at(state, point.frame), opts: { deliveryMode: "foreground" } })
      const after = await probeHostsUntil([state.target, state.front], () => pointerEvents(state.target, "mouseup").length > 0)
      const down = pointerEvents(state.target, "mousedown")
      return outcome(
        state,
        [
          ...stagingChecks(state, point.screen),
          ["click-succeeded", reply.error === undefined],
          ["target-got-one-press-at-point", down.length === 1 && down.every((line) => eventAt(line, point.screen, POINT_TOLERANCE))],
          ["target-got-release", pointerEvents(state.target, "mouseup").length === 1],
          ["front-got-no-press", pointerEvents(state.front, "mousedown").length === 0],
          ...restoreChecks(state, after),
        ],
        { point: { ...point }, ...replyFacts("click", reply) },
        after,
      )
    }),
}

export const foregroundDragSelectsInTarget: Scenario = {
  name: "foreground-drag-selects-in-target",
  run: (context) =>
    withEngine(context, async (engine) => {
      const state = await stage(context, engine, "drag")
      const from = framePoint(state, 0.2, 0.5)
      const to = framePoint(state, 0.8, 0.5)
      const path = [from.frame, framePoint(state, 0.5, 0.5).frame, to.frame]
      const reply = await engine.exec("drag", {
        target: state.target.id,
        path: path.map((point) => ({ x: point.x, y: point.y })),
        frameId: state.frame.id,
        opts: { deliveryMode: "foreground" },
      })
      const after = await probeHostsUntil([state.target, state.front], () => pointerEvents(state.target, "mouseup").length > 0)
      const selection = after.hosts[state.target.id]?.selection ?? { start: -1, end: -1 }
      const frontSelection = after.hosts[state.front.id]?.selection ?? { start: -1, end: -1 }
      const down = pointerEvents(state.target, "mousedown")
      const up = pointerEvents(state.target, "mouseup")
      return outcome(
        state,
        [
          ...stagingChecks(state, from.screen),
          ["drag-succeeded", reply.error === undefined],
          ["target-press-at-path-start", down.length === 1 && down.every((line) => eventAt(line, from.screen, POINT_TOLERANCE))],
          ["target-release-at-path-end", up.length === 1 && up.every((line) => eventAt(line, to.screen, POINT_TOLERANCE))],
          ["target-text-selected", selection.end > selection.start && selection.start >= 0],
          ["front-got-no-press", pointerEvents(state.front, "mousedown").length === 0],
          ["front-selection-empty", frontSelection.start === frontSelection.end],
          ...restoreChecks(state, after),
        ],
        { from: { ...from }, to: { ...to }, selection: { ...selection }, ...replyFacts("drag", reply) },
        after,
      )
    }),
}

function firstLine(seen: PointerProbe, host: PointerHost): number {
  return seen.hosts[host.id]?.firstVisibleLine ?? -1
}

export const foregroundScrollMovesTarget: Scenario = {
  name: "foreground-scroll-moves-target",
  run: (context) =>
    withEngine(context, async (engine) => {
      const state = await stage(context, engine, "scroll")
      const hosts = [state.target, state.front]
      const point = framePoint(state, 0.5, 0.5)
      const scroll = (dy: number) =>
        engine.exec("scroll", { ...at(state, point.frame), dx: 0, dy, opts: { deliveryMode: "foreground" } })
      const start = firstLine(state.before, state.target)
      const down = await scroll(SCROLL_DELTA)
      const middle = await probeHostsUntil(hosts, (seen) => firstLine(seen, state.target) !== start)
      const afterPositive = firstLine(middle, state.target)
      const up = await scroll(-SCROLL_DELTA)
      const after = await probeHostsUntil(hosts, (seen) => firstLine(seen, state.target) !== afterPositive)
      const afterNegative = firstLine(after, state.target)
      const wheels = pointerEvents(state.target, "wheel")
      return outcome(
        state,
        [
          ...stagingChecks(state, point.screen),
          ["document-opens-mid-content", start === HOST_FIRST_VISIBLE_LINE],
          ["positive-dy-succeeded", down.error === undefined],
          ["positive-dy-moves-target-toward-end", afterPositive > start],
          ["negative-dy-succeeded", up.error === undefined],
          ["negative-dy-returns-target-to-start", afterNegative === start],
          ["target-wheels-at-point", wheels.length === 2 && wheels.every((line) => eventAt(line, point.screen, POINT_TOLERANCE))],
          ["front-got-no-wheel", pointerEvents(state.front, "wheel").length === 0],
          ["front-document-unmoved", firstLine(after, state.front) === HOST_FIRST_VISIBLE_LINE],
          ...restoreChecks(state, after),
        ],
        {
          point: { ...point },
          firstVisibleLine: { before: start, afterPositiveDy: afterPositive, afterNegativeDy: afterNegative },
          ...replyFacts("positiveDy", down),
          ...replyFacts("negativeDy", up),
        },
        after,
      )
    }),
}
