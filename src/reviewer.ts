import { GoogleGenAI, Type } from '@google/genai';
import type { ReviewContext } from './context-builder.js';
import { isLineInDiffHunk, isRangeInDiffHunk } from './git-service.js';
import type {
  AppConfig,
  FindingCategory,
  PRFinding,
  PRReviewReport,
  PRReviewStats,
  ReviewGrade,
  ReviewVerdict,
  Severity,
} from './types.js';

interface RawAIFinding {
  filePath: string;
  lineNumber: number;
  endLineNumber?: number;
  title: string;
  severity: Severity;
  category: FindingCategory;
  problem: string;
  whyItMatters: string;
  recommendationDiff?: string;
}

interface RawAIReviewResponse {
  summary: string;
  findings: RawAIFinding[];
}

/**
 * Strict OpenAPI-compatible response schema for Gemini grammar-constrained decoding
 */
const REVIEW_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: {
      type: Type.STRING,
      description: 'Comprehensive 2-4 sentence executive summary of changes and overall review assessment.',
    },
    findings: {
      type: Type.ARRAY,
      description: 'List of all concrete, actionable defects identified in added or modified code.',
      items: {
        type: Type.OBJECT,
        properties: {
          filePath: { type: Type.STRING, description: 'File path matching a file in the diff.' },
          lineNumber: {
            type: Type.INTEGER,
            description: 'Start line number in the new file on an added/modified line in the diff hunk.',
          },
          endLineNumber: {
            type: Type.INTEGER,
            description: 'End line number in the new file for multi-line replacement (inclusive). Must be in the same diff hunk as lineNumber. Set equal to lineNumber for single-line changes.',
          },
          title: { type: Type.STRING, description: 'Short descriptive title of defect.' },
          severity: {
            type: Type.STRING,
            enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'],
          },
          category: {
            type: Type.STRING,
            enum: [
              'Security',
              'Performance',
              'Correctness',
              'Error Handling',
              'API Design',
              'Maintainability',
              'Testing',
            ],
          },
          problem: { type: Type.STRING, description: 'Clear explanation of the bug or architectural defect.' },
          whyItMatters: { type: Type.STRING, description: 'Impact explanation.' },
          recommendationDiff: {
            type: Type.STRING,
            description: 'Exact clean replacement code for GitHub 1-click suggestion. Do NOT include diff headers (@@), +/- diff prefixes, or markdown fences. Preserves exact indentation so it directly overwrites lines lineNumber through endLineNumber.',
          },
        },
        required: [
          'filePath',
          'lineNumber',
          'title',
          'severity',
          'category',
          'problem',
          'whyItMatters',
        ],
      },
    },
  },
  required: ['summary', 'findings'],
};

/**
 * Safely parses and repairs AI JSON responses, handling markdown wrappers,
 * unescaped newlines/tabs inside string literals, trailing commas,
 * rogue leading/trailing text, and unescaped quotes inside code snippets.
 */
