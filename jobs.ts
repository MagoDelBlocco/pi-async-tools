/**
 * jobs.ts — Background job registry for the async-tools extension.
 *
 * Dependency-free by design: no Pi imports, so the async execution engine
 * (timed handoff, cancellation, settle notification) can be unit-tested
 * with plain Node.
 */

export type JobState = "running" | "completed" | "failed" | "cancelled";

/** Minimal structural shape of a Pi AgentToolResult (avoids importing pi types here). */
export interface JobResult {
	content: Array<{ type: string; text?: string; [k: string]: unknown }>;
	details?: unknown;
	isError?: boolean;
	[key: string]: unknown;
}

export interface Job {
	/** Short public id, e.g. "job-3". */
	id: string;
	/** Tool the job runs (e.g. "bash", "mcp__srv__tool"). */
	toolName: string;
	/** One-line human/model-facing description of the work. */
	label: string;
	state: JobState;
	startedAt: number;
	endedAt?: number;
	/** Set when the call was handed off to the background; ms of the sync grace period. */
	handoffMs?: number;
	/** Final result once settled. */
	result?: JobResult;
	/** Failure text once failed/cancelled. */
	error?: string;
	/** True once the result has reached the model — via the settle notification
	 * or by direct consumption (async_tools wait/kill claimed the delivery). */
	notified: boolean;
	/** True while a waiter (async_tools wait/kill) owns delivery; the settle
	 * notification stays suppressed. Independent of `notified`, so repeated
	 * claim/unclaim cycles can never deliver twice. */
	deliveryClaimed: boolean;
	/** Last settle-listener failure, if any (notifications must never break the job). */
	notifyError?: string;
	/** When true, settling the job triggers the onSettle hook for user-facing notification. */
	notifyPending: boolean;
	/** Abort controller owned by the job (detached from the turn signal after handoff). */
	controller: AbortController;
	/** Resolves when the job settles (never rejects; inspect state). */
	settled: Promise<Job>;
}

export interface SpawnJobOptions {
	toolName: string;
	label: string;
	/** The actual work. Must honor `signal` (abort => cancelled). May return any JobResult. */
	runner: (signal: AbortSignal) => Promise<JobResult>;
	/** If true, the job is background from birth and settling fires the notification. */
	background?: boolean;
}

function isAbortError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.name === "AbortError" || err.message === "aborted";
}

