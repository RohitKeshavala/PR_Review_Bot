import { execSync } from 'node:child_process';
import type { DiffHunk, FileDiff } from './types.js';

/**
 * Normalizes file paths for cross-platform consistency (forward slashes, no leading ./)
 */
export function normalizePath(p: string): string {
  if (!p) return '';
  return p
    .replace(/^[ab]\//, '') // Remove Git diff a/ and b/ prefixes
    .replace(/^(\.\/|\.\\)/, '') // Remove ./ or .\
    .replace(/\\/g, '/'); // Convert backslashes to forward slashes
}

/**
 * Checks if a given directory is inside a Git repository work tree
 */
export function isGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Executes git diff locally between base and head or on current changes
 */
export function getDiff(base?: string, head?: string, targetDir?: string): string {
  const cwd = targetDir || process.cwd();

  if (!isGitRepo(cwd)) {
    console.warn(`⚠️ Warning: Directory "${cwd}" is not a Git repository. Proceeding with empty diff.`);
    return '';
  }

  try {
    let gitCommand: string;
    if (base && head) {
      gitCommand = `git diff ${base}...${head}`;
    } else if (base) {
      gitCommand = `git diff ${base}`;
    } else {
      // Try uncommitted / staged changes, or compare to HEAD~1
      try {
        const workingDiff = execSync('git diff HEAD', { cwd, encoding: 'utf-8', maxBuffer: 25 * 1024 * 1024 });
        if (workingDiff.trim().length > 0) {
          return workingDiff;
        }
      } catch {
        // Fall back to git diff without HEAD
      }
      gitCommand = 'git diff';
    }

    const output = execSync(gitCommand, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 25 * 1024 * 1024,
    });

    if (!output || output.trim().length === 0) {
      // If git diff is empty, try git diff HEAD~1 if in a git repo
      try {
        const fallbackDiff = execSync('git diff HEAD~1', { cwd, encoding: 'utf-8', maxBuffer: 25 * 1024 * 1024 });
        if (fallbackDiff.trim().length > 0) {
          return fallbackDiff;
        }
      } catch {
        // No commits or HEAD~1 not available
      }
    }

    return output;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('not a git repository')) {
      console.warn(`⚠️ Warning: Directory "${cwd}" is not a Git repository. Proceeding with empty diff.`);
      return '';
    }
    if (errorMsg.includes('ambiguous argument') || errorMsg.includes('unknown revision')) {
      console.warn(`⚠️ Warning: Revision "${base || ''}" not found in git history. Falling back to working tree diff.`);
      try {
        return execSync('git diff', { cwd, encoding: 'utf-8', maxBuffer: 25 * 1024 * 1024 });
      } catch {
        return '';
      }
    }
    throw new Error(`Failed to execute git diff in "${cwd}": ${errorMsg}`);
  }
}

/**
 * Parses unified diff text into structured FileDiff objects with hunks and line numbers
 */
