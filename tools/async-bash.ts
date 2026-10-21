/**
 * tools/async-bash.ts — override of the built-in `bash` tool with automatic
 * async handoff: the call runs synchronously; if it exceeds the threshold it
 * moves to a background job whose result is steered back into the run.
 * The agent decides nothing — no async argument exists.
 * Delegates real execution to a private instance from createBashToolDefinition(),
 * so the built-in implementation and renderers are preserved verbatim.
 */

import {
	type AgentToolResult,
	type BashToolDetails,
	createBashToolDefinition,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { AsyncEngine } from "../engine.ts";

type BaseDetails = BashToolDetails | undefined;

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds (kills a command that runs past it while synchronous)" })),
});

export function registerAsyncBash(pi: ExtensionAPI, engine: AsyncEngine): void {
	const base = createBashToolDefinition(process.cwd());

	const tool: ToolDefinition<typeof bashSchema, BaseDetails> = {
		...base,
		label: "bash",
		description:
			`${base.description} Commands that exceed the async threshold (~5s) move to a managed background job automatically; you are told to proceed with independent work and the real result is delivered automatically when the command finishes. Never detach long-running tasks yourself (nohup, trailing &, setsid, disown) — run them plainly and let the background handoff manage them.`,
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			"If a bash call reports that it moved to a background job, continue with work not dependent on it; its result arrives automatically, or await it with async_tools.",
		],
		parameters: bashSchema,
		execute: async (toolCallId, params, _signal, onUpdate, ctx) => {
			engine.setLiveCtx(ctx);
			const result = await engine.runManaged({
				toolName: "bash",
				label: params.command.slice(0, 120),
				nested: engine.nestedCallIds.has(toolCallId),
				ctx,
				onUpdate: onUpdate as ((p: AgentToolResult<unknown>) => void) | undefined,
				work: (sig, forward) =>
					base.execute(toolCallId, { command: params.command, timeout: params.timeout }, sig, forward, ctx) as Promise<AgentToolResult<unknown>>,
			});
			// Base renderers read only truncation/fullOutputPath from details; the
			// asyncJob placeholder details render as plain text alongside them.
			return result as unknown as AgentToolResult<BaseDetails>;
		},
	};

	pi.registerTool(tool);
}
