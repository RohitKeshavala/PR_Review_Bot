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
   - SCHEMA & INPUT BOUNDARY VALIDATION: In request validation schemas, DTOs, and model definitions across any language/framework (Zod, Pydantic, Joi, class-validator, Marshmallow, etc.):
     * Enforce string trimming before length checks to prevent whitespace-only bypass on required fields.
     * Enforce explicit upper-bound limits (max length/size) on all string, text, and collection inputs to prevent buffer bloat, database column truncation, and payload DoS.
     * Enforce non-empty lower bounds on required fields.
     * Guard against mass-assignment: strictly exclude client-controlled identity/role fields (e.g., authorId, userId, role, isAdmin) from request schemas.
     * Flag missing schema boundary limits or unconstrained input schemas as a MEDIUM severity defect.
   - Ensure proper input validation and sanitization at all external boundaries.

3. ASYNC FLOWS, REACTIVITY & STATE MANAGEMENT:
   - Identify missing 'await', unhandled Promise rejections, floating promises.
   - Audit race conditions, shared mutable state, lack of atomic operations or mutexes.
   - STATE & REACTIVITY INTEGRITY: In reactive systems (Angular Signals, React state, Vue ref/reactive, Redux/Zustand), strictly audit state mutations. Enforce immutability. Flag in-place mutations of objects or arrays (e.g., 'signal().push(...)', 'state.list.push(...)') before calling '.set()' or dispatching, because referential equality ('Object.is') prevents change detection, computed signal updates, or component re-renders from firing.
   - ASYNC LOADING & UI STATE LIFECYCLES: Verify that loading, busy, or pending flags and signals correctly track asynchronous operations (activated prior to request initiation and reset upon completion or error). Flag dead, inverted, or redundant state transitions that break progress indicators or cause premature empty-state flashes.
   - Ensure timeouts and cancellation tokens (e.g., AbortSignal) are honored.

