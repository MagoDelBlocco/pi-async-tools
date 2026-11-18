// test/comprehensive.test.mjs — full test battery for the async-tools extension.
//
// Sections:
//   S1  jobs.ts unit trials          (registry, transitions, notifications, formatters)
//   S2  util.ts unit trials          (flag parsing, abort-aware race)
//   S3  engine.ts unit trials        (handoff race, nested mode, signal linking, UI, delivery)
//   S4  integration: index.ts+tools  (registration, bash override, async_tools, /async_jobs,
//                                     status item, nested tracking, shutdown, flags, concurrency)
//
// Real bash processes are spawned in S4; thresholds are shrunk via the flag store to
// keep the battery fast. Each block gets an isolated extension instance.

import assert from "node:assert/strict";
import { createJiti } from "/home/bogdan/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/home/bogdan/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": `${PI}/dist/index.js`, typebox: `${PI}/node_modules/typebox/build/index.mjs` },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = (line) => process.stdout.write(`${line}\n`);
const text = (r) => r.content.map((c) => c.text ?? "").join("");
const ok = (t) => ({ content: [{ type: "text", text: t }], details: undefined });

let passed = 0;
const failures = [];
async function test(name, fn) {
	try {
		await fn();
		passed++;
		report(`  ok  ${name}`);
	} catch (err) {
		failures.push({ name, err });
		report(`FAIL  ${name}\n      ${err && err.message ? err.message.split("\n")[0] : String(err)}`);
	}
}

// =========================================================================
// Shared fakes
// =========================================================================