export function flattenResultText(result: JobResult | undefined, maxChars: number): string {
	if (!result) return "";
	const text = result.content
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[... truncated ${text.length - maxChars} chars of async job output ...]`;
}

export function formatElapsed(ms: number): string {
	const s = ms / 1000;
	return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export function describeJob(job: Job, contentMaxChars = 400): string {
	const elapsed = (job.endedAt ?? Date.now()) - job.startedAt;
	const handoff = job.handoffMs !== undefined ? `, handed off after ${formatElapsed(job.handoffMs)}` : "";
	const header = `${job.id} [${job.state}] ${job.toolName} — ${job.label} (${formatElapsed(elapsed)}${handoff})`;
	let body = job.error ?? "";
	if (job.state === "completed" && job.result) body = flattenResultText(job.result, contentMaxChars);
	return body ? `${header}\n${body}` : header;
}

/** User/model-facing completion notice for a settled background job. */
export function formatJobNotice(job: Job, contentMaxChars: number): string {
	const statusWord = job.state === "completed" ? "completed" : job.state;
	const elapsed = formatElapsed((job.endedAt ?? Date.now()) - job.startedAt);
	const head = `[async-tools] Background job ${job.id} ${statusWord} (${job.toolName}: ${job.label}, ${elapsed}).`;
	let body = job.error ?? "(no error information)";
	if (job.state === "completed") body = flattenResultText(job.result, contentMaxChars) || "(no output)";
	return `${head}\n\n${body}`;
}

export class JobRegistry {
	private jobs = new Map<string, Job>();
	private counter = 0;
	private settleListeners = new Set<(job: Job) => void>();
	private observers = new Set<(job: Job) => void>();

	constructor(private prefix = "job") {}

	/** Fire the user-facing completion notification exactly once per job. */
	private fireNotify(job: Job): void {
		if (!job.notifyPending || job.notified || job.deliveryClaimed) return;
		job.notified = true;
		for (const listener of this.settleListeners) {
			try {
				listener(job);
			} catch (err) {
				// A notification failure must never break the job or the runtime; record it on the job.
				job.notifyError = err instanceof Error ? err.message : String(err);
			}
		}
	}

	/** Register a settle (completion/failure/cancel) listener. Returns an unsubscribe function. */
	onSettle(listener: (job: Job) => void): () => void {
		this.settleListeners.add(listener);
		return () => this.settleListeners.delete(listener);
	}

	/**
	 * Observe EVERY settle, independent of the notification policy: settle
	 * listeners fire only for jobs marked for notify (or claimed/unclaimed),
	 * so UI repaints must not ride that path — a fast synchronous job that
	 * never notifies would otherwise leave the widget frozen on its
	 * spawn-time "running" paint. Returns an unsubscribe function.
	 */
	onObserve(listener: (job: Job) => void): () => void {
		this.observers.add(listener);
		return () => this.observers.delete(listener);
	}

	/** Fire observers; a UI failure must never break the job lifecycle. */
	private observe(job: Job): void {
		for (const listener of this.observers) {
			try {
				listener(job);
			} catch (err) {
				// Rendering is not load-bearing for jobs; record like fireNotify does.
				job.notifyError = err instanceof Error ? err.message : String(err);
			}
		}
	}

	list(): Job[] {
		return [...this.jobs.values()];
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	running(): Job[] {
		return this.list().filter((j) => j.state === "running");
	}

	/** Start a job immediately. The returned job's `settled` promise never rejects. */
	spawn(opts: SpawnJobOptions): Job {
		const id = `${this.prefix}-${++this.counter}`;
		const controller = new AbortController();
		const job: Job = {
			id,
			toolName: opts.toolName,
			label: opts.label,
			state: "running",
			startedAt: Date.now(),
			notified: false,
			deliveryClaimed: false,
			notifyPending: opts.background === true,
			controller,
			settled: Promise.resolve(), // replaced below
		};

		job.settled = (async () => {
			try {
				const result = await opts.runner(controller.signal);
				if (job.state === "running") {
					job.result = result;
					job.state = result.isError ? "failed" : "completed";
					if (result.isError) job.error = flattenResultText(result, 500);
				}
			} catch (err) {
				if (job.state === "running") {
					const msg = err instanceof Error ? err.message : String(err);
					job.state = isAbortError(err) || controller.signal.aborted ? "cancelled" : "failed";
					job.error = msg;
				}
			} finally {
				job.endedAt = Date.now();
				this.fireNotify(job);
				this.observe(job);
			}
			return job;
		})();

		this.jobs.set(id, job);
		return job;
	}

	/** Mark a job as background-owned: settling it will inject a completion notification. */
	markForNotify(job: Job, handoffMs: number): void {
		job.handoffMs = handoffMs;
		job.notifyPending = true;
		if (job.state === "running") return;
		// Race guard: the job settled while the handoff decision was being
		// made (the settle listener already ran with notifyPending false).
		// Notify now, or the promised result would be orphaned.
		this.fireNotify(job);
	}

	/**
	 * Claim delivery of a job's result: the caller (async_tools wait/kill)
	 * presents it to the model itself, so the settle notification must not
	 * duplicate it. Pair with unclaimDelivery when the claim is abandoned.
	 */
	claimDelivery(job: Job): void {
		job.deliveryClaimed = true;
	}

	/**
	 * Abandon a claim (wait timed out or was interrupted). If the job settled
	 * while claimed, notify now — the result was never actually shown; if it
	 * is still running, the settle listener will fire normally. Idempotent:
	 * a result that already reached the model is never re-delivered.
	 */
	unclaimDelivery(job: Job): void {
		job.deliveryClaimed = false;
		if (job.state === "running") return;
		this.fireNotify(job);
	}

	/** Abort a running job. Settled jobs are left untouched. Returns the job. */
	cancel(id: string): Job | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;
		if (job.state === "running") {
			// Pre-set the terminal state so runners that swallow the abort still read as cancelled.
			job.state = "cancelled";
			job.error = "Cancelled by user";
			job.endedAt = Date.now();
			job.controller.abort();
			this.observe(job); // repaint now; the runner may take a while to die
			void job.settled.then(() => this.fireNotify(job));
		}
		return job;
	}

	/** Cancel every running job (idempotent; used on session shutdown). */
	cancelAll(): void {
		for (const job of this.jobs.values()) {
			if (job.state === "running") this.cancel(job.id);
		}
	}
}

export interface HandoffDecision {
	/** "result": finished within the grace period (synchronous path). "handoff": exceeded it. */
	kind: "result" | "handoff";
	job: Job;
}

/**
 * Automatic-handoff core: await a spawned job but give up after
 * `thresholdMs`. On handoff the job keeps running in the background; the
 * caller returns a placeholder to the model and the registry notifies on
 * completion. `thresholdMs <= 0` means "never wait" (used in trials).
 */
export async function awaitWithHandoff(job: Job, thresholdMs: number): Promise<HandoffDecision> {
	if (thresholdMs <= 0) {
		return { kind: "handoff", job };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"handoff">((resolve) => {
		timer = setTimeout(() => resolve("handoff"), thresholdMs);
	});
	try {
		const winner = await Promise.race([job.settled.then(() => "result" as const), timeout]);
		if (winner === "handoff") return { kind: "handoff", job };
		return { kind: "result", job };
	} finally {
		if (timer) clearTimeout(timer);
	}
}