4. SECURITY & PERMISSION ENFORCEMENT:
   - Prevent Injection (SQL, NoSQL, OS Command, Code, LDAP, XSS, Template injection). Enforce parameterized bindings ('?', '$1') over raw string interpolation or concatenation.
   - Prevent Broken Object Level Authorization (BOLA/IDOR): Verify that mutating requests (DELETE, PUT, PATCH) verify that the requesting user owns the object ('item.userId === requestingUserId') or has verified administrator authorization, rather than only testing role exclusion (e.g. 'role !== VIEWER').
   - Template Security: Prohibit binding untrusted or raw user content directly via innerHTML ('[innerHTML]', 'v-html', 'dangerouslySetInnerHTML').
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
   - COMPONENT TIMERS & SUBSCRIPTIONS: In frontend components and long-lived services, check for lingering event listeners, unstopped timers/intervals ('setInterval', 'setTimeout'), or unmanaged RxJS / observable subscriptions upon component destruction ('OnDestroy', 'takeUntilDestroyed()', or 'AsyncPipe').
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
  detectedFrameworks: string[];
  frameworkGuidelines: string;
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
export function detectLanguages(fileDiffs: FileDiff[]): string[] {
  const extMap: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript (React)',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript (React)',
    '.mjs': 'JavaScript (ESM)',
    '.html': 'HTML / Template',
    '.css': 'CSS',
    '.scss': 'SCSS',
    '.sass': 'Sass',
    '.less': 'Less',
    '.vue': 'Vue Component',
    '.svelte': 'Svelte Component',
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
    '.graphql': 'GraphQL',
    '.gql': 'GraphQL',
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
 * Detects application frameworks, libraries, and runtimes by inspecting:
 * 1. Project manifests (package.json, requirements.txt, pyproject.toml, go.mod, pom.xml, composer.json)
 *    located at targetPath, common subfolders, and parent directories of modified files.
 * 2. File paths and imports / annotations inside changed file contents.
 */
export function detectFrameworks(
  targetPath: string,
  fileDiffs: FileDiff[],
  fileContents: Record<string, string>,
): string[] {
  const detected = new Set<string>();

  // 1. Inspect package.json and project manifests
  const candidateDirs = new Set<string>();
  candidateDirs.add(targetPath);

  // Common monorepo / subproject directories
  const subDirs = ['frontend', 'backend', 'client', 'server', 'web', 'api', 'app', 'packages', 'services'];
  for (const sub of subDirs) {
    const fullSub = path.resolve(targetPath, sub);
    if (fs.existsSync(fullSub)) {
      candidateDirs.add(fullSub);
    }
  }

  // Add directories from modified files (walking up to targetPath)
  for (const diff of fileDiffs) {
    const filePath = diff.newPath || diff.oldPath || '';
    if (!filePath) continue;

    let currentDir = path.dirname(path.resolve(targetPath, filePath));
    const resolvedTarget = path.resolve(targetPath);
    while (currentDir.startsWith(resolvedTarget)) {
      candidateDirs.add(currentDir);
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
  }

  // Dependency mapping for package.json
  const npmFrameworkMap: Array<{ name: string; packages: string[] }> = [
    { name: 'Angular', packages: ['@angular/core', '@angular/common'] },
    { name: 'React', packages: ['react', 'react-dom'] },
    { name: 'Next.js', packages: ['next'] },
    { name: 'Vue.js', packages: ['vue'] },
    { name: 'Nuxt', packages: ['nuxt', 'nuxt3'] },
    { name: 'Svelte', packages: ['svelte', '@sveltejs/kit'] },
    { name: 'Express', packages: ['express'] },
    { name: 'NestJS', packages: ['@nestjs/core', '@nestjs/common'] },
    { name: 'Fastify', packages: ['fastify'] },
    { name: 'Koa', packages: ['koa'] },
    { name: 'Remix', packages: ['@remix-run/react', '@remix-run/node'] },
    { name: 'Astro', packages: ['astro'] },
    { name: 'Prisma', packages: ['@prisma/client', 'prisma'] },
    { name: 'TypeORM', packages: ['typeorm'] },
    { name: 'Mongoose', packages: ['mongoose'] },
  ];

  for (const dir of candidateDirs) {
    // Node package.json
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkgContent = fs.readFileSync(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
        const deps = {
          ...((pkg.dependencies as Record<string, string>) || {}),
          ...((pkg.devDependencies as Record<string, string>) || {}),
          ...((pkg.peerDependencies as Record<string, string>) || {}),
        };

        for (const mapping of npmFrameworkMap) {
          if (mapping.packages.some((p) => p in deps)) {
            detected.add(mapping.name);
          }
        }
      } catch {
        // Skip unparseable package.json
      }
    }

    // Python requirements.txt or pyproject.toml
    const reqPath = path.join(dir, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      try {
        const reqContent = fs.readFileSync(reqPath, 'utf-8').toLowerCase();
        if (reqContent.includes('django')) detected.add('Django');
        if (reqContent.includes('fastapi')) detected.add('FastAPI');
        if (reqContent.includes('flask')) detected.add('Flask');
      } catch {}
    }

    const pyprojectPath = path.join(dir, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      try {
        const tomlContent = fs.readFileSync(pyprojectPath, 'utf-8').toLowerCase();
        if (tomlContent.includes('django')) detected.add('Django');
        if (tomlContent.includes('fastapi')) detected.add('FastAPI');
        if (tomlContent.includes('flask')) detected.add('Flask');
      } catch {}
    }

    // Go mod
    const goModPath = path.join(dir, 'go.mod');
    if (fs.existsSync(goModPath)) {
      try {
        const goContent = fs.readFileSync(goModPath, 'utf-8');
        if (goContent.includes('gin-gonic/gin')) detected.add('Gin');
        if (goContent.includes('gofiber/fiber')) detected.add('Fiber');
        if (goContent.includes('labstack/echo')) detected.add('Echo');
      } catch {}
    }

    // Java / Kotlin pom.xml or build.gradle
    const pomPath = path.join(dir, 'pom.xml');
    if (fs.existsSync(pomPath)) {
      try {
        const pomContent = fs.readFileSync(pomPath, 'utf-8');
        if (pomContent.includes('spring-boot') || pomContent.includes('org.springframework')) {
          detected.add('Spring Boot');
        }
      } catch {}
    }

    const gradlePath = path.join(dir, 'build.gradle');
    if (fs.existsSync(gradlePath)) {
      try {
        const gradleContent = fs.readFileSync(gradlePath, 'utf-8');
        if (gradleContent.includes('org.springframework.boot')) detected.add('Spring Boot');
      } catch {}
    }

    // PHP composer.json
    const composerPath = path.join(dir, 'composer.json');
    if (fs.existsSync(composerPath)) {
      try {
        const compContent = fs.readFileSync(composerPath, 'utf-8').toLowerCase();
        if (compContent.includes('laravel/framework')) detected.add('Laravel');
        if (compContent.includes('symfony/framework-bundle')) detected.add('Symfony');
      } catch {}
    }
  }

  // 2. Scan diff file paths and modified contents for framework signatures
  for (const diff of fileDiffs) {
    const filePath = (diff.newPath || diff.oldPath || '').toLowerCase();

    // Path-based hints
    if (
      filePath.endsWith('.component.ts') ||
      filePath.endsWith('.component.html') ||
      filePath.endsWith('.component.css') ||
      filePath.endsWith('.service.ts')
    ) {
      detected.add('Angular');
    }
    if (filePath.endsWith('.vue')) {
      detected.add('Vue.js');
    }
    if (filePath.endsWith('.svelte')) {
      detected.add('Svelte');
    }
    if (
      (filePath.includes('/pages/') || filePath.includes('/app/')) &&
      (filePath.endsWith('.tsx') || filePath.endsWith('.jsx'))
    ) {
      detected.add('Next.js');
    }
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) {
      detected.add('React');
    }
  }

  // Content-based hints across loaded target files
  for (const content of Object.values(fileContents)) {
    if (
      content.includes('@angular/core') ||
      content.includes('@angular/common') ||
      content.includes('@Component(') ||
      content.includes('provideRouter')
    ) {
      detected.add('Angular');
    }
    if (
      content.includes("from 'react'") ||
      content.includes('from "react"') ||
      content.includes("'use client'") ||
      content.includes('"use client"')
    ) {
      detected.add('React');
    }
    if (
      content.includes("from 'vue'") ||
      content.includes('from "vue"') ||
      content.includes('<template>')
    ) {
      detected.add('Vue.js');
    }
    if (
      content.includes("from 'express'") ||
      content.includes("require('express')") ||
      content.includes('express.Router')
    ) {
      detected.add('Express');
    }
    if (
      content.includes('@nestjs/common') ||
      content.includes('@nestjs/core') ||
      content.includes('@nestjs/')
    ) {
      detected.add('NestJS');
    }
    if (content.includes('from fastapi import') || content.includes('import FastAPI')) {
      detected.add('FastAPI');
    }
    if (content.includes('from django.') || content.includes('models.Model')) {
      detected.add('Django');
    }
    if (content.includes('@SpringBootApplication') || content.includes('@RestController')) {
      detected.add('Spring Boot');
    }
  }

  return Array.from(detected);
}

