import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

interface DiffConfig {
  remoteRepoUrl: string;
  localPath: string;
  branch: string;
  /** Path to a JSON file of PR review comments, e.g. from:
   *    list_pr_comments.sh <PR_NUMBER> --json > comments.json
   *  Shape: Array<{ path: string; line: number; author: string; body: string }>
   */
  commentsPath?: string;
  prNumber?: string;
  /** Lines of unified diff context. Default 3 (git's default). */
  contextLines?: number;
  /** Max characters of diff to include per file before truncating. Keeps
   *  huge generated/lockfile-style diffs from blowing out LLM context. */
  maxDiffCharsPerFile?: number;
}

interface PRComment {
  path: string;
  line: number | null;
  original_line: number | null;
  side?: string;
  author: string;
  body: string;
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'tar',
  'woff', 'woff2', 'ttf', 'eot', 'mp4', 'mp3', 'wav', 'exe', 'bin', 'lockb',
]);

function loadComments(commentsPath?: string): Map<string, PRComment[]> {
  const byFile = new Map<string, PRComment[]>();
  if (!commentsPath) return byFile;

  if (!fs.existsSync(commentsPath)) {
    console.warn(`⚠️  Comments file not found at ${commentsPath}, skipping annotation.`);
    return byFile;
  }

  try {
    const raw = fs.readFileSync(commentsPath, 'utf-8');
    const comments: PRComment[] = JSON.parse(raw);
    for (const c of comments) {
      const list = byFile.get(c.path) ?? [];
      list.push(c);
      byFile.set(c.path, list);
    }
  } catch (err) {
    console.warn(`⚠️  Failed to parse comments file: ${err instanceof Error ? err.message : err}`);
  }

  return byFile;
}

// Insert "💬 reviewer comment" callouts directly under the diff line they
// refer to, so the LLM sees code and feedback together instead of two
// separate documents it has to cross-reference itself.
function annotateDiffWithComments(diff: string, comments: PRComment[]): string {
  if (comments.length === 0) return diff;

  const leftCommentsByLine = new Map<number, PRComment[]>();
  const rightCommentsByLine = new Map<number, PRComment[]>();

  for (const c of comments) {
    const side = (c.side || 'RIGHT').toUpperCase();
    if (side === 'LEFT') {
      const lineNum = c.original_line ?? c.line;
      if (lineNum !== null && lineNum !== undefined) {
        const list = leftCommentsByLine.get(lineNum) ?? [];
        list.push(c);
        leftCommentsByLine.set(lineNum, list);
      }
    } else {
      const lineNum = c.line ?? c.original_line;
      if (lineNum !== null && lineNum !== undefined) {
        const list = rightCommentsByLine.get(lineNum) ?? [];
        list.push(c);
        rightCommentsByLine.set(lineNum, list);
      }
    }
  }

  const lines = diff.split('\n');
  const out: string[] = [];
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;

  for (const line of lines) {
    out.push(line);

    // Track both old and new line numbers in the diff from hunk headers
    // like "@@ -10,7 +12,8 @@" or "@@ -1,4 +1,4 @@" or "@@ -10 +12 @@"
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1] || "0", 10) - 1;
      currentNewLine = parseInt(hunkMatch[2] || "0", 10) - 1;
      inHunk = true;
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentNewLine += 1;
      const matches = rightCommentsByLine.get(currentNewLine);
      if (matches) {
        for (const m of matches) {
          const displayLine = m.line ?? m.original_line ?? currentNewLine;
          out.push(`💬 [${m.author} on line ${displayLine}]: ${m.body}`);
        }
      }
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentOldLine += 1;
      const matches = leftCommentsByLine.get(currentOldLine);
      if (matches) {
        for (const m of matches) {
          const displayLine = m.original_line ?? m.line ?? currentOldLine;
          out.push(`💬 [${m.author} on line ${displayLine} (original)]: ${m.body}`);
        }
      }
    } else if (!line.startsWith('-') && !line.startsWith('---') && !line.startsWith('\\')) {
      currentOldLine += 1;
      currentNewLine += 1;

      const leftMatches = leftCommentsByLine.get(currentOldLine);
      if (leftMatches) {
        for (const m of leftMatches) {
          const displayLine = m.original_line ?? m.line ?? currentOldLine;
          out.push(`💬 [${m.author} on line ${displayLine} (original)]: ${m.body}`);
        }
      }

      const rightMatches = rightCommentsByLine.get(currentNewLine);
      if (rightMatches) {
        for (const m of rightMatches) {
          const displayLine = m.line ?? m.original_line ?? currentNewLine;
          out.push(`💬 [${m.author} on line ${displayLine}]: ${m.body}`);
        }
      }
    }
  }

  return out.join('\n');
}

