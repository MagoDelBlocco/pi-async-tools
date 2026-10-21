// test/loader.test.mjs — loads index.ts against a simulated ExtensionAPI,
// exercising real bash execution through every surface.
import assert from "node:assert/strict";
import { createJiti } from "/home/bogdan/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/home/bogdan/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": `${PI}/dist/index.js`, typebox: `${PI}/node_modules/typebox/build/index.mjs` },
});

const report = (line) => process.stdout.write(`${line}\n`);
const text = (r) => r.content.map((c) => c.text ?? "").join("");

function makeFakePi() {
	const tools = new Map();
	const commands = new Map();
	const flags = new Map();
	const events = new Map();
	const sent = [];
	const api = {
		registerFlag: (name, opts) => flags.set(name, opts.default),
		getFlag: (name) => flags.get(name),
		registerTool: (t) => tools.set(t.name, t),
		registerCommand: (name, opts) => commands.set(name, opts),
		on: (event, handler) => {
			if (!events.has(event)) events.set(event, []);
			events.get(event).push(handler);
			return () => {};
		},
		sendMessage: (msg, opts) => sent.push({ msg, opts }),
		appendEntry: () => {},
		getActiveTools: () => [...tools.keys()],
		getAllTools: () => [],
		setActiveTools: () => {},
	};
	return { api, tools, commands, flags, events, sent };
}

function makeCtx(fake, signal) {
	const ctx = {
		cwd: process.cwd(),
		mode: "print",
		hasUI: false,
		signal,
		isIdle: () => true,
		ui: { setStatus: () => {}, notify: () => {} },
		model: undefined,
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		},
		get tools() {
			return [...fake.tools.values()].map((t) => ({ name: t.name }));
		},
		executeTool: (name, args, options) => executeTool(fake, ctx, signal, name, args, options),
	};
	return ctx;
}

async function executeTool(fake, ctx, signal, name, args, options) {
	const toolCall = { name };
	const tool = fake.tools.get(name);
	if (!tool) return { toolCall, result: errResult(`unknown ${name}`), isError: true };
	try {
		const result = await tool.execute("nested-1", args, options?.signal ?? signal, undefined, ctx);
		return { toolCall, result, isError: result.isError === true };
	} catch (err) {
		return { toolCall, result: errResult(String(err)), isError: true };
	}
}

function errResult(text) {
	return { content: [{ type: "text", text }], details: undefined, isError: true };
}

const fake = makeFakePi();
const mod = await jiti.import("../index.ts");
mod.default(fake.api);

// --- registration ---
assert.ok(fake.tools.has("bash"), "bash override registered");
assert.ok(!fake.tools.has("run_async"), "run_async is gone");
assert.ok(fake.tools.has("async_tools"), "async_tools registered");
assert.ok(fake.commands.has("async_jobs"), "/async_jobs registered");
assert.deepEqual(Object.keys(fake.tools.get("async_tools").parameters.properties).sort(), ["action", "job", "timeout"], "async_tools schema is minimal");
report("ok  registration: bash override + minimal async_tools + /async_jobs; no run_async");

const bash = fake.tools.get("bash");
const asyncTools = fake.tools.get("async_tools");

// async_tools accepts only wait/kill
const actionSchema = fake.tools.get("async_tools").parameters.properties.action;
const verbs = (actionSchema.anyOf ?? actionSchema.enum ?? []).map((v) => v.const ?? v);
assert.deepEqual(verbs.sort(), ["kill", "wait"], "actions are wait/kill only");

// --- synchronous passthrough (default behavior unchanged) ---
{
	const ac = new AbortController();
	const ctx = makeCtx(fake, ac.signal);
	const result = await bash.execute("tc-sync", { command: "echo hello-async" }, ac.signal, undefined, ctx);
	assert.match(text(result), /hello-async/);
	assert.equal(result.details?.asyncJob, undefined, "synchronous result carries no asyncJob details");
	report("ok  default synchronous call passes through unchanged");
}

