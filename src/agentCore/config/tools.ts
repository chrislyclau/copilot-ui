/**
 * The run_terminal_docker tool definition, package-side (extraction plan
 * phase 2b). agentCore session builders (auditorHelper) attach this exec
 * tool to every auditor session, so the definition itself moves into the
 * package; the app's src/config/tools.ts re-exports it during the
 * transition. All other audit/PBI/review tool definitions stay app-side.
 */

export const RUN_TERMINAL_DOCKER_TOOL = {
  type: 'function',
  function: {
    name: 'run_terminal_docker',
    description: 'Executes an arbitrary terminal command or script securely inside an isolated, containerized environment. Use this for all file creations, terminal commands, or testing operations. Each call runs a fresh bash process: working directory and environment variables do NOT persist between calls, so chain multi-step work with && inside one command. Use workingDir for directory context (relative paths resolve against the workspace root; absolute paths must stay inside it). Commands are killed after 60s unless timeoutSeconds (30-600) is given. Very large stdout/stderr is truncated (first+last ~40k chars).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The exact raw bash instruction sequence to stream into the shell stdin.' },
        workingDir: { type: 'string', description: 'The directory to run the command in. Relative paths resolve against the workspace root (default); absolute paths must remain inside the workspace. Does not persist between calls.' },
        timeoutSeconds: { type: 'integer', minimum: 30, maximum: 600, description: 'Max seconds the command may run before it is killed (exit code 124). Default 60. Raise for long builds, installs, or test suites.' }
      },
      required: ['command']
    }
  }
};
