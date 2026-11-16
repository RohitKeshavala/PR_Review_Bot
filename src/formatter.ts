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
  out += `  ${colors.bold}Files Changed:${colors.reset} ${report.stats.filesChanged} (+${report.stats.additions} / -${report.stats.deletions})\n`;
  out += `  ${colors.bold}Defects:${colors.reset}        Crit: ${report.stats.criticalIssues} | High: ${report.stats.highIssues} | Med: ${report.stats.mediumIssues} | Low: ${report.stats.lowIssues}\n\n`;

  // Summary
  out += `  ${colors.bold}Summary:${colors.reset}\n`;
  out += `  ${report.summary.replace(/\n/g, '\n  ')}\n\n`;

  // Tooling Checks
  if (report.toolingChecks.length > 0) {
    out += hr + '\n';
    out += `  ${colors.bold}Automated Tooling Checks:${colors.reset}\n`;
    for (const check of report.toolingChecks) {
      let statusStr = '';
      if (check.status === 'PASSED') {
        statusStr = `${colors.green}✔ PASSED${colors.reset}`;
      } else if (check.status === 'FAILED') {
        statusStr = `${colors.red}✖ FAILED${colors.reset}`;
      } else {
        statusStr = `${colors.dim}⊘ SKIPPED${colors.reset}`;
      }
      out += `  - ${check.name.padEnd(20)} ${statusStr.padEnd(18)} (${check.durationMs}ms)\n`;
      if (check.status === 'FAILED' && check.error) {
        out += `    ${colors.red}${check.error.split('\n')[0]}${colors.reset}\n`;
      }
    }
    out += '\n';
  }

  // Findings
  if (report.findings.length > 0) {
    out += hr + '\n';
    out += `  ${colors.bold}Itemized Review Findings (${report.findings.length}):${colors.reset}\n\n`;

    report.findings.forEach((f, idx) => {
      out += `  ${idx + 1}. [${getSeverityColor(f.severity)}] [${f.category}] ${colors.bold}${f.title}${colors.reset}\n`;
      out += `     Location: ${f.filePath}:${f.lineNumber} ${f.inDiffHunk ? `${colors.green}(In Diff Hunk)${colors.reset}` : `${colors.dim}(Outside Diff Hunk)${colors.reset}`}\n`;
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

  if (finding.recommendationDiff && finding.recommendationDiff.trim().length > 0) {
    const rec = finding.recommendationDiff.trim();
    // If already wrapped in markdown code blocks, strip them
    if (rec.startsWith('```suggestion')) {
      body += `**Suggested Fix:**\n${rec}\n`;
    } else if (rec.startsWith('```')) {
      const inner = rec.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
      body += `**Suggested Fix:**\n\`\`\`suggestion\n${inner}\n\`\`\`\n`;
    } else {
      body += `**Suggested Fix:**\n\`\`\`suggestion\n${rec}\n\`\`\`\n`;
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
      ? '🟢 **APPROVE**'
      : report.verdict === 'APPROVE_WITH_COMMENTS'
        ? '🟡 **APPROVE WITH COMMENTS**'
        : '🔴 **CHANGES REQUESTED**';

  let md = `<!-- ai-pr-review-bot-sticky -->\n`;
  md += `## 🤖 AI Pull Request Code Review\n\n`;

  // Scorecard table
  md += `| Health Score | Letter Grade | Review Verdict | Files Changed | Total Issues |\n`;
  md += `| :---: | :---: | :---: | :---: | :---: |\n`;
  md += `| **${report.healthScore}/100** | **${report.grade}** | ${verdictBadge} | ${report.stats.filesChanged} (+${report.stats.additions}/-${report.stats.deletions}) | **${report.findings.length}** |\n\n`;

  // Issues Breakdown
  md += `### 📊 Defect Breakdown\n\n`;
  md += `| 🚨 Critical | ⚠️ High | ⚡ Medium | 🔍 Low | 💡 Informational |\n`;
  md += `| :---: | :---: | :---: | :---: | :---: |\n`;
  md += `| **${report.stats.criticalIssues}** | **${report.stats.highIssues}** | **${report.stats.mediumIssues}** | **${report.stats.lowIssues}** | **${report.stats.informationalIssues}** |\n\n`;

  // Executive Summary
  md += `### 📝 Executive Summary\n\n`;
  md += `${report.summary}\n\n`;

  // Tooling Checks Table
  if (report.toolingChecks.length > 0) {
    md += `### ⚙️ Automated Workspace Checks\n\n`;
    md += `| Check | Command | Status | Duration |\n`;
    md += `| :--- | :--- | :---: | :---: |\n`;
    for (const c of report.toolingChecks) {
      const statusIcon =
        c.status === 'PASSED' ? '✅ Passed' : c.status === 'FAILED' ? '❌ Failed' : '⚪ Skipped';
      md += `| ${c.name} | \`${c.command}\` | ${statusIcon} | ${c.durationMs}ms |\n`;
    }
    md += `\n`;

    const failed = report.toolingChecks.filter((c) => c.status === 'FAILED');
    if (failed.length > 0) {
      md += `<details><summary>❌ <b>Check Failure Details</b></summary>\n\n`;
      for (const f of failed) {
        md += `**${f.name}** (\`${f.command}\`):\n\`\`\`\n${f.error || f.output}\n\`\`\`\n`;
      }
      md += `</details>\n\n`;
    }
  }

  // Findings Table & Details
  if (report.findings.length > 0) {
    md += `### 🔎 Review Findings\n\n`;
    md += `| # | Severity | Category | File : Line | Issue Title | Inline Comment |\n`;
    md += `| :-: | :-: | :-: | :--- | :--- | :-: |\n`;

    report.findings.forEach((f, idx) => {
      const inlineStatus = f.inDiffHunk ? '✅ Attached' : 'ℹ️ Top-level';
      md += `| ${idx + 1} | \`${f.severity}\` | ${f.category} | \`${f.filePath}:${f.lineNumber}\` | ${f.title} | ${inlineStatus} |\n`;
    });
    md += `\n`;

    md += `### 📋 Itemized Defect Details\n\n`;
    report.findings.forEach((f, idx) => {
      md += `<details open>\n`;
      md += `<summary><b>#${idx + 1} [${f.severity}] ${f.title}</b> — <code>${f.filePath}:${f.lineNumber}</code></summary>\n\n`;
      md += `- **Category:** \`${f.category}\`\n`;
      md += `- **Problem:** ${f.problem}\n`;
      md += `- **Why It Matters:** ${f.whyItMatters}\n`;
      if (f.recommendationDiff) {
        md += `- **Suggested Fix:**\n\n\`\`\`suggestion\n${f.recommendationDiff}\n\`\`\`\n`;
      }
      md += `</details>\n\n`;
    });
  } else {
    md += `### 🌟 Review Findings\n\n`;
    md += `> No defects or architectural violations identified. Great job!\n\n`;
  }

  // Footer
  md += `---\n`;
  md += `*Generated by **Universal AI PR Review Bot** powered by Google Gemini • ${report.generatedAt}*\n`;

  return md;
}

