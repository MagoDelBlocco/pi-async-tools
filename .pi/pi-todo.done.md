## Completed: 2026-10-21T15:48:36.029Z

# Todo List

- [x] t1: Investigate Pi API for tool interception points
  - definitionOfDone: Identify viable interception: tool_call/tool_result handler capabilities, executeTool availability, ToolDefinition override path
  - refs: docs/extensions.md
  - refs: dist/core/extensions/types.d.ts
  - refs: dist/core/tools/bash.js

- [x] t2: Build job registry module (jobs.ts)
  - definitionOfDone: Dependency-free job registry: spawn/race/cancel/wait/settle callbacks; unit-testable under plain node
  - rationale: Pi-free core so Strategy A/B logic can be tested without booting Pi

- [x] t3: Implement extension entry (index.ts): bash override + run_async + async_tools + /async_jobs
  - definitionOfDone: Strategy A (explicit async arg) and Strategy B (>5s auto-handoff) both live; default path returns identical synchronous results; nested-call recursion guarded; completion results injected via pi.sendMessage

- [x] t4: Unit-test the job engine strategies
  - definitionOfDone: node script exercises force/auto/sync modes, cancellation, settle notification

- [x] t5: Smoke-test inside Pi (print mode)
  - definitionOfDone: pi --extension loads without errors; synchronous bash passthrough unchanged; async handoff returns job id

- [x] t6: Write README with strategy evaluation and API limitations
  - definitionOfDone: Documents Strategy A vs B feasibility, handler limitations, chosen architecture


## Completed: 2026-10-21T15:54:43.207Z

# Todo List

- [x] r1: Excise Strategy A from model-facing surface (schemas, descriptions, mode parsing)
  - definitionOfDone: bash + run_async no longer declare async param; resolveAsyncMode removed; engine keeps auto/sync modes only

- [x] r2: Rewrite handoff placeholder to authorize independent work

- [x] r3: Switch busy-path completion delivery to steer; idle stays triggerTurn
  - definitionOfDone: notifyJob uses deliverAs:steer when agent is mid-run; README documents one-at-a-time steering caveat

- [x] r4: Update unit + loader trials; run green
  - definitionOfDone: engine.test.mjs and loader.test.mjs pass with Strategy A removed and new placeholder text asserted

- [x] r5: Live Pi re-verification including mid-run steer arrival
  - definitionOfDone: print-mode run: handoff at threshold, agent continues independent work, job result steered before next LLM call

- [x] r6: Update README: removal rationale, delivery semantics table


