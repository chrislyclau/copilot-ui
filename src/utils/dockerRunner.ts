import { exec, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getIsolatedName } from './workspace';

export function sanitizeDockerCommand(command: string): string {
  if (command.includes('rm ') && (
    command.includes('-rf') || 
    command.includes('-r') || 
    command.includes('-R') || 
    command.includes('--recursive') || 
    command.includes('--dir')
  )) {
    throw new Error("Command blocked: destructive delete command detected");
  }
  return command;
}

export async function runDockerProcess(
  command: string,
  workingDir: string = '/workspace',
  signal?: AbortSignal,
  sessionId?: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  sanitizeDockerCommand(command);

  let hasDocker = false;
  try {
    execSync('which docker', { stdio: 'ignore' });
    hasDocker = true;
  } catch (e) {}

  if (!hasDocker || process.env.VITEST === 'true') {
    let runDir = workingDir;
    if (workingDir === '/workspace') {
      runDir = process.cwd();
    } else if (workingDir.startsWith('/workspace/')) {
      runDir = path.join(process.cwd(), workingDir.substring(11));
    }

    if (!fs.existsSync(runDir)) {
      runDir = process.cwd();
    }

    return new Promise((resolve) => {
      const child = exec(command, {
        cwd: runDir,
        env: {
          ...process.env,
          PATH: '/usr/local/bin:/usr/bin:/bin'
        }
      }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: error ? (error.code || 1) : 0
        });
      });

      if (signal) {
        const onAbort = () => {
          try {
            child.kill('SIGKILL');
          } catch (e) {}
          resolve({
            stdout: "",
            stderr: "Docker process aborted",
            exitCode: 1
          });
        };
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  const containerName = getIsolatedName('copilot-runner', sessionId);
  const dockerCmd = `docker exec -w ${workingDir} ${containerName} bash -c "${command.replace(/"/g, '\\"')}"`;

  return new Promise((resolve) => {
    const child = exec(dockerCmd, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: error ? (error.code || 1) : 0
      });
    });

    if (signal) {
      const onAbort = () => {
        try {
          child.kill('SIGKILL');
        } catch (e) {}
        resolve({
          stdout: "",
          stderr: "Docker process aborted",
          exitCode: 1
        });
      };
      signal.addEventListener('abort', onAbort);
    }
  });
}
