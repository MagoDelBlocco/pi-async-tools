/**
 * util.ts — small shared helpers for async-tools.
 */

export type RaceOutcome = "settled" | "timeout" | "aborted";

/** Parse the --async-tools-timeout flag value; undefined when absent/invalid. */
export function parseTimeoutMs(raw: boolean | string | undefined): number | undefined {
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Race a job settlement against a cap and an optional abort signal; never rejects. */
export async function raceWithAbort(
	settled: Promise<unknown>,
	capMs: number,
	signal: AbortSignal | undefined,
): Promise<RaceOutcome> {
	if (signal?.aborted) return "aborted";
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const parts: Promise<RaceOutcome>[] = [
		settled.then(() => "settled" as const),
		new Promise<RaceOutcome>((resolve) => {
			timer = setTimeout(() => resolve("timeout"), capMs);
		}),
	];
	if (signal) {
		parts.push(
			new Promise<RaceOutcome>((resolve) => {
				onAbort = () => resolve("aborted");
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		);
	}
	try {
		return await Promise.race(parts);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort && signal) signal.removeEventListener("abort", onAbort);
	}
}
