import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

interface DiffConfig {
  remoteRepoUrl: string;
  localPath: string;
  branch: string;
}

function optimizeDiffForLLM(localPath: string, repoPath: string): string {
  let markdownOutput = `# Git Diff Report for LLM Context\n`;
  markdownOutput += `Generated on: ${new Date().toISOString()}\n`;
  markdownOutput += `Comparing Local Path: \`${localPath}\` against Remote Main\n\n`;
  markdownOutput += `---\n\n`;

  // Get all unique relative file paths from both directories
  const localFiles = getAllFiles(localPath).map(f => path.relative(localPath, f));
  const remoteFiles = getAllFiles(repoPath).map(f => path.relative(repoPath, f));
  const allFiles = Array.from(new Set([...localFiles, ...remoteFiles])).sort();

  for (const file of allFiles) {
    const localFilePath = path.join(localPath, file);
    const remoteFilePath = path.join(repoPath, file);

    const existsLocally = fs.existsSync(localFilePath);
    const existsRemotely = fs.existsSync(remoteFilePath);

    // Skip control directories like .git or node_modules or build/temporary directories if encountered
    if (file.startsWith('.git' + path.sep) || file === '.git' ||
        file.startsWith('node_modules' + path.sep) || file === 'node_modules' ||
        file.startsWith('dist' + path.sep) || file === 'dist') {
      continue;
    }

    if (existsLocally && !existsRemotely) {
      // File was added locally
      markdownOutput += `## 🟢 File Added: \`${file}\`\n\n`;
      try {
        const content = fs.readFileSync(localFilePath, 'utf-8');
        markdownOutput += `\`\`\`${getFileExtension(file)}\n${content}\n\`\`\`\n\n`;
      } catch (err) {
        markdownOutput += `*(Could not read file contents: ${err instanceof Error ? err.message : err})*\n\n`;
      }
    } else if (!existsLocally && existsRemotely) {
      // File was deleted locally
      markdownOutput += `## 🔴 File Deleted: \`${file}\`\n\n`;
    } else if (existsLocally && existsRemotely) {
      // File exists in both, check for changes
      try {
        // Use git diff between the two files directly
        const diff = execSync(`git diff --no-index "${remoteFilePath}" "${localFilePath}"`, { encoding: 'utf-8' });
        
        if (diff) {
          markdownOutput += `## 🟡 File Modified: \`${file}\`\n\n`;
          markdownOutput += `\`\`\`diff\n${diff}\`\`\`\n\n`;
        }
      } catch (error: any) {
        // git diff --no-index returns exit code 1 if differences are found. 
        // We catch it here because execSync treats non-zero exits as fatal errors.
        if (error.stdout) {
          markdownOutput += `## 🟡 File Modified: \`${file}\`\n\n`;
          markdownOutput += `\`\`\`diff\n${error.stdout}\`\`\`\n\n`;
        }
      }
    }
  }

  return markdownOutput;
}

// Helper to recursively get all files in a directory
function getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return [];
  
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    // Skip .git, node_modules, and dist directories
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

export function runRemoteDiff(config: DiffConfig) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-diff-'));
  const clonePath = path.join(tmpDir, 'remote_repo');
  
  console.log(`⏳ Cloning remote repository into temporary directory...`);
  console.log(`Repository: ${config.remoteRepoUrl} (Branch: ${config.branch})`);
  
  try {
    // Clone only the specific branch, shallow clone (--depth 1) to optimize speed and space
    execSync(`git clone --depth 1 --branch ${config.branch} ${config.remoteRepoUrl} "${clonePath}"`, {
      stdio: 'ignore'
    });

    console.log(`📊 Comparing directories and optimizing output for LLM consumption...`);
    const llmReadyDiff = optimizeDiffForLLM(path.resolve(config.localPath), clonePath);

    const outputPath = path.join(tmpDir, 'llm_ready_diff.md');
    fs.writeFileSync(outputPath, llmReadyDiff, 'utf-8');

    console.log(`\n✅ Diff processing complete!`);
    console.log(`📂 Output streamed to: ${outputPath}`);
    
    return outputPath;

  } catch (error) {
    console.error('❌ Error executing remote diff:', error);
    throw error;
  } finally {
    // Cleanup cloned repository to free up space in /tmp
    if (fs.existsSync(clonePath)) {
      fs.rmSync(clonePath, { recursive: true, force: true });
    }
  }
}

// Example / Direct CLI execution:
const DEFAULT_CONFIG: DiffConfig = {
  remoteRepoUrl: 'https://github.com/chrislyclau/copilot-ui.git', // Target repo from import-repo.ts
  localPath: '.',                                                // Current workspace root
  branch: 'main'                                                 // Default branch name
};

// Check if run directly under tsx or Node
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
