import * as path from "path";

export type ExecCommand = (
    command: string,
    signal?: AbortSignal
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

// Tighter deadline than the runner's default user-command timeout — git
// operations on local disk should never take long. If they do, something
// is wrong (stale lock file, credential prompt) and we want to fail loudly.
const GIT_TIMEOUT_MS = 30_000;

export class GitSandbox {
    private readonly workTree: string;
    private readonly gitDir: string;
    private readonly execCommand: ExecCommand;
    private busy = false;
    private initialized = false;
    private baseBranch = "main";

    /**
     * @param workTree   Absolute path to the workspace root (host or container).
     * @param gitDir     Absolute path to the .git directory (host or container).
     * @param execCommand Runner-provided executor — routes commands to the correct
     *                   environment (native bash or docker exec) automatically.
     */
    constructor(workTree: string, gitDir: string, execCommand: ExecCommand) {
        this.workTree = workTree;
        this.gitDir = gitDir;
        this.execCommand = execCommand;
    }

    // -------------------------------------------------------------------------
    // Lock helper — wraps any async operation so the busy flag is held for the
    // entire duration of the public method, not just each individual git() call.
    // -------------------------------------------------------------------------
    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        if (this.busy) {
            throw new Error(
                "GitSandbox is busy — concurrent git operations are not permitted."
            );
        }
        this.busy = true;
        try {
            return await fn();
        } finally {
            this.busy = false;
        }
    }

    // -------------------------------------------------------------------------
    // Raw git executor — delegates to the injected execCommand so git always
    // runs in the same environment as the workspace (host or container).
    // Uses a dedicated GIT_TIMEOUT_MS deadline — tighter than the runner's
    // default user-command timeout — so hung git ops fail loudly and fast.
    // -------------------------------------------------------------------------
    private async git(args: string[]): Promise<string> {
        // Build env prefix so git uses the correct work tree and git dir
        // regardless of the shell's working directory inside the runner.
        const env = [
            `HOME=${this.workTree}`,
            `GIT_DIR=${this.gitDir}`,
            `GIT_WORK_TREE=${this.workTree}`,
            `GIT_PAGER=cat`,
        ].join(" ");

        const command = `${env} git ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
        const result = await this.execCommand(command, AbortSignal.timeout(GIT_TIMEOUT_MS));

        if (result.exitCode !== 0) {
            const message = result.stderr ? result.stderr.trim() : "(no stderr)";
            throw new Error(
                `Git command failed (exit ${result.exitCode}): ${message}`
            );
        }

        return result.stdout ? result.stdout.trim() : "";
    }

    // -------------------------------------------------------------------------
    // Shell helper — runs a non-git command in the workspace environment.
    // Used for mkdir, tee, etc. during initialisation.
    // -------------------------------------------------------------------------
    private async sh(command: string): Promise<void> {
        const result = await this.execCommand(command);
        if (result.exitCode !== 0) {
            const message = result.stderr ? result.stderr.trim() : "(no stderr)";
            throw new Error(`Shell command failed (exit ${result.exitCode}): ${message}`);
        }
    }

    /**
     * Safely checks out the primary base branch, falling back in order of preference.
     * Deduplicates candidates to avoid redundant CLI invocations.
     */
    private async checkoutBaseBranch(): Promise<void> {
        const candidates = Array.from(new Set([this.baseBranch, "main", "master"]));
        for (const branch of candidates) {
            try {
                await this.git(["checkout", branch]);
                return;
            } catch (e) {
                // Continue to fallback candidate
            }
        }
        throw new Error(`Failed to checkout any base branch. Tried: ${candidates.join(", ")}`);
    }

    // -------------------------------------------------------------------------
    // Public methods — each delegates to a private *Impl so that withLock wraps
    // the full operation boundary rather than individual git() calls.
    // -------------------------------------------------------------------------

    public async initializeGitSandboxAsync(): Promise<void> {
        return this.withLock(() => this._initializeGitSandboxAsync());
    }

    public async getGitDiffHead(): Promise<string> {
        return this.withLock(() => this._getGitDiffHead());
    }

    public async getGitDiffHeadNumstat(): Promise<string> {
        return this.withLock(() => this._getGitDiffHeadNumstat());
    }

    public async commitAllChangesAsync(message: string): Promise<string> {
        return this.withLock(() => this._commitAllChangesAsync(message));
    }

    public async restoreCheckpointAsync(
        commitSha: string,
        message: string
    ): Promise<void> {
        return this.withLock(() => this._restoreCheckpointAsync(commitSha, message));
    }

    public async getGitDiffAsync(): Promise<string> {
        return this.withLock(() => this._getGitDiffAsync());
    }

    public async getHeadShaAsync(): Promise<string> {
        return this.withLock(() => this._getHeadShaAsync());
    }

    public async checkoutAsync(branchName: string): Promise<string> {
        return this.withLock(() => this.git(["checkout", branchName]));
    }

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
            
            // Persist the branch name on the task record in SQLite
            try {
                const { getTask, saveTask } = await import("../db/taskStore");
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

            // Persist the branch name on the task record in SQLite
            try {
                const { getTask, saveTask } = await import("../db/taskStore");
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

            // Return to base branch
            await this.checkoutBaseBranch();
        });
    }

    public async resumeTaskBranch(taskId: string): Promise<string> {
        return this.withLock(async () => {
            const out = await this.git(["checkout", `task/${taskId}`]);

            // Persist the branch name on the task record in SQLite
            try {
                const { getTask, saveTask } = await import("../db/taskStore");
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
            return out;
        });
    }

    // -------------------------------------------------------------------------
    // Private implementations
    // -------------------------------------------------------------------------

    /**
     * Prepares the sandbox git environment if it does not already exist.
     * All filesystem operations are routed through execCommand so they run
     * inside the container in docker mode rather than on the host.
     *
     * Guards against partial initialisation by checking for the git HEAD file.
     * Throws if called more than once on the same instance.
     */
    private async _initializeGitSandboxAsync(): Promise<void> {
        if (this.initialized) {
            throw new Error(
                "GitSandbox: initializeGitSandboxAsync() has already been called on this instance."
            );
        }
        this.initialized = true;

        // A valid git repo always has a HEAD file. Checking for it (rather than
        // just the directory) avoids silently skipping a previously interrupted init.
        const headPath = path.join(this.gitDir, "HEAD");
        const alreadyInitialized = await this.execCommand(`test -f '${headPath}'`)
            .then(r => r.exitCode === 0);

        if (!alreadyInitialized) {
            await this.sh(`mkdir -p '${this.gitDir}' '${this.workTree}'`);

            // Run init first so git owns the metadata layout, then write
            // info/exclude into the directory structure git itself created.
            await this.git(["init"]);

            // Write the exclude file to suppress the snapshots folder from git tracking.
            const excludePath = path.join(this.gitDir, "info", "exclude");
            await this.sh(`mkdir -p '${path.join(this.gitDir, "info")}' && echo 'snapshots/' > '${excludePath}'`);

            await this.git(["config", "user.email", "sandbox@aistudio.local"]);
            await this.git(["config", "user.name", "AI Studio Sandbox"]);
            await this.git(["add", "-A"]);
            await this.git([
                "commit",
                "--allow-empty",
                "-m",
                "Sandbox Baseline (pre-existing files)"
            ]);
        }
        try {
            this.baseBranch = await this.detectBaseBranch();
        } catch (e) {
            this.baseBranch = "main";
        }
    }

    /**
     * Attempts to dynamically detect the repository's base/default branch.
     * Handles standard, detached HEAD, and fallback environments elegantly.
     */
    private async detectBaseBranch(): Promise<string> {
        // 1. Try rev-parse on HEAD
        try {
            const current = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
            if (current && current !== "HEAD") {
                return current;
            }
        } catch (e) {
            // Proceed to fallbacks
        }

        // 2. Try show-current
        try {
            const fallback = await this.git(["branch", "--show-current"]);
            if (fallback && fallback !== "HEAD") {
                return fallback;
            }
        } catch (e) {
            // Proceed to fallbacks
        }

        // 3. Detached HEAD fallbacks:
        // A. Try to read origin/HEAD
        try {
            const remoteHead = await this.git(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
            if (remoteHead && remoteHead.startsWith("origin/")) {
                return remoteHead.substring("origin/".length);
            }
        } catch (e) {
            // Proceed to next fallback
        }

        // B. Try name-rev on HEAD
        try {
            const nameRev = await this.git(["name-rev", "--name-only", "HEAD"]);
            if (nameRev && !nameRev.includes("~") && !nameRev.includes("^") && nameRev !== "undefined") {
                let cleanName = nameRev;
                if (cleanName.startsWith("remotes/origin/")) {
                    cleanName = cleanName.substring("remotes/origin/".length);
                } else if (cleanName.startsWith("origin/")) {
                    cleanName = cleanName.substring("origin/".length);
                }
                if (cleanName && cleanName !== "HEAD") {
                    return cleanName;
                }
            }
        } catch (e) {
            // Keep default fallback
        }

        return "main";
    }

    /**
     * Compares the current working tree AND staging area against the last commit (HEAD).
     * Captures both staged and unstaged local changes.
     */
    private async _getGitDiffHead(): Promise<string> {
        return this.git(["diff", "HEAD"]);
    }

    /**
     * Compares the current working tree AND staging area against HEAD, returning
     * only the numerical tracking statistics (added/deleted lines per modified file).
     */
    private async _getGitDiffHeadNumstat(): Promise<string> {
        return this.git(["diff", "HEAD", "--numstat"]);
    }

    /**
     * Stages all modified and untracked changes, records a new commit, and
     * returns the resulting HEAD SHA. Uses --allow-empty so that snapshot commits
     * are always recorded as timestamped markers even when nothing has changed.
     */
    private async _commitAllChangesAsync(message: string): Promise<string> {
        await this.git(["add", "-A"]);
        await this.git(["commit", "--allow-empty", "-m", message]);
        return this.git(["rev-parse", "HEAD"]);
    }

    /**
     * Overlays a historical snapshot onto the active working directory,
     * staging and committing the changes forward to maintain direct linearity.
     *
     * Throws if the worktree is dirty so in-progress changes are never
     * silently discarded by the checkout.
     *
     * Uses `git read-tree --reset -u <commitSha>` to force the index and working
     * tree to exactly match the checkpoint's tree in one atomic step (handles
     * additions, modifications, and deletions uniformly), followed by
     * `git clean -fd` to sweep any remaining untracked files, before committing
     * forward. HEAD/branch refs are never moved — restoration is always a new
     * forward commit, never a rewind.
     */
    private async _restoreCheckpointAsync(
        commitSha: string,
        message: string
    ): Promise<void> {
        // Detect uncommitted changes (staged or unstaged) before overwriting.
        const isDirty = await this.git(["status", "--porcelain"]).then(
            (out) => out.length > 0
        );

        if (isDirty) {
            throw new Error(
                "GitSandbox: cannot restore checkpoint — worktree has uncommitted changes. " +
                "Commit or discard them first."
            );
        }

        // Force the index and working tree to exactly match commitSha's tree in a single,
        // atomic step: additions since commitSha are removed, modifications are reverted,
        // and deletions are restored. This never moves HEAD or any ref, so the branch and
        // its history remain untouched — we still commit forward below.
        //
        // (Deliberately not `git checkout commitSha -- .`: that form only touches paths
        // that exist in commitSha's tree, so files added and committed after commitSha
        // were silently left in place. `read-tree --reset -u` has no such gap.)
        await this.git(["read-tree", "--reset", "-u", commitSha]);

        // Remove any remaining untracked files/directories added after commitSha so the
        // working tree is an exact mirror of the snapshot, not just a partial overlay.
        await this.git(["clean", "-fd"]);
        await this.git(["add", "-A"]);
        await this.git(["commit", "-m", message]);
    }

    /**
     * Compares the current working tree against the staging area.
     * Captures ONLY unstaged local changes; modifications already added via
     * `git add` are not included.
     */
    private async _getGitDiffAsync(): Promise<string> {
        return this.git(["diff"]);
    }

    /**
     * Returns the exact full commit SHA currently referenced by HEAD.
     */
    private async _getHeadShaAsync(): Promise<string> {
        return this.git(["rev-parse", "HEAD"]);
    }
}
