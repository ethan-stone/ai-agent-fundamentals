# ai-agent-fundamentals

This repo contains a minimal Bedrock-backed REPL agent for learning core AI agent runtime concepts.

## Project Layout

The codebase is organized in two layers:

- `src/lib/` contains reusable library code for agent runtimes, schemas, storage, and conversation management.
- `src/apps/` contains runnable entrypoints that compose the library into concrete applications.

Current library areas:

- `src/lib/custom/` for the hand-rolled Bedrock agent runtime
- `src/lib/strands/` for Strands-specific conversation managers and storage backends
- `src/lib/config/` for shared schemas and runtime config validation
- `src/lib/core/` for cross-cutting helpers like tool definition/validation
- `src/lib/db/` for Drizzle schema and migrations

Current app entrypoints:

- `src/apps/custom-repl-agent.ts`
- `src/apps/strands-repl-agent.ts`
- `src/apps/evals.ts`
- `src/apps/analyze-evals.ts`

## Install

```bash
bun install
```

## Test

```bash
bun test
```

## Database

Generate a new migration after changing the schema:

```bash
bun run db:generate
```

Apply migrations to the local SQLite database:

```bash
bun run db:migrate
```

## Evals

```bash
bun run evals
```

This runs the benchmark prompts in `evals/tasks.json`, drives the current REPL agent, scores the resulting traces, and writes results under `evals/results/`.

To compare models, run the same eval suite with different `AGENT_MODEL_ID` values. Each eval result records the model and region used for that run.

Example:

```bash
AGENT_MODEL_ID=us.amazon.nova-2-lite-v1:0 bun run evals
```

To summarize patterns across saved eval runs:

```bash
bun run analyze-evals
```

## Local Env Setup

This repo requires local runtime configuration in a repo-level `.env` file. Bun loads this automatically when you run scripts.

The project includes:

- `.env.example` as the committed template
- `.env` as the local runtime config for this workspace

Current `.env` shape:

```dotenv
AWS_PROFILE=personal-admin
AWS_REGION=us-east-1
AGENT_MODEL_ID=us.amazon.nova-2-lite-v1:0
MAX_AGENT_ITERATIONS=8
```

## Configuration

The runtime requires these environment variables:

- `AGENT_MODEL_ID`
- `AWS_PROFILE`
- `AWS_REGION`
- `AWS_DEFAULT_REGION`
  Used only if `AWS_REGION` is not set.
- `MAX_AGENT_ITERATIONS`

If any required value is missing, the agent exits at startup.

## Prerequisites

- The configured AWS profile must exist in your local AWS config or credentials files.
- That profile must have permission to call Bedrock in the configured region.
- The selected model must be enabled in that region for your account.

## Run

```bash
bun run custom-repl-agent
```

## Run With Strands

```bash
bun run strands-repl-agent
```

## Run With Strands Multi-Agent

```bash
bun run strands-multi-agent-repl
```

This entrypoint uses the agents-as-tools pattern:

- `orchestrator` talks to the user and decides when to delegate
- `repo_researcher` inspects the local codebase and returns evidence-backed findings
- `critic` reviews draft answers for weak claims and omissions

The Strands version uses:

- `SessionManager` for native Strands session persistence
- `S3Storage` backed by the S3 bucket configured for this repo
- `SlidingWindowConversationManager` for model-facing conversation trimming
- `STRANDS_CONVERSATION_MANAGER=safe|summarizing` to compare a Bedrock-safe trimming manager with a custom summarizing manager in the Strands REPL
- the same local workspace tools as the hand-rolled agent

Optional env vars for the Strands entrypoint:

- `STRANDS_SESSION_BUCKET`
- `STRANDS_SESSION_PREFIX`
- `STRANDS_SESSION_ID`

If `STRANDS_SESSION_ID` is not set, the Strands REPL creates a fresh random session ID on each startup.

On startup, the agent fails fast if:

- the repo `.env` file is missing
- required environment variables are missing
- `MAX_AGENT_ITERATIONS` is not a positive integer

