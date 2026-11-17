import { GoogleGenAI } from '@google/genai';
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
 * Safely parses and repairs AI JSON responses, handling markdown wrappers,
 * rogue leading/trailing text, and unescaped double quotes inside code snippets.
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

  // 4. Line-by-line repair of unescaped quotes in property values
  try {
    const lines = cleaned.split('\n');
    const repairedLines = lines.map((line) => {
      // Matches standard JSON string property line: "key": "content..." (with optional trailing comma)
      const match = line.match(/^(\s*"[a-zA-Z0-9_]+"\s*:\s*")(.*)("(?:\s*,|\s*)?)$/);
      if (match) {
        const [, prefix, content, suffix] = match;
        // Escape quotes that are not already escaped
        const escapedContent = content.replace(/(?<!\\)"/g, '\\"');
        return `${prefix}${escapedContent}${suffix}`;
      }
      return line;
    });

    const repaired = repairedLines.join('\n');
    const parsed = JSON.parse(repaired) as RawAIReviewResponse;
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch {
    // Fall through to multiline repair
  }

  // 5. Multiline regex repair for fields spanning lines
  try {
    const multilineRepaired = cleaned.replace(
      /"(recommendationDiff|problem|whyItMatters|title|summary)"\s*:\s*"([\s\S]*?)"(?=\s*(?:,|\n\s*\}|\n\s*\]))/g,
      (_match, key, val) => {
        const escapedVal = val.replace(/(?<!\\)"/g, '\\"');
        return `"${key}": "${escapedVal}"`;
      },
    );
    const parsed = JSON.parse(multilineRepaired) as RawAIReviewResponse;
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
  const prompt = `${systemPrompt}\n\n${userPrompt}`;

  // Candidate models: latest active Gemini 3.x and universal aliases
  const candidateModels = [
    config.geminiModel,
    config.geminiFallbackModel,
    'gemini-flash-lite-latest',
    'gemini-flash-latest',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.8-flash-lite',
  ].filter((m): m is string => Boolean(m) && m !== '');

  const uniqueModels = [...new Set(candidateModels)];

  let lastError: unknown = null;

  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey! });

  for (const model of uniqueModels) {
    try {
      console.log(`[AI Reviewer] Invoking Google Gemini AI with model: '${model}'...`);
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
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
          console.warn(`[AI Reviewer Warning] Model '${model}' produced malformed JSON (${msg}). Trying next model in fallback chain...`);
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
  const systemPrompt = `You are an elite autonomous polyglot Staff Principal Software Engineer and Security Architect conducting a comprehensive Pull Request Code Review.

Detected Project Languages / Technologies: ${context.detectedLanguages.join(', ')}.

Embedded 12-Step Universal Review Principles:
${context.principles}

Rules for Review:
1. NO SPECULATIVE / THEORETICAL ISSUES: Do NOT raise "what-if" issues, theoretical design preferences, or hypothetical future misuse scenarios (e.g., "if someone in the future uses this field for dynamic data"). Only report concrete, demonstrable bugs, fatal exceptions, or security vulnerabilities that exist in this exact code right now.
2. HIGH CONFIDENCE THRESHOLD: Only report an issue if you have >= 90% confidence that it is an actual defect or regression introduced by this PR. When in doubt, prefer silence over false alarms.
3. FOCUS ON BLOCKERS: Reserve CRITICAL and HIGH strictly for catastrophic defects (fatal runtime exceptions, authentication bypass, active injection, data loss, hardcoded secrets). Minor style suggestions, naming improvements, or non-fatal refactors must be LOW or INFORMATIONAL.
4. For every finding:
   - Identify the exact filePath (must match a file in the diff).
   - Identify the lineNumber in the NEW file where the defect or improvement occurs.
   - Assign severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL'.
   - Assign category: 'Security' | 'Performance' | 'Correctness' | 'Error Handling' | 'API Design' | 'Maintainability' | 'Testing'.
   - Detail the problem clearly.
   - Explain why it matters (impact on reliability, security, scalability).
   - Provide a concise recommendationDiff or suggested replacement code block.
5. If the PR diff is completely clean, return an empty findings list [].
6. CRITICAL JSON ENCODING REQUIREMENT:
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

  return {
    summary: `[DRY-RUN SIMULATION] Analyzed ${context.fileDiffs.length} modified file(s) across ${context.detectedLanguages.join(', ')}. Code structure validated against universal review principles.`,
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
    const inHunk = isLineInDiffHunk(f.filePath, f.lineNumber, context.fileDiffs);
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
    targetPath: config.targetProjectPath,
    baseBranch: config.baseBranch,
    headBranch: config.headBranch,
    prNumber: config.prNumber,
    repository: config.githubRepository,
    generatedAt: new Date().toISOString(),
  };

  return report;
}
