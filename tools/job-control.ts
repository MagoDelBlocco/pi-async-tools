/**
 * tools/job-control.ts — the `async_tools` tool: model-facing control of a
 * background job from an async bash handoff. Exactly two operations, as
 * simple as possible:
 *   wait — block until the job settles (capped, abort-aware) and return its result
 *   kill — terminate a running job
 */

import { type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { AsyncEngine } from "../engine.ts";
import { type Job, describeJob } from "../jobs.ts";
import { raceWithAbort } from "../util.ts";

const WAIT_DEFAULT_S = 60;
const WAIT_MAX_S = 300;

function text(t: string, isError = false): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: t }], details: undefined, ...(isError ? { isError: true } : {}) };
}

export function registerAsyncTools(pi: ExtensionAPI, engine: AsyncEngine): void {
	pi.registerTool({
		name: "async_tools",
		label: "async_tools",
		description:
			'Control one background job from an async bash handoff (the job id comes from the handoff message): action "wait" blocks up to timeout seconds for the job to finish and returns its full result; action "kill" terminates a running job. Jobs whose result you never wait for deliver it automatically.',
		promptSnippet: "Wait for or kill a background job from an async bash handoff",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("wait"), Type.Literal("kill")]),
			job: Type.String({ description: 'Job id from the handoff message (e.g. "job-3")' }),
			timeout: Type.Optional(Type.Number({ description: `wait only: max seconds to block (default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S})` })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			engine.setLiveCtx(ctx);
			const result = await runAction(engine, params as { action: "wait" | "kill"; job: string; timeout?: number }, signal);
			// The settle notice also repainted the UI; when this call consumed the
			// delivery, the notice stayed silent — repaint on its behalf.
			engine.refreshUi();
			return result;
		},
	});
}

async function runAction(
	engine: AsyncEngine,
	params: { action: "wait" | "kill"; job: string; timeout?: number },
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<unknown>> {
	const found = engine.registry.get(params.job.trim());
	if (!found) {
		return text(`Unknown job id "${params.job}". Job ids come from async handoff messages; see /async_jobs for the human-facing overview.`, true);
	}
	if (params.action === "kill") return killJob(engine, found.id);
	return await waitJob(engine, found.id, params.timeout, signal);
}

function killJob(engine: AsyncEngine, id: string): AgentToolResult<unknown> {
	const job = engine.registry.cancel(id);
	if (!job) return text(`Job ${id} had already settled; nothing to kill.`, true);
	if (job.state === "cancelled") {
		// The "Killed" result itself informs the model; suppress the duplicate
		// cancelled-notification.
		engine.registry.claimDelivery(job);
		return text(`Killed ${job.id}.`);
	}
	return text(`Job ${job.id} had already settled (${job.state}).`);
}

async function waitJob(
	engine: AsyncEngine,
	id: string,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<unknown>> {
	const job = engine.registry.get(id);
	if (!job) return text(`Unknown job id "${id}".`, true);
	if (job.state !== "running") {
		engine.registry.claimDelivery(job);
		return settledResult(job);
	}
	return await awaitedDelivery(engine, job, timeout, signal);
}

/** Return the original tool result intact, including full output and error metadata. */
function settledResult(job: Job): AgentToolResult<unknown> {
	if (job.result) return job.result as AgentToolResult<unknown>;
	return text(describeJob(job), job.state === "failed");
}

/** Blocking half of wait: claim the delivery, race, unclaim if abandoned. */
async function awaitedDelivery(
	engine: AsyncEngine,
	job: Job,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<unknown>> {
	// Claim: if the job settles while we block, we present the result here
	// and the settle notification must stay silent. A timeout or an abort
	// unclaims, restoring the automatic delivery.
	const capMs = Math.min(Math.max(timeout ?? WAIT_DEFAULT_S, 1), WAIT_MAX_S) * 1000;
	engine.registry.claimDelivery(job);
	const outcome = await raceWithAbort(job.settled, capMs, signal);
	if (outcome !== "settled") engine.registry.unclaimDelivery(job);

	if (outcome === "timeout") return text(`Job ${job.id} still running after ${Math.round(capMs / 1000)}s (${describeJob(job, 0)}).`);
	if (outcome === "aborted") return text(`Wait interrupted; job ${job.id} continues in the background (${describeJob(job, 0)}).`);
	return settledResult(job);
}
