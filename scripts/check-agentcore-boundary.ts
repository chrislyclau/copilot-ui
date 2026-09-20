/**
 * agentCore boundary guard — phase 0 of docs/agent-core-extraction-plan.md.
 *
 * Fails if any file under a target root (src/agentCore today;
 * packages/agent-core from phase 4) imports anything that resolves outside
 * its own tree, with two exceptions:
 *   - Node builtins and the bare packages in ALLOWED_BARE_SPECS (the
 *     package's fixed third-party surface, plan §3);
 *   - entries in KNOWN_VIOLATIONS, the seeded allowlist of the five
 *     back-edges the extraction plan starts from.
 *
 * Checked import forms: static `import ... from`, `export ... from`,
 * dynamic `import()`, `require()`, type-position `import("...").T`, and
 * `vi.mock`/`jest.mock` string paths. Dynamic forms are the reason this
 * guard exists: back-edge 5 (three dynamic taskStore imports in
 * workspace/git.ts) is invisible to a static import scan and to
 * `no-restricted-imports`.
 *
 * KNOWN_VIOLATIONS is a ratchet: it may only shrink. An entry whose
 * violation no longer occurs is stale and fails the guard, so removed
 * back-edges force entry deletion instead of letting the list rot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import ts from 'typescript';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// Phase 0 guards the in-tree src/agentCore. Phase 4 git-mv's the source into
// packages/agent-core — update TARGET_ROOTS in that same commit; the guard
// fails loudly rather than silently no-oping if a root is missing.
const TARGET_ROOTS: readonly string[] = ['src/agentCore'];

// Third-party packages agentCore may import directly (plan §3: the package's
// third-party surface is @github/copilot-sdk, plus vitest for the in-tree
// test file). Node builtins are always allowed. `express` is deliberately
// absent: it is back-edge 4 and stays in KNOWN_VIOLATIONS until phase 2
// isolates it behind the ./proxy subpath.
const ALLOWED_BARE_SPECS: ReadonlySet<string> = new Set([
    '@github/copilot-sdk',
    'vitest',
]);

interface KnownViolation {
    /** Repo-root-relative POSIX path of the file containing the import. */
    file: string;
    /** Module specifier exactly as written in the source. */
    spec: string;
    /** Back-edge number from the extraction plan §3, for traceability. */
    backEdge: number;
}

// Back-edges still present after phase 1 (plan §3; back-edges 1 and the
// toolHandlers half of 4 were removed by moving toolHandlers.ts into
// src/orchestration). Keyed by (file, spec) so entries survive line shifts;
// one entry covers every occurrence of that pair (the three dynamic
// taskStore imports in git.ts are one entry). Back-edge 2 now spans only
// providerRegistry.ts (auditorHelper's policy half moved to
// src/orchestration/auditorPolicy.ts in phase 1), so the remaining
// back-edges expand to four entries.
const KNOWN_VIOLATIONS: readonly KnownViolation[] = [
    // Back-edge 2: config/models data (ModelProviderConfig, MODEL_TIERS, ...).
    { file: 'src/agentCore/providerRegistry.ts', spec: '../config/models', backEdge: 2 },
    // Back-edge 3: config/tools (RUN_TERMINAL_DOCKER_TOOL).
    { file: 'src/agentCore/auditorHelper.ts', spec: '../config/tools', backEdge: 3 },
    // Back-edge 4: express types (type-only; becomes an optional peer dep).
    { file: 'src/agentCore/providerProxy.ts', spec: 'express', backEdge: 4 },
];

type ViolationKind =
    | 'static-import'
    | 'export-from'
    | 'dynamic-import'
    | 'dynamic-import-non-literal'
    | 'require'
    | 'require-non-literal'
    | 'type-import'
    | 'module-mock';

interface FoundImport {
    /** Repo-root-relative POSIX path of the file containing the import. */
    file: string;
    line: number;
    spec: string;
    kind: ViolationKind;
}

