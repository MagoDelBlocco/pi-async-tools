/**
 * engine.ts — managed execution core for async-tools.
 *
 * Owns the job registry, the automatic handoff race, handoff placeholders,
 * turn-signal linking, completion notification injection, and the UI
 * (footer status item, styled per the guardrails/oculus convention).
 * Delivery: while the agent runs, results are steered — delivered after the
 * current assistant turn's tool calls, before its next LLM call. When idle,
 * completion triggers a turn so no result is orphaned.
 */

import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import {
	awaitWithHandoff,
	formatJobNotice,
	Job,
	JobRegistry,
	JobResult,
} from "./jobs.ts";
import { parseTimeoutMs } from "./util.ts";

export const CUSTOM_TYPE_RESULT = "async-tools:job-result";
export const NOTIFY_CONTENT_MAX = 6000;
export const DEFAULT_TIMEOUT_MS = 5000;

/** Result details for handed-off (background) calls. */
export interface AsyncJobDetails {
	asyncJob: { id: string; toolName: string; label: string; handoffMs: number };
}

export interface ManagedRunOptions {
	toolName: string;
	label: string;
	/** True for calls issued by another tool (ctx.executeTool): never handed off — the caller must receive the real result. */
	nested: boolean;
	ctx: ExtensionToolContext;
	/** Forwarded partial-result callback; frozen at handoff. */
	onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined;
	/** The real work. Rejects/throws on failure; honors the abort signal. */
	work: (
		signal: AbortSignal,
		onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
	) => Promise<JobResult>;
}

export interface AsyncEngine {
	registry: JobRegistry;
	/** Tool-call ids issued by another tool (parentToolCallId set), tracked from `tool_call`. */
	nestedCallIds: Set<string>;
	setLiveCtx(ctx: ExtensionContext): void;
	/** Install the session UI: the footer status item (guardrails/oculus pattern). */
	setupUi(ctx: ExtensionContext): void;
	/** Repaint the footer status item from current registry state. */
	refreshUi(): void;
	/** Stop queued notification retries during session shutdown. */
	stopNotifications(): void;
	runManaged(o: ManagedRunOptions): Promise<AgentToolResult<AsyncJobDetails>>;
	/** Handoff threshold in ms, re-read per call so flag changes apply. */
	timeoutMs(): number;
}

