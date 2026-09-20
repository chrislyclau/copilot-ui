import { getAuditorExecutionConfig } from '../auditorPolicy';
import { executeAuditSession } from '../../agentCore/auditorHelper';
import { submitPbiDerivationTool } from '../../config/tools';
import { getExecCommand, getWorkspaceRoot } from '../../agentCore/workspace';
import { getSpec } from '../db/taskStore';
import path from 'path';

/**
 * A single PBI as proposed by the derivation operation. `batchId` is a
 * batch-local identifier used only to express `dependsOn` edges within the
 * same derivation call -- it is not a persisted database `pbiId`. Real
 * `pbiId`s are assigned when a batch (or diff against an existing batch) is
 * accepted and persisted (see Issue 4).
 */
export interface DerivedPbi {
  readonly batchId: string;
  readonly title: string;
  readonly description: string;
  readonly status: 'pending' | 'in_progress' | 'blocked' | 'done';
  readonly dependsOn: readonly string[];
}

interface PbiDerivationToolResult {
  pbis: DerivedPbi[];
}

export interface PbiDerivationResult {
  readonly specId: string;
  readonly pbis: DerivedPbi[];
}

const SUBMIT_PBI_DERIVATION_EXAMPLE = `{
  "pbis": [
    { "batchId": "pbi-1", "title": "Set up auth scaffolding", "description": "Add the auth module skeleton, config, and empty middleware.", "status": "pending", "dependsOn": [] },
    { "batchId": "pbi-2", "title": "Wire login flow", "description": "Implement the login endpoint and session issuance on top of the scaffolding.", "status": "pending", "dependsOn": ["pbi-1"] }
  ]
}`;

const SYSTEM_PROMPT = `You are a PBI (Product Backlog Item) derivation agent. Given a specification document and the current repository state, break the spec down into a set of PBIs -- coherent, independently workable units of work larger than a single task but smaller than the whole spec.

**Boundary rules:**
- PBI boundaries are derived from the spec's actual functional seams, not from its document structure -- a single markdown section or requirement may span multiple PBIs, and a single PBI may draw from multiple sections.
- Prefer PBIs that can be worked and verified independently once their dependencies are done.
- Do not over-fragment: a PBI that would only ever contain a single trivial task is usually too small.

**Dependency rules:**
- Only express a \`dependsOn\` edge when one PBI's work genuinely cannot begin (or cannot be verified) until another completes.
- \`dependsOn\` values must reference \`batchId\`s from this same batch only.
- Do not create dependency cycles.

You must not answer conversationally and must strictly invoke 'submit_pbi_derivation'.

**How to call the tool:**
Call 'submit_pbi_derivation' using your tool-calling capability (a real function/tool call), not as text in your message. Example of correctly-shaped arguments:

${SUBMIT_PBI_DERIVATION_EXAMPLE}`;

function buildUserPrompt(specContent: string): string {
  return `Derive the set of PBIs for the following specification.

SPEC:
${specContent}`;
}

/**
 * Human-initiated PBI-derivation operation (RM-REQ-070). Analyzes the spec
 * identified by `specId` together with the current repository state and
 * produces a proposed set of PBIs via a forced tool call, following the same
 * discipline as the Spec-Gate Auditor and PR Reviewer.
 *
 * This does NOT persist anything -- the returned set is a proposal. Diffing
 * against any already-persisted PBIs for this spec, and persistence on
 * acceptance, are handled by a later operation (Issue 4 / RM-REQ-072/073).
 */
export async function runPbiDerivation(
  cwd: string,
  specId: string,
  abortSignal?: AbortSignal
): Promise<PbiDerivationResult> {
  const specRecord = getSpec(specId);
  if (!specRecord) {
    throw new Error(`No spec found for specId "${specId}".`);
  }

  const absoluteSpecPath = path.isAbsolute(specRecord.filePath)
    ? specRecord.filePath
    : path.join(getWorkspaceRoot(), specRecord.filePath);

  const execResult = await getExecCommand()(`cat '${absoluteSpecPath}'`, abortSignal);
  if (execResult.exitCode !== 0) {
    throw new Error(`Failed to read spec file for specId "${specId}" at ${specRecord.filePath}: ${execResult.stderr}`);
  }
  const specContent = execResult.stdout;

  const executionConfig = getAuditorExecutionConfig();
  const userPrompt = buildUserPrompt(specContent);

  const result = await executeAuditSession<PbiDerivationToolResult>(
    cwd,
    executionConfig,
    SYSTEM_PROMPT,
    submitPbiDerivationTool,
    userPrompt,
    { toolCallExample: SUBMIT_PBI_DERIVATION_EXAMPLE },
    abortSignal
  );

  if (!result || !Array.isArray(result.pbis)) {
    throw new Error('PBI derivation failed: model did not return a proper submit_pbi_derivation tool call.');
  }

  return { specId, pbis: result.pbis };
}