function makeFakePi(seedFlags = {}) {
	const tools = new Map();
	const commands = new Map();
	const flags = new Map(Object.entries(seedFlags));
	const events = new Map();
	const sent = [];
	const api = {
		// A seeded flag stands in for a CLI-provided value and wins over the default.
		registerFlag: (name, opts) => {
			if (!flags.has(name)) flags.set(name, opts.default);
		},
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

function makeFakeCtx(fake, { signal, isIdle = () => true, uiExtras = {} } = {}) {
	const ctx = {
		cwd: process.cwd(),
		mode: "print",
		hasUI: false,
		signal,
		isIdle,
		ui: { setStatus: () => {}, notify: () => {}, ...uiExtras },
		model: undefined,
		modelRegistry: {},
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
		get tools() {
			return [...fake.tools.values()].map((t) => ({ name: t.name }));
		},
		executeTool: (name, args, options) => runNestedTool(fake, ctx, signal, name, args, options),
	};
	return ctx;
}

async function runNestedTool(fake, ctx, signal, name, args, options) {
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

function errResult(t) {
	return { content: [{ type: "text", text: t }], details: undefined, isError: true };
}

async function newExtension(seedFlags = {}, ctxOpts = {}) {
	const fake = makeFakePi(seedFlags);
	const mod = await jiti.import("../index.ts");
	mod.default(fake.api);
	const ac = new AbortController();
	const ctx = makeFakeCtx(fake, { signal: ac.signal, ...ctxOpts });
	const dispatch = async (event, evtObj = {}) => {
		for (const h of fake.events.get(event) ?? []) await h(evtObj, ctx);
	};
	return {
		fake,
		ctx,
		ac,
		bash: fake.tools.get("bash"),
		asyncTools: fake.tools.get("async_tools"),
		dispatch,
		waitForJob: (id, timeout = 20) =>
			fake.tools.get("async_tools").execute("tc-w", { action: "wait", job: id, timeout }, ac.signal, undefined, ctx),
	};
}

// =========================================================================
// S1 — jobs.ts unit trials
// =========================================================================

const { JobRegistry, awaitWithHandoff, formatJobNotice, describeJob, flattenResultText, formatElapsed } =
	await jiti.import("../jobs.ts");

report("S1 jobs.ts");

await test("S1.1 spawn identity: ids increment, state starts running, list/get/running()", async () => {
	const reg = new JobRegistry("job");
	const a = reg.spawn({ toolName: "bash", label: "a", runner: async () => (await sleep(50), ok("A")) });
	const b = reg.spawn({ toolName: "bash", label: "b", runner: async () => (await sleep(50), ok("B")) });
	assert.equal(a.id, "job-1");
	assert.equal(b.id, "job-2");
	assert.equal(a.state, "running");
	assert.ok(Number.isFinite(a.startedAt));
	assert.equal(reg.list().length, 2);
	assert.deepEqual(reg.list().map((j) => j.id), ["job-1", "job-2"]);
	assert.equal(reg.get("job-1"), a);
	assert.equal(reg.get("job-404"), undefined);
	assert.equal(reg.running().length, 2);
	await Promise.all([a.settled, b.settled]);
});

await test("S1.2 completed transition stores result and endedAt", async () => {
	const reg = new JobRegistry("job");
	const job = reg.spawn({ toolName: "t", label: "l", runner: async () => ok("done") });
	await job.settled;
	assert.equal(job.state, "completed");
	assert.equal(job.result.content[0].text, "done");
	assert.ok(job.endedAt >= job.startedAt);
	assert.equal(reg.running().length, 0);
});

await test("S1.3 failed transitions: throwing runner and isError result", async () => {
	const reg = new JobRegistry("job");
	const thrower = reg.spawn({ toolName: "t", label: "l", runner: async () => { throw new Error("boom"); } });
	await thrower.settled;
	assert.equal(thrower.state, "failed");
	assert.equal(thrower.error, "boom");
	const errer = reg.spawn({ toolName: "t", label: "l", runner: async () => ({ ...ok("bad exit"), isError: true }) });
	await errer.settled;
	assert.equal(errer.state, "failed");
	assert.equal(errer.result.isError, true, "the isError result itself is stored");
});

await test("S1.4 cancellation: cooperative runner is cancelled with user-facing error", async () => {
	const reg = new JobRegistry("job");
	const job = reg.spawn({
		toolName: "t",
		label: "l",
		runner: (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })),
	});
	reg.cancel(job.id);
	await job.settled;
	assert.equal(job.state, "cancelled");
	assert.equal(job.error, "Cancelled by user");
});

await test("S1.5 markForNotify on a settled job still notifies (threshold-tick race)", async () => {
	const reg = new JobRegistry("job");
	const notices = [];
	reg.onSettle((j) => notices.push(formatJobNotice(j, 100)));
	const job = reg.spawn({ toolName: "t", label: "l", runner: async () => ok("fast truth") });
	await job.settled; // settled BEFORE the handoff decision reached markForNotify
	reg.markForNotify(job, 42);
	assert.equal(notices.length, 1, "settled-at-threshold job must still deliver its result");
	assert.match(notices[0], /fast truth/);
	reg.markForNotify(job, 42);
	assert.equal(notices.length, 1, "never notifies twice");
	assert.equal(job.handoffMs, 42);
});

await test("S1.6 markForNotify on running job notifies once at settle", async () => {
	const reg = new JobRegistry("job");
	const notices = [];
	reg.onSettle((j) => notices.push(j.id));
	const job = reg.spawn({ toolName: "t", label: "l", runner: async () => (await sleep(30), ok("x")) });
	reg.markForNotify(job, 5);
	assert.equal(notices.length, 0);
	await job.settled;
	assert.deepEqual(notices, ["job-1"]);
});

await test("S1.7 onSettle unsubscribe stops notifications", async () => {
	const reg = new JobRegistry("job");
	let count = 0;
	const unsub = reg.onSettle(() => count++);
	const j1 = reg.spawn({ toolName: "t", label: "l", background: true, runner: async () => ok("x") });
	await j1.settled;
	unsub();
	const j2 = reg.spawn({ toolName: "t", label: "l", background: true, runner: async () => ok("y") });
	await j2.settled;
	assert.equal(count, 1);
});

await test("S1.8 throwing listener is recorded on the job, never escapes", async () => {
	const reg = new JobRegistry("job");
	let attempts = 0;
	reg.onSettle(() => { if (++attempts === 1) throw new Error("listener died"); });
	const job = reg.spawn({ toolName: "t", label: "l", background: true, runner: async () => ok("x") });
	await job.settled;
	assert.equal(job.notifyError, "listener died");
	assert.equal(job.notified, false, "a failed send must remain pending");
	assert.equal(job.state, "completed", "job lifecycle unaffected");
	reg.retryNotify(job);
	assert.equal(attempts, 2);
	assert.equal(job.notified, true, "retry marks delivery only after success");
	assert.equal(job.notifyError, undefined);
	reg.retryNotify(job);
	assert.equal(attempts, 2, "successful delivery is not repeated");
});

await test("S1.9 formatters: flatten, elapsed, describeJob, formatJobNotice", async () => {
	const flat = flattenResultText({ content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }] }, 100);
	assert.equal(flat, "one\ntwo");
	const big = flattenResultText({ content: [{ type: "text", text: "x".repeat(500) }] }, 100);
	assert.match(big, /\[\.\.\. truncated 400 chars/);
	assert.equal(formatElapsed(5000), "5.0s");
	assert.equal(formatElapsed(75000), "1m15s");
	const reg = new JobRegistry("job");
	const done = reg.spawn({ toolName: "bash", label: "make", runner: async () => ok("built") });
	await done.settled;
	assert.match(describeJob(done, 200), /job-1 \[completed\] bash — make/);
	assert.match(describeJob(done, 200), /built/);
	assert.match(formatJobNotice(done, 200), /\[async-tools\] Background job job-1 completed \(bash: make/);
	const dead = reg.spawn({ toolName: "bash", label: "x", runner: async () => { throw new Error("nope"); } });
	await dead.settled;
	assert.match(describeJob(dead, 200), /\[failed\]/);
	assert.match(describeJob(dead, 200), /nope/);
});

await test("S1.10 awaitWithHandoff returns result vs handoff at threshold", async () => {
	const reg = new JobRegistry("job");
	const fast = reg.spawn({ toolName: "t", label: "l", runner: async () => (await sleep(10), ok("v")) });
	assert.equal((await awaitWithHandoff(fast, 5000)).kind, "result");
	const slow = reg.spawn({ toolName: "t", label: "l", runner: async () => (await sleep(200), ok("v")) });
	assert.equal((await awaitWithHandoff(slow, 30)).kind, "handoff");
	const zero = reg.spawn({ toolName: "t", label: "l", runner: async () => (await sleep(200), ok("v")) });
	assert.equal((await awaitWithHandoff(zero, 0)).kind, "handoff", "threshold 0 = never wait");
	slow.controller.abort();
	zero.controller.abort();
});

await test("S1.11 claim/unclaim delivery: wait-style consumption suppresses notices", async () => {
	const reg = new JobRegistry("job");
	const notices = [];
	reg.onSettle((j) => notices.push(j.id));
	// Claimed while running, settles claimed, unclaimed after settle: fires once, then never again.
	const j1 = reg.spawn({
		toolName: "t",
		label: "l",
		runner: (s) => new Promise((_, rej) => s.addEventListener("abort", () => rej(new Error("aborted")), { once: true })),
	});
	reg.markForNotify(j1, 5);
	reg.claimDelivery(j1);
	j1.controller.abort();
	await j1.settled;
	assert.equal(notices.length, 0, "no notice while claimed");
	reg.unclaimDelivery(j1);
	assert.deepEqual(notices, ["job-1"], "unclaim after settle delivers immediately");
	reg.unclaimDelivery(j1);
	assert.equal(notices.length, 1, "never twice");
	// Unclaimed while still running: the normal settle listener fires.
	const j2 = reg.spawn({ toolName: "t", label: "l2", runner: async () => (await sleep(30), ok("x")) });
	reg.markForNotify(j2, 5);
	reg.claimDelivery(j2);
	reg.unclaimDelivery(j2);
	await j2.settled;
	assert.deepEqual(notices, ["job-1", "job-2"], "abandoned claim restores automatic delivery");
});

await test("S1.12 onObserve fires on every settle regardless of notify policy", async () => {
	const reg = new JobRegistry("job");
	const notices = [];
	const seen = [];
	reg.onSettle((j) => notices.push(j.id));
	const off = reg.onObserve((j) => seen.push(`${j.id}:${j.state}`));
	// The stale-status trap: a plain sync job settles WITHOUT notifying — the
	// observer must still fire, the settle listener must not.
	const j1 = reg.spawn({ toolName: "bash", label: "sync", runner: async () => ok("v") });
	await j1.settled;
	assert.deepEqual(seen, ["job-1:completed"], "plain settle is observed");
	assert.deepEqual(notices, [], "unmarked job must not notify");
	// Cancel repaints immediately, without waiting for a slow runner to die.
	const j2 = reg.spawn({ toolName: "bash", label: "zombie", runner: () => new Promise(() => {}) });
	reg.cancel("job-2");
	assert.deepEqual(seen.at(-1), "job-2:cancelled", "cancel is observed eagerly");
	off();
	const j3 = reg.spawn({ toolName: "bash", label: "x", runner: async () => ok("v") });
	await j3.settled;
	assert.equal(seen.length, 2, "unsubscribe stops observation");
});

// =========================================================================
// S2 — util.ts unit trials
// =========================================================================

const { parseTimeoutMs, raceWithAbort } = await jiti.import("../util.ts");

report("S2 util.ts");

await test("S2.1 parseTimeoutMs accepts non-negative numbers only", async () => {
	assert.equal(parseTimeoutMs("2500"), 2500);
	assert.equal(parseTimeoutMs("0"), 0);
	assert.equal(parseTimeoutMs(undefined), undefined);
	assert.equal(parseTimeoutMs(""), undefined);
	assert.equal(parseTimeoutMs("   "), undefined);
	assert.equal(parseTimeoutMs("abc"), undefined);
	assert.equal(parseTimeoutMs("-5"), undefined);
	assert.equal(parseTimeoutMs(true), undefined);
});

await test("S2.2 raceWithAbort: settled, timeout, pre-aborted, aborted mid-race", async () => {
	assert.equal(await raceWithAbort(Promise.resolve(), 1000, undefined), "settled");
	assert.equal(await raceWithAbort(new Promise(() => {}), 30, undefined), "timeout");
	const pre = new AbortController();
	pre.abort();
	assert.equal(await raceWithAbort(new Promise(() => {}), 1000, pre.signal), "aborted");
	const mid = new AbortController();
	const p = raceWithAbort(new Promise(() => {}), 5000, mid.signal);
	setTimeout(() => mid.abort(), 20);
	assert.equal(await p, "aborted");
});

// =========================================================================
// S3 — engine.ts unit trials
// =========================================================================

const { createEngine, DEFAULT_TIMEOUT_MS } = await jiti.import("../engine.ts");

function makeEnginePi(flagValue) {
	const sent = [];
	return {
		sent,
		api: {
			getFlag: (name) => (name === "async-tools-timeout" ? flagValue : undefined),
			sendMessage: (msg, opts) => sent.push({ msg, opts }),
		},
	};
}

function engineCtx({ signal, isIdle = () => true, uiExtras = {} } = {}) {
	return {
		cwd: process.cwd(),
		signal,
		isIdle,
		ui: { setStatus: () => {}, notify: () => {}, ...uiExtras },
		tools: [],
		executeTool: async () => errResult("unused"),
	};
}

report("S3 engine.ts");

await test("S3.1 timeoutMs: flag parsing with DEFAULT_TIMEOUT_MS fallback", async () => {
	assert.equal(createEngine(makeEnginePi(undefined).api).timeoutMs(), DEFAULT_TIMEOUT_MS);
	assert.equal(createEngine(makeEnginePi("1234").api).timeoutMs(), 1234);
	assert.equal(createEngine(makeEnginePi("0").api).timeoutMs(), 0);
	assert.equal(createEngine(makeEnginePi("bogus").api).timeoutMs(), DEFAULT_TIMEOUT_MS);
});

await test("S3.2 fast runManaged returns real result, no notification", async () => {
	const pi = makeEnginePi("5000");
	const engine = createEngine(pi.api);
	const ctx = engineCtx({ signal: new AbortController().signal });
	const result = await engine.runManaged({
		toolName: "bash", label: "fast", nested: false, ctx, onUpdate: undefined,
		work: async () => (await sleep(10), ok("REAL")),
	});
	assert.equal(text(result), "REAL");
	assert.equal(result.details, undefined, "no asyncJob details on the sync path");
	await sleep(30);
	assert.equal(pi.sent.length, 0);
	assert.equal(engine.registry.list()[0].state, "completed");
});

await test("S3.3 slow runManaged handoff: placeholder text and details.asyncJob", async () => {
	const pi = makeEnginePi("80");
	const engine = createEngine(pi.api);
	const ctx = engineCtx({ signal: new AbortController().signal });
	const t0 = Date.now();
	const result = await engine.runManaged({
		toolName: "toolX", label: "the label", nested: false, ctx, onUpdate: undefined,
		work: async () => (await sleep(300), ok("LATE")),
	});
	const elapsed = Date.now() - t0;
	assert.ok(elapsed < 250, `handoff at threshold, took ${elapsed}ms`);
	const jobId = result.details.asyncJob.id;
	assert.deepEqual(Object.keys(result.details.asyncJob).sort(), ["handoffMs", "id", "label", "toolName"]);
	assert.equal(result.details.asyncJob.toolName, "toolX");
	assert.equal(result.details.asyncJob.label, "the label");
	assert.equal(result.details.asyncJob.handoffMs, 80);
	const body = text(result);
	assert.match(body, new RegExp(jobId));
	assert.match(body, /proceed with outstanding work that is NOT dependent/i);
	assert.match(body, /\{"action":"wait","job":"job-1","timeout":60\}/);
	assert.match(body, /\{"action":"kill","job":"job-1"\}/);
	await engine.registry.get(jobId).settled;
	assert.equal(pi.sent.length, 1, "one steered/injected notice on settle");
	assert.match(pi.sent[0].msg.content, /LATE/);
});

await test("S3.4 nested runManaged never hands off", async () => {
	const pi = makeEnginePi("20");
	const engine = createEngine(pi.api);
	const ctx = engineCtx({ signal: new AbortController().signal });
	const t0 = Date.now();
	const result = await engine.runManaged({
		toolName: "bash", label: "nested", nested: true, ctx, onUpdate: undefined,
		work: async () => (await sleep(200), ok("NESTED-REAL")),
	});
	assert.ok(Date.now() - t0 >= 190, "nested call waited for the real result");
	assert.equal(text(result), "NESTED-REAL");
	assert.equal(result.details, undefined);
});

await test("S3.5 abort before handoff cancels the job and surfaces the failure", async () => {
	const pi = makeEnginePi("5000");
	const engine = createEngine(pi.api);
	const ac = new AbortController();
	const ctx = engineCtx({ signal: ac.signal });
	const p = engine.runManaged({
		toolName: "bash", label: "x", nested: false, ctx, onUpdate: undefined,
		work: (signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })),
	});
	setTimeout(() => ac.abort(), 30);
	await assert.rejects(p, /aborted/);
	assert.equal(engine.registry.list()[0].state, "cancelled");
});

