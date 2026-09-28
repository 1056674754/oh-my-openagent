// X11 scroll-direction scenarios: the engine's semantic scroll contract (positive `dy` moves the view
// toward the end of the content, positive `dx` toward its right edge, negatives back) on a Tk text
// widget, for XTEST (foreground) and XSendEvent (background) delivery. The widget reports its own
// view; the engine's report is never read.
import { asObject, Engine, type Outcome, outcome } from "./engine.ts";
import { type Context, type Result, result } from "./scenario.ts";
import type { ScrollView, X11Observer, X11Stage } from "./x11-env.ts";

const VERTICAL_CLICKS = 3;
const HORIZONTAL_CLICKS = 2;

interface Step {
	readonly reply: Outcome;
	readonly view: ScrollView;
}

export async function scrollDirection(
	ctx: Context,
	stage: X11Stage,
	observe: X11Observer,
	deliveryMode: "foreground" | "background",
): Promise<Result> {
	const engine = Engine.spawn(ctx.engineBinary, ctx.procs.childEnv(stage.env));
	try {
		await engine.activate(false);
		await observe.activate(stage.other);
		const frame = asObject(await engine.result("capture", { target: stage.scroll }));
		const at = {
			target: stage.scroll,
			x: Math.floor(Number(frame.width) / 2),
			y: Math.floor(Number(frame.height) / 2),
			frameId: frame.frameId ?? null,
			opts: { deliveryMode },
		};
		const step = async (dx: number, dy: number, from: ScrollView): Promise<Step> => {
			const reply = outcome(await engine.exec("scroll", { ...at, dx, dy }));
			return { reply, view: reply === "ok" ? await observe.scrollViewMoved(from) : observe.scrollView() };
		};
		const start = observe.scrollView();
		const before = { active: await observe.activeWindow(), ...start };
		const down = await step(0, VERTICAL_CLICKS, start);
		const up = await step(0, -VERTICAL_CLICKS, down.view);
		const right = await step(HORIZONTAL_CLICKS, 0, up.view);
		const left = await step(-HORIZONTAL_CLICKS, 0, right.view);
		const after = { active: await observe.activeWindow(), ...left.view };
		return result(
			`x11-scroll-direction-${deliveryMode}`,
			{
				other_active_before: before.active === stage.other,
				scroll_requests_ok: [down, up, right, left].every((taken) => taken.reply === "ok"),
				positive_dy_moves_toward_end: down.view.line > start.line,
				negative_dy_moves_toward_start: up.view.line < down.view.line,
				negative_dy_returns_to_start: up.view.line === start.line,
				positive_dx_moves_toward_right_edge: right.view.column > up.view.column,
				negative_dx_moves_toward_left_edge: left.view.column < right.view.column,
				negative_dx_returns_to_start: left.view.column === start.column,
				active_window_restored: after.active === before.active,
			},
			{
				display: stage.display,
				target: stage.scroll,
				other: stage.other,
				deliveryMode,
				point: { x: at.x, y: at.y },
				clicks: { vertical: VERTICAL_CLICKS, horizontal: HORIZONTAL_CLICKS },
				views: { start, afterPositiveDy: down.view, afterNegativeDy: up.view, afterPositiveDx: right.view, afterNegativeDx: left.view },
				replies: { positiveDy: down.reply, negativeDy: up.reply, positiveDx: right.reply, negativeDx: left.reply },
			},
			{ before, after },
		);
	} finally {
		await engine.close();
	}
}