export function safeParseAIResponse(raw: string): RawAIReviewResponse {
  if (!raw || raw.trim().length === 0) {
    throw new Error('Received empty response from AI model');
  }

  // 1. Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  // 2. Extract JSON block from first { to last }
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  // 3. Attempt direct JSON parse
  try {
    const parsed = JSON.parse(cleaned) as RawAIReviewResponse;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Fall through to repair logic
  }

  // 4. Sanitize unescaped control characters inside string literals (raw newlines, tabs, carriage returns)
  let inString = false;
  let escaped = false;
  let sanitized = '';

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escaped) {
      sanitized += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      sanitized += char;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      sanitized += char;
      continue;
    }

    if (inString) {
      if (char === '\n') {
        sanitized += '\\n';
      } else if (char === '\r') {
        sanitized += '\\r';
      } else if (char === '\t') {
        sanitized += '\\t';
      } else if (char.charCodeAt(0) < 32) {
        sanitized += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      } else {
        sanitized += char;
      }
    } else {
      sanitized += char;
    }
  }

  // 5. Remove trailing commas before } or ]
  sanitized = sanitized.replace(/,\s*([}\]])/g, '$1');

  try {
    const parsed = JSON.parse(sanitized) as RawAIReviewResponse;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Fall through to quote repair
  }

  // 6. Regex repair for unescaped internal quotes inside common fields
  try {
    const quoteRepaired = sanitized.replace(
      /"(recommendationDiff|problem|whyItMatters|title|summary)"\s*:\s*"([\s\S]*?)"(?=\s*(?:,|\n\s*\}|\n\s*\]))/g,
      (_match, key, val) => {
        const escapedVal = val.replace(/(?<!\\)"/g, '\\"');
        return `"${key}": "${escapedVal}"`;
      },
    );
    const parsed = JSON.parse(quoteRepaired) as RawAIReviewResponse;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Fall through to auto-close truncated JSON
  }

  // 7. Auto-close truncated JSON if stream was cut off (LIFO stack)
  try {
    const stack: string[] = [];
    let inStr = false;
    let isEsc = false;

    for (let i = 0; i < sanitized.length; i++) {
      const c = sanitized[i];
      if (isEsc) {
        isEsc = false;
        continue;
      }
      if (c === '\\') {
        isEsc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (!inStr) {
        if (c === '{') stack.push('}');
        else if (c === '[') stack.push(']');
        else if (c === '}' || c === ']') {
          if (stack.length > 0 && stack[stack.length - 1] === c) {
            stack.pop();
          }
        }
      }
    }

    let completed = sanitized.trim();
    if (inStr) completed += '"';
    completed = completed.replace(/,\s*$/, '');
    completed = completed.replace(/:\s*$/, ': null');
    completed = completed.replace(/,\s*([}\]])/g, '$1');

    while (stack.length > 0) {
      completed += stack.pop();
    }

    const parsed = JSON.parse(completed) as RawAIReviewResponse;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Final throw with diagnostic details
  }

  throw new Error(`Failed to parse or repair AI response as JSON.`);
}

/**
 * Executes query using official GoogleGenAI SDK with dynamic multi-model fallback chain
 */
async function executeGeminiWithFallback(
  config: AppConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ rawText: string; parsed: RawAIReviewResponse }> {
  // Candidate models: ordered by reasoning capability (flagship flash -> workhorse -> aliases -> lite)
  // gemini-3.8-flash-lite was removed because it is an audio/TTS model and returns 404 for generateContent.
  const candidateModels = [
    config.geminiModel,
    config.geminiFallbackModel,
    'gemini-flash-lite-latest',
    'gemini-flash-latest',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
  ].filter((m): m is string => Boolean(m) && m !== '');

  const uniqueModels = [...new Set(candidateModels)];

  let lastError: unknown = null;

  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey! });

  for (const model of uniqueModels) {
    try {
      console.log(`[AI Reviewer] Invoking Google Gemini AI with model: '${model}'...`);
      const response = await ai.models.generateContent({
        model,
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseSchema: REVIEW_RESPONSE_SCHEMA,
          temperature: 0.0,
        },
      });

      const text = response.text || '';
      if (text) {
        try {
          const parsed = safeParseAIResponse(text);
          console.log(`[AI Reviewer] Successfully received and validated AI review JSON from model '${model}'!`);
          return { rawText: text, parsed };
        } catch (parseErr: unknown) {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          const snippet = text.slice(0, 200).replace(/\r?\n/g, ' ');
          console.warn(`[AI Reviewer Warning] Model '${model}' produced malformed JSON (${msg}). Output preview: "${snippet}..."`);
          lastError = parseErr;
        }
      }
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AI Reviewer Warning] Model '${model}' failed (${msg}). Trying next model...`);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('No valid response received from any candidate Gemini model in the fallback chain.');
}

/**
 * Builds the AI system and user prompts incorporating review context
 */
function buildPrompts(context: ReviewContext) {
  const frameworksHeader =
    context.detectedFrameworks.length > 0
      ? `\nDetected Project Frameworks & Stacks: ${context.detectedFrameworks.join(', ')}.\n\nFramework-Specific Specialized Review Rules:\n${context.frameworkGuidelines}\n`
      : `\nFull-Stack Review Rules:\n${context.frameworkGuidelines}\n`;

  const systemPrompt = `You are an elite autonomous polyglot Staff Principal Software Engineer and Security Architect conducting a comprehensive Pull Request Code Review.

