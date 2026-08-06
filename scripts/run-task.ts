// check for openrouter models first before falling back to gemini
if (!process.env.REVIEWER_PROVIDER && process.env.REVIEWER_MODEL) {
    if (process.env.REVIEWER_MODEL.includes("/")) {
        process.env.REVIEWER_PROVIDER = "openrouter";
    } else {
        process.env.REVIEWER_PROVIDER = "gemini";
    }
}
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { app, setActiveOpenRouterSessionId } from "../src/serverRuntime.ts";
import {
    executeAuditSession,
    getReviewerExecutionConfig,
} from "../src/utils/auditorHelper.ts";
import { FORCED_TOOL_TURN_HARD_TIMEOUT_MS } from "../src/utils/toolCallEnforcement.ts";

interface Task {
    /** Zero-based index into the parsed tasks array. */
    readonly taskIndex: number;
    /** The task description text. */
    readonly description: string;
}

interface TaskResult {
    readonly status: "completed" | "blocked";
    readonly summary: string;
    readonly changes_made: readonly string[];
}

const submitTaskResultTool = {
    type: "function",
    function: {
        name: "submit_task_result",
        description:
            "Submit the result of implementing a task. Call this once work is done or you are blocked.",
        parameters: {
            type: "object",
            properties: {
                status: {
                    type: "string",
                    enum: ["completed", "blocked"],
                    description:
                        "'completed' if the task is fully implemented, 'blocked' if you cannot proceed.",
                },
                summary: {
                    type: "string",
                    description:
                        "A concise description of what was done or why you are blocked.",
                },
                changes_made: {
                    type: "array",
                    items: { type: "string" },
                    description:
                        "List of files created or modified (relative paths). Empty if blocked.",
                },
            },
            required: ["status", "summary", "changes_made"],
        },
    },
};

const SUBMIT_TASK_RESULT_EXAMPLE = `{
  "status": "completed",
  "summary": "Added input validation to the login endpoint.",
  "changes_made": ["api/src/Controllers/AuthController.cs", "api/test/AuthControllerTests.cs"]
}`;

const PORT = parseInt(process.env.PORT || "3000", 10);

/**
 * ProviderRegistry routes gemini (and other non-anthropic-direct) calls through
 * this app's own '/api/providers/:provider/*' proxy route rather than hitting
 * the upstream API directly (see src/serverRuntime.ts). That route is normally
 * only reachable because the full app server is already running. This script
 * runs headless in CI, so it has to stand the proxy up itself for the duration
 * of the task session.
 */
function startProviderProxy(): Promise<Server> {
    process.env.COPILOT_API_URL = `http://127.0.0.1:${PORT}`;
    return new Promise((resolve, reject) => {
        const server = app.listen(PORT, "127.0.0.1", () => resolve(server));
        server.on("error", reject);
    });
}