function toRepoRel(absPath: string): string {
    return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function isInside(target: string, rootAbs: string): boolean {
    const rel = path.relative(rootAbs, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * True if `spec`, imported from `absFile`, stays inside `rootAbs` (or is a
 * permitted bare specifier). Non-literal dynamic specifiers are handled by
 * the caller — they can never be proven to stay inside.
 */
function resolvesInsideTree(spec: string, absFile: string, rootAbs: string): boolean {
    if (spec.startsWith('./') || spec.startsWith('../')) {
        return isInside(path.resolve(path.dirname(absFile), spec), rootAbs);
    }
    if (spec.startsWith('@/')) {
        // tsconfig paths: "@/*": ["./*"] — alias to the repo root.
        return isInside(path.resolve(REPO_ROOT, spec.slice('@/'.length)), rootAbs);
    }
    // Bare specifier: Node builtin or an allowlisted third-party package.
    if (isBuiltin(spec)) {
        return true;
    }
    return ALLOWED_BARE_SPECS.has(spec);
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function specifierText(node: ts.Expression | undefined): string | undefined {
    return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined;
}

function collectImportsFromFile(absFile: string): FoundImport[] {
    const content = fs.readFileSync(absFile, 'utf8');
    const sourceFile = ts.createSourceFile(absFile, content, ts.ScriptTarget.Latest, true);
    const repoRel = toRepoRel(absFile);
    const found: FoundImport[] = [];

    function record(node: ts.Node, spec: string, kind: ViolationKind): void {
        found.push({ file: repoRel, line: getLine(sourceFile, node), spec, kind });
    }

    function visit(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) {
            const spec = specifierText(node.moduleSpecifier);
            if (spec !== undefined) {
                record(node, spec, 'static-import');
            }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            const spec = specifierText(node.moduleSpecifier);
            if (spec !== undefined) {
                record(node, spec, 'export-from');
            }
        } else if (ts.isImportTypeNode(node)) {
            // Type-position import("...").T — e.g. `import("express").Response`.
            const arg = node.argument;
            const literal = ts.isLiteralTypeNode(arg) ? arg.literal : arg;
            const spec = ts.isStringLiteral(literal) ? literal.text : undefined;
            if (spec !== undefined) {
                record(node, spec, 'type-import');
            }
        } else if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const spec = specifierText(node.arguments[0]);
                if (spec !== undefined) {
                    record(node, spec, 'dynamic-import');
                } else {
                    // Cannot be proven to stay inside the tree.
                    record(node, '<non-literal>', 'dynamic-import-non-literal');
                }
            } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
                const spec = specifierText(node.arguments[0]);
                if (spec !== undefined) {
                    record(node, spec, 'require');
                } else {
                    record(node, '<non-literal>', 'require-non-literal');
                }
            } else if (
                ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                (node.expression.expression.text === 'vi' || node.expression.expression.text === 'jest') &&
                (node.expression.name.text === 'mock' || node.expression.name.text === 'doMock')
            ) {
                const spec = specifierText(node.arguments[0]);
                if (spec !== undefined) {
                    record(node, spec, 'module-mock');
                }
            }
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return found;
}

function walkTsFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...walkTsFiles(filePath));
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            results.push(filePath);
        }
    }
    return results;
}

