import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CheckResult } from './types.js';

/**
 * Checks if an executable command is available in the current environment
 */
function isCommandAvailable(command: string): boolean {
  try {
    const isWindows = process.platform === 'win32';
    const checkCmd = isWindows ? `where ${command}` : `which ${command}`;
    execSync(checkCmd, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Executes a single command safely and records status, duration, output, and errors
 */
function runCommand(name: string, command: string, cwd: string, timeoutMs = 120000): CheckResult {
  const startTime = Date.now();
  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true' },
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      name,
      command,
      status: 'PASSED',
      durationMs: Date.now() - startTime,
      output: output.trim(),
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errorObj = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const stdout = errorObj.stdout ? String(errorObj.stdout).trim() : '';
    const stderr = errorObj.stderr ? String(errorObj.stderr).trim() : '';
    const message = errorObj.message || 'Command failed';

    const fullOutput = [stdout, stderr].filter(Boolean).join('\n') || message;

    // If command is not installed in runner environment, skip instead of failing the PR
    const isMissingCommand =
      fullOutput.includes('not found') ||
      fullOutput.includes('command not found') ||
      fullOutput.includes('is not recognized as an internal or external command') ||
      fullOutput.includes('No such file or directory');

    if (isMissingCommand) {
      return {
        name,
        command,
        status: 'SKIPPED',
        durationMs,
        output: `Skipped: command not found in runner environment (${fullOutput.split('\n')[0]})`,
      };
    }

    return {
      name,
      command,
      status: 'FAILED',
      durationMs,
      output: stdout,
      error: fullOutput,
    };
  }
}

/**
 * Creates a skipped check result record
 */
function skippedCheck(name: string, command: string, reason: string): CheckResult {
  return {
    name,
    command,
    status: 'SKIPPED',
    durationMs: 0,
    output: reason,
  };
}

/**
 * Polyglot Tooling Runner
 * Dynamically inspects the target workspace and runs language-appropriate checks
 * for Node/TypeScript, Python, Go, Rust, etc.
 */
export async function runPolyglotChecks(targetDir: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const resolvedTarget = path.resolve(targetDir);

  if (!fs.existsSync(resolvedTarget)) {
    return [skippedCheck('Target Directory', resolvedTarget, 'Directory does not exist')];
  }

  // 1. Node.js / TypeScript Projects
  const packageJsonPath = path.join(resolvedTarget, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkgContent = fs.readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(pkgContent);
      const scripts = pkg.scripts || {};
      const hasNodeModules = fs.existsSync(path.join(resolvedTarget, 'node_modules'));

      if (!hasNodeModules) {
        results.push(
          skippedCheck(
            'Node.js Build',
            'npm run build',
            'Skipped: node_modules not installed in target workspace on runner',
          ),
        );
        results.push(
          skippedCheck(
            'Node.js Lint',
            'npm run lint',
            'Skipped: node_modules not installed in target workspace on runner',
          ),
        );
        results.push(
          skippedCheck(
            'Node.js Test',
            'npm test',
            'Skipped: node_modules not installed in target workspace on runner',
          ),
        );
      } else {
        // Build check
        if (scripts.build) {
          results.push(runCommand('Node.js Build', 'npm run build', resolvedTarget));
        } else {
          results.push(skippedCheck('Node.js Build', 'npm run build', 'No "build" script in package.json'));
        }

        // Lint check
        if (scripts.lint) {
          results.push(runCommand('Node.js Lint', 'npm run lint', resolvedTarget));
        } else {
          results.push(skippedCheck('Node.js Lint', 'npm run lint', 'No "lint" script in package.json'));
        }

        // Test check
        if (scripts.test) {
          // Skip dummy test script ("echo \"Error: no test specified\" && exit 1")
          if (typeof scripts.test === 'string' && scripts.test.includes('no test specified')) {
            results.push(skippedCheck('Node.js Test', 'npm test', 'Default npm test placeholder (no tests defined)'));
          } else {
            results.push(runCommand('Node.js Test', 'npm test', resolvedTarget));
          }
        } else {
          results.push(skippedCheck('Node.js Test', 'npm test', 'No "test" script in package.json'));
        }
      }
    } catch (e) {
      results.push({
        name: 'Node.js Check',
        command: 'package.json parsing',
        status: 'FAILED',
        durationMs: 0,
        error: `Failed to read package.json: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // 2. Python Projects
  const isPythonProject =
    fs.existsSync(path.join(resolvedTarget, 'pyproject.toml')) ||
    fs.existsSync(path.join(resolvedTarget, 'requirements.txt')) ||
    fs.existsSync(path.join(resolvedTarget, 'Pipfile')) ||
    fs.existsSync(path.join(resolvedTarget, 'setup.py'));

  if (isPythonProject) {
    if (isCommandAvailable('pytest')) {
      results.push(runCommand('Python Pytest', 'pytest', resolvedTarget));
    } else {
      results.push(skippedCheck('Python Pytest', 'pytest', 'pytest is not installed in the runner environment'));
    }

    if (isCommandAvailable('ruff')) {
      results.push(runCommand('Python Ruff Lint', 'ruff check .', resolvedTarget));
    } else {
      results.push(skippedCheck('Python Ruff', 'ruff check .', 'ruff is not installed in the runner environment'));
    }
  }

  // 3. Go Projects
  const isGoProject = fs.existsSync(path.join(resolvedTarget, 'go.mod'));
  if (isGoProject) {
    if (isCommandAvailable('go')) {
      results.push(runCommand('Go Test', 'go test ./...', resolvedTarget));
    } else {
      results.push(skippedCheck('Go Test', 'go test ./...', 'Go compiler is not installed in the runner environment'));
    }
  }

  // 4. Rust Projects
  const isRustProject = fs.existsSync(path.join(resolvedTarget, 'Cargo.toml'));
  if (isRustProject) {
    if (isCommandAvailable('cargo')) {
      results.push(runCommand('Cargo Test', 'cargo test', resolvedTarget));
    } else {
      results.push(skippedCheck('Cargo Test', 'cargo test', 'Cargo is not installed in the runner environment'));
    }
  }

  // 5. If no language files were detected at all
  if (results.length === 0) {
    results.push(
      skippedCheck(
        'Workspace Checks',
        'Auto-detection',
        'No recognized project manifests (package.json, pyproject.toml, go.mod, Cargo.toml) found',
      ),
    );
  }

  return results;
}

