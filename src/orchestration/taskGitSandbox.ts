/**
 * App-side (orchestration) half of the git sandbox: task/PBI branch
 * orchestration. Extends the generic agentCore `GitSandbox`, composing its
 * protected `withLock`/`git`/`checkoutBaseBranch` hooks — it never reaches
 * into private state. (Extraction plan phase 2a: these methods moved out of
 * agentCore's GitSandbox, which removed its dynamic imports of
 * orchestration/db/taskStore — the last agentCore → app back-edge in this
 * file. Branch-name persistence on task records is app policy, so it lives
 * here behind a static import.)
 *
 * RM-REQ-014/015/016/017: PBI-level integration branches, fast-forward-only
 * merges, and trunk untouched until human PR review.
 */
import { GitSandbox, ExecCommand } from '../agentCore/workspace/git';
import { getGitSandbox } from '../agentCore/workspace';
import { getTask, saveTask } from './db/taskStore';

/**
 * Creates the app's GitSandbox instance. Passed to initializeWorkspace() as
 * its `createSandbox` factory so the shared singleton exposes the task/PBI
 * branch operations (getGitSandbox() is typed as the agentCore base class;
 * use getTaskGitSandbox() for typed access to the app-layer methods).
 */
export function createTaskGitSandbox(
    workTree: string,
    gitDir: string,
    execCommand: ExecCommand
): TaskGitSandbox {
    return new TaskGitSandbox(workTree, gitDir, execCommand);
}

/**
 * Returns the shared sandbox as the app-side subclass, so callers get the
 * task/PBI branch operations in their static type. Throws a loud error when
 * the workspace was initialized without the app factory
 * (initializeWorkspace({ createSandbox: createTaskGitSandbox })) — e.g. a
 * test that initialized the plain agentCore sandbox — rather than failing
 * later with a missing-method error mid git operation.
 */
export function getTaskGitSandbox(): TaskGitSandbox {
    const sandbox = getGitSandbox();
    if (!(sandbox instanceof TaskGitSandbox)) {
        throw new Error(
            'TaskGitSandbox is not installed. Call initializeWorkspace({ createSandbox: createTaskGitSandbox }) before using task/PBI branch operations.'
        );
    }
    return sandbox;
}

export class TaskGitSandbox extends GitSandbox {
    /**
     * Ensures `pbi/<pbiId>` exists, branched off trunk if it doesn't already.
     * Leaves the sandbox checked out on `pbi/<pbiId>`. Idempotent — safe to
     * call on every task within a PBI, not just the first.
     * (RM-REQ-014: PBI-level integration branch, created off trunk when a
     * PBI's first task begins.)
     */
    private async ensurePbiBranchImpl(pbiId: string): Promise<void> {
        const pbiBranch = `pbi/${pbiId}`;
        const exists = await this.git(["branch", "--list", pbiBranch]).then(
            (out) => out.trim().length > 0
        );
        if (exists) {
            await this.git(["checkout", pbiBranch]);
            return;
        }
        await this.checkoutBaseBranch();
        await this.git(["checkout", "-b", pbiBranch]);
    }

    public async ensurePbiBranch(pbiId: string): Promise<void> {
        return this.withLock(() => this.ensurePbiBranchImpl(pbiId));
    }

    /**
     * Branches a task off `pbi/<pbiId>` when a PBI context exists, or off
     * trunk directly when it doesn't (non-PBI tasks keep the original
     * behavior). (RM-REQ-014.)
     */
    public async checkoutTaskBranch(taskId: string, pbiId?: string): Promise<string> {
        return this.withLock(async () => {
            // Return to the correct base first so we don't try to delete the active branch.
            try {
                if (pbiId) {
                    await this.ensurePbiBranchImpl(pbiId);
                } else {
                    await this.checkoutBaseBranch();
                }
            } catch (e) {
                console.warn(`[GitSandbox] Failed to checkout base for task branch:`, e);
                // Ignore failure if we can't switch, but try to proceed
            }

            // Delete branch if it already exists to start fresh off current clean HEAD
            try {
                await this.git(["branch", "-D", `task/${taskId}`]);
            } catch (e) {
                // Ignore if the branch did not exist
            }
            const out = await this.git(["checkout", "-b", `task/${taskId}`]);

            await this.persistTaskBranchName(taskId);
            return out;
        });
    }

    /**
     * Fast-forward-merges `task/<taskId>` into `pbi/<pbiId>` on task completion.
     * Throws (no auto three-way merge) if a fast-forward is not possible —
     * callers are expected to catch this and raise an escalation.
     * Leaves the sandbox back on the base trunk branch afterward, win or lose,
     * consistent with `parkTaskBranch`. Trunk itself is never touched here
     * (RM-REQ-014/RM-REQ-017 — trunk stays untouched until human PR review).
     */
    public async mergeTaskIntoPbi(taskId: string, pbiId: string): Promise<void> {
        return this.withLock(async () => {
            const pbiBranch = `pbi/${pbiId}`;
            try {
                await this.git(["checkout", pbiBranch]);
                await this.git(["merge", "--ff-only", `task/${taskId}`]);
            } finally {
                // Always return to base branch afterward, success or failure —
                // including if the checkout of pbiBranch itself failed (e.g.
                // pbi/<pbiId> doesn't exist) — so the sandbox is never left
                // stuck mid-operation for the next task.
                try {
                    await this.checkoutBaseBranch();
                } catch (e) {
                    console.warn(`[GitSandbox] Failed to checkout base branch after merge:`, e);
                }
            }
        });
    }

    public async parkTaskBranch(taskId: string): Promise<void> {
        return this.withLock(async () => {
            // Stage and commit all current changes on the task branch
            await this.git(["add", "-A"]);
            await this.git(["commit", "--allow-empty", "-m", `Park task ${taskId}`]);

            await this.persistTaskBranchName(taskId);

            // Return to base branch
            await this.checkoutBaseBranch();
        });
    }

    public async resumeTaskBranch(taskId: string): Promise<string> {
        return this.withLock(async () => {
            const out = await this.git(["checkout", `task/${taskId}`]);

            await this.persistTaskBranchName(taskId);
            return out;
        });
    }

    /**
     * Returns the diff of `pbi/<pbiId>` against the base trunk branch —
     * i.e. everything the PBI's tasks have accumulated so far, regardless of
     * what's currently checked out or staged. Used by the compliance-audit
     * operation (RM-REQ-010), which audits the PBI's accumulated diff, not
     * the working tree.
     */
    public async getPbiDiffAsync(pbiId: string): Promise<string> {
        return this.withLock(() =>
            this.git(["diff", `${this.getBaseBranchName()}...pbi/${pbiId}`])
        );
    }

    /**
     * Persists the `task/<taskId>` branch name on the task record in SQLite.
     * Best-effort: failures are swallowed (same behavior as before the
     * extraction split), since branch tracking is bookkeeping, not a
     * precondition for the git operations around it.
     */
    private async persistTaskBranchName(taskId: string): Promise<void> {
        try {
            const task = getTask(taskId);
            if (task) {
                saveTask({
                    ...task,
                    branchName: `task/${taskId}`,
                    updatedAt: Date.now()
                });
            }
        } catch (err) {
            // Ignore or log error
        }
    }
}