await test("S3.6 after handoff the job detaches: turn abort no longer kills it", async () => {
	const pi = makeEnginePi("40");
	const engine = createEngine(pi.api);
	const ac = new AbortController();
	const ctx = engineCtx({ signal: ac.signal });
	const result = await engine.runManaged({
		toolName: "bash", label: "survivor", nested: false, ctx, onUpdate: undefined,
		work: async (signal) => {
			await sleep(300);
			if (signal.aborted) throw new Error("aborted");
			return ok("SURVIVED");
		},
	});
	const jobId = result.details.asyncJob.id;
	ac.abort(); // user presses Escape after the handoff
	await engine.registry.get(jobId).settled;
	assert.equal(engine.registry.get(jobId).state, "completed");
	assert.equal(pi.sent.length, 1);
	assert.match(pi.sent[0].msg.content, /SURVIVED/);
});

await test("S3.7 onUpdate forwards partials until handoff, then freezes", async () => {
	const pi = makeEnginePi("60");
	const engine = createEngine(pi.api);
	const ctx = engineCtx({ signal: new AbortController().signal });
	const seen = [];
	await engine.runManaged({
		toolName: "bash", label: "streamer", nested: false, ctx,
		onUpdate: (p) => seen.push(text(p)),
		work: async (_signal, forward) => {
			forward?.(ok("early-partial"));
			await sleep(300);
			forward?.(ok("post-handoff-1")); // must be dropped
			forward?.(ok("post-handoff-2")); // must be dropped
			return ok("final");
		},
	});
	assert.deepEqual(seen, ["early-partial"], "partials frozen at handoff");
});

