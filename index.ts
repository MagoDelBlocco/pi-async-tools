/**
 * async-tools — Pi extension: asynchronous execution for tool calls.
 *
 * Automatic handoff (no agent burden — no async argument exists):
 * a tool call runs synchronously; if it has not finished after a
 * threshold (default 5000 ms) it is handed off to a background job. The
 * model receives a placeholder authorizing it to proceed with independent
 * work, and the real result is steered into the run at the next tool
 * boundary (or delivered as a new turn when the agent is idle).
 *
 * Why tool `execute()` and not `tool_call` handlers: see README.md — event
 * handlers can mutate or block but cannot execute tools, and no hook can
 * detach an in-flight execution. The only interception point that owns the
 * execution promise is a registered ToolDefinition.
 *
 * Surfaces:
 *  - `bash` override — built-in bash plus automatic handoff (the only tool
 *    surface touched; it replaces the built-in under the same name).
 *  - `async_tools`   — minimal job control: wait / kill.
 *  - `/async_jobs`   — human-facing job overview.
 *  - widget          — below-editor count of running jobs (oculus pattern).
 *
 * MCP tools are deliberately left synchronous (blocking): covering them
 * transparently is not achievable as an extension (see README.md), and no
 * extra tool is introduced for them.
 *
 * Flags:
 *  --async-tools-timeout <ms>  handoff threshold (default 5000).
 *  --no-async-bash             Do not override the built-in bash tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createEngine } from "./engine.ts";
import { describeJob } from "./jobs.ts";
import { registerAsyncBash } from "./tools/async-bash.ts";
import { registerAsyncTools } from "./tools/job-control.ts";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("async-tools-timeout", {
		description: "async-tools: milliseconds before a tool call is handed to a background job (default 5000)",
		type: "string",
		default: "5000",
	});
	pi.registerFlag("no-async-bash", {
		description: "async-tools: do not override the built-in bash tool with the async-capable variant",
		type: "boolean",
		default: false,
	});

	const engine = createEngine(pi);

	if (!pi.getFlag("no-async-bash")) registerAsyncBash(pi, engine);
	registerAsyncTools(pi, engine);

	pi.registerCommand("async_jobs", {
		description: "List async-tools background jobs (status, elapsed time, results)",
		handler: async (_args, ctx) => {
			engine.setLiveCtx(ctx);
			const jobs = engine.registry.list();
			const body = jobs.length === 0 ? "async-tools: no jobs this session" : jobs.map((j) => describeJob(j, 600)).join("\n\n");
			ctx.ui.notify(body, "info");
		},
	});

	// Track nested (parent-issued) tool calls. A nested bash must return the
	// real result to its caller, so automatic handoff degrades to sync for it.
	pi.on("tool_call", async (event) => {
		if (event.parentToolCallId) engine.nestedCallIds.add(event.toolCallId);
	});
	pi.on("tool_result", async (event) => {
		engine.nestedCallIds.delete(event.toolCallId);
	});

	pi.on("session_start", async (_event, ctx) => {
		engine.setLiveCtx(ctx);
		engine.setupUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		// Idempotent: never leave orphaned background work behind.
		engine.registry.cancelAll();
	});
}
