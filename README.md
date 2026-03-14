# ai-agent-fundamentals

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

The current entrypoint is a minimal Bedrock-backed agent loop:

- Uses `fromIni({ profile: "personal-admin" })` for AWS credentials.
- Uses the Bedrock model `us.amazon.nova-2-lite-v1:0`.
- Uses `AWS_REGION` or `AWS_DEFAULT_REGION`, and falls back to `us-east-1`.
- Keeps conversation history in memory for the current REPL session.
- Repeats Bedrock tool calls until the model returns a normal assistant response.
- Writes a structured timeline trace for each session under `traces/*.jsonl`.
- Exposes these local tools:
- `getCurrentDateTime` for the local date/time and timezone.
- `getWorkingDirectory` for the workspace root.
- `listDirectory` for inspecting repo structure.
- `readTextFile` for reading small text files in the workspace.

Prerequisites:

- The AWS profile `personal-admin` must exist in your local AWS config/credentials.
- That profile must have permission to call Bedrock in the target region.
- The selected model must be enabled in that region for your account.

Run it:

```bash
bun run index.ts
```

REPL commands:

- `/clear` resets the in-memory conversation history.
- `/exit` quits the loop.

Tracing:

- Each run creates a timestamped JSONL trace file in `traces/`.
- Events include user messages, model responses, tool requests, tool results, final assistant replies, and errors.
- Tool calls and tool results are also echoed to the console during execution.