function isBinaryFile(file: string): boolean {
  const ext = getFileExtension(file).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function truncate(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;
  const kept = text.slice(0, maxChars);
  return `${kept}\n\n*(... truncated, ${label} exceeded ${maxChars} chars — full diff omitted to save context ...)*\n`;
}

function optimizeDiffForLLM(
  localPath: string,
  repoPath: string,
  commentsByFile: Map<string, PRComment[]>,
  contextLines: number,
  maxDiffCharsPerFile: number,
): string {
  const localFiles = getAllFiles(localPath).map(f => path.relative(localPath, f));
  const remoteFiles = getAllFiles(repoPath).map(f => path.relative(repoPath, f));
  const allFiles = Array.from(new Set([...localFiles, ...remoteFiles])).sort();

  let added = 0;
  let deleted = 0;
  let modified = 0;
  let skippedBinary = 0;

  const sections: string[] = [];

  for (const file of allFiles) {
    if (
      file.startsWith('.git' + path.sep) || file === '.git' ||
      file.startsWith('node_modules' + path.sep) || file === 'node_modules' ||
      file.startsWith('dist' + path.sep) || file === 'dist'
    ) {
      continue;
    }

    if (isBinaryFile(file)) {
      skippedBinary++;
      continue;
    }

    const localFilePath = path.join(localPath, file);
    const remoteFilePath = path.join(repoPath, file);

    const existsLocally = fs.existsSync(localFilePath);
    const existsRemotely = fs.existsSync(remoteFilePath);

    if (existsLocally && !existsRemotely) {
      added++;
      let section = `## 🟢 File Added: \`${file}\`\n\n`;
      try {
        const content = fs.readFileSync(localFilePath, 'utf-8');
        const capped = truncate(content, maxDiffCharsPerFile, `\`${file}\` contents`);
        section += `\`\`\`${getFileExtension(file)}\n${capped}\n\`\`\`\n\n`;
      } catch (err) {
        section += `*(Could not read file contents: ${err instanceof Error ? err.message : err})*\n\n`;
      }
      sections.push(section);
    } else if (!existsLocally && existsRemotely) {
      deleted++;
      sections.push(`## 🔴 File Deleted: \`${file}\`\n\n`);
    } else if (existsLocally && existsRemotely) {
      try {
        const diff = execSync(
          `git diff --no-index -U${contextLines} "${remoteFilePath}" "${localFilePath}"`,
          { encoding: 'utf-8' },
        );
        if (diff) {
          modified++;
          const fileComments = commentsByFile.get(file) ?? [];
          const annotated = annotateDiffWithComments(diff, fileComments);
          const capped = truncate(annotated, maxDiffCharsPerFile, `\`${file}\` diff`);
          sections.push(`## 🟡 File Modified: \`${file}\`\n\n\`\`\`diff\n${capped}\`\`\`\n\n`);
        }
      } catch (error: any) {
        // git diff --no-index exits 1 when differences are found — that's
        // expected, not a real failure. Anything else (missing binary,
        // permission error, etc.) should surface as an actual error rather
        // than being silently treated as "diff found."
        if (error.status === 1 && typeof error.stdout === 'string') {
          modified++;
          const fileComments = commentsByFile.get(file) ?? [];
          const annotated = annotateDiffWithComments(error.stdout, fileComments);
          const capped = truncate(annotated, maxDiffCharsPerFile, `\`${file}\` diff`);
          sections.push(`## 🟡 File Modified: \`${file}\`\n\n\`\`\`diff\n${capped}\`\`\`\n\n`);
        } else {
          sections.push(
            `## ⚠️ Error diffing \`${file}\`\n\n*(${error.message ?? error})*\n\n`,
          );
        }
      }
    }
  }

  let header = `# Git Diff Report for LLM Context\n`;
  header += `Generated on: ${new Date().toISOString()}\n`;
  header += `Comparing Local Path: \`${localPath}\` against Remote Main\n\n`;
  header += `## Summary\n\n`;
  header += `- 🟢 Added: ${added}\n`;
  header += `- 🔴 Deleted: ${deleted}\n`;
  header += `- 🟡 Modified: ${modified}\n`;
  if (skippedBinary > 0) header += `- ⏭️ Skipped (binary): ${skippedBinary}\n`;
  header += `\n---\n\n`;

  return header + sections.join('');
}

// Helper to recursively get all files in a directory
function getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return [];

  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    if (file === '.git' || file === 'node_modules' || file === 'dist') return;

    const filePath = path.join(dirPath, file);
    if (fs.statSync(filePath).isDirectory()) {
      arrayOfFiles = getAllFiles(filePath, arrayOfFiles);
    } else {
      arrayOfFiles.push(filePath);
    }
  });

  return arrayOfFiles;
}

