import type { PRFinding, PRReviewReport, ReviewVerdict, Severity } from './types.js';

// ANSI escape sequences for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

/**
 * Returns an ANSI colored severity badge for terminal
 */
function getSeverityColor(sev: Severity): string {
  switch (sev) {
    case 'CRITICAL':
      return `${colors.bgRed}${colors.white}${colors.bold} CRITICAL ${colors.reset}`;
    case 'HIGH':
      return `${colors.red}${colors.bold}HIGH${colors.reset}`;
    case 'MEDIUM':
      return `${colors.yellow}${colors.bold}MEDIUM${colors.reset}`;
    case 'LOW':
      return `${colors.cyan}LOW${colors.reset}`;
    case 'INFORMATIONAL':
      return `${colors.dim}INFO${colors.reset}`;
  }
}

/**
 * Returns an ANSI colored verdict string
 */
function getVerdictColor(verdict: ReviewVerdict): string {
  switch (verdict) {
    case 'APPROVE':
      return `${colors.bgGreen}${colors.white}${colors.bold} APPROVED ${colors.reset}`;
    case 'APPROVE_WITH_COMMENTS':
      return `${colors.bgYellow}${colors.white}${colors.bold} APPROVE WITH COMMENTS ${colors.reset}`;
    case 'CHANGES_REQUESTED':
      return `${colors.bgRed}${colors.white}${colors.bold} CHANGES REQUESTED ${colors.reset}`;
  }
}

/**
 * Formats report for terminal / ANSI output
 */
export function toConsole(report: PRReviewReport): string {
  const hr = `${colors.dim}${'─'.repeat(70)}${colors.reset}`;
  const doubleHr = `${colors.bold}${'═'.repeat(70)}${colors.reset}`;

  let out = '\n' + doubleHr + '\n';
  out += ` ${colors.bold}${colors.cyan}🤖 UNIVERSAL AI PR REVIEW BOT${colors.reset}\n`;
  out += doubleHr + '\n\n';

  // Overall Score & Verdict
  out += `  ${colors.bold}Verdict:${colors.reset}       ${getVerdictColor(report.verdict)}\n`;
  out += `  ${colors.bold}Health Score:${colors.reset}  ${report.healthScore}/100 (Grade: ${colors.bold}${report.grade}${colors.reset})\n`;
  if (report.detectedLanguages && report.detectedLanguages.length > 0) {
    out += `  ${colors.bold}Languages:${colors.reset}     ${report.detectedLanguages.join(', ')}\n`;
  }
  if (report.detectedFrameworks && report.detectedFrameworks.length > 0) {
    out += `  ${colors.bold}Frameworks:${colors.reset}    ${colors.cyan}${report.detectedFrameworks.join(', ')}${colors.reset}\n`;
  }
  out += `  ${colors.bold}Files Changed:${colors.reset} ${report.stats.filesChanged} (+${report.stats.additions} / -${report.stats.deletions})\n`;
  out += `  ${colors.bold}Defects:${colors.reset}        Crit: ${report.stats.criticalIssues} | High: ${report.stats.highIssues} | Med: ${report.stats.mediumIssues} | Low: ${report.stats.lowIssues}\n\n`;

  // Summary
  out += `  ${colors.bold}Summary:${colors.reset}\n`;
  out += `  ${report.summary.replace(/\n/g, '\n  ')}\n\n`;

  // Findings
  if (report.findings.length > 0) {
    out += hr + '\n';
    out += `  ${colors.bold}Itemized Review Findings (${report.findings.length}):${colors.reset}\n\n`;

    report.findings.forEach((f, idx) => {
      const lineRange =
        f.endLineNumber && f.endLineNumber > f.lineNumber
          ? `${f.filePath}:${f.lineNumber}-${f.endLineNumber}`
          : `${f.filePath}:${f.lineNumber}`;
      out += `  ${idx + 1}. [${getSeverityColor(f.severity)}] [${f.category}] ${colors.bold}${f.title}${colors.reset}\n`;
      out += `     Location: ${lineRange} ${f.inDiffHunk ? `${colors.green}(In Diff Hunk)${colors.reset}` : `${colors.dim}(Outside Diff Hunk)${colors.reset}`}\n`;
      out += `     Problem:  ${f.problem}\n`;
      out += `     Impact:   ${f.whyItMatters}\n`;
      if (f.recommendationDiff) {
        out += `     Fix:\n       ${colors.dim}${f.recommendationDiff.replace(/\n/g, '\n       ')}${colors.reset}\n`;
      }
      out += '\n';
    });
  } else {
    out += `  ${colors.green}✔ No defects identified. Clean PR diff!${colors.reset}\n\n`;
  }

  out += doubleHr + '\n';
  return out;
}