The current entrypoint is a minimal Bedrock-backed agent loop:

- Reads AWS credentials from `AWS_PROFILE`.
- Uses the Bedrock model from `AGENT_MODEL_ID`.
- Uses `AWS_REGION` or `AWS_DEFAULT_REGION`, and falls back to `us-east-1`.
- Stores session memory in SQLite through a pluggable memory adapter.
- Persists durable session state through a pluggable session store.
- Uses a conversation manager to decide which messages are sent back to the model.
- Associates each conversation with a `sessionId`.
- Uses rolling summary compaction once the active message window gets too large.
- Repeats Bedrock tool calls until the model returns a normal assistant response.
- Writes a structured timeline trace for each session under `traces/*.jsonl`.

The agent exposes these local tools:

- `getCurrentDateTime` for the local date/time and timezone.
- `getWorkingDirectory` for the workspace root.
- `listDirectory` for inspecting repo structure.
- `readTextFile` for reading small text files in the workspace.
- `readFileChunk` for inspecting larger files in smaller pieces.
- `searchFiles` for searching file contents or file names inside the workspace.

The tool layer is covered by tests for schema validation, coercion, and `defineTool` behavior.

The evaluation layer scores tasks against a simple rubric:

- required tools were used
- no error event was emitted
- the final assistant response matched an expected snippet
- the run stayed within an iteration budget

The eval analysis layer summarizes recurring failure patterns across runs, including:

- infrastructure failures
- missing required tool usage
- answer mismatches
- iteration-budget failures
- most common failing tasks
- breakdowns by model

## Memory

The runtime now separates session storage from conversation management:

- Session state is stored by `sessionId` in SQLite at `data/agent-memory.sqlite`.
- The runtime depends on a session-store interface, so the backing store can be swapped later.
- Full session history is retained in a transcript table, even after compaction.
- Older conversation turns are summarized into a compact running memory.
- Recent turns are kept verbatim in working memory storage.
- A conversation manager chooses the selective slice of recent raw messages sent back to the model on each turn.
- Compaction decisions are written to the trace as `memory_compacted` events.

This is a practical tradeoff between retaining task context and avoiding unbounded conversation growth. In production, this distinction matters:

- stored history is the durable session transcript
- summary memory preserves older high-value context
- working memory is the compact session state used to continue the conversation efficiently
- the model context is only the recent subset that is most useful for the current turn

This mirrors a common production split:

- session management answers: "what happened in this session?"
- conversation management answers: "what should the model see on this turn?"

As a rule of thumb, the most useful messages to keep verbatim are:

- the newest user requests
- the newest assistant/tool exchange that explains current progress
- recent tool results the model may need to reference directly

The least useful messages to keep verbatim are usually:

- old acknowledgements or filler responses
- stale exploration steps that have already been summarized
- old tool output that no longer affects the current task

For this learning repo, the compaction thresholds are intentionally small so the behavior is easy to observe during normal use. In practice, you would usually compact less aggressively and base the decision on context-window pressure rather than a tiny fixed message count.

In production, a more typical approach would be:

- trigger compaction from estimated token usage, not just raw message count
- preserve the latest user request, active constraints, and recent tool results verbatim
- summarize older exploration and resolved steps once they become background context
- compact before prompt size starts to crowd out the current task or meaningfully increase cost and latency

## REPL Commands

- `/clear` clears the stored memory for the current session.
- `/exit` quits the loop.

## Tracing

- Each run creates a timestamped JSONL trace file in `traces/`.
- Events include user messages, model responses, tool requests, tool results, final assistant replies, and errors.
- Tool calls and tool results are also echoed to the console during execution.

## Common Failure Modes

- Missing AWS profile or credentials.
- Missing repo `.env` file.
- Bedrock access not enabled for the configured model or region.
- Invalid `MAX_AGENT_ITERATIONS` value.
- Asking the agent to read files outside the workspace or files larger than the configured read limit.
