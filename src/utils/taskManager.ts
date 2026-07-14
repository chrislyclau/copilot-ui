import * as fs from 'fs';
import * as path from 'path';
import { getGitSandbox, getWorkspaceRoot } from '../workspace';
import { saveSpec, saveTask, getTasksForSpec, SpecRecord, TaskRecord } from '../db/taskStore';
import { savePbi, getPbi, PbiRecord } from '../db/pbiStore';
import { db } from '../db';
import crypto from 'crypto';

export async function decomposeSpecIntoTasks(cwd: string): Promise<{ spec: SpecRecord; tasks: TaskRecord[] } | null> {
  // 1. Locate spec file
  const resolvedCwd = path.isAbsolute(cwd) ? cwd : path.resolve(getWorkspaceRoot(), cwd);
  const specPath = path.join(resolvedCwd, 'architecture-spec.md');
  if (!fs.existsSync(specPath)) {
    return null;
  }
  const specContent = fs.readFileSync(specPath, 'utf8');

  // 2. Get Git SHA
  let gitSha = 'v1';
  try {
    const sandbox = getGitSandbox();
    gitSha = await sandbox.getHeadShaAsync();
  } catch (err) {
    // Fallback: generate a MD5 hash of specContent or similar if not in git
    gitSha = crypto.createHash('md5').update(specContent).digest('hex').substring(0, 8);
  }

  // 3. Define specId based on the relative path to avoid absolute path discrepancies
  const relativePath = path.relative(getWorkspaceRoot(), specPath);
  let specId = 'spec-' + crypto.createHash('sha256').update(relativePath).digest('hex').substring(0, 12);

  // Check if we already have a record for this exact filePath
  const existingSpecByPath = db.prepare('SELECT * FROM specs WHERE filePath = ?').get(relativePath) as SpecRecord | undefined;
  if (existingSpecByPath) {
    specId = existingSpecByPath.specId;
  } else {
    // Look for a moved/renamed spec
    const allSpecs = db.prepare('SELECT * FROM specs').all() as SpecRecord[];
    const missingSpecs = allSpecs.filter(s => !fs.existsSync(path.resolve(getWorkspaceRoot(), s.filePath)));
    
    let migratedSpecId = null;
    if (missingSpecs.length > 0) {
      const basenameMatch = missingSpecs.find(s => {
        if (path.basename(s.filePath) !== path.basename(relativePath)) {
          return false;
        }
        // Require identical parent folder name to avoid mismatches
        if (path.basename(path.dirname(s.filePath)) !== path.basename(path.dirname(relativePath))) {
          return false;
        }
        return true;
      });

      if (basenameMatch) {
        migratedSpecId = basenameMatch.specId;
      }
    }

    if (migratedSpecId) {
      db.prepare('UPDATE specs SET filePath = ?, version = ?, createdAt = ? WHERE specId = ?')
        .run(relativePath, gitSha, Date.now(), migratedSpecId);
      specId = migratedSpecId;
    }
  }

  // 4. Save Spec
  const spec: SpecRecord = {
    specId,
    filePath: relativePath,
    version: gitSha,
    createdAt: Date.now(),
  };
  saveSpec(spec);

  // Create and save catch-all PBI per spec
  const pbiId = specId + '-pbi-default';
  const existingPbi = getPbi(pbiId);
  const catchAllPbi: PbiRecord = {
    pbiId,
    specId,
    title: 'Default PBI',
    description: 'Catch-all Product Backlog Item for the specification.',
    status: existingPbi ? existingPbi.status : 'pending',
    dependsOn: null,
    createdAt: existingPbi ? existingPbi.createdAt : Date.now(),
    updatedAt: existingPbi ? existingPbi.updatedAt : Date.now(),
  };
  savePbi(catchAllPbi);

  // 5. Parse Tasks from specContent
  const lines = specContent.split('\n');
  const parsedSteps: { title: string; description: string }[] = [];
  
  let currentTitle = '';
  let currentDesc: string[] = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Check for headers like: ## Step 1: ... or ### Task 1 - ...
    const headingMatch =
      line.match(/^#+\s*(?:Step|Task)?\s*(\d+)\s*[:.-]\s*(.+)$/i) ||
      line.match(/^#+\s*(?:Step|Task)\s+(\d+)\s*(.*)$/i) ||
      line.match(/^#+\s*(\d+)\s*[:.-]\s*(.+)$/i);
      
    // Check for list items like: - Step 1: ... or - [ ] Task 1 - ...
    const listMatch =
      line.match(/^\s*[-*+]\s*(?:\[[ xX]?\])?\s*(?:Step|Task)?\s*(\d+)\s*[:.-]\s*(.+)$/i) ||
      line.match(/^\s*[-*+]\s*(?:\[[ xX]?\])?\s*(?:Step|Task)\s+(\d+)\s*(.*)$/i) ||
      line.match(/^\s*[-*+]\s*(?:\[[ xX]?\])?\s*(\d+)\s*[:.-]\s*(.+)$/i);

    if (headingMatch) {
      if (currentTitle) {
        parsedSteps.push({ title: currentTitle, description: currentDesc.join('\n').trim() });
        currentDesc = [];
      }
      const match1 = headingMatch[1] || '';
      const match2 = headingMatch[2] || '';
      currentTitle = match2.trim() || `Step ${match1}`;
    } else if (listMatch) {
      if (currentTitle) {
        parsedSteps.push({ title: currentTitle, description: currentDesc.join('\n').trim() });
        currentDesc = [];
      }
      const match1 = listMatch[1] || '';
      const match2 = listMatch[2] || '';
      currentTitle = match2.trim() || `Step ${match1}`;
    } else {
      if (currentTitle) {
        currentDesc.push(line);
      }
    }
  }

  if (currentTitle) {
    parsedSteps.push({ title: currentTitle, description: currentDesc.join('\n').trim() });
  }

  // Fallback: If no structured steps found, try to split by markdown list items or smaller headers
  if (parsedSteps.length === 0) {
    let stepIndex = 1;
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (line.startsWith('## ') || line.startsWith('### ')) {
        const title = line.replace(/^#+\s*/, '').trim();
        parsedSteps.push({ title, description: '' });
      } else if (line.match(/^[-*+]\s+(?:\[[ xX]?\]\s+)?/)) {
        const title = line.replace(/^[-*+]\s*(?:\[[ xX]?\]\s*)?/, '').trim();
        if (title.length > 5 && !title.toLowerCase().startsWith('conforms') && !title.toLowerCase().startsWith('must')) {
          parsedSteps.push({ title, description: '' });
        }
      }
    }
  }

  // If still empty, create a single fallback task
  if (parsedSteps.length === 0) {
    parsedSteps.push({
      title: 'Implement Specification',
      description: 'Implement the goals defined in the architecture specification file.',
    });
  }

  // 6. Save or update Tasks
  const tasks: TaskRecord[] = [];
  const existingTasks = getTasksForSpec(specId);
  const existingMap = new Map(existingTasks.map(t => [t.taskId, t]));

  for (let i = 0; i < parsedSteps.length; i++) {
    const step = parsedSteps[i];
    if (!step) continue;

    const taskId = `${specId}-step-${i + 1}`;
    
    // Check if the task already exists
    const existing = existingMap.get(taskId);
    
    const dependsOn = i > 0 ? JSON.stringify([`${specId}-step-${i}`]) : null;
    const task: TaskRecord = {
      taskId,
      specId,
      specVersion: gitSha,
      title: step.title,
      description: step.description || null,
      status: existing ? existing.status : 'pending',
      touches: existing ? existing.touches : null,
      dependsOn,
      branchName: existing ? existing.branchName : null,
      blockedReason: existing ? existing.blockedReason : null,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now(),
      pbiId,
    };
    saveTask(task);
    tasks.push(task);
  }

  return { spec, tasks };
}