/**
 * Cleans recommendation code to ensure it works reliably as a GitHub 1-click suggestion.
 * - Strips outer markdown code fences (```suggestion, ```typescript, etc.)
 * - Identifies and safely handles unified diff notations
 * - Strips diff prefixes ('+', context lines) while preserving exact target indentation
 */
export function cleanSuggestionCode(raw: string): { code: string; isRawDiff: boolean } {
  if (!raw) return { code: '', isRawDiff: false };

  // Strip leading and trailing newlines, but preserve indentation on lines
  let text = raw.replace(/^[\r\n]+/, '').replace(/[\r\n\s]+$/, '');

  // Strip outer markdown code blocks if the AI model included them
  if (text.startsWith('```')) {
    text = text.replace(/^```[^\r\n]*\r?\n/, '').replace(/\r?\n```[^\r\n]*$/, '');
  }

  // Count hunk headers (@@ -... @@)
  const hunkHeaders = text.match(/^@@\s+-\d+/gm) || [];
  if (hunkHeaders.length > 1) {
    // Contains multiple disjoint diff hunks: unsafe for a single GitHub suggestion block
    return { code: text, isRawDiff: true };
  }

  if (hunkHeaders.length === 1) {
    text = text.replace(/^@@.*?@@\r?\n?/m, '');
  }

  const lines = text.split(/\r?\n/);
  const hasMinus = lines.some((l) => l.startsWith('-'));
  const hasPlus = lines.some((l) => l.startsWith('+'));

  if (hasMinus || hasPlus) {
    // If unified diff notation was used, extract the '+' replacement lines
    const replacementLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('+')) {
        replacementLines.push(line.replace(/^\+\s?/, ''));
      } else if (!line.startsWith('-')) {
        // Context line (strip leading space if standard diff format)
        replacementLines.push(line.startsWith(' ') ? line.substring(1) : line);
      }
    }
    return { code: replacementLines.join('\n'), isRawDiff: false };
  }

  return { code: text, isRawDiff: false };
}

/**
 * Formats individual finding for GitHub inline diff comment with ```suggestion block
 */
export function toInlineComment(finding: PRFinding): string {
  const severityEmojis: Record<Severity, string> = {
    CRITICAL: '🚨 **[CRITICAL]**',
    HIGH: '⚠️ **[HIGH]**',
    MEDIUM: '⚡ **[MEDIUM]**',
    LOW: '🔍 **[LOW]**',
    INFORMATIONAL: '💡 **[INFO]**',
  };

  let body = `${severityEmojis[finding.severity]} **${finding.title}**\n\n`;
  body += `> **Category**: \`${finding.category}\`\n\n`;
  body += `**Problem:**\n${finding.problem}\n\n`;
  body += `**Why It Matters:**\n${finding.whyItMatters}\n\n`;

  if (finding.recommendationDiff !== undefined && finding.recommendationDiff.trim().length > 0) {
    const { code, isRawDiff } = cleanSuggestionCode(finding.recommendationDiff);

    if (isRawDiff) {
      body += `**Suggested Fix (Unified Diff Reference):**\n\`\`\`diff\n${code}\n\`\`\`\n*(Note: This recommendation includes unified diff notation spanning multiple disjoint sections. Please apply manually.)*\n`;
    } else {
      body += `**Suggested Fix:**\n\`\`\`suggestion\n${code}\n\`\`\`\n`;
    }
  }

  return body;
}

/**
 * Formats top-level PR summary markdown for GitHub comment and PR_REVIEW_REPORT.md
 */
