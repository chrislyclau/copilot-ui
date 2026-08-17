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
    // called from SessionWrapper (src/copilotSdk/sessionWrapper.ts), which
    // binds and re-derives a session's tool policy on every create/resume.
    // Calling either method anywhere else can silently drop
    // `availableTools`/`onPermissionRequest`/`autoApproveAll` (the exact
    // regressions issue #246 was opened over). boundary.ts is exempt because
    // it *is* the SDK boundary -- its `super.createSession`/`super.resumeSession`
    // calls are the base-class delegation the override wraps, not a bypass.
    // sessionWrapper.ts is exempt for the same reason: it *is* the sanctioned
    // SDK entry point (README.md SYS-REQ-026/027 families), and its own
    // `sendAndWait()` create/resume calls (SYS-REQ-027c/d) are that entry
    // point's implementation, not a bypass of it. hardenedSession.ts (the
    // module SessionWrapper superseded per the "Migration plan (hotswap)"
    // section) is deleted and no longer needs an entry here.
    // Test files are exempt where they intentionally exercise the raw SDK
    // client itself (e.g. proxy/integration tests), not SessionWrapper.
    files: ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts"],
    ignores: [
      "src/copilotSdk/boundary.ts",
      "src/copilotSdk/sessionWrapper.ts",
      // Manual, human-triggered SDK-baseline capture (issue #345 follow-up),
      // not a call site the wrapper needs to police -- see the file's own
      // header comment for why it lives under src/test/ despite not being a
      // `*.test.ts` itself.
      "src/test/scripts/capture-system-message-baseline.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-syntax": ["error", {
        "selector": "CallExpression[callee.property.name='createSession']",
        "message": "❌ Do not call CopilotClient.createSession directly. Use SessionWrapper from src/copilotSdk/sessionWrapper.ts so the session's tool policy is bound and enforced (issue #246, SYS-REQ-026/027). If this call site predates the wrapper and hasn't been migrated yet, add a documented eslint-disable-next-line referencing the issue rather than removing this rule."
      }, {
        "selector": "CallExpression[callee.property.name='resumeSession']",
        "message": "❌ Do not call CopilotClient.resumeSession directly. Use SessionWrapper from src/copilotSdk/sessionWrapper.ts so the full tool policy (availableTools/onPermissionRequest/autoApproveAll) is re-derived on resume instead of risking a partial config (issue #246, SYS-REQ-026/027). If this call site predates the wrapper and hasn't been migrated yet, add a documented eslint-disable-next-line referencing the issue rather than removing this rule."
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