export function parseDiff(rawDiff: string): FileDiff[] {
  if (!rawDiff || rawDiff.trim().length === 0) {
    return [];
  }

  const fileDiffs: FileDiff[] = [];
  const lines = rawDiff.split('\n');

  let currentFile: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let currentOldLine = 0;
  let currentNewLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect file boundary: diff --git a/path b/path
    if (line.startsWith('diff --git ')) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
        currentHunk = null;
      }
      if (currentFile) {
        fileDiffs.push(currentFile);
      }

      const match = line.match(/^diff --git a\/(.+?)\s+b\/(.+)$/);
      const oldPath = match ? normalizePath(match[1]) : '';
      const newPath = match ? normalizePath(match[2]) : '';

      currentFile = {
        oldPath: oldPath || undefined,
        newPath: newPath || oldPath,
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!currentFile) {
      continue;
    }

    // Detect status flags
    if (line.startsWith('new file mode ')) {
      currentFile.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      currentFile.status = 'deleted';
      continue;
    }
    if (line.startsWith('similarity index ') || line.startsWith('rename from ')) {
      currentFile.status = 'renamed';
      continue;
    }

    // Detect file header paths
    if (line.startsWith('--- ')) {
      const raw = line.substring(4).trim();
      if (raw === '/dev/null') {
        currentFile.status = 'added';
        currentFile.oldPath = undefined;
      } else {
        currentFile.oldPath = normalizePath(raw);
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const raw = line.substring(4).trim();
      if (raw === '/dev/null') {
        currentFile.status = 'deleted';
      } else {
        currentFile.newPath = normalizePath(raw);
      }
      continue;
    }

    // Detect hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    if (line.startsWith('@@ ')) {
      if (currentHunk && currentFile) {
        currentFile.hunks.push(currentHunk);
      }

      const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/);
      if (hunkMatch) {
        const oldStart = Number.parseInt(hunkMatch[1], 10);
        const oldLines = hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1;
        const newStart = Number.parseInt(hunkMatch[3], 10);
        const newLines = hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1;

        currentOldLine = oldStart;
        currentNewLine = newStart;

        currentHunk = {
          header: line,
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
        };
      }
      continue;
    }

    // Process hunk content lines
    if (currentHunk) {
      if (line.startsWith('+')) {
        currentFile.additions++;
        currentHunk.lines.push({
          type: 'add',
          newLineNumber: currentNewLine,
          content: line.substring(1),
        });
        currentNewLine++;
      } else if (line.startsWith('-')) {
        currentFile.deletions++;
        currentHunk.lines.push({
          type: 'del',
          oldLineNumber: currentOldLine,
          content: line.substring(1),
        });
        currentOldLine++;
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'context',
          oldLineNumber: currentOldLine,
          newLineNumber: currentNewLine,
          content: line.substring(1),
        });
        currentOldLine++;
        currentNewLine++;
      }
      // Lines starting with \ (like \ No newline at end of file) are ignored
    }
  }

  // Push lingering hunk and file
  if (currentHunk && currentFile) {
    currentFile.hunks.push(currentHunk);
  }
  if (currentFile) {
    fileDiffs.push(currentFile);
  }

  return fileDiffs;
}

/**
 * Crucial safety check: Validates that a reported line number actually exists
 * inside an added or modified diff hunk for the given file.
 * This eliminates GitHub 422 Unprocessable Entity errors when posting inline comments.
 */
export function isLineInDiffHunk(
  filePath: string,
  lineNumber: number,
  fileDiffs: FileDiff[],
): boolean {
  if (!filePath || !lineNumber || lineNumber <= 0) {
    return false;
  }

  const normalizedTarget = normalizePath(filePath).toLowerCase();

  const matchingDiff = fileDiffs.find((diff) => {
    const diffNew = normalizePath(diff.newPath).toLowerCase();
    const diffOld = diff.oldPath ? normalizePath(diff.oldPath).toLowerCase() : '';
    return (
      diffNew === normalizedTarget ||
      diffOld === normalizedTarget ||
      diffNew.endsWith(normalizedTarget) ||
      normalizedTarget.endsWith(diffNew)
    );
  });

  if (!matchingDiff) {
    return false;
  }

  // Check if the lineNumber exists in any hunk for the file
  for (const hunk of matchingDiff.hunks) {
    for (const line of hunk.lines) {
      // In GitHub PR reviews, inline comments on the new file (RIGHT side)
      // must correspond to a line in the diff hunk.
      if (line.newLineNumber === lineNumber) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns line content from diff for a given file and line number
 */
export function getDiffLineContent(
  filePath: string,
  lineNumber: number,
  fileDiffs: FileDiff[],
): string | undefined {
  const normalizedTarget = normalizePath(filePath).toLowerCase();
  const matchingDiff = fileDiffs.find((diff) => {
    const diffNew = normalizePath(diff.newPath).toLowerCase();
    return diffNew === normalizedTarget || diffNew.endsWith(normalizedTarget);
  });

  if (!matchingDiff) return undefined;

  for (const hunk of matchingDiff.hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber === lineNumber) {
        return line.content;
      }
    }
  }

  return undefined;
}