await test("S3.8 throwing work rejects runManaged with its message", async () => {
	const pi = makeEnginePi("5000");
	const engine = createEngine(pi.api);
	const ctx = engineCtx({ signal: new AbortController().signal });
	await assert.rejects(
		engine.runManaged({ toolName: "t", label: "x", nested: false, ctx, onUpdate: undefined, work: async () => { throw new Error("kaboom"); } }),
		/kaboom/,
	);
});

await test("S3.9 delivery mode: steer mid-run, triggerTurn idle", async () => {
	const runningPi = makeEnginePi("30");
	const engine1 = createEngine(runningPi.api);
	engine1.setLiveCtx(engineCtx({ isIdle: () => false }));
	await engine1.runManaged({ toolName: "t", label: "x", nested: false, ctx: engineCtx(), onUpdate: undefined, work: async () => (await sleep(150), ok("v")) });
	await engine1.registry.get("job-1").settled;
	assert.deepEqual(runningPi.sent[0].opts, { deliverAs: "steer" });

	const idlePi = makeEnginePi("30");
	const engine2 = createEngine(idlePi.api);
	engine2.setLiveCtx(engineCtx({ isIdle: () => true }));
	await engine2.runManaged({ toolName: "t", label: "x", nested: false, ctx: engineCtx(), onUpdate: undefined, work: async () => (await sleep(150), ok("v")) });
	await engine2.registry.get("job-1").settled;
	assert.deepEqual(idlePi.sent[0].opts, { triggerTurn: true });
});

