# AI Agent Fundamentals Learning Path

## Purpose

This document defines a formal learning path for this repository. It is intended to:

- Keep the project focused on core agent-building concepts.
- Make progress visible over time.
- Provide clear completion criteria for each stage.

## Current Baseline

Status: `Completed`

The repository currently includes a minimal Bedrock-backed REPL agent with:

- A basic system prompt.
- A tool-calling loop.
- Local read-only tools for time, workspace inspection, directory listing, and small file reads.
- In-memory conversation history for the current session.
- JSONL tracing for model, tool, and assistant events.

This baseline establishes the core concept that an agent is the control loop around a model, tools, and runtime state.

## Progress Tracking

Update this file as work is completed.

Status values:

- `Not Started`
- `In Progress`
- `Completed`
- `Blocked`

## Phase 1: Stabilize the Baseline

Status: `Completed`

### Goal

Make the current agent easy to run, easy to understand, and safe to extend.

### Learning Objectives

- Understand the responsibilities of the agent runtime.
- Separate configuration from code.
- Establish a reliable local development workflow.

### Deliverables

- README instructions match the actual script and entrypoint.
- Model, region, and AWS profile are configurable via environment variables.
- Basic startup and failure modes are documented.
- Setup validation is built into agent startup.

### Suggested Tasks

- [x] Fix mismatches between documentation and runnable commands.
- [x] Move hardcoded runtime configuration into environment variables with defaults.
- [x] Document required AWS setup and model access assumptions.
- [x] Build setup validation into agent startup.

### Exit Criteria

- A new contributor can run the agent without reading the source first.
- Runtime configuration changes do not require editing TypeScript files.

## Phase 2: Expand the Tooling Surface

Status: `Not Started`

### Goal

Teach how tool design affects agent performance, reliability, and safety.

### Learning Objectives

- Design tool schemas that are easy for the model to use correctly.
- Validate tool input and handle failures explicitly.
- Understand the difference between read-only and state-changing tools.

### Deliverables

- At least two additional read-oriented tools.
- Clear input validation and error messages for each tool.
- Guardrails for workspace boundaries and file-size limits.

### Suggested Tasks

- [ ] Add `searchFiles` for filename or content discovery.
- [ ] Add `readFileChunk` for reading larger files safely in pieces.
- [ ] Refactor tool definitions and execution into a clearer structure.
- [ ] Add tests or fixtures for tool input validation.

### Exit Criteria

- The agent can inspect moderately sized repos more effectively.
- Tool failures are understandable and recoverable.

## Phase 3: Add Safe Write Capabilities

Status: `Not Started`

### Goal

Introduce controlled mutation so the repo can demonstrate real agent actions, not just inspection.

### Learning Objectives

- Understand why write access changes the risk profile of an agent.
- Add approval boundaries and constraints before making changes.
- Represent tool outputs in a way the model can act on safely.

### Deliverables

- One or more write tools with explicit workspace guardrails.
- Clear documentation of when the agent should and should not modify files.
- Tracing that captures attempted and successful writes.

### Suggested Tasks

- [ ] Add `writeTextFile` with path restrictions.
- [ ] Add an `applyPatch`-style tool or structured edit primitive.
- [ ] Require explicit user confirmation for destructive operations.
- [ ] Record file modification events in traces.

### Exit Criteria

- The agent can make small controlled changes in the workspace.
- Unsafe or ambiguous write attempts are blocked by design.

## Phase 4: Improve Observability and Evaluation

Status: `Not Started`

### Goal

Move from “demo works once” to “behavior is measurable.”

### Learning Objectives

- Understand why agent systems require evals, not just manual testing.
- Measure tool use, task completion, and failure modes.
- Use traces to debug reasoning and control-flow problems.

### Deliverables

- A small evaluation set of representative agent tasks.
- A script or workflow for running those evaluations.
- A lightweight rubric for success, failure, and partial completion.

### Suggested Tasks

- [ ] Create 5 to 10 benchmark tasks for the agent.
- [ ] Define success criteria for each task.
- [ ] Add a script to run the tasks and capture outcomes.
- [ ] Summarize common failure patterns from trace data.

### Exit Criteria

- Changes to prompts or tools can be evaluated consistently.
- The repo can demonstrate measurable improvement over time.

## Phase 5: Introduce Planning

