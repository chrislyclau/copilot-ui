import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      "no-restricted-imports": ["error", {
        "patterns": [
          {
            "group": ["src/workspace/**/*"],
            "message": "❌ Avoid importing internal workspace modules directly. Import from 'src/workspace/index.ts' (the public API barrel) instead.",
            "importNames": ["*"]
          }
        ]
      }]
    }
  },
  {
    // Issue #246: CopilotClient.createSession/resumeSession must only be
    // called from the hardened wrapper (src/copilotSdk/hardenedSession.ts),
    // which binds and re-derives a session's tool policy on every
    // create/resume. Calling either method anywhere else can silently drop
    // `availableTools`/`onPermissionRequest`/`autoApproveAll` (the exact
    // regressions issue #246 was opened over). boundary.ts is exempt because
    // it *is* the SDK boundary -- its `super.createSession`/`super.resumeSession`
    // calls are the base-class delegation the override wraps, not a bypass.
    // Test files are exempt where they intentionally exercise the raw SDK
    // client itself (e.g. proxy/integration tests), not the hardened wrapper.
    files: ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts"],
    ignores: [
      "src/copilotSdk/boundary.ts",
      "src/copilotSdk/hardenedSession.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-syntax": ["error", {
        "selector": "CallExpression[callee.property.name='createSession']",
        "message": "❌ Do not call CopilotClient.createSession directly. Use createHardenedSession() from src/copilotSdk/hardenedSession.ts so the session's tool policy is bound and enforced (issue #246). If this call site predates the wrapper and hasn't been migrated yet (issue #246 item 7), add a documented eslint-disable-next-line referencing the issue rather than removing this rule."
      }, {
        "selector": "CallExpression[callee.property.name='resumeSession']",
        "message": "❌ Do not call CopilotClient.resumeSession directly. Use resumeHardenedSession() from src/copilotSdk/hardenedSession.ts so the full tool policy (availableTools/onPermissionRequest/autoApproveAll) is re-derived on resume instead of risking a partial config (issue #246). If this call site predates the wrapper and hasn't been migrated yet (issue #246 item 7), add a documented eslint-disable-next-line referencing the issue rather than removing this rule."
      }]
    }
  },
  {
    // Issue #320: `*.pure.ts` is a co-located-suffix convention (pure logic
    // lives in `foo.pure.ts` beside `foo.ts`, no new directory structure) for
    // decision functions split out of side-effect-heavy code (see #301).
    // A file can only earn the suffix if it stays free of I/O: no
    // fs/child_process/net/http, no reaching into `src/workspace` (or any
    // module that transitively reaches getExecCommand/getGitSandbox), and no
    // SDK client modules. This is enforced here rather than left to review,
    // because an unenforced naming convention drifts and gets silently
    // violated -- see buildAuditorSessionSettings in the issue, which was
    // exactly the kind of file this would have mislabeled.
    files: ["**/*.pure.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        "paths": [
          { "name": "fs", "message": "❌ *.pure.ts files may not import fs -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "node:fs", "message": "❌ *.pure.ts files may not import fs -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "fs/promises", "message": "❌ *.pure.ts files may not import fs/promises -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "node:fs/promises", "message": "❌ *.pure.ts files may not import fs/promises -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "child_process", "message": "❌ *.pure.ts files may not import child_process -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "node:child_process", "message": "❌ *.pure.ts files may not import child_process -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "net", "message": "❌ *.pure.ts files may not import net -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "node:net", "message": "❌ *.pure.ts files may not import net -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "http", "message": "❌ *.pure.ts files may not import http -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "node:http", "message": "❌ *.pure.ts files may not import http -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "https", "message": "❌ *.pure.ts files may not import https -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "node:https", "message": "❌ *.pure.ts files may not import https -- this is an I/O-bearing module. Move this logic to a non-pure file (issue #320)." },
          { "name": "@github/copilot-sdk", "message": "❌ *.pure.ts files may not import the SDK client module directly. Move this logic to a non-pure file (issue #320)." }
        ],
        "patterns": [
          {
            "group": ["**/workspace", "**/workspace/*", "**/workspace/**"],
            "message": "❌ *.pure.ts files may not import from src/workspace (transitively reaches getExecCommand/getGitSandbox, which are I/O-bearing). Move this logic to a non-pure file (issue #320)."
          },
          {
            "group": ["**/copilotSdk/*", "**/copilotSdk/**"],
            "message": "❌ *.pure.ts files may not import SDK client modules. Move this logic to a non-pure file (issue #320)."
          }
        ]
      }]
    }
  },
  {
    files: [
      "src/orchestrator/**/*.ts",
      "src/orchestrator/**/*.tsx",
      "src/copilotSdk/boundary.ts"
    ],
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      // Native ESLint is set to error for explicit ratcheting.
      // The check-explicit-any script runs as a secondary layer to ensure no eslint-disable escape hatches are used.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error"
    }
  }
];