await test("S3.10 notification truncates huge results", async () => {
	const pi = makeEnginePi("30");
	const engine = createEngine(pi.api);
	await engine.runManaged({
		toolName: "t", label: "x", nested: false, ctx: engineCtx(), onUpdate: undefined,
		work: async () => (await sleep(120), ok("Z".repeat(9000))),
	});
	await engine.registry.get("job-1").settled;
	const notice = pi.sent[0].msg.content;
	assert.match(notice, /\[\.\.\. truncated \d+ chars of async job output/);
	assert.ok(notice.length < 7000, `notice kept under the cap (${notice.length})`);
});

await test("S3.10a failed sendMessage retries and delivers once", async () => {
	const pi = makeEnginePi("20");
	let attempts = 0;
	pi.api.sendMessage = (msg, opts) => {
		if (++attempts === 1) throw new Error("send unavailable");
		pi.sent.push({ msg, opts });
	};
	const engine = createEngine(pi.api);
	const handoff = await engine.runManaged({
		toolName: "t", label: "retry", nested: false, ctx: engineCtx(), onUpdate: undefined,
		work: async () => (await sleep(80), ok("RETRY-TOKEN")),
	});
	const job = engine.registry.get(handoff.details.asyncJob.id);
	await job.settled;
	assert.equal(job.notified, false);
	assert.equal(job.notifyError, "send unavailable");
	await sleep(1150);
	assert.equal(attempts, 2);
	assert.equal(pi.sent.length, 1);
	assert.match(pi.sent[0].msg.content, /RETRY-TOKEN/);
	assert.equal(job.notified, true);
	engine.stopNotifications();
});

await test("S3.10b consuming a failed notice suppresses its retry", async () => {
	const pi = makeEnginePi("20");
	let attempts = 0;
	pi.api.sendMessage = () => { attempts++; throw new Error("send unavailable"); };
	const engine = createEngine(pi.api);
	const handoff = await engine.runManaged({
		toolName: "t", label: "claim", nested: false, ctx: engineCtx(), onUpdate: undefined,
		work: async () => (await sleep(80), ok("CLAIMED")),
	});
	const job = engine.registry.get(handoff.details.asyncJob.id);
	await job.settled;
	assert.equal(attempts, 1);
	engine.registry.claimDelivery(job);
	engine.registry.retryNotify(job);
	assert.equal(attempts, 1, "claimed result cannot be retried");
	engine.stopNotifications();
});

// Footer status styling per the guardrails/oculus convention: fg inside bg.
const statusTheme = { fg: (c, s) => `<${c}>${s}</>`, bg: (b, s) => `[${b}]${s}` };

await test("S3.11 setupUi: status repaints without theme support (plain label fallback)", async () => {
	const pi = makeEnginePi("40");
	const engine = createEngine(pi.api);
	const statuses = [];
	const uiNoTheme = { setStatus: (k, v) => statuses.push([k, v]), notify: () => {} };
	const ctx = engineCtx({ uiExtras: uiNoTheme });
	engine.setLiveCtx(ctx); // production invariant: tools set the live context
	engine.setupUi(ctx); // must not throw when the UI has no theme
	await engine.runManaged({ toolName: "t", label: "x", nested: false, ctx, onUpdate: undefined, work: async () => (await sleep(150), ok("v")) });
	assert.deepEqual(statuses[0], ["async", undefined]); // idle: no footer element
	assert.ok(statuses.some(([, v]) => v === "async: 1 running"), "unthemed UI still gets the plain label");
	await engine.registry.get("job-1").settled;
	assert.equal(statuses.at(-1)[1], undefined, "status clears after settle");
});

await test("S3.12 footer status: green `async: N running` badge while jobs run, hidden when idle", async () => {
	const pi = makeEnginePi("40");
	const engine = createEngine(pi.api);
	const statuses = [];
	const ui = { setStatus: (k, v) => statuses.push([k, v]), notify: () => {}, theme: statusTheme };
	engine.setLiveCtx(engineCtx({ uiExtras: ui }));
	engine.setupUi(engineCtx({ uiExtras: ui }));
	assert.deepEqual(statuses.at(-1), ["async", undefined], "idle: element absent");
	const run = engine.runManaged({ toolName: "t", label: "job-status", nested: false, ctx: engineCtx({ uiExtras: ui }), onUpdate: undefined, work: async () => (await sleep(150), ok("v")) });
	await sleep(30); // observe the running paint before the job settles
	assert.deepEqual(statuses.at(-1), ["async", "[toolSuccessBg]<success>async: 1 running</>"], "guardrails-style badge");
	await run;
	await engine.registry.get("job-1").settled;
	assert.equal(statuses.at(-1)[1], undefined, "hidden once the job settles");
});

await test("S3.13 stale-status regression: settle of a fast sync job erases its spawn paint", async () => {
	const pi = makeEnginePi("40");
	const engine = createEngine(pi.api);
	const statuses = [];
	const ui = { setStatus: (k, v) => statuses.push([k, v]), notify: () => {}, theme: statusTheme };
	const ctx = engineCtx({ uiExtras: ui });
	engine.setLiveCtx(ctx); // production invariant: tools set the live context
	engine.setupUi(ctx);
	// The exact bug: spawn paints "async: 1 running"; the job settles within
	// the grace period and never notifies; only an observer wired to EVERY
	// settle can clear that paint. Without it the badge lingers forever.
	await engine.runManaged({ toolName: "t", label: "fast", nested: false, ctx, onUpdate: undefined, work: async () => ok("v") });
	await engine.registry.get("job-1").settled;
	assert.ok(statuses.some(([, v]) => typeof v === "string" && v.includes("async: 1 running")), "spawn painted the badge");
	assert.equal(statuses.at(-1)[1], undefined, "status hidden after the settled synchronous run");
	assert.equal(pi.sent.length, 0, "a synchronous run injects no notification");
});

// =========================================================================
// S4 — integration: index.ts + tools/ + commands + status item
// =========================================================================

report("S4 integration");

await test("S4.1 registration: flags, bash override, async_tools, /async_jobs; no run_async", async () => {
	const ext = await newExtension();
	assert.ok(ext.fake.tools.has("bash"));
	assert.ok(ext.fake.tools.has("async_tools"));
	assert.ok(!ext.fake.tools.has("run_async"));
	assert.ok(ext.fake.commands.has("async_jobs"));
	assert.equal(ext.fake.flags.get("async-tools-timeout"), "5000");
	assert.equal(ext.fake.flags.get("no-async-bash"), false);
	const action = ext.asyncTools.parameters.properties.action;
	const verbs = (action.anyOf ?? action.enum ?? []).map((v) => v.const ?? v).sort();
	assert.deepEqual(verbs, ["kill", "wait"]);
});

await test("S4.2 --no-async-bash keeps the built-in bash tool untouched", async () => {
	const ext = await newExtension({ "no-async-bash": true });
	assert.ok(!ext.fake.tools.has("bash"), "no bash override registered");
	assert.ok(ext.fake.tools.has("async_tools"), "job control still present");
});

await test("S4.3 bash sync: fast command passthrough and non-zero exit as error", async () => {
	const ext = await newExtension();
	const r = await ext.bash.execute("tc-1", { command: "echo quick-echo-test" }, ext.ac.signal, undefined, ext.ctx);
	assert.match(text(r), /quick-echo-test/);
	assert.equal(r.details?.asyncJob, undefined);
	const bad = await ext.bash.execute("tc-2", { command: "exit 3" }, ext.ac.signal, undefined, ext.ctx);
	assert.equal(bad.isError, true, "non-zero exit stays an error result");
	assert.match(text(bad), /exited with code 3/);
	assert.equal(bad.structuredContent?.exit_code, 3, "structured content preserved on the sync path");
	assert.equal(ext.fake.sent.length, 0);
});

await test("S4.4 bash timeout argument still kills synchronous commands", async () => {
	const ext = await newExtension();
	await assert.rejects(
		ext.bash.execute("tc-to", { command: "sleep 5", timeout: 1 }, ext.ac.signal, undefined, ext.ctx),
		/[Tt]imed out/,
	);
});

await test("S4.5 handoff: placeholder with job id, then full result delivered", async () => {
	const ext = await newExtension({ "async-tools-timeout": "150" });
	const r = await ext.bash.execute("tc-h", { command: "sleep 0.4 && echo DELIVERED-TOKEN" }, ext.ac.signal, undefined, ext.ctx);
	const jobId = r.details?.asyncJob?.id;
	assert.ok(jobId, "placeholder carries job id");
	assert.match(text(r), /proceed with outstanding work/i);
	assert.equal(r.details.asyncJob.handoffMs, 150);
	const waited = await ext.waitForJob(jobId);
	assert.match(text(waited), /DELIVERED-TOKEN/);
	assert.equal(waited.isError, undefined);
	await sleep(50);
	assert.equal(ext.fake.sent.length, 0, "wait consumed the result; no duplicate notice");
});

await test("S4.6 wait: running job beyond timeout reports still-running; kill ends it", async () => {
	const ext = await newExtension({ "async-tools-timeout": "100" });
	const r = await ext.bash.execute("tc-w1", { command: "sleep 30" }, ext.ac.signal, undefined, ext.ctx);
	const jobId = r.details.asyncJob.id;
	const slow = await ext.waitForJob(jobId, 1);
	assert.match(text(slow), /still running after 1s/);
	const killed = await ext.asyncTools.execute("tc-w2", { action: "kill", job: jobId }, ext.ac.signal, undefined, ext.ctx);
	assert.match(text(killed), /Killed job-/);
	const waited = await ext.waitForJob(jobId, 1);
	assert.match(text(waited), /\[cancelled\]/);
	assert.match(text(waited), /Cancelled by user/);
});

await test("S4.7 wait on failed handoff reports failure with command output", async () => {
	const ext = await newExtension({ "async-tools-timeout": "100" });
	const r = await ext.bash.execute("tc-f", { command: "echo out-before-fail; sleep 0.3; exit 3" }, ext.ac.signal, undefined, ext.ctx);
	const jobId = r.details.asyncJob.id;
	const waited = await ext.waitForJob(jobId);
	assert.equal(waited.isError, true);
	assert.match(text(waited), /out-before-fail/);
	assert.match(text(waited), /exited with code 3/);
});

await test("S4.7a wait returns complete output and original error details", async () => {
	const ext = await newExtension({ "async-tools-timeout": "80" });
	const marker = "TAIL-" + "Z".repeat(32);
	const command = `for i in {1..90}; do echo ${"A".repeat(100)}; done; echo ${marker}; sleep 0.2; exit 7`;
	const r = await ext.bash.execute("tc-full", { command }, ext.ac.signal, undefined, ext.ctx);
	const waited = await ext.waitForJob(r.details.asyncJob.id);
	assert.equal(waited.isError, true);
	assert.match(text(waited), new RegExp(marker));
	assert.ok(text(waited).length > 9000, "wait preserves output beyond the notification cap");
	assert.match(text(waited), /exited with code 7/);
	assert.equal(waited.structuredContent?.exit_code, 7, "wait preserves the original structured result");
	assert.deepEqual(waited.details?.asyncJobCompletion, { id: r.details.asyncJob.id, state: "failed" }, "wait identifies the settled job for other extensions");
	assert.equal(ext.fake.sent.length, 0, "consumed result is not notified again");
});

await test("S4.8 wait/kill: unknown job ids error; kill of settled job reports honestly", async () => {
	const ext = await newExtension({ "async-tools-timeout": "100" });
	const u1 = await ext.asyncTools.execute("tc-u1", { action: "wait", job: "job-777" }, ext.ac.signal, undefined, ext.ctx);
	assert.equal(u1.isError, true);
	const u2 = await ext.asyncTools.execute("tc-u2", { action: "kill", job: "job-777" }, ext.ac.signal, undefined, ext.ctx);
	assert.equal(u2.isError, true);
	const r = await ext.bash.execute("tc-u3", { command: "sleep 0.3 && echo T" }, ext.ac.signal, undefined, ext.ctx);
	await ext.waitForJob(r.details.asyncJob.id);
	const late = await ext.asyncTools.execute("tc-u4", { action: "kill", job: r.details.asyncJob.id }, ext.ac.signal, undefined, ext.ctx);
	assert.notEqual(late.isError, true, "killing a settled job is not an error");
	assert.match(text(late), /had already settled \(completed\)/);
});

await test("S4.9 /async_jobs: empty overview and populated listing", async () => {
	const ext = await newExtension({ "async-tools-timeout": "100" });
	const notes = [];
	ext.ctx.ui.notify = (msg) => notes.push(msg);
	await ext.fake.commands.get("async_jobs").handler("", ext.ctx);
	assert.match(notes.at(-1), /no jobs this session/);
	const r = await ext.bash.execute("tc-j", { command: "sleep 0.3 && echo LISTED" }, ext.ac.signal, undefined, ext.ctx);
	await ext.waitForJob(r.details.asyncJob.id);
	await ext.fake.commands.get("async_jobs").handler("", ext.ctx);
	assert.match(notes.at(-1), /job-1 \[completed\] bash — sleep 0\.3 && echo LISTED/);
});

await test("S4.10 footer status tracks spawn, multiple running jobs, and settle via session_start", async () => {
	const statuses = [];
	const ext = await newExtension({ "async-tools-timeout": "100" }, { uiExtras: { setStatus: (k, v) => statuses.push([k, v]), theme: statusTheme } });
	await ext.dispatch("session_start");
	assert.deepEqual(statuses.at(-1), ["async", undefined], "idle at session start");
	const a = await ext.bash.execute("tc-m1", { command: "sleep 0.5 && echo A" }, ext.ac.signal, undefined, ext.ctx);
	const b = await ext.bash.execute("tc-m2", { command: "sleep 0.6 && echo B" }, ext.ac.signal, undefined, ext.ctx);
	assert.match(statuses.at(-1)[1], /async: 2 running/, "badge counts concurrent jobs");
	await ext.waitForJob(a.details.asyncJob.id);
	await ext.waitForJob(b.details.asyncJob.id);
	assert.equal(statuses.at(-1)[1], undefined, "hidden once all settle");
});

await test("S4.11 nested calls stay synchronous; cleanup restores handoff", async () => {
	const ext = await newExtension({ "async-tools-timeout": "120" });
	await ext.dispatch("tool_call", { type: "tool_call", toolCallId: "parent-1/1", parentToolCallId: "parent-1", toolName: "bash", input: {} });
	const t0 = Date.now();
	const r = await ext.bash.execute("parent-1/1", { command: "sleep 0.4 && echo NESTED-REAL" }, ext.ac.signal, undefined, ext.ctx);
	assert.ok(Date.now() - t0 >= 350, "nested call waited for the real result");
	assert.match(text(r), /NESTED-REAL/);
	assert.equal(r.details?.asyncJob, undefined, "nested call never hands off");
	await ext.dispatch("tool_result", { type: "tool_result", toolCallId: "parent-1/1", toolName: "bash", input: {}, content: [], isError: false });
	const r2 = await ext.bash.execute("tc-n2", { command: "sleep 0.4 && echo TOP-LEVEL" }, ext.ac.signal, undefined, ext.ctx);
	assert.ok(r2.details?.asyncJob?.id, "top-level calls hand off again");
	await ext.waitForJob(r2.details.asyncJob.id);
});

await test("S4.12 session_shutdown cancels all running jobs", async () => {
	const ext = await newExtension({ "async-tools-timeout": "100" });
	const r = await ext.bash.execute("tc-sd", { command: "sleep 30" }, ext.ac.signal, undefined, ext.ctx);
	const jobId = r.details.asyncJob.id;
	await ext.dispatch("session_shutdown");
	await sleep(50);
	const waited = await ext.waitForJob(jobId, 1);
	assert.match(text(waited), /\[cancelled\]/);
});

await test("S4.13 --async-tools-timeout 0 backgrounds even instant commands", async () => {
	const ext = await newExtension({ "async-tools-timeout": "0" });
	const r = await ext.bash.execute("tc-z", { command: "echo instant" }, ext.ac.signal, undefined, ext.ctx);
	const jobId = r.details?.asyncJob?.id;
	assert.ok(jobId, "threshold 0 hands off immediately");
	const waited = await ext.waitForJob(jobId);
	assert.match(text(waited), /instant/);
});

await test("S4.14 invalid flag value falls back to the 5000 ms default", async () => {
	const ext = await newExtension({ "async-tools-timeout": "not-a-number" });
	const r = await ext.bash.execute("tc-inv", { command: "echo fine" }, ext.ac.signal, undefined, ext.ctx);
	assert.equal(r.details?.asyncJob, undefined, "fast command stays synchronous under the default");
});

await test("S4.15 concurrent jobs: distinct ids, all results delivered independently", async () => {
	const ext = await newExtension({ "async-tools-timeout": "80" });
	const jobs = [];
	for (const [n, token] of [["0.25", "TOK-A"], ["0.3", "TOK-B"], ["0.35", "TOK-C"]]) {
		const r = await ext.bash.execute(`tc-c-${n}`, { command: `sleep ${n} && echo ${token}` }, ext.ac.signal, undefined, ext.ctx);
		jobs.push({ id: r.details.asyncJob.id, token });
	}
	assert.equal(new Set(jobs.map((j) => j.id)).size, 3, "distinct job ids");
	// Consume two via wait (no notices); the third delivers automatically (one notice).
	for (const { id, token } of jobs.slice(0, 2)) {
		const waited = await ext.waitForJob(id);
		assert.match(text(waited), new RegExp(token));
	}
	await sleep(700);
	assert.equal(ext.fake.sent.length, 1, "only the unconsumed job notifies");
	assert.match(ext.fake.sent[0].msg.content, /TOK-C/);
});

await test("S4.16 abort during wait interrupts the wait, not the job", async () => {
	const ext = await newExtension({ "async-tools-timeout": "100" });
	const r = await ext.bash.execute("tc-aw", { command: "sleep 3 && echo STILL-ALIVE" }, ext.ac.signal, undefined, ext.ctx);
	const jobId = r.details.asyncJob.id;
	const waiterAc = new AbortController();
	const p = ext.asyncTools.execute("tc-aw2", { action: "wait", job: jobId, timeout: 20 }, waiterAc.signal, undefined, ext.ctx);
	await sleep(80);
	waiterAc.abort();
	const interrupted = await p;
	assert.match(text(interrupted), /Wait interrupted; job .* continues in the background/);
	const killed = await ext.asyncTools.execute("tc-aw3", { action: "kill", job: jobId }, ext.ac.signal, undefined, ext.ctx);
	assert.match(text(killed), /Killed job-/, "job survived the interrupted wait and is killable");
});

await test("S4.17 kill suppresses the duplicate cancelled notice", async () => {
	const ext = await newExtension({ "async-tools-timeout": "100" });
	const r = await ext.bash.execute("tc-kn", { command: "sleep 30" }, ext.ac.signal, undefined, ext.ctx);
	const killed = await ext.asyncTools.execute("tc-kn2", { action: "kill", job: r.details.asyncJob.id }, ext.ac.signal, undefined, ext.ctx);
	assert.match(text(killed), /Killed job-/);
	assert.deepEqual(killed.details?.asyncJobCompletion, { id: r.details.asyncJob.id, state: "cancelled" });
	await sleep(80);
	assert.equal(ext.fake.sent.length, 0, "the Killed result already informed the model");
});

await test("S4.18 wait timeout unclaims; the later settle still notifies", async () => {
	const ext = await newExtension({ "async-tools-timeout": "80" });
	const r = await ext.bash.execute("tc-ut", { command: "sleep 1.3 && echo UNCLAIMED-TOKEN" }, ext.ac.signal, undefined, ext.ctx);
	const jobId = r.details.asyncJob.id;
	const early = await ext.waitForJob(jobId, 1);
	assert.match(text(early), /still running after 1s/);
	await sleep(1000);
	assert.equal(ext.fake.sent.length, 1, "the unclaimed job still delivers automatically");
	assert.match(ext.fake.sent[0].msg.content, /UNCLAIMED-TOKEN/);
});

await test("S4.19 interrupted wait unclaims; delivery still arrives automatically", async () => {
	const ext = await newExtension({ "async-tools-timeout": "80" });
	const r = await ext.bash.execute("tc-ia", { command: "sleep 0.8 && echo INTERRUPT-OK" }, ext.ac.signal, undefined, ext.ctx);
	const jobId = r.details.asyncJob.id;
	const waiterAc = new AbortController();
	const p = ext.asyncTools.execute("tc-ia2", { action: "wait", job: jobId, timeout: 20 }, waiterAc.signal, undefined, ext.ctx);
	await sleep(60);
	waiterAc.abort();
	assert.match(text(await p), /Wait interrupted/);
	await sleep(1300);
	assert.equal(ext.fake.sent.length, 1, "an abandoned wait does not swallow the notice");
	assert.match(ext.fake.sent[0].msg.content, /INTERRUPT-OK/);
});

await test("S4.20 consumed delivery still repaints the UI (wait repaints, no notice)", async () => {
	const statuses = [];
	const ext = await newExtension({ "async-tools-timeout": "100" }, { uiExtras: { setStatus: (k, v) => statuses.push([k, v]), theme: statusTheme } });
	await ext.dispatch("session_start");
	const r = await ext.bash.execute("tc-rp", { command: "sleep 0.3 && echo REPAINT-OK" }, ext.ac.signal, undefined, ext.ctx);
	const jobId = r.details.asyncJob.id;
	assert.match(statuses.at(-1)[1], /async: 1 running/);
	const waited = await ext.waitForJob(jobId);
	assert.match(text(waited), /REPAINT-OK/);
	assert.equal(statuses.at(-1)[1], undefined, "wait itself hid the status");
	await sleep(50);
	assert.equal(ext.fake.sent.length, 0, "consumed delivery injects no notice");
});

// =========================================================================
// Summary
// =========================================================================

report("");
if (failures.length > 0) {
	report(`${passed} passed, ${failures.length} FAILED:`);
	for (const f of failures) report(`  - ${f.name}: ${f.err && f.err.stack ? f.err.stack.split("\n").slice(0, 3).join(" | ") : f.err}`);
	process.exitCode = 1;
} else {
	report(`${passed} trials passed — the comprehensive battery is satisfied.`);
}