Detected Project Languages / Technologies: ${context.detectedLanguages.join(', ')}.${frameworksHeader}

Embedded 12-Step Universal Review Principles:
${context.principles}

Rules for Review:
1. DISTINGUISH CONCRETE DEFECTS FROM SPECULATIVE OPINIONS:
   - Do NOT raise purely speculative "what-if" future opinions, subjective naming debates, or aesthetic formatting preferences.
   - MUST report real, concrete defects introduced in this PR: security vulnerabilities, broken object-level authorization (BOLA), broken state/reactivity tracking (e.g. in-place signal mutations), inverted or dead async loading state flags, missing schema boundary constraints (unbounded strings, missing trimming/min-max), memory leaks (uncleared intervals/subscriptions), logic flaws, unhandled error conditions, and injection flaws.
2. EXHAUSTIVE MULTI-TIER AUDIT:
   - Review EVERY hunk of EVERY file in this diff. Do not stop after a few findings.
   - Audit BOTH frontend components/templates and backend services/routes with equal rigor.
   - ONLY report issues on lines marked '+' (added/modified). Unchanged code is context only.
   - lineNumber MUST be an added line number shown in the diff.
3. SEVERITY TIERS CALIBRATION:
   - CRITICAL: Active security breaches (SQL injection, hardcoded secrets, unauthenticated remote execution) or fatal server-crashing defects.
   - HIGH: Broken Object Level Authorization (BOLA/IDOR), Stored/Reflected XSS, privilege escalation, or major data loss.
   - MEDIUM: Functional defects, broken framework reactivity (such as in-place state mutation bypassing change detection), resource leaks (uncleared intervals/timers/subscriptions), dead or inverted async state flags, schema validation boundary omissions (e.g. missing string trimming allowing whitespace-only bypass, unbounded strings/collections lacking max limits, or mass-assignment in request schemas), or unhandled edge cases.
   - LOW: Minor boundary oversights, missing defensive defaults, or non-critical edge cases.
   - INFORMATIONAL: Significant architectural or maintainability insights.
   - CRITICAL NOTICE ON REACTIVE MUTATION: Do NOT dismiss in-place mutation of reactive state or signals as a minor style choice; in reactive frameworks it breaks referential equality tracking (Object.is), halts UI synchronization, and is a functional bug (MEDIUM or HIGH).
4. HIGH CONFIDENCE BAR:
   - Report issues when you have >= 85% confidence that the code introduces a real vulnerability, bug, or anti-pattern that impairs correctness, security, or stability.
5. PRECISE MULTI-LINE RANGE TARGETING:
   - lineNumber: The START line number in the NEW file where the defect or replacement begins (MUST be an added/modified line in the diff hunk).
   - endLineNumber: The END line number in the NEW file where the replacement block ends (inclusive).
     * If the issue/replacement is on a single line, endLineNumber MUST equal lineNumber.
     * If the issue/replacement replaces multiple lines (e.g., lines 26 through 28), set endLineNumber to the last line of that block (e.g., 28).
     * CRITICAL: Both lineNumber and endLineNumber MUST be within the SAME contiguous diff hunk. Never span across different hunks or files.
     * ISOLATE DISCONNECTED DEFECTS: If a PR has issues in multiple separate locations (e.g., line 26 AND line 61), report them as SEPARATE findings, one for each location. NEVER combine separate locations into one finding.
