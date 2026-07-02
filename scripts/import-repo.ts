import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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

const tempCloneDir = path.join(process.cwd(), 'temp_clone');

try {
  // 1. Clean up any stale temp clone directories
  if (fs.existsSync(tempCloneDir)) {
    console.log(`Cleaning up old temp directory: ${tempCloneDir}...`);
    fs.rmSync(tempCloneDir, { recursive: true, force: true });
  }

  // 2. Clone the repository
  console.log(`Cloning repository into temporary directory...`);
  // Use HTTPS cloning, which works seamlessly in container environments
  execSync(`git clone ${repoUrl} "${tempCloneDir}"`, { stdio: 'inherit' });
  
  console.log('Clone successful! Distributing files to workspace root...');

  // 3. Copy files recursively
  copyRecursiveSync(tempCloneDir, process.cwd());

  // 4. Clean up temp clone directory
  console.log('Cleaning up temporary files...');
  fs.rmSync(tempCloneDir, { recursive: true, force: true });
  
  console.log('--- Import completed successfully! ---');
} catch (err: any) {
  console.error('--- Import failed ---');
  console.error(err.message || err);
  
  // Try to clean up on failure
  if (fs.existsSync(tempCloneDir)) {
    try {
      fs.rmSync(tempCloneDir, { recursive: true, force: true });
    } catch (_) {}
  }
  process.exit(1);
}
