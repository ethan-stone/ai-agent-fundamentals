# ai-agent-fundamentals

This repo contains a minimal Bedrock-backed REPL agent for learning core AI agent runtime concepts.

## Install

```bash
bun install
```

## Test

```bash
bun test
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
bun run repl-agent
```

On startup, the agent fails fast if:

- the repo `.env` file is missing
- required environment variables are missing
- `MAX_AGENT_ITERATIONS` is not a positive integer

The current entrypoint is a minimal Bedrock-backed agent loop:

- Reads AWS credentials from `AWS_PROFILE`.
- Uses the Bedrock model from `AGENT_MODEL_ID`.
- Uses `AWS_REGION` or `AWS_DEFAULT_REGION`, and falls back to `us-east-1`.
- Keeps conversation history in memory for the current REPL session.
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

## REPL Commands

- `/clear` resets the in-memory conversation history.
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