6. CLEAN REPLACEMENT CODE FOR GITHUB 1-CLICK SUGGESTIONS (recommendationDiff):
   - In GitHub PR reviews, recommendationDiff is placed directly inside a \`\`\`suggestion\`\`\` block. Clicking "Commit suggestion" will REWRITE lines lineNumber through endLineNumber with the exact content of recommendationDiff.
   - MUST BE PURE, CLEAN REPLACEMENT CODE:
     * NEVER output Git diff notation: NO "@@ ... @@" headers, NO leading "+" or "-" signs.
     * NEVER include unchanged context lines from outside the lineNumber..endLineNumber range (doing so creates DUPLICATE lines when applied!).
     * NEVER wrap recommendationDiff in markdown code fences (no \`\`\`suggestion or \`\`\`ts).
     * MUST preserve exact indentation (spaces or tabs) matching the target file so the replacement fits seamlessly.
     * To delete lines lineNumber through endLineNumber without replacement, provide an empty string "".
   - STRICT LEXICAL SCOPE INTEGRITY (AVOID NESTED DECLARATIONS):
     * The replacement code MUST be 100% syntactically valid in the EXACT lexical scope of lineNumber..endLineNumber.
     * If lineNumber..endLineNumber is inside a method or function body (e.g. inside ngOnInit, a constructor, a route handler, or a helper function):
       - NEVER include class-level member declarations (e.g., 'private myListener = ...').
       - NEVER declare new methods or lifecycle hooks (e.g., 'ngOnInit(): void', 'ngOnDestroy(): void').
       - Pasting class properties or methods inside an existing method body causes fatal compiler errors (TS1068, TS2393).
     * If a fix requires multi-scope refactoring (e.g., modifying class properties, constructor, AND a separate lifecycle method like ngOnDestroy):
       - EITHER provide an in-scope self-contained solution (e.g., in Angular using 'fromEvent(window, "keydown").pipe(takeUntilDestroyed(this.destroyRef)).subscribe(...)', or in standard JS using an AbortController),
       - OR OMIT recommendationDiff entirely and explain the required multi-file/multi-method refactoring steps in the problem and whyItMatters text!
7. If the PR diff is completely clean, return an empty findings list [].
8. CRITICAL JSON ENCODING REQUIREMENT:
   - Output must be strictly valid JSON.
   - Any double quotes inside JSON string values (especially HTML attributes in recommendationDiff like class="...", or string literals in code snippets) MUST be properly escaped as \\" or use single quotes '.
   - Never output raw unescaped double quotes inside a JSON string value.

Output strictly valid JSON with this exact schema:
{
  "summary": "Comprehensive 2-4 sentence executive summary of changes and overall review assessment.",
  "findings": [
    {
      "filePath": "string",
      "lineNumber": 26,
      "endLineNumber": 28,
      "title": "Short descriptive title of defect",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL",
      "category": "Security" | "Performance" | "Correctness" | "Error Handling" | "API Design" | "Maintainability" | "Testing",
      "problem": "Clear explanation of the bug or architectural defect.",
      "whyItMatters": "Impact explanation.",
      "recommendationDiff": "        u.role AS authorRole"
    }
  ]
}`;

  let fileContentsSection = '';
  for (const [filePath, content] of Object.entries(context.fileContents)) {
    fileContentsSection += `\n--- Full File Context: ${filePath} ---\n${content}\n`;
  }

  const rawDiff = context.fileDiffs
    .map((f) => {
      let hunkText = '';
      for (const h of f.hunks) {
        hunkText += `\n${h.header}\n`;
        for (const line of h.lines) {
          const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
          hunkText += `${prefix}${line.content}\n`;
        }
      }
      return `diff --git a/${f.oldPath || f.newPath} b/${f.newPath}\n${hunkText}`;
    })
    .join('\n');

  const userPrompt = `Please review this Pull Request:

PULL REQUEST UNIFIED DIFF:
${rawDiff || 'No changes detected in diff.'}

FULL FILE CONTENTS (Surrounding Context):
${fileContentsSection || 'No modified file contents available.'}
`;

  return { systemPrompt, userPrompt };
}

