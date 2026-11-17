import fs from 'node:fs';
import path from 'node:path';
import type { DiffHunk, FileDiff } from './types.js';

export const UNIVERSAL_REVIEW_PRINCIPLES = `
=== 12-STEP UNIVERSAL CODE REVIEW PRINCIPLES ===

1. LAYER BOUNDARIES & SEPARATION OF CONCERNS:
   - Enforce clean separation: Controller / Handler -> Service / Domain -> Repository / Data Access.
   - Avoid business logic leakage into HTTP handlers, UI layers, or DB migrations.
   - Guard against circular dependencies and leaky abstraction layers.

2. LOGIC, NULLABILITY & BOUNDARY DEFENSES:
   - Verify handling of undefined, null, empty arrays, NaN, zero, and boundary inputs.
   - Check for off-by-one errors, reversed conditionals, and unhandled enum/switch branches.
   - Ensure proper input validation and sanitization at all external boundaries.

3. ASYNC FLOWS, CONCURRENCY & RACE CONDITIONS:
   - Identify missing 'await', unhandled Promise rejections, floating promises.
   - Audit race conditions, shared mutable state, lack of atomic operations or mutexes.
   - Ensure timeouts and cancellation tokens (e.g., AbortSignal) are honored.

4. SECURITY & PERMISSION ENFORCEMENT:
   - Prevent Injection (SQL, NoSQL, OS Command, Code, LDAP, XSS, Template injection).
   - Prevent Broken Object Level Authorization (BOLA/IDOR) and missing permission checks.
   - Guard against mass-assignment, prototype pollution, SSRF, and open redirects.
   - Ensure NO hardcoded secrets, tokens, private keys, or passwords.

5. DATABASE, QUERIES & STORAGE INTEGRITY:
   - Identify N+1 query patterns in loops or nested relationships.
   - Check for missing indexes on frequently queried or filtered fields.
   - Verify connection pool management, transaction boundaries, and rollback on failure.
   - Audit migration safety: lock timeouts, non-blocking index creation, column drops.

6. API CONTRACTS & BACKWARD COMPATIBILITY:
   - Guard against breaking changes in public REST/GraphQL/gRPC APIs, endpoints, or SDK interfaces.
   - Validate HTTP status codes, standard JSON error envelopes, and semantic versioning.
   - Ensure schema additions are backward-compatible (optional fields, defaults).

7. ERROR HANDLING & SYSTEM RESILIENCE:
   - Prohibit swallowing exceptions or empty catch blocks.
   - Ensure errors retain stack traces, context, and diagnostic details.
   - Verify exponential backoff, jitter on retries, and circuit-breaker patterns for external calls.

8. RESOURCE MANAGEMENT & LEAK PREVENTION:
   - Guarantee file handles, database connections, and HTTP sockets are closed in finally blocks.
   - Check for lingering event listeners, unstopped timers/intervals, or unbounded caches.
   - Ensure memory is freed and streams are piped with backpressure management.

9. PERFORMANCE & COMPUTATIONAL COMPLEXITY:
   - Flag unnecessary O(N^2) or higher algorithmic loops where O(N) or O(N log N) is standard.
   - Avoid repeated expensive computations inside loops (regex compilation, JSON parsing, disk I/O).
   - Encourage sensible caching with explicit TTL and size eviction policies.

10. TESTING INTEGRITY & VERIFICATION:
    - Ensure every new feature, bug fix, or edge case is covered by automated unit/integration tests.
    - Check for brittle tests, flawed assertions (e.g., asserting true === true), or over-mocking.
    - Validate that test failures are deterministic and independent of execution order.

11. CONFIGURATION, OBSERVABILITY & TELEMETRY:
    - Avoid hardcoding configuration values, magic numbers, or environment-specific URLs.
    - Ensure structured logging (JSON) with request/correlation IDs across asynchronous calls.
    - Strictly prohibit logging PII, passwords, authentication headers, or credentials.

12. CODE HEALTH, TYPING & IDIOMATIC DESIGN:
    - Enforce strict typing (avoid 'any', 'unknown' without validation, unchecked type assertions).
    - Maintain high readability, self-documenting naming, and low cyclomatic complexity.
    - Remove dead code, commented-out code, and obsolete TODOs.
`;

export interface ReviewContext {
  targetPath: string;
  detectedLanguages: string[];
  fileDiffs: FileDiff[];
  fileContents: Record<string, string>;
  principles: string;
  summaryOfChanges: {
    filesCount: number;
    totalAdditions: number;
    totalDeletions: number;
  };
}

/**
 * Detects programming languages from changed file extensions
 */
