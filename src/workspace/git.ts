import { execFile } from "child_process";
import * as util from "util";
import * as fs from "fs/promises";
import * as path from "path";

const FIXED_GIT_PATH = "/usr/bin/git";
const execFileAsync = util.promisify(execFile);

export class GitSandbox {
    private readonly workTree: string;
    private readonly gitDir: string;
    private busy = false;

    constructor(workTree: string, gitDir: string) {
        this.workTree = workTree;
        this.gitDir = gitDir;
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
    // Raw git executor — no longer manages the busy flag (withLock owns that).
    // -------------------------------------------------------------------------
    private async git(args: string[]): Promise<string> {
        try {
            const ret = await execFileAsync(FIXED_GIT_PATH, args, {
                cwd: this.workTree,
                env: {
                    HOME: this.workTree,
                    // FIX: USER must be a username string, not a directory path.
                    USER: "sandbox",
                    GIT_DIR: this.gitDir,
                    GIT_WORK_TREE: this.workTree,
                    GIT_PAGER: "cat"
                }
            });
            return ret.stdout ? ret.stdout.trim() : "";
        } catch (e: any) {
            const message = e.stderr ? e.stderr.trim() : e.message;
            throw new Error(`Git command failed (exit ${e.code}): ${message}`);
        }
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

    // -------------------------------------------------------------------------
    // Private implementations
    // -------------------------------------------------------------------------

    /**
     * Prepares the sandbox git environment if it does not already exist.
     * Guards against partial initialisation by checking for the git HEAD file
     * rather than just the directory, and uses async I/O throughout to avoid
     * blocking the event loop.
     * Roots baseline exclusions to the snapshots folder.
     */
    private async _initializeGitSandboxAsync(): Promise<void> {
        // A valid git repo always has a HEAD file. Checking for it (rather than
        // just the directory) avoids silently skipping a previously interrupted init.
        const headPath = path.join(this.gitDir, "HEAD");
        const alreadyInitialized = await fs.access(headPath).then(() => true, () => false);

        if (!alreadyInitialized) {
            await fs.mkdir(this.gitDir, { recursive: true });
            await fs.mkdir(this.workTree, { recursive: true });

            // Run init first so git owns the metadata layout, then write
            // info/exclude into the directory structure git itself created.
            await this.git(["init"]);

            const excludeDir = path.join(this.gitDir, "info");
            await fs.mkdir(excludeDir, { recursive: true });
            await fs.writeFile(path.join(excludeDir, "exclude"), "snapshots/\n");
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
     * After checking out, runs `git clean -fd` to remove any untracked files
     * that were added after the checkpoint, ensuring the working tree exactly
     * mirrors the historic snapshot before committing forward.
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

        await this.git(["checkout", commitSha, "--", "."]);
        // Remove untracked files/directories added after commitSha so the
        // working tree is an exact mirror of the snapshot, not just a partial overlay.
        await this.git(["clean", "-fd"]);
        await this.git(["add", "-A"]);
        await this.git(["commit", "-m", message]);
    }

    /**
     * Compares the current working tree against the staging area.
     * Captures ONLY unstaged local changes; modifications already added via
     * `git add` are not included.
     *
     * FIX: Consistent with other diff methods — GIT_PAGER=cat in the env already
     * suppresses the pager, so --no-pager is not needed here.
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
}    // -------------------------------------------------------------------------
    // Raw git executor — no longer manages the busy flag (withLock owns that).
    // -------------------------------------------------------------------------
    private async git(args: string[]): Promise<string> {
        try {
            const ret = await execFileAsync(FIXED_GIT_PATH, args, {
                cwd: this.workTree,
                env: {
                    HOME: this.workTree,
                    // FIX: USER must be a username string, not a directory path.
                    USER: "sandbox",
                    GIT_DIR: this.gitDir,
                    GIT_WORK_TREE: this.workTree,
                    GIT_PAGER: "cat"
                }
            });
            return ret.stdout ? ret.stdout.trim() : "";
        } catch (e: any) {
            const message = e.stderr ? e.stderr.trim() : e.message;
            throw new Error(`Git command failed (exit ${e.code}): ${message}`);
        }
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
        return this.withLock(() =>
            this._restoreCheckpointAsync(commitSha, message)
        );
    }

    public async getGitDiffAsync(): Promise<string> {
        return this.withLock(() => this._getGitDiffAsync());
    }

    public async getHeadShaAsync(): Promise<string> {
        return this.withLock(() => this._getHeadShaAsync());
    }

    // -------------------------------------------------------------------------
    // Private implementations
    // -------------------------------------------------------------------------

    /**
     * Prepares the sandbox git environment if it does not already exist.
     * Guards against partial initialisation by checking for the git HEAD file
     * rather than just the directory, and uses async I/O throughout to avoid
     * blocking the event loop.
     * Roots baseline exclusions to the snapshots folder.
     */
    private async _initializeGitSandboxAsync(): Promise<void> {
        // A valid git repo always has a HEAD file. Checking for it (rather than
        // just the directory) avoids silently skipping a previously interrupted init.
        const headPath = path.join(this.gitDir, "HEAD");
        const alreadyInitialized = await fs.access(headPath).then(
            () => true,
            () => false
        );

        if (!alreadyInitialized) {
            await fs.mkdir(this.gitDir, { recursive: true });
            await fs.mkdir(this.workTree, { recursive: true });

            // Run init first so git owns the metadata layout, then write
            // info/exclude into the directory structure git itself created.
            await this.git(["init"]);

            const excludeDir = path.join(this.gitDir, "info");
            await fs.mkdir(excludeDir, { recursive: true });
            await fs.writeFile(
                path.join(excludeDir, "exclude"),
                "snapshots/\n"
            );
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
     * After checking out, runs `git clean -fd` to remove any untracked files
     * that were added after the checkpoint, ensuring the working tree exactly
     * mirrors the historic snapshot before committing forward.
     */
    private async _restoreCheckpointAsync(
        commitSha: string,
        message: string
    ): Promise<void> {
        // Detect uncommitted changes (staged or unstaged) before overwriting.
        const isDirty = await this.git(["status", "--porcelain"]).then(
            out => out.length > 0
        );

        if (isDirty) {
            throw new Error(
                "GitSandbox: cannot restore checkpoint — worktree has uncommitted changes. " +
                    "Commit or discard them first."
            );
        }

        await this.git(["checkout", commitSha, "--", "."]);
        // Remove untracked files/directories added after commitSha so the
        // working tree is an exact mirror of the snapshot, not just a partial overlay.
        await this.git(["clean", "-fd"]);
        await this.git(["add", "-A"]);
        await this.git(["commit", "-m", message]);
    }

    /**
     * Compares the current working tree against the staging area.
     * Captures ONLY unstaged local changes; modifications already added via
     * `git add` are not included.
     *
     * FIX: Consistent with other diff methods — GIT_PAGER=cat in the env already
     * suppresses the pager, so --no-pager is not needed here.
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