/**
 * Generates mock findings for dry-run testing when no Gemini API key is configured
 */
function generateDryRunReview(context: ReviewContext): RawAIReviewResponse {
  const findings: RawAIFinding[] = [];

  if (context.fileDiffs.length > 0) {
    const firstDiff = context.fileDiffs[0];
    const firstHunk = firstDiff.hunks[0];
    const targetLine = firstHunk ? firstHunk.newStart : 1;

    findings.push({
      filePath: firstDiff.newPath,
      lineNumber: targetLine,
      endLineNumber: targetLine,
      title: 'Dry-Run Simulation: Validated Diff Structure & Polyglot Engine',
      severity: 'INFORMATIONAL',
      category: 'Maintainability',
      problem: 'Simulated finding generated during --dry-run mode without active Gemini API call.',
      whyItMatters: 'Demonstrates end-to-end AST diff hunk validation, scoring rubric, and GitHub reporting pipeline.',
      recommendationDiff: '// Code looks good. Ready for live review.',
    });
  }

  const frameworksSummary =
    context.detectedFrameworks.length > 0
      ? ` and frameworks (${context.detectedFrameworks.join(', ')})`
      : '';

  return {
    summary: `[DRY-RUN SIMULATION] Analyzed ${context.fileDiffs.length} modified file(s) across ${context.detectedLanguages.join(', ')}${frameworksSummary}. Code structure validated against universal review principles and framework-specific guidelines.`,
    findings,
  };
}

/**
 * Calculates review health score (0-100), letter grade (A+ to F), and review verdict
 */
export function calculateScoreAndVerdict(findings: PRFinding[]): {
  healthScore: number;
  grade: ReviewGrade;
  verdict: ReviewVerdict;
  stats: Omit<PRReviewStats, 'filesChanged' | 'additions' | 'deletions'>;
} {
  let criticalIssues = 0;
  let highIssues = 0;
  let mediumIssues = 0;
  let lowIssues = 0;
  let informationalIssues = 0;

  for (const f of findings) {
    // Production rule: only findings inside the PR diff hunks can penalize score or block PR
    if (!f.inDiffHunk) {
      informationalIssues++;
      continue;
    }

    switch (f.severity) {
      case 'CRITICAL':
        criticalIssues++;
        break;
      case 'HIGH':
        highIssues++;
        break;
      case 'MEDIUM':
        mediumIssues++;
        break;
      case 'LOW':
        lowIssues++;
        break;
      case 'INFORMATIONAL':
        informationalIssues++;
        break;
    }
  }

  // Pure Code Quality Scoring Rubric:
  // Score = 100 - (Critical * 30 + High * 15 + Medium * 7 + Low * 3)
  const penalty =
    criticalIssues * 30 +
    highIssues * 15 +
    mediumIssues * 7 +
    lowIssues * 3;

  const rawScore = 100 - penalty;
  const healthScore = Math.max(0, Math.min(100, rawScore));

  // Determine Letter Grade
  let grade: ReviewGrade = 'F';
  if (healthScore >= 95) grade = 'A+';
  else if (healthScore >= 85) grade = 'A';
  else if (healthScore >= 70) grade = 'B';
  else if (healthScore >= 55) grade = 'C';
  else if (healthScore >= 40) grade = 'D';
  else grade = 'F';

  // Determine Verdict
  // CHANGES_REQUESTED: If >= 1 Critical or >= 1 High issue.
  // APPROVE_WITH_COMMENTS: If only Medium/Low issues remain.
  // APPROVE: Clean diff with 0 issues (or only informational).
  let verdict: ReviewVerdict = 'APPROVE';
  if (criticalIssues > 0 || highIssues > 0) {
    verdict = 'CHANGES_REQUESTED';
  } else if (mediumIssues > 0 || lowIssues > 0) {
    verdict = 'APPROVE_WITH_COMMENTS';
  } else {
    verdict = 'APPROVE';
  }

  return {
    healthScore,
    grade,
    verdict,
    stats: {
      criticalIssues,
      highIssues,
      mediumIssues,
      lowIssues,
      informationalIssues,
    },
  };
}

