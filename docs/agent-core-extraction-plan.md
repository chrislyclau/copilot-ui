# agentCore extraction plan

Status: draft, September 2026
Branch: `fix/issue-<N>-extract-agent-core` (issue number TBD; `main` is never touched)
Verification at every step: `npx tsc --noEmit -p tsconfig.json`, `npm run lint`, `npx vitest run`

## 1. Goal and definition of done

Produce a self-contained `agent-core` package that can be copied into its own repository and works there with no reference to the app.

"Ready to copy" means all of these hold on the branch:

1. **Complete.** Everything the package needs (source, tests, test support, docs, configs) lives under one directory: `packages/agent-core/`.
2. **Standalone.** Nothing in that directory imports from outside it. This includes dynamic `import()` and `require()`, which the current lint rules do not catch.
3. **Proven on a copy.** `scripts/verify-standalone.sh` copies the directory to a temp path outside the repo, then runs install, `tsc`, lint, and the non-Docker tests, and passes.
4. **App still works.** The app, on the same branch, passes `tsc`, lint, and `vitest` while importing agentCore only through the package's public entrypoints.
5. **Documented contract.** The package README lists every environment variable it reads.

Two deliverables come out of this branch:

- **A. The package directory**, which you copy into the new repo.
- **B. The app-side changes** (relocations, import rewrites, dependency swap), which land in `main` later as one or more PRs.

Until B lands, `main` keeps its in-tree `src/agentCore` and is unaffected.

## 2. Non-goals

- No behavior changes. Every phase is a move, a cut, or an injection, and the existing tests must pass unchanged, apart from tests that move or are deleted.
- No redesign of `SessionWrapper`, the provider layer, or the gate loop.
- No publishing or CI setup for the new repo (see phase 6 for a checklist only).

## 3. Baseline (verified on upstream clone)

agentCore is 20 files, about 5k lines: `workspace/` (Docker and native runners, `git.ts`, process groups), `copilotSdk/` (`boundary`, `sessionWrapper`, `systemMessageBaseline`), and top-level modules (`auditorHelper`, `toolCallEnforcement`, `providerRegistry`, `providerProxy`, `contextManager`, `execTool`, `toolHandlers`, `prompt`, `traceRegistry`, `simulator`).

**Back-edges (agentCore importing from the app), five in total:**

| # | Back-edge | Where |
|---|---|---|
| 1 | `LogLevel` from `orchestration/orchestrator/sessionState` | `toolHandlers.ts` |
| 2 | `config/models` (`ModelProviderConfig`, `MODEL_TIERS`, `DEFAULT_ROLES_CONFIG`, ...) | `auditorHelper.ts`, `providerRegistry.ts` |
| 3 | `config/tools` (`RUN_TERMINAL_DOCKER_TOOL`) | `auditorHelper.ts` |
| 4 | `express` types | `toolHandlers.ts`, `providerProxy.ts` |
| 5 | Three dynamic `import()` of `orchestration/db/taskStore` | `workspace/git.ts` |

Back-edge 5 is invisible to a static import scan and to `no-restricted-imports`. Phase 0 adds a guard that catches it.

**Third-party dependencies actually used:** `@github/copilot-sdk` and `express` (proxy and toolHandlers only), plus Node builtins (`fs`, `path`, `os`, `crypto`, `child_process`, `https`).