export function createEngine(pi: ExtensionAPI): AsyncEngine {
	const registry = new JobRegistry("job");
	const nestedCallIds = new Set<string>();
	let liveCtx: ExtensionContext | undefined;
	let lastUiError: string | undefined;
	let notificationsStopped = false;
	const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const retryAttempts = new Map<string, number>();

	function scheduleRetry(job: Job): void {
		if (notificationsStopped || retryTimers.has(job.id)) return;
		const attempt = retryAttempts.get(job.id) ?? 0;
		const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30000);
		retryAttempts.set(job.id, attempt + 1);
		const timer = setTimeout(() => {
			retryTimers.delete(job.id);
			if (!notificationsStopped) {
				registry.retryNotify(job);
				if (job.notified || job.deliveryClaimed) retryAttempts.delete(job.id);
			}
		}, delay);
		retryTimers.set(job.id, timer);
	}

	function stopNotifications(): void {
		notificationsStopped = true;
		for (const timer of retryTimers.values()) clearTimeout(timer);
		retryTimers.clear();
		retryAttempts.clear();
	}

	function setStatusLine(ctx?: ExtensionContext): void {
		const n = registry.running().length;
		const ui = (ctx ?? liveCtx)?.ui;
		try {
			if (!ui) return;
			if (n === 0) {
				ui.setStatus("async", undefined); // idle: no footer element at all
				return;
			}
			// guardrails/oculus convention: `name: state` label, success fg on toolSuccessBg.
			const label = `async: ${n} running`;
			ui.setStatus(
				"async",
				typeof ui.theme?.fg === "function" ? ui.theme.bg("toolSuccessBg", ui.theme.fg("success", label)) : label,
			);
		} catch (err) {
			// Status UI is unavailable in some modes (print/json); record and carry on —
			// jobs and notifications are independent of rendering.
			lastUiError = err instanceof Error ? err.message : String(err);
		}
	}

	function refreshUi(): void {
		setStatusLine();
	}

	function setupUi(ctx: ExtensionContext): void {
		// Footer status item only — the count reads the registry at render time
		// (single source of truth). No below-editor widget: one compact slot,
		// like guardrails and oculus own theirs.
		setStatusLine(ctx);
	}

	function notifyJob(job: Job): void {
		if (notificationsStopped) return;
		// Mid-run: steer, so the result lands after the agent's current tool
		// batch and before its next LLM call (Pi's steering boundary). Idle:
		// trigger a turn — otherwise the result would never be seen.
		const idle = liveCtx?.isIdle() ?? true;
		pi.sendMessage(
			{ customType: CUSTOM_TYPE_RESULT, content: formatJobNotice(job, NOTIFY_CONTENT_MAX), display: true, details: { jobId: job.id } },
			idle ? { triggerTurn: true } : { deliverAs: "steer" },
		);
	}

	registry.onSettle((job) => {
		try {
			notifyJob(job);
		} catch (err) {
			scheduleRetry(job);
			throw err; // Registry records the failure and leaves delivery pending.
		}
		retryAttempts.delete(job.id);
	});

	// Repaint on EVERY settle, notified or not: a fast synchronous call never
	// sends a notification, and riding the notify path would leave the status
	// stuck on its spawn-time "1 running" forever.
	registry.onObserve(() => refreshUi());

	function handoffPlaceholder(job: Job, graceMs: number): AgentToolResult<AsyncJobDetails> {
		const text =
			`Call moved to background as ${job.id} (${job.toolName}: ${job.label}) after ${(graceMs / 1000).toFixed(1)}s. ` +
			`It will finish on its own — you may proceed with outstanding work that is NOT dependent on this call. ` +
			`The result will be delivered to you automatically (after your current tool batch, or as a new turn if you have stopped). ` +
			`Need the result now? async_tools {"action":"wait","job":"${job.id}","timeout":60}. Kill it: {"action":"kill","job":"${job.id}"}. ` +
			`End-of-turn rule, do not recite: if you believe this is the last task before returning control to the user and the result is not needed to finish the answer, do not block on wait. ` +
			`First recap the changes you made and mentally re-check them against the request, then play devil's advocate for your own work: look for a missed requirement, a broken assumption, or an unverified claim. ` +
			`Fix a mistake only if you are confident one exists; otherwise do not backtrack or keep polishing. Then return control — the result still arrives automatically.`;
		return {
			content: [{ type: "text", text }],
			details: { asyncJob: { id: job.id, toolName: job.toolName, label: job.label, handoffMs: graceMs } },
		};
	}

	function settleToResult(job: Job): AgentToolResult<AsyncJobDetails> {
		if (job.result) return job.result as AgentToolResult<AsyncJobDetails>;
		throw new Error(job.error ?? `Job ${job.id} ${job.state}`);
	}

	async function runManaged(o: ManagedRunOptions): Promise<AgentToolResult<AsyncJobDetails>> {
		let handedOff = false;
		const forward = o.onUpdate
			? (partial: AgentToolResult<unknown>) => {
					if (!handedOff) o.onUpdate?.(partial);
				}
			: undefined;

		const job = registry.spawn({
			toolName: o.toolName,
			label: o.label,
			runner: (signal) => o.work(signal, forward),
		});
		setStatusLine(o.ctx);
		refreshUi();

		// Tie the job to the turn's abort signal until a handoff detaches it,
		// so Escape still cancels calls the model is actively waiting on.
		let detach = (): void => {};
		if (o.ctx.signal) {
			const onAbort = (): void => job.controller.abort();
			o.ctx.signal.addEventListener("abort", onAbort, { once: true });
			detach = () => o.ctx.signal?.removeEventListener("abort", onAbort);
		}

		// Nested calls always wait for the real result: their caller would
		// consume a placeholder as if it were the truth.
		if (o.nested) {
			const settled = await job.settled;
			detach();
			return settleToResult(settled);
		}

		const decision = await awaitWithHandoff(job, timeoutMs());
		detach();
		if (decision.kind === "handoff") {
			handedOff = true;
			const grace = timeoutMs();
			registry.markForNotify(job, grace);
			return handoffPlaceholder(job, grace);
		}
		return settleToResult(decision.job);
	}

	function timeoutMs(): number {
		return parseTimeoutMs(pi.getFlag("async-tools-timeout")) ?? DEFAULT_TIMEOUT_MS;
	}

	return {
		registry,
		nestedCallIds,
		setLiveCtx(ctx) {
			liveCtx = ctx;
		},
		setupUi,
		refreshUi,
		stopNotifications,
		runManaged,
		timeoutMs,
	};
}