Status: `Not Started`

### Goal

Show the difference between a reactive tool loop and a more structured agent.

### Learning Objectives

- Understand when explicit planning improves behavior.
- Separate planning, execution, and final response phases.
- Compare planned and unplanned agent behavior.

### Deliverables

- A planning step before tool execution.
- A visible representation of the plan in logs or traces.
- Documentation describing when planning helps and when it adds overhead.

### Suggested Tasks

- [ ] Add a planning mode that produces a short task list.
- [ ] Track plan execution progress during the run.
- [ ] Compare outputs and tool usage with and without planning.
- [ ] Document tradeoffs between simplicity and structure.

### Exit Criteria

- The repo demonstrates planning as a distinct agent capability.
- Users can observe concrete behavior changes caused by planning.

## Phase 6: Add Memory and Context Management

Status: `Not Started`

### Goal

Teach how agents handle long-running tasks and finite context windows.

### Learning Objectives

- Understand context-window limits in practical systems.
- Implement conversation summarization or pruning.
- Distinguish short-term session memory from longer-term stored memory.

### Deliverables

- A strategy for trimming or summarizing history.
- Documentation for what information is retained and why.
- Trace visibility into memory compaction decisions.

### Suggested Tasks

- [ ] Add automatic conversation summarization after a threshold.
- [ ] Preserve important tool results while dropping low-value turns.
- [ ] Document tradeoffs between cost, recall, and accuracy.
- [ ] Create a long-session test case.

### Exit Criteria

- The agent remains useful across longer sessions.
- Memory behavior is intentional rather than accidental.

## Phase 7: Add Human-in-the-Loop Controls

Status: `Not Started`

### Goal

Make approval and oversight first-class parts of the learning experience.

### Learning Objectives

- Learn where human approval is necessary in agent systems.
- Design interruption points without breaking usability.
- Distinguish safe autonomy from unchecked autonomy.

### Deliverables

- Approval flow for sensitive actions.
- Clear user-facing messaging around pending actions.
- Examples of actions that require approval versus actions that do not.

### Suggested Tasks

- [ ] Add approval checkpoints before writes or external actions.
- [ ] Log approval decisions in traces.
- [ ] Define a policy for sensitive tools.
- [ ] Document the UX tradeoffs of requiring approval.

### Exit Criteria

- The repo demonstrates practical governance patterns.
- Sensitive actions are visible and reviewable before execution.

## Phase 8: Explore Multi-Agent or Workflow Patterns

Status: `Not Started`

### Goal

Only after the core concepts are stable, explore coordination patterns beyond a single loop.

### Learning Objectives

- Understand when multi-agent systems are useful and when they are unnecessary.
- Compare specialized roles with a single general-purpose agent.
- Learn how workflow orchestration differs from free-form agent behavior.

### Deliverables

- One concrete multi-step workflow or multi-agent experiment.
- Documentation explaining why the added complexity is justified.
- Comparison notes against the simpler single-agent baseline.

### Suggested Tasks

- [ ] Create a planner/executor split or reviewer pattern.
- [ ] Add a workflow with explicit state transitions.
- [ ] Compare complexity, reliability, and debuggability against the baseline.
- [ ] Document lessons learned and when not to use this pattern.

### Exit Criteria

- The repo demonstrates advanced patterns without losing clarity.
- The value of added orchestration is evidence-based.

## Recommended Working Order

1. Phase 1: Stabilize the Baseline
2. Phase 2: Expand the Tooling Surface
3. Phase 3: Add Safe Write Capabilities
4. Phase 4: Improve Observability and Evaluation
5. Phase 5: Introduce Planning
6. Phase 6: Add Memory and Context Management
7. Phase 7: Add Human-in-the-Loop Controls
8. Phase 8: Explore Multi-Agent or Workflow Patterns

## Operating Notes

- Prefer completing one phase before starting the next.
- If a phase becomes too large, split it into milestones in this document.
- Update status and checkboxes as work progresses.
- Record blockers directly in the relevant phase section.

## Progress Log

Use this section to record meaningful project milestones.

| Date | Phase | Update |
| --- | --- | --- |
| 2026-03-15 | Baseline | Learning path created from current repo state. |
| 2026-03-15 | Phase 1 | Baseline stabilized with env-based config, corrected docs, and a local validation command. |