function stopProviderProxy(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Parse tasks.md (YAML) and return all pending tasks.
 */
function parseUncompletedTasks(content: string): readonly Task[] {
    const doc = parseYaml(content) as { tasks?: Array<{ status?: string; description?: string }> };
    const raw = doc?.tasks ?? [];
    const tasks: Task[] = [];
    for (let i = 0; i < raw.length; i++) {
        const entry = raw[i];
        if (entry?.status === "pending" && typeof entry.description === "string") {
            tasks.push({ taskIndex: i, description: entry.description.trim() });
        }
    }
    return tasks;
}

/**
 * Mark a task as completed in tasks.md by updating its status field in the YAML.
 */
function markTaskCompleted(tasksFilePath: string, taskIndex: number): void {
    const content = readFileSync(tasksFilePath, "utf8");
    const doc = parseYaml(content) as { tasks?: Array<{ status?: string; description?: string }> };
    const entry = doc?.tasks?.[taskIndex];
    if (entry !== undefined) {
        entry.status = "completed";
    }
    writeFileSync(tasksFilePath, stringifyYaml(doc), "utf8");
}

function buildSystemPrompt(task: Task, workspaceDir: string): string {
    return `You are a software implementation agent. Your job is to implement the following task in the codebase located at \`${workspaceDir}\`.

**Task:**
${task.description}

**Instructions:**
- Read relevant files to understand the codebase before making changes.
- Implement the task fully and correctly. Follow existing code conventions.
- Consult \`AGENTS.md\` and \`README.md\` in the workspace for project conventions and patterns.
- After completing your work, call \`submit_task_result\` with status "completed", a summary of what you did, and the list of files you changed.
- If you encounter a blocker that prevents you from completing the task, call \`submit_task_result\` with status "blocked" and explain why.
- Do not ask clarifying questions. Make reasonable assumptions and proceed.

**How to call the tool:**
Call \`submit_task_result\` using your tool-calling capability (a real function/tool call), not as text in your message. Example:

${SUBMIT_TASK_RESULT_EXAMPLE}`;
}

function buildUserPrompt(task: Task): string {
    return `Please implement the following task: ${task.description}`;
}

async function main() {
    const tasksFilePath = resolve(
        process.env.TASKS_FILE ||
            join(process.cwd(), "..", "lhs-hosting-platform", "tasks.md"),
    );
    const workspaceDir = resolve(
        process.env.WORKSPACE_DIR ||
            join(process.cwd(), "..", "lhs-hosting-platform"),
    );

    let tasksContent: string;
    try {
        tasksContent = readFileSync(tasksFilePath, "utf8");
    } catch (err) {
        console.error(
            `[run-task] Cannot read tasks file at ${tasksFilePath}:`,
            err,
        );
        process.exit(1);
    }

    const uncompletedTasks = parseUncompletedTasks(tasksContent);
    if (uncompletedTasks.length === 0) {
        console.log(
            "[run-task] No uncompleted tasks found in tasks.md. Nothing to do.",
        );
        process.exit(0);
    }

    const task = uncompletedTasks[0];
    if (task === undefined) {
        console.log(
            "[run-task] No uncompleted tasks found in tasks.md. Nothing to do.",
        );
        process.exit(0);
    }
    console.log(
        `[run-task] Picked task (index ${task.taskIndex}): ${task.description.slice(0, 80)}...`,
    );

    const contextDir = join(process.cwd(), ".task-context");
    mkdirSync(contextDir, { recursive: true });

    const manifest = [
        "# Task Context",
        `- **Task:** ${task.description}`,
        `- **Workspace:** \`${workspaceDir}\``,
        `- **tasks.md:** \`${tasksFilePath}\``,
    ].join("\n");
    writeFileSync(join(contextDir, "README.md"), manifest);

    const systemPrompt = buildSystemPrompt(task, workspaceDir);
    const userPrompt = buildUserPrompt(task);

    const executionConfig = getReviewerExecutionConfig();
    const proxyServer = await startProviderProxy();
    let result: TaskResult | null = null;
    let sessionId: string | undefined;

    try {
        result = await executeAuditSession<TaskResult>(
            workspaceDir,
            executionConfig,
            systemPrompt,
            submitTaskResultTool,
            userPrompt,
            {
                toolCallExample: SUBMIT_TASK_RESULT_EXAMPLE,
            },
            undefined,
            FORCED_TOOL_TURN_HARD_TIMEOUT_MS,
            (id) => {
                sessionId = id;
                setActiveOpenRouterSessionId(id);
            },
        );
    } finally {
        setActiveOpenRouterSessionId(undefined);
        await stopProviderProxy(proxyServer);
    }

    if (sessionId) {
        console.log(`[run-task] session_id: ${sessionId}`);
    } else {
        console.warn("[run-task] no session_id was captured for this run.");
    }

    if (!result) {
        throw new Error(
            "Unreachable: executeAuditSession resolved without throwing or returning a result.",
        );
    }

    const summary = typeof result.summary === "string" ? result.summary : "";
    const changesMade = Array.isArray(result.changes_made)
        ? result.changes_made
        : [];

    console.log(`[run-task] Task status: ${result.status}`);
    console.log(`[run-task] Summary: ${summary}`);
    if (changesMade.length > 0) {
        console.log(`[run-task] Files changed:\n  ${changesMade.join("\n  ")}`);
    }

    if (result.status === "completed") {
        markTaskCompleted(tasksFilePath, task.taskIndex);
        console.log(`[run-task] Marked task as completed in ${tasksFilePath}`);
    } else {
        console.warn(
            `[run-task] Task not completed (blocked). tasks.md not updated.`,
        );
    }

    process.exit(0);
}

main().catch((err) => {
    console.error("[run-task] failed:", err?.message || err);
    process.exit(1);
});