**Environment variables read inside agentCore:** `COPILOT_API_URL`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_BASE_URL`, `LOCAL_PROVIDER_URL`, `LOCAL_PROVIDER_API_KEY`, `WORKSPACE_HOST_LOCATION`, `CONTAINER_NAME`, `AI_STUDIO`, `PORT`, `NODE_ENV`, `VITEST`.

## 4. Decisions needed before or during the work

| Decision | Recommendation | Blocks |
|---|---|---|
| Issue number for branch and commit names | Create one for the reorg | Phase 0 |
| Package name and scope (`@<org>/agent-core`) | Use the org that will own the new repo | Phase 4 |
| Package format: compiled `dist/` versus TypeScript source | **Compiled.** The app's production build is `esbuild --packages=external`, so an external `.ts` package cannot run under `node dist/server.cjs`. | Phase 4 |
| Keep `providerProxy` in the package? | Yes, as the `./proxy` subpath with `express` as an optional peer dependency | Phase 3 |
| Keep the stall-recovery path (`runForcedToolTurn`, `sendAndWaitWithAbort`, `STALL_TIMEOUT_MS`)? | Keep for now. The file calls it dormant, but `gateLoop.ts` (around lines 2083 to 2097) still references it and it has heavy tests. Decide after phase 1. | Phase 3 |
| Keep `systemMessageBaseline.ts`? | Move to the package's `test/` support. Only a capture script and one integration test use it, and `SessionWrapper` no longer uses a frozen baseline. | Phase 4 |
| Preserve git history in the new repo? | Optional: `git filter-repo --path packages/agent-core` on a clone. A plain copy loses history. | Phase 6 |

## 5. Phases

Each phase is a set of small commits that leave `tsc`, lint, and `vitest` green. Phases 1 to 3 are self-contained enough to be cherry-picked into `main` as separate PRs later if you choose.

### Phase 0: Branch, baseline, and boundary guard

- Create the branch from `main` in the fork. Record the baseline: `tsc` clean, lint clean, `vitest` pass and skip counts.
- Add `scripts/check-agentcore-boundary.ts`. It fails if any file under `src/agentCore/` (and later `packages/agent-core/`) has a static import, dynamic `import()`, or `require()` that resolves outside its own tree, other than `node_modules`.
- Seed it with the five back-edges above as a `KNOWN_VIOLATIONS` allowlist. The allowlist may only shrink. Wire it into `npm run lint`.
- Sync policy: while the branch is open, merge `main` into it at least weekly, and check `git log main -- src/agentCore test/agentCore` before each phase, since any agentCore change landing on `main` must be carried over.

Exit: guard runs in lint and reports exactly the five known violations.

### Phase 1: Remove dead and misplaced code

Relocations go into `src/orchestration/`. Each move is its own commit with import rewrites.

| Item | Action |
|---|---|
| `simulator.ts` + `simulator.test.tsx` | Delete. No production importer, and the test re-implements the function locally. Re-verify with grep before deleting. |
| `toolHandlers.ts` | Move to orchestration (used only by `gateLoop` and `serverRuntime`). This removes back-edges 1 and part of 4 for free. |
| `prompt.ts` + `test/agentCore/prompt.test.ts` | Move to orchestration. It holds gate-loop prompt vocabulary. |
| `traceRegistry.ts` | Verify no agentCore-internal use, then move to orchestration (it keys on `subtaskId` and `role`). |
| `auditorHelper.ts` policy half | Split. **Stays:** `ToolDefinition`, `ResponseRequirement`, `buildAuditorSessionSettings`, `makeAuditorExecToolHandler`, `executeAuditSession`, tool-usage boilerplate. **Moves** to `orchestration/auditorPolicy.ts`: `getAuditorExecutionConfig`, `selectRotatingAuditorConfig`, `getReviewerExecutionConfig`, `resolveExecutionConfig`, tier and pool selection, `crossArtifactDisagreementInstruction`. The scripts (`review-pr`, `audit-codebase`, `run-issue-task`, `code-change-agent`, `code-change-agent-open`) that use the policy functions re-point to the new location. |

Also check whether the stall-recovery path can be removed (see decision table), and whether the `replace`-mode wording in the auditor boilerplate is stale now that `SessionWrapper` uses `customize` mode.

Exit: `KNOWN_VIOLATIONS` is down to back-edges 2, 3, and 5, plus `express` in `providerProxy`.

### Phase 2: Cut the remaining back-edges

**2a. `workspace/git.ts` and `taskStore` (back-edge 5).**
- Stop the three dynamic imports. `GitSandbox` returns the branch name it created or checked out. The caller (orchestration) persists it, or passes an `onBranchCreated` callback.
- Split `GitSandbox` into a generic core and an app layer. **Core (stays):** init, base-branch detection, diff HEAD, numstat, unstaged diff, commit all, HEAD SHA, checkout, restore checkpoint. **App layer (moves to orchestration):** `ensurePbiBranch`, `checkoutTaskBranch`, `mergeTaskIntoPbi`, `parkTaskBranch`, `resumeTaskBranch`, `getPbiDiffAsync`, and all `pbi/<id>` and `task/<id>` naming.
- `GitSandbox` currently keeps `git()` and `sh()` private. The app layer needs a small public runner (`run(args)`) or a protected subclass hook. The app layer should compose it, not reach into privates.
- Affected tests are in `test/orchestration/` (`branch_management`, `pbi_branch_integration`, `pbi_derivation`). They stay in the app and should pass unchanged apart from import paths.

**2b. Config data (back-edges 2 and 3).**
- **Move into the package:** `PROVIDERS`, `ProviderType`, `isProviderType`, `ModelProviderConfig` from `config/models.ts`, and `RUN_TERMINAL_DOCKER_TOOL` from `config/tools.ts`.
- `ProviderRegistry` takes the known-models list through its constructor instead of importing `DEFAULT_ROLES_CONFIG`, `KNOWN_MODELS_CONFIG`, and `MODEL_TIERS`. The app builds that list from its own config and passes it in. Default behavior must not change.
- **Stays in the app:** role and tier data (`DEFAULT_ROLES_CONFIG`, `KNOWN_MODELS_CONFIG`, `MODEL_TIERS`, tier and pool helpers) and all audit, PBI, and review tool definitions. The app re-exports the moved types from `config/models.ts` during the transition so other consumers (`ui/hooks`, `types/`, scripts) keep compiling.

**2c. `express` in `providerProxy` (back-edge 4).**
- No code change beyond isolating it. The proxy is exposed later as the `./proxy` subpath, with `express` as an optional peer dependency.
- The proxy's session-id state is module-level and only safe for single-session processes (its own TODO says so). Document it in the README; fixing it is out of scope.

Exit: `KNOWN_VIOLATIONS` is empty. The guard is now a hard failure.

### Phase 3: Define the public API and migrate importers

1. Generate an inventory of every symbol the app imports from agentCore, by script (`orchestration` about 25 sites across 11 modules, `types/session.ts`, `ui/mockEvents` and `ui/parser`, seven scripts, `server.entry.ts`, tests). Anything not in the inventory is not exported.
2. Add `src/agentCore/index.ts` and subpath entrypoints. Proposed:
   - `.`: `SessionWrapper`, `runForcedToolTurnUntilTimeout`, `executeAuditSession` and helpers, `ProviderRegistry`, `defineTool`, the moved types.
   - `./workspace`: `initializeWorkspace`, `getExecCommand`, `getGitSandbox`, `getWorkspaceRoot`, `getWorkspaceHostLocation`, `resolveWorkDir`, `TRAVERSAL_ERROR`, `GitSandbox`, `killProcessGroup`.
   - `./proxy`: `providerProxy`.
   - `./types`: type-only re-exports so `ui/` and `types/` never pull Node code into the browser bundle. Use `import type` at those sites.
3. Rewrite every app-side deep import to an entrypoint. Then replace the ESLint workspace-barrel rule with a rule that forbids importing `src/agentCore/**` except through those entrypoints.
4. The `createSession`/`resumeSession` restriction and the "no direct SDK import outside `boundary.ts`" rule move into the package's own lint config. The app gets a new rule forbidding a direct `@github/copilot-sdk` import.

Exit: no app file imports an agentCore internal path.

### Phase 4: Make it a package in-tree

- Create `packages/agent-core/` and `git mv` the source into `packages/agent-core/src/`. Enable npm workspaces in the root `package.json`.
- Add the package's own `package.json` (name, `type: module`, `exports` map matching phase 3, `dependencies`: `@github/copilot-sdk`; `peerDependencies`: `express` marked optional), `tsconfig.json` (copy the strict flags from the root, `include` only the package), `eslint.config.js`, and `vitest.config.ts`.
- **Vitest settings must carry over.** The current config depends on `maxWorkers: 1`, `fileParallelism: false`, `isolate: true`, and an explicit `root`, because tests share Docker and global state.
- **Compiled build** (per the decision above): `build` script emitting `dist/` (ESM plus `.d.ts`). The app's `build` and `dev` scripts must work against it.
- Move tests and test support (see the disposition table). Update the `vi.mock('../src/agentCore/workspace/workspace')` path in `test/vitest.setup.ts`, and paths inside `test/runner.ts` and `test/processGroup.ts`.
- Move docs: `SessionWrapper-spec.md`, `copilot-sdk-record-replay.md`, the agentCore requirements from `system-requirements.md` (SYS-REQ-022 to 028; verify numbering), and the agentCore sections of `AGENTS.md`. Leave a short pointer in the app's docs. Write the package's own `AGENTS.md` (about 100 lines, as a table of contents), README, and env-var contract.
- Parameterize `scripts/check-explicit-any.ts`, which currently hardcodes `src/agentCore/copilotSdk/boundary.ts`. The package gets its own copy.
- Point the boundary guard at `packages/agent-core/` and make its rule "nothing outside the package directory".
- Switch the app to depend on the workspace package. Run everything.

Exit: app and package both green, with the package consumed via its `exports` map.

### Phase 5: Prove it stands alone

- Write `scripts/verify-standalone.sh`: copy `packages/agent-core` to a temp directory outside the repo (no parent `node_modules`), then `npm install`, `tsc`, lint, build, and `vitest run`.
- Docker-dependent tests (`docker_cleanup`, `docker_workspace_location`, `docker_workspace_mount_verification`, `workspace_docker_path_resolution`, `execToolWorkingDir.docker`) need a running container. Gate them behind a separate script or vitest project so the standalone run has a Docker-free tier and a Docker tier.
- Fix whatever the copy surfaces: missing files, implicit root-level config, hidden path assumptions.

Exit: definition-of-done items 1 to 5 all hold.

### Phase 6: Cutover checklist (after copying, outside this branch)

- Create the new repo. Copy `packages/agent-core/` (or run `git filter-repo` on a clone to keep history).
- Give it its own `ci/check.sh` (build, lint, tests, boundary guard), thin CI wrappers, PR template, CODEOWNERS for gate files (`ci/`, lint and tsconfig, workflows, the boundary guard), and a ruleset with a required merge queue.
- Publish (GitHub Packages, or a pinned git dependency to start).
- App side (deliverable B): replace the workspace dependency with the published version, delete `packages/agent-core/` from the app, and land the PR(s) into `main`.
- Scope any fixer-agent token to the new repo only.

## 6. Test disposition

Sorted by which modules each test actually imports, not by filename.

| Group | Tests | Action |
|---|---|---|
| **Move with the package** (agentCore-only imports) | `checkpoint_guard`, `docker_cleanup`, `docker_workspace_location`, `docker_workspace_mount_verification`, `executeAuditSessionStallDisconnect`, `findings`, `integration`, `largeOutputCustomTool`, `model_escalation`, `multi_turn_gate_failure`, `scenario-5-restore-checkpoint`, `sessionWrapper.integration`, `spec_gate_audit`, `spec_patch`, `stream_token_timing`, `toolCallEnforcement`, `toolCallEnforcementUntilTimeout`, `toolExecutionStallFalsePositive`, `workspace_docker_path_resolution`, `workspace/*` | Move. |
| **Rewrite before moving** (import agentCore only, but use policy functions that leave) | `auditSessionResume` (uses `getAuditorExecutionConfig`), `auditor_rotation_sdk_integration` (uses `selectRotatingAuditorConfig`) | Build configs directly with the generic helpers, or split the policy part into an app-side test. |
| **Move to the app** | `auditor_default_toolset` (imports `config/tools`), `auditor_pool_rotation` (imports `config/models`), `prompt.test` (`prompt.ts` moves), `terminal_escalation_bypass` (imports `orchestration/db/taskStore`; confirm) | Move to `test/orchestration/`. |
| **Delete** | `simulator.test.tsx` | Delete with `simulator.ts`. |
| **Stay in the app, update imports** | `test/orchestration/*` (about 9 files), `test/ui/parser.test.ts` | Import from package entrypoints. |

Names like `model_escalation`, `spec_gate_audit`, and `multi_turn_gate_failure` suggest orchestration scenarios, yet they import only agentCore. Phase 1 will show by compile errors whether any of them exercise a module that moved. Re-triage them then.

**Shared test support** (all free of app imports; `ServerHarness` and `CapiProxy` are used by 13 agentCore tests): `test/harness/ServerHarness.ts`, `test/harness/CapiProxy.ts`, `test/utils/eventProcessor.ts`, `test/fixtures/mockStreamPayloads.ts`, `test/vitest.setup.ts`, `test/runner.ts`, `test/processGroup.ts`, `test/scripts/capture-system-message-baseline.ts`. Copy them into the package's `test/`. The app keeps its own copies for now. Longer term the package could export a `./testing` subpath, so the two don't drift.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Changes land in agentCore on `main` while the branch is open | Weekly merge from `main`; check `git log main -- src/agentCore test/agentCore` before each phase |
| Behavior change hidden inside a "move" | No logic edits in relocation commits; injection changes (2b) keep the old defaults; full `vitest run` after each commit |
| Vitest globals, module mocks, and sequential-run assumptions break when tests move | Carry over the exact vitest settings; fix the `vi.mock` path; run the package tests both in-tree and on the copy |
| UI bundle pulls in Node code through agentCore imports | `./types` subpath and `import type` at UI sites; verify with `npm run build` |
| Production build cannot load a TypeScript-source package | Compile to `dist/` (decision above); test `npm run build && npm start` |
| `AI_STUDIO`, `NODE_ENV`, and `VITEST` select the runner inside production code | Documented in the env contract; cleaning it up is a follow-up, not part of this extraction |
| Wide API surface makes every change a two-repo change | Phase 3 inventory keeps the surface to what is actually used; review it before publishing |
| Boundary guard misses a form of import | Guard checks static imports, dynamic `import()`, and `require()`, and `verify-standalone.sh` is the final proof |

## 8. Not verified

- The full contents of `contextManager.ts`, `providerProxy.ts` routes, and `traceRegistry.ts` were read only through exports and doc comments. Confirm they have no hidden app coupling during phase 1.
- Docker-tier test behavior in a fresh environment.
- Whether the stall-recovery path can be removed (needs a `gateLoop.ts` read).
- SYS-REQ numbering for the agentCore requirements.
