/**
 * widget.ts — TUI widget for running background jobs.
 *
 * Mirrors the oculus clean-widget pattern: the widget renders from a
 * `snapshotFn` callback over the engine's single source of truth (the job
 * registry). There is no separate job store — the widget always shows exactly
 * what is running, and no-ops on runtimes without widget hosting.
 *
 * Registered in widget-FACTORY mode (oculus convention: a Component holding
 * the session Theme, styled with theme.fg(token, text)): lines are green
 * (the "success" token) while jobs run. With no running jobs the widget is
 * removed entirely — setWidget(key, undefined) is the only content that
 * unregisters it; an empty line array would leave a registered empty
 * container behind.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** One running job for display. Scoped to what the widget needs. */
export interface JobEntry {
	id: string;
	toolName: string;
	label: string;
}

/** Provided by the engine: returns the currently running jobs at render time. */
export type JobSnapshotFn = () => JobEntry[];

/** Structural subset of pi-tui's Theme (keeps this file import-free). */
export interface WidgetTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

/** Structural subset of pi-tui's Component. */
export interface WidgetComponent {
	render(width: number): string[];
	dispose?(): void;
}

const WIDGET_KEY = "async-tools:jobs";
const MAX_LINES = 5;

/** Hard-clip to the viewport width (labels may exceed narrow terminals). */
function clip(text: string, width: number): string {
	if (width <= 0) return "";
	return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Green while jobs run; the header line is bold when the theme supports it. */
class JobsWidget {
	constructor(private theme: WidgetTheme, private lines: string[]) {}

	render(width: number): string[] {
		return this.lines.map((line, i) => {
			const clipped = clip(line, width);
			const styled = i === 0 && this.theme.bold ? this.theme.bold(clipped) : clipped;
			return this.theme.fg("success", styled);
		});
	}
}

/**
 * Set up the TUI widget rendered below the editor.
 *
 * Shows `Async: N background job(s) running` (green) plus up to MAX_LINES
 * entries. An empty snapshot HIDES the widget (undefined content).
 *
 * @param ui - Pi's UI context (may be undefined in headless mode)
 * @param snapshotFn - returns currently running jobs from the registry
 * @returns `update` — call to re-render from the latest snapshot; no-op when
 *          the UI can't host a widget.
 */
export function setupWidget(ui: ExtensionUIContext | undefined, snapshotFn: JobSnapshotFn): () => void {
	const setWidget = ui?.setWidget;

	function render(): string[] {
		const running = snapshotFn();
		if (running.length === 0) return [];
		const lines = [`Async: ${running.length} background job${running.length === 1 ? "" : "s"} running`];
		for (const job of running.slice(0, MAX_LINES)) {
			lines.push(`  ${job.id}  ${job.toolName}: ${job.label}`);
		}
		if (running.length > MAX_LINES) {
			lines.push(`  ...and ${running.length - MAX_LINES} more`);
		}
		return lines;
	}

	function update(): void {
		if (typeof setWidget !== "function") return;
		const lines = render();
		if (lines.length === 0) {
			// undefined removes the widget from Pi's widget map: with no jobs
			// there is nothing rendered at all — not even a blank slot.
			setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
			return;
		}
		setWidget(
			WIDGET_KEY,
			(_tui: unknown, theme: WidgetTheme): WidgetComponent => new JobsWidget(theme, lines),
			{ placement: "belowEditor" },
		);
	}

	update();
	return update;
}
