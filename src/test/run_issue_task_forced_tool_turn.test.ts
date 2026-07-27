import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('scripts/run-issue-task.ts', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../scripts/run-issue-task.ts'),
    'utf-8'
  );

  it('drives the agent turn through runForcedToolTurnUntilTimeout, not a bare sendAndWait', () => {
    expect(source).toContain('runForcedToolTurnUntilTimeout');
    expect(source).not.toMatch(/session\.sendAndWait/);
  });

  it('imports runForcedToolTurnUntilTimeout from the shared enforcement util', () => {
    expect(source).toMatch(
      /import\s*\{\s*runForcedToolTurnUntilTimeout\s*\}\s*from\s*['"]\.\.\/src\/utils\/toolCallEnforcement['"]/
    );
  });

  it('forces the same RUN_GH_COMMAND_TOOL_NAME tool that was previously only advertised, not enforced', () => {
    expect(source).toMatch(/runForcedToolTurnUntilTimeout\(\s*session,\s*executionConfig,\s*RUN_GH_COMMAND_TOOL_NAME/);
  });
});