export function toGitHubMarkdown(report: PRReviewReport): string {
  const verdictBadge =
    report.verdict === 'APPROVE'
      ? '🟢 **ALL LOOKS GOOD**'
      : report.verdict === 'APPROVE_WITH_COMMENTS'
        ? '🟡 **APPROVE WITH COMMENTS**'
        : '🔴 **CHANGES REQUESTED**';

  let md = `<!-- ai-pr-review-bot-sticky -->\n`;
  md += `## 🤖 AI Pull Request Code Review\n\n`;

  // Scorecard table
  md += `| Health Score | Letter Grade | Review Verdict | Files Changed | Total Issues |\n`;
  md += `| :---: | :---: | :---: | :---: | :---: |\n`;
  md += `| **${report.healthScore}/100** | **${report.grade}** | ${verdictBadge} | ${report.stats.filesChanged} (+${report.stats.additions}/-${report.stats.deletions}) | **${report.findings.length}** |\n\n`;

  // Tech Stack & Framework Callout
  const hasLangs = report.detectedLanguages && report.detectedLanguages.length > 0;
  const hasFws = report.detectedFrameworks && report.detectedFrameworks.length > 0;
  if (hasLangs || hasFws) {
    const parts: string[] = [];
    if (hasLangs) parts.push(`**Languages:** ${report.detectedLanguages!.join(', ')}`);
    if (hasFws) parts.push(`**Frameworks / Stacks:** \`${report.detectedFrameworks!.join('`, `')}\``);
    md += `> 🛠️ **Environment:** ${parts.join(' | ')}\n\n`;
  }

  // Issues Breakdown
  md += `### 📊 Defect Breakdown\n\n`;
  md += `| 🚨 Critical | ⚠️ High | ⚡ Medium | 🔍 Low | 💡 Informational |\n`;
  md += `| :---: | :---: | :---: | :---: | :---: |\n`;
  md += `| **${report.stats.criticalIssues}** | **${report.stats.highIssues}** | **${report.stats.mediumIssues}** | **${report.stats.lowIssues}** | **${report.stats.informationalIssues}** |\n\n`;

  // Executive Summary
  md += `### 📝 Executive Summary\n\n`;
  md += `${report.summary}\n\n`;

  // Findings Table & Details
  if (report.findings.length > 0) {
    md += `### 🔎 Review Findings\n\n`;
    md += `| # | Severity | Category | File : Line | Issue Title | Inline Comment |\n`;
    md += `| :-: | :-: | :-: | :--- | :--- | :-: |\n`;

    report.findings.forEach((f, idx) => {
      const inlineStatus = f.inDiffHunk ? '✅ Attached' : 'ℹ️ Top-level';
      const lineRange =
        f.endLineNumber && f.endLineNumber > f.lineNumber
          ? `${f.filePath}:${f.lineNumber}-${f.endLineNumber}`
          : `${f.filePath}:${f.lineNumber}`;
      md += `| ${idx + 1} | \`${f.severity}\` | ${f.category} | \`${lineRange}\` | ${f.title} | ${inlineStatus} |\n`;
    });
    md += `\n`;

    md += `### 📋 Itemized Defect Details\n\n`;
    report.findings.forEach((f, idx) => {
      const lineRange =
        f.endLineNumber && f.endLineNumber > f.lineNumber
          ? `${f.filePath}:${f.lineNumber}-${f.endLineNumber}`
          : `${f.filePath}:${f.lineNumber}`;
      md += `<details open>\n`;
      md += `<summary><b>#${idx + 1} [${f.severity}] ${f.title}</b> — <code>${lineRange}</code></summary>\n\n`;
      md += `- **Category:** \`${f.category}\`\n`;
      md += `- **Problem:** ${f.problem}\n`;
      md += `- **Why It Matters:** ${f.whyItMatters}\n`;
      if (f.recommendationDiff && f.recommendationDiff.trim().length > 0) {
        const { code, isRawDiff } = cleanSuggestionCode(f.recommendationDiff);
        if (isRawDiff) {
          md += `- **Suggested Fix (Unified Diff Reference):**\n\n\`\`\`diff\n${code}\n\`\`\`\n`;
        } else {
          md += `- **Suggested Fix:**\n\n\`\`\`suggestion\n${code}\n\`\`\`\n`;
        }
      }
      md += `</details>\n\n`;
    });
  } else {
    md += `### 🌟 Review Findings\n\n`;
    md += `> ✅ **All looks good!** No defects, security vulnerabilities, or architectural violations identified. Clean PR diff ready for merge.\n\n`;
  }

  // Footer
  md += `---\n`;
  md += `*Generated by **Universal AI PR Review Bot** powered by Google Gemini • ${report.generatedAt}*\n`;

  return md;
}


