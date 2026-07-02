import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Recursively copies files and folders from src to dest.
 * Excludes control files like .git and node_modules.
 */
function copyRecursiveSync(src: string, dest: string) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats && stats.isDirectory();

  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      // Exclude specific environment or control files during import
      if (childItemName === '.git' || childItemName === 'node_modules') {
        return;
      }
      copyRecursiveSync(
        path.join(src, childItemName),
        path.join(dest, childItemName)
      );
    });
  } else {
    fs.copyFileSync(src, dest);
    console.log(`Copied: ${src} -> ${dest}`);
  }
}

// Hardcoded repository URL
const repoUrl = 'https://github.com/chrislyclau/copilot-ui.git';

console.log(`--- Starting Git Import Script ---`);
console.log(`Target Repository: ${repoUrl}`);

const workspaceDir = process.cwd();
const backupDir = path.join(os.tmpdir(), 'workspace_backup');
const tempCloneDir = path.join(os.tmpdir(), 'temp_clone');

try {
  // 1. Clean up any stale temp or backup directories
  if (fs.existsSync(backupDir)) {
    console.log(`Cleaning up old backup directory: ${backupDir}...`);
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  if (fs.existsSync(tempCloneDir)) {
    console.log(`Cleaning up old temp directory: ${tempCloneDir}...`);
    fs.rmSync(tempCloneDir, { recursive: true, force: true });
  }

  // Create backup directory
  fs.mkdirSync(backupDir, { recursive: true });

  // 2. Move current workspace contents to the backup directory, skipping node_modules and .git
  console.log(`Moving current workspace contents into temporary backup directory: ${backupDir}...`);
  const items = fs.readdirSync(workspaceDir);
  for (const item of items) {
    if (item === '.git' || item === 'node_modules') {
      console.log(`Skipping: ${item}`);
      continue;
    }
    const srcPath = path.join(workspaceDir, item);
    const destPath = path.join(backupDir, item);

    try {
      fs.renameSync(srcPath, destPath);
      console.log(`Moved: ${item} -> backup`);
    } catch (err: any) {
      if (err.code === 'EXDEV') {
        // Fallback for cross-device move
        copyRecursiveSync(srcPath, destPath);
        fs.rmSync(srcPath, { recursive: true, force: true });
        console.log(`Copied and removed (cross-device): ${item} -> backup`);
      } else {
        throw err;
      }
    }
  }

  // 3. Clone the repository into temporary clone directory
  console.log(`Cloning repository into temporary directory: ${tempCloneDir}...`);
  // Use HTTPS cloning, which works seamlessly in container environments
  execSync(`git clone ${repoUrl} "${tempCloneDir}"`, { stdio: 'inherit' });
  
  console.log('Clone successful! Distributing files to workspace root...');

  // 4. Copy files recursively from temporary clone to workspace
  copyRecursiveSync(tempCloneDir, workspaceDir);

  // 5. Clean up temp clone directory
  console.log('Cleaning up temporary files...');
  fs.rmSync(tempCloneDir, { recursive: true, force: true });
  
  console.log('--- Import completed successfully! ---');
  console.log(`Backup of the old workspace is kept at: ${backupDir}`);
} catch (err: any) {
  console.error('--- Import failed ---');
  console.error(err.message || err);
  
  // Try to clean up temp clone on failure
  if (fs.existsSync(tempCloneDir)) {
    try {
      fs.rmSync(tempCloneDir, { recursive: true, force: true });
    } catch (_) {}
  }
  process.exit(1);
}
