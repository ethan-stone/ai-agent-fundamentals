import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createAgentRuntime, type RuntimeConfig, type TraceEvent } from "./agent-runtime";

type EvalTask = {
  id: string;
  prompt: string;
  requiredTools: string[];
  assistantMustContainOneOf?: string[];
  maxIterations?: number;
};

type EvalTaskResult = {
  id: string;
  prompt: string;
  modelId: string;
  traceFile: string | null;
  assistantText: string;
  toolRequests: string[];
  iterationsObserved: number;
  hadError: boolean;
  passed: boolean;
  checks: {
    noError: boolean;
    requiredToolsUsed: boolean;
    assistantContentMatched: boolean;
    withinIterationBudget: boolean;
  };
  infrastructureError?: string;
};

type EvalRunResult = {
  startedAt: string;
  modelId: string;
  awsRegion: string;
  taskCount: number;
  passedCount: number;
  results: EvalTaskResult[];
};

const WORKSPACE_ROOT = process.cwd();
const TASKS_PATH = resolve(WORKSPACE_ROOT, "evals", "tasks.json");
const RESULTS_DIR = resolve(WORKSPACE_ROOT, "evals", "results");

function getTimestampLabel() {
  return new Date().toISOString().replaceAll(":", "-");
}

async function loadTasks(): Promise<EvalTask[]> {
  const raw = await readFile(TASKS_PATH, "utf8");
  return JSON.parse(raw) as EvalTask[];
}

async function parseTraceFile(traceFile: string): Promise<TraceEvent[]> {
  const raw = await readFile(traceFile, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}

function getTracePathFromOutput(stdout: string): string | null {
  const match = stdout.match(/Trace file: (.+)/);
  return match?.[1]?.trim() ?? null;
}

function collectAssistantText(events: TraceEvent[]): string {
  return events
    .filter((event) => event.type === "assistant_message")
    .map((event) => String(event.data.text ?? ""))
    .join("\n")
    .trim();
}

function collectToolRequests(events: TraceEvent[]): string[] {
  return events
    .filter((event) => event.type === "tool_request")
    .map((event) => String(event.data.name ?? ""))
    .filter(Boolean);
}

function getMaxIteration(events: TraceEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.iteration ?? 0), 0);
}

async function runTask(task: EvalTask): Promise<EvalTaskResult> {
  try {
    const agent = await createAgentRuntime();
    const config = agent.getConfig();
    const result = await agent.run(task.prompt);
    const traceFile = result.traceFile;

    const events = await parseTraceFile(traceFile);
    const assistantText = result.assistantText || collectAssistantText(events);
    const toolRequests = collectToolRequests(events);
    const iterationsObserved = getMaxIteration(events);
    const hadError = events.some((event) => event.type === "error");
    const requiredToolsUsed = task.requiredTools.every((tool) => toolRequests.includes(tool));
    const assistantContentMatched = (task.assistantMustContainOneOf ?? [""])
      .some((snippet) => assistantText.toLowerCase().includes(snippet.toLowerCase()));
    const withinIterationBudget = task.maxIterations ? iterationsObserved <= task.maxIterations : true;
    const noError = !hadError;
    const passed = noError && requiredToolsUsed && assistantContentMatched && withinIterationBudget;

    return {
      id: task.id,
      prompt: task.prompt,
      modelId: config.modelId,
      traceFile,
      assistantText,
      toolRequests,
      iterationsObserved,
      hadError,
      passed,
      checks: {
        noError,
        requiredToolsUsed,
        assistantContentMatched,
        withinIterationBudget,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const modelId = process.env.AGENT_MODEL_ID ?? "unknown";

    return {
      id: task.id,
      prompt: task.prompt,
      modelId,
      traceFile: null,
      assistantText: "",
      toolRequests: [],
      iterationsObserved: 0,
      hadError: true,
      passed: false,
      checks: {
        noError: false,
        requiredToolsUsed: false,
        assistantContentMatched: false,
        withinIterationBudget: false,
      },
      infrastructureError: message,
    };
  }
}

function formatSummary(result: EvalRunResult): string {
  const lines = [
    `Evaluation run: ${result.startedAt}`,
    `Model: ${result.modelId}`,
    `Region: ${result.awsRegion}`,
    `Passed ${result.passedCount}/${result.taskCount} tasks`,
    "",
  ];

  for (const task of result.results) {
    lines.push(
      `${task.passed ? "PASS" : "FAIL"} ${task.id} | tools=${task.toolRequests.join(", ") || "none"} | iterations=${task.iterationsObserved} | trace=${task.traceFile ? basename(task.traceFile) : "none"}${task.infrastructureError ? ` | infra=${task.infrastructureError}` : ""}`,
    );
  }

  return lines.join("\n");
}

async function main() {
  const tasks = await loadTasks();
  const results: EvalTaskResult[] = [];
  const baselineAgent = await createAgentRuntime();
  const config: RuntimeConfig = baselineAgent.getConfig();

  for (const task of tasks) {
    console.log(`Running eval task: ${task.id}`);
    results.push(await runTask(task));
  }

  const runResult: EvalRunResult = {
    startedAt: new Date().toISOString(),
    modelId: config.modelId,
    awsRegion: config.awsRegion,
    taskCount: tasks.length,
    passedCount: results.filter((result) => result.passed).length,
    results,
  };

  await mkdir(RESULTS_DIR, { recursive: true });

  const timestamp = getTimestampLabel();
  const jsonPath = join(RESULTS_DIR, `${timestamp}.json`);
  const summaryPath = join(RESULTS_DIR, `${timestamp}.txt`);

  await writeFile(jsonPath, `${JSON.stringify(runResult, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${formatSummary(runResult)}\n`, "utf8");

  console.log(formatSummary(runResult));
  console.log(`\nSaved JSON results to ${jsonPath}`);
  console.log(`Saved text summary to ${summaryPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Eval run failed: ${message}`);
  process.exitCode = 1;
});
