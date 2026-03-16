import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

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
const RESULTS_DIR = resolve(WORKSPACE_ROOT, "evals", "results");

async function loadEvalRuns(): Promise<EvalRunResult[]> {
  const entries = await readdir(RESULTS_DIR, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const runs: EvalRunResult[] = [];

  for (const fileName of jsonFiles) {
    const raw = await readFile(join(RESULTS_DIR, fileName), "utf8");
    runs.push(JSON.parse(raw) as EvalRunResult);
  }

  return runs;
}

function summarizeRuns(runs: EvalRunResult[]): string {
  if (runs.length === 0) {
    return "No eval runs found under evals/results/.";
  }

  const allResults = runs.flatMap((run) => run.results);
  const passedCount = allResults.filter((result) => result.passed).length;
  const failedResults = allResults.filter((result) => !result.passed);
  const infraFailures = failedResults.filter((result) => Boolean(result.infrastructureError));
  const iterationFailures = failedResults.filter((result) => !result.checks.withinIterationBudget);
  const toolSelectionFailures = failedResults.filter((result) => !result.checks.requiredToolsUsed);
  const answerMismatchFailures = failedResults.filter((result) => !result.checks.assistantContentMatched);
  const explicitErrorFailures = failedResults.filter((result) => !result.checks.noError);

  const failureByTask = new Map<string, number>();
  const toolUsageCounts = new Map<string, number>();
  const resultsByModel = new Map<string, EvalTaskResult[]>();

  for (const result of allResults) {
    const modelId = result.modelId || "unknown-or-legacy";
    const modelResults = resultsByModel.get(modelId) ?? [];
    modelResults.push(result);
    resultsByModel.set(modelId, modelResults);

    for (const tool of result.toolRequests) {
      toolUsageCounts.set(tool, (toolUsageCounts.get(tool) ?? 0) + 1);
    }

    if (!result.passed) {
      failureByTask.set(result.id, (failureByTask.get(result.id) ?? 0) + 1);
    }
  }

  const mostCommonFailureTasks = [...failureByTask.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const mostUsedTools = [...toolUsageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const modelBreakdown = [...resultsByModel.entries()]
    .map(([modelId, modelResults]) => ({
      modelId,
      total: modelResults.length,
      passed: modelResults.filter((result) => result.passed).length,
      failed: modelResults.filter((result) => !result.passed).length,
      iterationFailures: modelResults.filter((result) => !result.checks.withinIterationBudget).length,
      toolFailures: modelResults.filter((result) => !result.checks.requiredToolsUsed).length,
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));

  const lines = [
    `Eval runs analyzed: ${runs.length}`,
    `Total task executions: ${allResults.length}`,
    `Passed task executions: ${passedCount}`,
    `Failed task executions: ${failedResults.length}`,
    "",
    "Failure pattern counts:",
    `- Infrastructure failures: ${infraFailures.length}`,
    `- Explicit error failures: ${explicitErrorFailures.length}`,
    `- Missing required tool failures: ${toolSelectionFailures.length}`,
    `- Assistant content mismatch failures: ${answerMismatchFailures.length}`,
    `- Iteration budget failures: ${iterationFailures.length}`,
    "",
    "Most common failing tasks:",
    ...(
      mostCommonFailureTasks.length > 0
        ? mostCommonFailureTasks.map(([taskId, count]) => `- ${taskId}: ${count}`)
        : ["- none"]
    ),
    "",
    "Most frequently used tools:",
    ...(
      mostUsedTools.length > 0
        ? mostUsedTools.map(([tool, count]) => `- ${tool}: ${count}`)
        : ["- none"]
    ),
    "",
    "Breakdown by model:",
    ...(
      modelBreakdown.length > 0
        ? modelBreakdown.map((entry) =>
          `- ${entry.modelId}: passed=${entry.passed}/${entry.total}, failed=${entry.failed}, tool-failures=${entry.toolFailures}, iteration-failures=${entry.iterationFailures}`,
        )
        : ["- none"]
    ),
    "",
    "Recent failed examples:",
  ];

  const recentFailures = failedResults.slice(-5);

  if (recentFailures.length === 0) {
    lines.push("- none");
  } else {
    for (const failure of recentFailures) {
      const traceLabel = failure.traceFile ? basename(failure.traceFile) : "none";
      const failureReasons = [
        !failure.checks.noError ? "error-event" : null,
        !failure.checks.requiredToolsUsed ? "wrong-tool-selection" : null,
        !failure.checks.assistantContentMatched ? "answer-mismatch" : null,
        !failure.checks.withinIterationBudget ? "iteration-budget" : null,
        failure.infrastructureError ? `infra:${failure.infrastructureError}` : null,
      ].filter(Boolean);

      lines.push(`- ${failure.id} | reasons=${failureReasons.join(", ")} | trace=${traceLabel}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const runs = await loadEvalRuns();
  console.log(summarizeRuns(runs));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Eval analysis failed: ${message}`);
  process.exitCode = 1;
});
