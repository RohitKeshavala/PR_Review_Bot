import { GoogleGenAI } from '@google/genai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ReviewContext } from './context-builder.js';
import { isLineInDiffHunk } from './git-service.js';
import type {
  AppConfig,
  CheckResult,
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
 * Strips markdown code block wrappers (```json ... ```) from model output
 */
function cleanJsonOutput(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

/**
 * Executes query with dual-SDK and multi-model fallback chain aligned with debugging-agent architecture
 */
async function executeGeminiWithFallback(
  config: AppConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const prompt = `${systemPrompt}\n\n${userPrompt}`;

  // Candidate models aligned with debugging-agent architecture
  const candidateModels = [
    config.geminiModel,
    config.geminiFallbackModel,
    'gemini-flash-lite-latest',
    'gemini-flash-latest',
    'gemini-3.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash',
  ].filter((m): m is string => Boolean(m) && m !== '');

  const uniqueModels = [...new Set(candidateModels)];

  let text = '';
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
          temperature: 0.1,
        },
      });
      text = response.text || '';
      if (text) {
        console.log(`[AI Reviewer] Successfully received AI review from model '${model}'!`);
        break;
      }
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AI Reviewer Warning] Model '${model}' failed (${msg}). Trying next model...`);
    }
  }

  // Secondary fallback: @google/generative-ai SDK if @google/genai exhausted
  if (!text) {
    for (const fallbackModel of ['gemini-flash-latest', 'gemini-1.5-flash']) {
      try {
        console.log(`[AI Reviewer] Fallback attempting @google/generative-ai SDK with '${fallbackModel}'...`);
        const genAI = new GoogleGenerativeAI(config.geminiApiKey!);
        const model = genAI.getGenerativeModel({
          model: fallbackModel,
          systemInstruction: systemPrompt,
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        });
        const result = await model.generateContent(prompt);
        text = result.response.text();
        if (text) {
          console.log(`[AI Reviewer] Successfully received AI review from fallback model '${fallbackModel}'!`);
          break;
        }
      } catch (fbErr: unknown) {
        lastError = fbErr;
        const msg = fbErr instanceof Error ? fbErr.message : String(fbErr);
        console.warn(`[AI Reviewer Warning] Fallback model '${fallbackModel}' failed (${msg}). Trying next fallback...`);
      }
    }
  }

  if (!text && lastError) {
    throw lastError;
  }

  if (!text) {
    throw new Error('No response received from any candidate Gemini model or SDK fallback.');
  }

  return text;
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
1. Thoroughly review all additions, modifications, and deletions.
2. Focus on actionable, high-impact defects: Security flaws, logic errors, race conditions, memory leaks, performance bottlenecks, unhandled nulls/exceptions, broken contracts.
3. Ignore purely stylistic nitpicks unless they violate standard idiomatic practices or cause bugs.
4. For every finding:
   - Identify the exact filePath (must match a file in the diff).
   - Identify the lineNumber in the NEW file where the defect or improvement occurs.
   - Assign severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL'.
   - Assign category: 'Security' | 'Performance' | 'Correctness' | 'Error Handling' | 'API Design' | 'Maintainability' | 'Testing'.
   - Detail the problem clearly.
   - Explain why it matters (impact on reliability, security, scalability).
   - Provide a concise recommendationDiff or suggested replacement code block.
5. If the PR diff is completely clean, return an empty findings list [].

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

  // Assemble user prompt with empirical check results, diff, and full file contents
  const checkResultsSummary = context.checkResults
    .map(
      (c) =>
        `- [${c.status}] ${c.name} (${c.command}): ${c.error ? 'ERROR: ' + c.error : c.output || 'Passed'}`,
    )
    .join('\n');

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

EMPIRICAL TOOLING CHECK RESULTS:
${checkResultsSummary || 'No automated checks executed.'}

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

  // Check if any check failed
  const failedChecks = context.checkResults.filter((c) => c.status === 'FAILED');

  if (failedChecks.length > 0) {
    findings.push({
      filePath: context.fileDiffs[0]?.newPath || 'package.json',
      lineNumber: 1,
      title: `Automated Tooling Check Failed: ${failedChecks[0].name}`,
      severity: 'HIGH',
      category: 'Testing',
      problem: `Execution of "${failedChecks[0].command}" failed: ${failedChecks[0].error || 'Non-zero exit code'}`,
      whyItMatters: 'Failing automated checks block continuous integration and indicate broken builds or tests.',
      recommendationDiff: '// Ensure all build, lint, and test scripts pass locally before submitting PR.',
    });
  }

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
    summary: `[DRY-RUN SIMULATION] Analyzed ${context.fileDiffs.length} modified file(s) across ${context.detectedLanguages.join(', ')}. Automated checks completed: ${context.checkResults.filter((c) => c.status === 'PASSED').length} passed, ${failedChecks.length} failed, ${context.checkResults.filter((c) => c.status === 'SKIPPED').length} skipped.`,
    findings,
  };
}

/**
 * Calculates review health score (0-100), letter grade (A+ to F), and review verdict
 */
export function calculateScoreAndVerdict(
  findings: PRFinding[],
  checkResults: CheckResult[],
): {
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

  const failedChecksCount = checkResults.filter((c) => c.status === 'FAILED').length;

  // Blueprint rubric formula:
  // Score = 100 - (Critical * 30 + High * 15 + Medium * 7 + Low * 3 + FailedChecks * 25)
  const penalty =
    criticalIssues * 30 +
    highIssues * 15 +
    mediumIssues * 7 +
    lowIssues * 3 +
    failedChecksCount * 25;

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
  // CHANGES_REQUESTED: If >= 1 Critical, >= 1 High, or failed tests.
  // APPROVE_WITH_COMMENTS: If only Medium/Low issues remain.
  // APPROVE: Clean diff with 0 issues (or only informational).
  let verdict: ReviewVerdict = 'APPROVE';
  if (criticalIssues > 0 || highIssues > 0 || failedChecksCount > 0) {
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
    const rawJson = await executeGeminiWithFallback(
      config,
      systemPrompt,
      userPrompt,
    );

    try {
      const cleaned = cleanJsonOutput(rawJson);
      aiResponse = JSON.parse(cleaned) as RawAIReviewResponse;
    } catch (parseErr) {
      throw new Error(`Failed to parse Gemini response as JSON: ${parseErr}\nRaw Output: ${rawJson}`);
    }
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

  const { healthScore, grade, verdict, stats } = calculateScoreAndVerdict(
    validatedFindings,
    context.checkResults,
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
    toolingChecks: context.checkResults,
    findings: validatedFindings,
    targetPath: config.targetProjectPath,
    baseBranch: config.baseBranch,
    headBranch: config.headBranch,
    prNumber: config.prNumber,
    repository: config.githubRepository,
    generatedAt: new Date().toISOString(),
  };

  return report;
}