/**
 * Assembles specialized framework-aware review rules based on detected frameworks
 */
export function getFrameworkGuidelines(frameworks: string[]): string {
  const sections: string[] = [];

  if (frameworks.includes('Angular')) {
    sections.push(`[ANGULAR ARCHITECTURE & REACTIVITY]:
1. Signals & Reactivity Immutability:
   - Angular Signals (signal, computed) rely on referential equality checking (Object.is) via defaultEquals.
   - NEVER mutate an array or object in place (e.g., this.mySignal().push(item) or this.mySignal().field = value) before calling .set(this.mySignal()). Because the object reference is identical, Angular skips notifying signal consumers, breaking reactivity and UI synchronization.
   - ALWAYS flag in-place signal mutation as a MEDIUM or HIGH Correctness defect. Require immutable updates:
     'this.mySignal.update(list => [...list, item])' or 'this.mySignal.set([...this.mySignal(), item])'.
2. Component Lifecycle & Resource Cleanup:
   - Intervals (setInterval), timeouts (setTimeout), and manual RxJS subscriptions in components or services MUST be cleared when destroyed (ngOnDestroy with clearInterval, takeUntilDestroyed(), takeUntil(), or AsyncPipe).
   - Flag uncleared polling timers or unmanaged subscriptions as MEDIUM Memory Leak / Resource defects.
3. Template Security:
   - Untrusted or user-supplied content MUST NOT be bound via [innerHTML]="..." due to Stored/Reflected XSS risks. Require safe text interpolation {{ ... }} or explicit sanitization via DomSanitizer.
4. Change Detection:
   - Avoid side-effects inside computed() signals. In Zoneless or OnPush components, ensure all state updates notify signals or call ChangeDetectorRef.
5. Async UI State Lifecycles:
   - Ensure loading and pending state signals correctly wrap asynchronous operations (activated prior to dispatching requests and reset in both completion and error callbacks).
   - Flag inverted, dead, or redundant state transitions that prevent progress indicators from displaying or cause premature empty-state flashes.`);
  }

  if (frameworks.includes('React') || frameworks.includes('Next.js')) {
    sections.push(`[REACT / NEXT.JS ARCHITECTURE & HOOKS]:
1. State Immutability:
   - Never mutate state objects or arrays in place (e.g., state.push(x)). Always use immutable setters (setState(prev => [...prev, x])).
2. Hook Rules & Lifecycle Cleanup:
   - useEffect dependency arrays must be exhaustive. Any effect establishing timers, event listeners, or websockets MUST return a cleanup function to prevent memory leaks.
3. Next.js Client/Server Boundaries:
   - Client components using hooks or browser APIs must have 'use client'.
   - Server secrets, database handles, and private keys must never be imported or exposed in client components.
4. Security:
   - Flag unsanitized dangerouslySetInnerHTML as XSS.
5. Async Loading & State Lifecycles:
   - Ensure loading/busy state (e.g. setLoading(true)) is set before async calls and reset in finally/completion blocks. Flag redundant or inverted loading flags.`);
  }

  if (frameworks.includes('Vue.js') || frameworks.includes('Nuxt')) {
    sections.push(`[VUE / NUXT ARCHITECTURE & REACTIVITY]:
1. Reactivity Retention:
   - Avoid breaking reactivity when destructuring reactive objects (use toRefs()). Do not overwrite reactive() proxies.
2. Lifecycle Resource Cleanup:
   - Clean up event listeners, timers, and subscriptions in onUnmounted().
3. Template Security:
   - Flag unsafe v-html with user-supplied content.`);
  }

  if (frameworks.includes('Express') || frameworks.includes('NestJS')) {
    sections.push(`[BACKEND (EXPRESS / NESTJS) SECURITY & RELIABILITY]:
1. Broken Object Level Authorization (BOLA / IDOR):
   - Every mutating route (DELETE, PUT, PATCH, POST) MUST verify that the requesting user owns the resource (e.g. comment.userId === req.userId) or possesses ADMIN privilege.
   - Never rely solely on high-level role checks (e.g. merely checking userRole !== 'VIEWER') without verifying resource ownership.
2. Injection Prevention (SQL / Query):
   - Enforce parameterized query bindings ('?', '$1'). Flag raw string interpolation in SQL queries (e.g., DELETE FROM ... WHERE id = '\${id}') as CRITICAL SQL Injection.
3. Asynchronous Error Propagation:
   - Ensure all asynchronous route handlers catch errors and delegate to next(err) to avoid unhandled promise rejections or hung requests.
4. Schema & Input Boundary Validation:
   - Enforce schema validation (Zod, Joi, class-validator) on all req.body, req.params, and req.query.
   - Enforce trimming before length checks, non-empty minimum lengths, and explicit maximum length bounds on user inputs. Exclude client-controlled identity/role fields to prevent mass assignment. Flag missing schema boundary limits as MEDIUM severity.`);
  }

  if (frameworks.includes('FastAPI') || frameworks.includes('Django')) {
    sections.push(`[PYTHON (FASTAPI / DJANGO) ARCHITECTURE]:
1. Async Safety:
   - In async FastAPI handlers, never call blocking synchronous I/O without run_in_threadpool.
2. ORM & Query Safety:
   - Avoid raw SQL interpolation. Prevent N+1 queries using select_related() / prefetch_related().
3. Object-Level Permissions:
   - Verify that the authenticated user is authorized to access or mutate the requested record.
4. Schema & Model Boundaries:
   - Enforce Pydantic / Serializer boundaries: apply strip_whitespace, min_length, and explicit max_length constraints on user inputs to prevent memory bloat and DoS.`);
  }

  if (frameworks.includes('Spring Boot')) {
    sections.push(`[SPRING BOOT ARCHITECTURE]:
1. Security & CSRF/Authorization:
   - Verify @PreAuthorize or object ownership checks on mutating endpoints.
2. JPA / Transactions:
   - Verify transaction boundaries (@Transactional) and avoid lazy loading exceptions or N+1 queries.`);
  }

  if (sections.length === 0) {
    sections.push(`[GENERAL FULL-STACK & REACTIVE PRINCIPLES]:
1. State & Reactivity: Flag in-place mutation of arrays or objects held in reactive state stores or signals before setting them, as it breaks referential equality (Object.is) checks.
2. Resource Cleanup: Verify that timers (setInterval, setTimeout), event listeners, and data subscriptions are cleaned up when components or transient scopes are destroyed.
3. Authorization & Permissions: Ensure all mutating endpoints enforce object-level ownership checks (BOLA/IDOR protection).
4. Schema & Input Boundaries: Enforce trimming, explicit max length/size limits, and non-empty checks on user input schemas; flag missing bounds as MEDIUM severity.
5. Injection Protection: Prohibit raw string interpolation into database queries and template innerHTML bindings.`);
  }

  return sections.join('\n\n');
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
  const frameworks = detectFrameworks(targetPath, fileDiffs, fileContents);
  const frameworkGuidelines = getFrameworkGuidelines(frameworks);

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const diff of fileDiffs) {
    totalAdditions += diff.additions;
    totalDeletions += diff.deletions;
  }

  return {
    targetPath,
    detectedLanguages: languages,
    detectedFrameworks: frameworks,
    frameworkGuidelines,
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