// --- automatic handoff: slow bash call moves to background ---
{
	fake.flags.set("async-tools-timeout", "300"); // engine re-reads the flag per call
	const ac = new AbortController();
	const ctx = makeCtx(fake, ac.signal);
	const t0 = Date.now();
	const result = await bash.execute("tc-async", { command: "sleep 1 && echo SLEPT-A" }, ac.signal, undefined, ctx);
	const elapsed = Date.now() - t0;
	assert.ok(elapsed < 900, `handoff near the 300ms threshold, took ${elapsed}ms`);
	const jobId = result.details?.asyncJob?.id;
	assert.ok(jobId, `placeholder carries a job id (got ${JSON.stringify(result.details)})`);
	assert.match(text(result), /proceed with outstanding work/i, "placeholder authorizes independent work");
	// Await through the async_tools surface.
	const waited = await asyncTools.execute("tc-wait", { action: "wait", job: jobId, timeout: 15 }, ac.signal, undefined, ctx);
	assert.match(text(waited), /SLEPT-A/, "waited job delivers the real result");
	// The wait consumed the delivery; no duplicate notice may be injected.
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(fake.sent.length, 0, "wait consumed the result; no duplicate notice");
	report(`ok  automatic handoff at threshold (${elapsed}ms); real result via async_tools wait, notice suppressed`);
}

// --- guards ---
{
	const ac = new AbortController();
	const ctx = makeCtx(fake, ac.signal);
	const unknownKill = await asyncTools.execute("tc-guard1", { action: "kill", job: "job-999" }, ac.signal, undefined, ctx);
	assert.equal(unknownKill.isError, true, "kill of unknown job rejected");
	const unknownWait = await asyncTools.execute("tc-guard2", { action: "wait", job: "job-999" }, ac.signal, undefined, ctx);
	assert.equal(unknownWait.isError, true, "wait of unknown job rejected");
	report("ok  guards: unknown job id rejected for both wait and kill");
}

// --- kill through the model surface ---
{
	const ac = new AbortController();
	const ctx = makeCtx(fake, ac.signal);
	const result = await bash.execute("tc-kill", { command: "sleep 30" }, ac.signal, undefined, ctx);
	const jobId = result.details.asyncJob.id;
	const killed = await asyncTools.execute("tc-kill2", { action: "kill", job: jobId }, ac.signal, undefined, ctx);
	assert.match(text(killed), /Killed/, "kill terminates a running job");
	const waited = await asyncTools.execute("tc-kill3", { action: "wait", job: jobId }, ac.signal, undefined, ctx);
	assert.match(text(waited), /\[cancelled\]/, "wait on a killed job returns its cancelled state immediately");
	report("ok  kill: async_tools kill terminates a running job; wait reports cancelled");
}

// --- widget: oculus-style snapshot over the registry (green; hidden when idle) ---
{
	fake.flags.set("async-tools-timeout", "200");
	const ac = new AbortController();
	const widgets = [];
	const wl = (c, w = 200) => (typeof c === "function" ? c({}, { fg: (_x, s) => s, bold: (s) => s }).render(w) : c);
	const ctx = makeCtx(fake, ac.signal);
	ctx.ui.setWidget = (key, content, opts) => widgets.push({ key, content, opts });
	for (const h of fake.events.get("session_start")) await h({}, ctx);
	assert.equal(widgets.at(-1).content, undefined, "widget hidden at start (no running jobs)");
	const result = await bash.execute("tc-widget", { command: "sleep 2 && echo WIDGET-OK" }, ac.signal, undefined, ctx);
	const jobId = result.details.asyncJob.id;
	const shown = widgets.at(-1);
	assert.equal(shown.key, "async-tools:jobs");
	assert.equal(shown.opts.placement, "belowEditor");
	assert.match(wl(shown.content)[0], /Async: 1 background job running/);
	assert.ok(wl(shown.content)[1].includes(jobId), "widget lists the running job id");
	await asyncTools.execute("tc-widget-wait", { action: "wait", job: jobId, timeout: 15 }, ac.signal, undefined, ctx);
	assert.equal(widgets.at(-1).content, undefined, "widget hidden when no jobs run");
	report("ok  widget: green below-editor count from registry snapshot; hidden when idle");
}

report("all loader trials passed");