function detectLanguages(fileDiffs: FileDiff[]): string[] {
  const extMap: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript (React)',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript (React)',
    '.mjs': 'JavaScript (ESM)',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.cs': 'C#',
    '.cpp': 'C++',
    '.c': 'C',
    '.rb': 'Ruby',
    '.php': 'PHP',
    '.swift': 'Swift',
    '.sql': 'SQL',
    '.sh': 'Shell',
    '.yml': 'YAML / Workflow',
    '.yaml': 'YAML / Workflow',
    '.json': 'JSON',
    '.md': 'Markdown',
  };

  const detected = new Set<string>();
  for (const diff of fileDiffs) {
    const ext = path.extname(diff.newPath || diff.oldPath || '').toLowerCase();
    if (extMap[ext]) {
      detected.add(extMap[ext]);
    }
  }

  return detected.size > 0 ? Array.from(detected) : ['General Code / Polyglot'];
}

/**
 * Extracts line windows around diff hunks with gap markers for large files.
 * Line ranges [hunkStart - contextLines, hunkEnd + contextLines] are included,
 * overlapping or adjacent ranges are merged, and gaps marked with /* ... lines X-Y omitted ... *\/
 */
export function extractHunkWindows(
  lines: string[],
  hunks: DiffHunk[],
  contextLines = 40,
): string {
  if (lines.length === 0) {
    return '/* [Empty file] */';
  }

  if (!hunks || hunks.length === 0) {
    return `/* ... lines 1-${lines.length} omitted (no diff hunks found) ... */`;
  }

  const rawRanges: { start: number; end: number }[] = [];

  for (const hunk of hunks) {
    const hunkStart = hunk.newStart;
    const hunkEnd = hunk.newStart + Math.max(0, hunk.newLines - 1);
    const start = Math.max(1, hunkStart - contextLines);
    const end = Math.min(lines.length, hunkEnd + contextLines);
    if (start <= end) {
      rawRanges.push({ start, end });
    }
  }

  if (rawRanges.length === 0) {
    return `/* ... lines 1-${lines.length} omitted (no diff hunks found) ... */`;
  }

  // Sort ranges by start line ascending
  rawRanges.sort((a, b) => a.start - b.start);

  // Merge overlapping and adjacent ranges
  const mergedRanges: { start: number; end: number }[] = [];
  for (const r of rawRanges) {
    if (mergedRanges.length === 0) {
      mergedRanges.push({ ...r });
    } else {
      const prev = mergedRanges[mergedRanges.length - 1];
      if (r.start <= prev.end + 1) {
        prev.end = Math.max(prev.end, r.end);
      } else {
        mergedRanges.push({ ...r });
      }
    }
  }

  const output: string[] = [];
  let currentLine = 1;

  for (const r of mergedRanges) {
    if (r.start > currentLine) {
      output.push(`/* ... lines ${currentLine}-${r.start - 1} omitted ... */`);
    }

    for (let i = r.start; i <= r.end; i++) {
      output.push(`${i}: ${lines[i - 1]}`);
    }

    currentLine = r.end + 1;
  }

  if (currentLine <= lines.length) {
    output.push(`/* ... lines ${currentLine}-${lines.length} omitted ... */`);
  }

  return output.join('\n');
}

/**
 * Reads full contents of modified files in the target project with safety limits.
 * For large files (> 60,000 chars or > 500KB), embeds hunk windows [hunkStart - 40, hunkEnd + 40]
 * with merged overlapping ranges and omission markers instead of head-truncation or skipping.
 */
export function loadTargetFileContents(
  targetPath: string,
  fileDiffs: FileDiff[],
  maxCharsPerFile = 60000,
): Record<string, string> {
  const contents: Record<string, string> = {};

  for (const diff of fileDiffs) {
    if (diff.status === 'deleted') continue;

    const relPath = diff.newPath;
    const fullPath = path.resolve(targetPath, relPath);

    if (fs.existsSync(fullPath)) {
      try {
        const stats = fs.statSync(fullPath);
        const isOverSizeThreshold = stats.size > 500 * 1024;

        const raw = fs.readFileSync(fullPath, 'utf-8');
        const lines = raw.split('\n');

        if (isOverSizeThreshold || raw.length > maxCharsPerFile) {
          // Large file: embed hunk-window context instead of head-truncation or bare omitted placeholder
          contents[relPath] = extractHunkWindows(lines, diff.hunks, 40);
        } else {
          // Normal file: embed full file with line numbering
          contents[relPath] = lines.map((l, idx) => `${idx + 1}: ${l}`).join('\n');
        }
      } catch (err) {
        contents[relPath] = `/* [Error reading file: ${err instanceof Error ? err.message : String(err)}] */`;
      }
    }
  }

  return contents;
}

/**
 * Builds the complete multi-source review context
 */
export function buildReviewContext(
  targetPath: string,
  fileDiffs: FileDiff[],
): ReviewContext {
  const languages = detectLanguages(fileDiffs);
  const fileContents = loadTargetFileContents(targetPath, fileDiffs);

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const diff of fileDiffs) {
    totalAdditions += diff.additions;
    totalDeletions += diff.deletions;
  }

  return {
    targetPath,
    detectedLanguages: languages,
    fileDiffs,
    fileContents,
    principles: UNIVERSAL_REVIEW_PRINCIPLES,
    summaryOfChanges: {
      filesCount: fileDiffs.length,
      totalAdditions,
      totalDeletions,
    },
  };
}