/**
 * Main review reasoning engine
 */
export async function performAIReview(
  context: ReviewContext,
  config: AppConfig,
): Promise<PRReviewReport> {
  let aiResponse: RawAIReviewResponse;

  const isPlaceholderKey =
    !config.geminiApiKey ||
    config.geminiApiKey === 'your-gemini-api-key-here' ||
    config.geminiApiKey.startsWith('your-');

  if (config.dryRun && isPlaceholderKey) {
    aiResponse = generateDryRunReview(context);
  } else {
    if (!config.geminiApiKey) {
      throw new Error('GEMINI_API_KEY is required to perform AI review.');
    }

    const { systemPrompt, userPrompt } = buildPrompts(context);
    const { parsed } = await executeGeminiWithFallback(
      config,
      systemPrompt,
      userPrompt,
    );
    aiResponse = parsed;
  }

  // Validate diff hunk boundaries for each finding
  const validatedFindings: PRFinding[] = (aiResponse.findings || []).map((f) => {
    const startLine = Number(f.lineNumber);
    const parsedEnd = f.endLineNumber !== undefined ? Number(f.endLineNumber) : startLine;
    const requestedEndLine = parsedEnd >= startLine ? parsedEnd : startLine;

    // Check if multi-line range is valid within a single diff hunk
    const isMultiLineValid =
      requestedEndLine > startLine &&
      isRangeInDiffHunk(f.filePath, startLine, requestedEndLine, context.fileDiffs);

    const singleLineInHunk = isLineInDiffHunk(f.filePath, startLine, context.fileDiffs, true);
    const inHunk = isMultiLineValid || singleLineInHunk;

    return {
      filePath: f.filePath,
      lineNumber: startLine,
      endLineNumber: isMultiLineValid ? requestedEndLine : undefined,
      inDiffHunk: inHunk,
      title: f.title || 'Review Finding',
      severity: f.severity || 'MEDIUM',
      category: f.category || 'Maintainability',
      problem: f.problem || '',
      whyItMatters: f.whyItMatters || '',
      recommendationDiff: f.recommendationDiff,
    };
  });

  const severityRank: Record<Severity, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
    INFORMATIONAL: 4,
  };

  // Prioritize findings in diff hunks first, then by severity
  const prioritizedFindings = validatedFindings.sort((a, b) => {
    if (a.inDiffHunk !== b.inDiffHunk) {
      return a.inDiffHunk ? -1 : 1;
    }
    return severityRank[a.severity] - severityRank[b.severity];
  });

  const { healthScore, grade, verdict, stats } = calculateScoreAndVerdict(
    prioritizedFindings,
  );

  const fullStats: PRReviewStats = {
    filesChanged: context.summaryOfChanges.filesCount,
    additions: context.summaryOfChanges.totalAdditions,
    deletions: context.summaryOfChanges.totalDeletions,
    ...stats,
  };

  const report: PRReviewReport = {
    healthScore,
    grade,
    verdict,
    summary: aiResponse.summary || 'Code review completed successfully.',
    stats: fullStats,
    findings: prioritizedFindings,
    detectedLanguages: context.detectedLanguages,
    detectedFrameworks: context.detectedFrameworks,
    targetPath: config.targetProjectPath,
    baseBranch: config.baseBranch,
    headBranch: config.headBranch,
    prNumber: config.prNumber,
    repository: config.githubRepository,
    generatedAt: new Date().toISOString(),
  };

  return report;
}