function getFileExtension(filename: string): string {
  return filename.split('.').pop() || '';
}

export function runRemoteDiff(config: DiffConfig): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-diff-'));
  const clonePath = path.join(tmpDir, 'remote_repo');

  console.log(`⏳ Cloning remote repository into temporary directory...`);
  console.log(`Repository: ${config.remoteRepoUrl} (Branch: ${config.branch})`);

  try {
    execSync(`git clone --depth 1 --branch ${config.branch} ${config.remoteRepoUrl} "${clonePath}"`, {
      stdio: 'ignore',
    });

    console.log(`📊 Comparing directories and optimizing output for LLM consumption...`);
    let commentsByFile = new Map<string, PRComment[]>();
    let prTextInfo = '';

    if (config.prNumber) {
      console.log(`💬 Fetching PR comments for PR #${config.prNumber}...`);
      try {
        const repoMatch = config.remoteRepoUrl.match(/github\.com\/([^\/]+\/[^\/\.]+)/);
        let repo = 'chrislyclau/copilot-ui';
        if (repoMatch) {
          repo = (repoMatch[1] || '').replace('.git', '');
        }
        const env = { ...process.env, REPO: repo };

        const jsonOutput = execFileSync('bash', ['scripts/list_pr_comments.sh', config.prNumber, '--json'], { encoding: 'utf-8', env });
        const comments: PRComment[] = JSON.parse(jsonOutput);
        for (const c of comments) {
          const list = commentsByFile.get(c.path) ?? [];
          list.push(c);
          commentsByFile.set(c.path, list);
        }
        prTextInfo = execFileSync('bash', ['scripts/list_pr_comments.sh', config.prNumber], { encoding: 'utf-8', env });
      } catch (err: any) {
        console.warn(`⚠️  Failed to fetch PR comments: ${err.message}`);
      }
    } else {
      commentsByFile = loadComments(config.commentsPath);
      if (config.commentsPath) {
        console.log(`💬 Loaded PR comments from ${config.commentsPath} (${commentsByFile.size} file(s) annotated)`);
      }
    }

    let llmReadyDiff = optimizeDiffForLLM(
      path.resolve(config.localPath),
      clonePath,
      commentsByFile,
      config.contextLines ?? 3,
      config.maxDiffCharsPerFile ?? 20000,
    );

    if (prTextInfo) {
      llmReadyDiff = `# PR Comments & Reviews\n\n${prTextInfo}\n\n---\n\n` + llmReadyDiff;
    }

    const outputPath = path.join(tmpDir, 'llm_ready_diff.md');
    fs.writeFileSync(outputPath, llmReadyDiff, 'utf-8');

    console.log(`\n✅ Diff processing complete!`);
    console.log(`📂 Output streamed to: ${outputPath}`);

    return outputPath;
  } catch (error) {
    console.error('❌ Error executing remote diff:', error);
    throw error;
  } finally {
    if (fs.existsSync(clonePath)) {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  }
}

// Example / Direct CLI execution:
// Usage: tsx remote-diff.ts [comments.json | PR_NUMBER]
const arg = process.argv[2];
let commentsPath: string | undefined;
let prNumber: string | undefined;

if (arg) {
  if (arg.endsWith('.json')) {
    commentsPath = arg;
  } else {
    prNumber = arg;
  }
}

const DEFAULT_CONFIG: DiffConfig = {
  remoteRepoUrl: 'https://github.com/chrislauyc/copilot-ui-llm.git',
  localPath: '.',
  branch: 'main',
  commentsPath,
  prNumber,
};

const isDirectRun = () => {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const executionPath = process.argv[1];
    if (!executionPath) return false;
    return fs.realpathSync(executionPath) === fs.realpathSync(currentFilePath);
  } catch {
    return false;
  }
};

if (isDirectRun()) {
  console.log('🚀 Running remote diff script directly...');
  try {
    runRemoteDiff(DEFAULT_CONFIG);
  } catch (error) {
    process.exit(1);
  }
}
