import { GoogleGenAI, Type } from '@google/genai';
import type { ReviewContext } from './context-builder.js';
import { isLineInDiffHunk } from './git-service.js';
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
          lineNumber: { type: Type.INTEGER, description: 'Line number in the new file on an added line.' },
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
          recommendationDiff: { type: Type.STRING, description: 'Suggested replacement code or fix.' },
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
   - MUST report real, concrete defects introduced in this PR: security vulnerabilities, broken object-level authorization (BOLA), broken state/reactivity tracking (e.g. in-place signal mutations), memory leaks (uncleared intervals/subscriptions), logic flaws, unhandled error conditions, and injection flaws.
2. EXHAUSTIVE MULTI-TIER AUDIT:
   - Review EVERY hunk of EVERY file in this diff. Do not stop after a few findings.
   - Audit BOTH frontend components/templates and backend services/routes with equal rigor.
   - ONLY report issues on lines marked '+' (added/modified). Unchanged code is context only.
   - lineNumber MUST be an added line number shown in the diff.
3. SEVERITY TIERS CALIBRATION:
   - CRITICAL: Active security breaches (SQL injection, hardcoded secrets, unauthenticated remote execution) or fatal server-crashing defects.
   - HIGH: Broken Object Level Authorization (BOLA/IDOR), Stored/Reflected XSS, privilege escalation, or major data loss.
   - MEDIUM: Functional defects, broken framework reactivity (such as in-place Angular signal mutation bypassing change detection), resource leaks (uncleared intervals/timers/subscriptions), or unhandled edge cases.
   - LOW: Minor boundary oversights, missing defensive defaults, or non-critical edge cases.
   - INFORMATIONAL: Significant architectural or maintainability insights.
   - CRITICAL NOTICE ON REACTIVE MUTATION: Do NOT dismiss reactive state mutation (e.g. \`this.signal().push(x); this.signal.set(...)\`) as a minor style choice; in reactive frameworks it halts UI synchronization and is a functional bug (MEDIUM or HIGH).
4. HIGH CONFIDENCE BAR:
   - Report issues when you have >= 85% confidence that the code introduces a real vulnerability, bug, or anti-pattern that impairs correctness, security, or stability.
5. For every finding:
   - Identify the exact filePath (must match a file in the diff).
   - Identify the lineNumber in the NEW file where the defect or improvement occurs (MUST be a line number shown in the diff for an added line marked '+').
   - Assign severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL'.
   - Assign category: 'Security' | 'Performance' | 'Correctness' | 'Error Handling' | 'API Design' | 'Maintainability' | 'Testing'.
   - Detail the problem clearly, referencing framework mechanics where applicable.
   - Explain why it matters (impact on reliability, security, reactivity, memory).
   - Provide a concise recommendationDiff or suggested replacement code block.
6. If the PR diff is completely clean, return an empty findings list [].
7. CRITICAL JSON ENCODING REQUIREMENT:
   - Output must be strictly valid JSON.
   - Any double quotes inside JSON string values (especially HTML attributes in recommendationDiff like class="...", or string literals in code snippets) MUST be properly escaped as \\" or use single quotes '.
   - Never output raw unescaped double quotes inside a JSON string value.

Output strictly valid JSON with this exact schema:
{
  "summary": "Comprehensive 2-4 sentence executive summary of changes and overall review assessment.",
  "findings": [
    {
      "filePath": "string",
      "lineNumber": 123,
      "title": "Short descriptive title of defect",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL",
      "category": "Security" | "Performance" | "Correctness" | "Error Handling" | "API Design" | "Maintainability" | "Testing",
      "problem": "Clear explanation of the bug or architectural defect.",
      "whyItMatters": "Impact explanation.",
      "recommendationDiff": "Suggested code replacement or fix"
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
    const inHunk = isLineInDiffHunk(f.filePath, f.lineNumber, context.fileDiffs, true);
    return {
      filePath: f.filePath,
      lineNumber: f.lineNumber,
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