function main(): void {
    console.log('=== agentCore boundary guard (docs/agent-core-extraction-plan.md, phase 0) ===');

    const missingRoots = TARGET_ROOTS.filter((root) => !fs.existsSync(path.join(REPO_ROOT, root)));
    if (missingRoots.length > 0) {
        console.error('\n❌ ERROR: Expected target root(s) do not exist:\n');
        for (const root of missingRoots) {
            console.error(`  ${root}`);
        }
        console.error(
            '\nThis usually means the source tree has been reorganized (e.g. the phase 4 git mv ' +
            'into packages/agent-core) and TARGET_ROOTS is stale. Update ' +
            'scripts/check-agentcore-boundary.ts rather than letting this check silently no-op.\n'
        );
        process.exit(1);
    }

    const files: string[] = [];
    for (const root of TARGET_ROOTS) {
        const rootAbs = path.join(REPO_ROOT, root);
        const rootFiles = walkTsFiles(rootAbs);
        if (rootFiles.length === 0) {
            console.error(`\n❌ ERROR: Target root "${root}" exists but contains no .ts/.tsx files. Refusing to silently pass.\n`);
            process.exit(1);
        }
        files.push(...rootFiles);
    }
    console.log(`Scanning ${TARGET_ROOTS.length} root(s), ${files.length} file(s): ${TARGET_ROOTS.join(', ')}`);

    const found: FoundImport[] = [];
    for (const absFile of files) {
        found.push(...collectImportsFromFile(absFile));
    }

    // Classify each found import against the root the file lives under.
    const boundaryViolations = found.filter((imp) => {
        const rootForFile = TARGET_ROOTS.find((root) => imp.file.startsWith(root + '/'));
        if (rootForFile === undefined) {
            // File directly at a root path itself — treat its own directory as the tree.
            const rootDir = path.dirname(path.join(REPO_ROOT, imp.file));
            return !resolvesInsideTree(imp.spec, path.join(REPO_ROOT, imp.file), rootDir);
        }
        return !resolvesInsideTree(imp.spec, path.join(REPO_ROOT, imp.file), path.join(REPO_ROOT, rootForFile));
    });

    const allowlistKeys = new Map<string, KnownViolation>();
    for (const known of KNOWN_VIOLATIONS) {
        allowlistKeys.set(`${known.file}::${known.spec}`, known);
    }

    const matchedKeys = new Set<string>();
    const fresh: FoundImport[] = [];
    for (const imp of boundaryViolations) {
        const key = `${imp.file}::${imp.spec}`;
        if (allowlistKeys.has(key)) {
            matchedKeys.add(key);
        } else {
            fresh.push(imp);
        }
    }
    const stale = [...allowlistKeys.keys()].filter((key) => !matchedKeys.has(key));

    if (matchedKeys.size > 0) {
        console.log(`\nAllowlisted back-edge imports (KNOWN_VIOLATIONS — may only shrink): ${matchedKeys.size}/${KNOWN_VIOLATIONS.length} entries still active`);
        for (const imp of boundaryViolations) {
            const known = allowlistKeys.get(`${imp.file}::${imp.spec}`);
            if (known) {
                console.log(`  [back-edge ${known.backEdge}] ${imp.file}:${imp.line}  "${imp.spec}"  (${imp.kind})`);
            }
        }
    }

    let failed = false;
    if (fresh.length > 0) {
        failed = true;
        console.error('\n❌ NEW boundary violation(s) — agentCore importing from outside its own tree, not in KNOWN_VIOLATIONS:');
        for (const imp of fresh) {
            console.error(`  ${imp.file}:${imp.line}  "${imp.spec}"  (${imp.kind})`);
        }
        console.error('\nagentCore must not import from the app (docs/agent-core-extraction-plan.md §3). ' +
            'Fix the import; do not add a KNOWN_VIOLATIONS entry without plan sign-off.\n');
    }
    if (stale.length > 0) {
        failed = true;
        const noun = stale.length === 1 ? 'entry' : 'entries';
        console.error(`\n❌ Stale KNOWN_VIOLATIONS ${noun} — the violation no longer occurs; delete the ${noun} (the allowlist may only shrink):`);
        for (const key of stale) {
            const known = allowlistKeys.get(key);
            if (known) {
                console.error(`  [back-edge ${known.backEdge}] ${known.file}  "${known.spec}"`);
            }
        }
        console.error('');
    }

    if (failed) {
        process.exit(1);
    }

    console.log(`\n✅ Boundary clean: ${boundaryViolations.length} import(s) outside the tree, all covered by KNOWN_VIOLATIONS (${KNOWN_VIOLATIONS.length} entries, ${matchedKeys.size} active).`);
    process.exit(0);
}

main();
