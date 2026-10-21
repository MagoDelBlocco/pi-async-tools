// test/engine.test.mjs — unit trials for jobs.ts (run with node via jiti).
import assert from "node:assert/strict";
import { createJiti } from "/home/bogdan/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const { JobRegistry, awaitWithHandoff, formatJobNotice } = await jiti.import("../jobs.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (text) => ({ content: [{ type: "text", text }], details: undefined });

let passed = 0;
const report = (line) => process.stdout.write(`${line}\n`);
async function test(name, fn) {
	await fn();
	passed++;
	report(`  ok  ${name}`);
}

// --- Immediate handoff (threshold 0) --------------------------------------
{
	const reg = new JobRegistry("job");
	const notices = [];
	reg.onSettle((j) => notices.push(formatJobNotice(j, 100)));
	const job = reg.spawn({ toolName: "bash", label: "slow", background: true, runner: async () => (await sleep(60), ok("DONE")) });
	const d = await awaitWithHandoff(job, 0);
	assert.equal(d.kind, "handoff", "force mode hands off immediately");
	assert.equal(job.state, "running");
	assert.equal(notices.length, 0, "no notice before settle");
	await job.settled;
	assert.equal(job.state, "completed");
	assert.match(notices[0], /job-1 completed/);
	assert.match(notices[0], /DONE/);
	await test("Immediate handoff returns at once, notifies once on settle", async () => {
		assert.equal(notices.length, 1);
	});
}

// --- Automatic handoff: fast call stays synchronous -------------------------
{
	const reg = new JobRegistry("job2");
	const notices = [];
	reg.onSettle((j) => notices.push(j));
	const job = reg.spawn({ toolName: "bash", label: "fast", runner: async () => (await sleep(10), ok("quick result")) });
	const d = await awaitWithHandoff(job, 5000);
	assert.equal(d.kind, "result", "fast call resolves within threshold");
	assert.equal(job.state, "completed");
	assert.equal(job.result.content[0].text, "quick result", "synchronous path returns the real result unchanged");
	await sleep(30);
	assert.equal(notices.length, 0, "synchronous completion injects nothing");
	await test("Fast call remains synchronous with unchanged result", async () => {});
}

// --- Automatic handoff: slow call hands off after threshold ------------------
{
	const reg = new JobRegistry("job3");
	const notices = [];
	reg.onSettle((j) => notices.push(formatJobNotice(j, 100)));
	const job = reg.spawn({ toolName: "mcp__x__scan", label: "crawl", runner: async () => (await sleep(150), ok("crawled")) });
	const t0 = Date.now();
	const d = await awaitWithHandoff(job, 50);
	const elapsed = Date.now() - t0;
	assert.equal(d.kind, "handoff", "slow call hands off at threshold");
	assert.ok(elapsed < 120, `handoff at threshold, took ${elapsed}ms`);
	reg.markForNotify(job, 50);
	await job.settled;
	assert.equal(job.state, "completed");
	assert.match(notices[0], /crawled/);
	assert.equal(job.handoffMs, 50);
	await test("Slow call hands off at threshold and delivers the real result later", async () => {
		assert.equal(notices.length, 1);
	});
}

// --- Failure path --------------------------------------------------------
{
	const reg = new JobRegistry("job4");
	const notices = [];
	reg.onSettle((j) => notices.push(j));
	const job = reg.spawn({ toolName: "bash", label: "boom", background: true, runner: async () => { throw new Error("exit 3"); } });
	await job.settled;
	assert.equal(job.state, "failed");
	assert.equal(job.error, "exit 3");
	assert.equal(notices.length, 1, "failed background jobs notify too");
	await test("Failure: rejected runner marks job failed and notifies", async () => {});
}

{
	const reg = new JobRegistry("job5");
	const job = reg.spawn({ toolName: "bash", label: "err", background: true, runner: async () => ({ content: [{ type: "text", text: "bad" }], isError: true }) });
	await job.settled;
	assert.equal(job.state, "failed", "isError result maps to failed");
	await test("Failure: isError result maps to failed state", async () => {});
}

// --- Cancellation ---------------------------------------------------------
{
	const reg = new JobRegistry("job6");
	const notices = [];
	reg.onSettle((j) => notices.push(j));
	const job = reg.spawn({
		toolName: "bash",
		label: "sleeper",
		background: true,
		runner: (signal) =>
			new Promise((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	});
	const cancelled = reg.cancel(job.id);
	assert.equal(cancelled.state, "cancelled");
	await job.settled;
	await sleep(10);
	assert.equal(job.state, "cancelled");
	assert.equal(notices.length, 1, "cancellation notifies");
	assert.equal(reg.cancel(job.id).state, "cancelled", "cancel is idempotent on settled jobs");
	await test("Cancellation: abort settles the job as cancelled and notifies once", async () => {});
}

{
	// A runner that ignores abort must still read as cancelled.
	const reg = new JobRegistry("job7");
	const job = reg.spawn({ toolName: "bash", label: "stubborn", background: true, runner: async () => (await sleep(50), ok("too late")) });
	reg.cancel(job.id);
	await job.settled;
	assert.equal(job.state, "cancelled", "non-cooperative runner stays cancelled");
	assert.equal(job.result, undefined);
	await test("Cancellation: non-cooperative runner cannot overwrite cancelled state", async () => {});
}

// --- cancelAll ------------------------------------------------------------
{
	const reg = new JobRegistry("job8");
	const a = reg.spawn({ toolName: "t", label: "a", background: true, runner: async () => (await sleep(1000), ok("x")) });
	const b = reg.spawn({ toolName: "t", label: "b", runner: async () => (await sleep(1000), ok("x")) });
	reg.cancelAll();
	assert.equal(a.state, "cancelled");
	assert.equal(b.state, "cancelled");
	reg.cancelAll();
	await test("cancelAll: idempotent mass cancellation (session shutdown)", async () => {});
}

report(`${passed} trials passed — the machine spirit is satisfied.`);
