import type {
  PRFinding,
  PRReviewReport,
  ResolvedCommentResolution,
  Severity,
} from './types.js';

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

export const QUALITY_GATE_STICKY_MARKER = '<!-- ai-quality-gate-sticky -->';
export const INLINE_COMMENT_MARKER_PREFIX = '<!-- ai-review-comment:';

export interface CleanedSuggestion {
  code: string;
  isSafeSuggestion: boolean;
  reason?: string;
}

/**
 * Checks if code contains unbalanced brackets, braces, or parentheses
 * that would break structural integrity if committed inline.
 */
function isDelimiterBalanced(text: string): boolean {
  let curly = 0;
  let paren = 0;
  let square = 0;
  let inStr = false;
  let strChar = '';
  let isEsc = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (isEsc) {
      isEsc = false;
      continue;
    }
    if (ch === '\\') {
      isEsc = true;
      continue;
    }

    if (inStr) {
      if (ch === strChar) {
        inStr = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true;
      strChar = ch;
      continue;
    }

    // Ignore single-line comments
    if (ch === '/' && text[i + 1] === '/') {
      const nextLine = text.indexOf('\n', i);
      if (nextLine === -1) break;
      i = nextLine;
      continue;
    }

    if (ch === '{') curly++;
    else if (ch === '}') curly--;
    else if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;

    // Closed before opened
    if (curly < 0 || paren < 0 || square < 0) {
      return false;
    }
  }

  return curly === 0 && paren === 0 && square === 0;
}

/**
 * Detects if code contains class-level members (e.g. private properties,
 * class lifecycle hooks like ngOnInit/ngOnDestroy, or decorators) that would cause
 * syntax errors (e.g. TS1068, TS2393) if applied inline inside a function or method body.
 */
function checkScopeViolation(text: string): boolean {
  const hasAccessModifiers = /(?:^|\n)\s*(?:private|protected)\s+[a-zA-Z0-9_$]+\s*[:=]/m.test(text);
  const hasClassDecorators = /(?:^|\n)\s*@(HostListener|Component|Injectable|Directive|Input|Output)\s*\(/m.test(text);
  const hasLifecycleDeclarations =
    /(?:^|\n)\s*(?:public|private|protected)?\s*(?:ngOnInit|ngOnDestroy|componentDidMount|componentWillUnmount)\s*\([^)]*\)\s*(?::\s*[a-zA-Z0-9_$<>[\]]+)?\s*\{/m.test(text);
  const hasMultipleMethods = /\bngOnInit\s*\([^)]*\)[\s\S]*\bngOnDestroy\s*\(/m.test(text);

  return hasAccessModifiers || hasClassDecorators || (hasLifecycleDeclarations && hasMultipleMethods);
}

/**
 * Cleans recommendation code to ensure structural integrity and prevent broken code:
 * - Strips outer markdown fences and diff notation headers
 * - Strips leading + from unified diff lines while preserving indentation
 * - Validates bracket/brace balance and lexical scope
 */
export function cleanSuggestionCode(raw: string): CleanedSuggestion {
  if (!raw || raw.trim().length === 0) {
    return { code: '', isSafeSuggestion: false, reason: 'Empty suggestion' };
  }

  let text = raw.replace(/^[\r\n]+/, '').replace(/[\r\n\s]+$/, '');

  // Strip outer markdown code blocks if the AI model included them
  if (text.startsWith('```')) {
    text = text.replace(/^```[^\r\n]*\r?\n/, '').replace(/\r?\n```[^\r\n]*$/, '');
  }

  // Count hunk headers (@@ -... @@)
  const hunkHeaders = text.match(/^@@\s+-\d+/gm) || [];
  if (hunkHeaders.length > 1) {
    return { code: text, isSafeSuggestion: false, reason: 'Contains multiple disjoint diff hunks' };
  }

  if (hunkHeaders.length === 1) {
    text = text.replace(/^@@.*?@@\r?\n?/m, '');
  }

  const lines = text.split(/\r?\n/);
  const hasMinus = lines.some((l) => l.startsWith('-'));
  const hasPlus = lines.some((l) => l.startsWith('+'));

  let cleanCode = text;
  if (hasMinus || hasPlus) {
    const replacementLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('+')) {
        replacementLines.push(line.replace(/^\+\s?/, ''));
      } else if (!line.startsWith('-')) {
        replacementLines.push(line.startsWith(' ') ? line.substring(1) : line);
      }
    }
    cleanCode = replacementLines.join('\n');
  }

  if (checkScopeViolation(cleanCode)) {
    return {
      code: cleanCode,
      isSafeSuggestion: false,
      reason: 'Contains class-level properties or lifecycle methods that cannot be applied inline',
    };
  }

  if (!isDelimiterBalanced(cleanCode)) {
    return {
      code: cleanCode,
      isSafeSuggestion: false,
      reason: 'Contains unbalanced brackets/braces that would break code structure if applied directly',
    };
  }

  return { code: cleanCode, isSafeSuggestion: true };
}

/**
 * Formats individual finding for GitHub inline review comments matching Image 2
 */
export function toInlineComment(finding: PRFinding, defectId?: string): string {
  const idStr = defectId || finding.id || `defect-${finding.lineNumber}`;
  const severityEmojis: Record<Severity, string> = {
    CRITICAL: '🚨',
    HIGH: '🔴',
    MEDIUM: '⚡',
    LOW: '🔍',
    INFORMATIONAL: '💡',
  };

  const emoji = severityEmojis[finding.severity] || '🔴';
  let body = `<!-- ai-review-comment: id=${idStr}, status=active, severity=${finding.severity}, category=${finding.category} -->\n`;
  body += `${emoji} **${finding.title}**\n\n`;

  // Finding detail collapsible section
  body += `<details open>\n<summary>Finding detail</summary>\n\n`;
  body += `${finding.problem}\n\n`;
  body += `**Impact:** ${finding.whyItMatters}\n\n`;

  let suggestedFixText = 'See recommendation below.';
  if (finding.recommendationDiff && finding.recommendationDiff.trim().length > 0) {
    const { code, isSafeSuggestion, reason } = cleanSuggestionCode(finding.recommendationDiff);
    if (isSafeSuggestion) {
      suggestedFixText = 'Apply suggested fix below:';
      body += `**Suggested fix:** ${suggestedFixText}\n</details>\n\n`;
      body += `\`\`\`suggestion\n${code}\n\`\`\`\n`;
      return body;
    } else {
      suggestedFixText = reason ? `(${reason})` : '';
      body += `**Suggested fix:** ${suggestedFixText}\n\n\`\`\`typescript\n${code}\n\`\`\`\n</details>\n`;
      return body;
    }
  } else {
    body += `**Suggested fix:** Manual review required.\n</details>\n`;
    return body;
  }
}

/**
 * Formats an updated inline comment body when a defect has been resolved (Option A)
 */
export function formatResolvedComment(
  existingBody: string,
  resolution: ResolvedCommentResolution,
  shortCommitSha: string,
): string {
  // Update or insert status tag
  let cleanExisting = existingBody;
  cleanExisting = cleanExisting.replace(
    /<!-- ai-review-comment:\s*id=([^,]+),\s*status=[^,]+(.*?)-->/,
    `<!-- ai-review-comment: id=$1, status=resolved, resolved_in=${shortCommitSha}$2 -->`,
  );

  let resolvedHeader = `✅ **Resolved in ${shortCommitSha}**.\n\n`;

  if (resolution.fixDiffSnippet && resolution.fixDiffSnippet.trim().length > 0) {
    let diffCode = resolution.fixDiffSnippet.trim();
    if (diffCode.startsWith('```')) {
      diffCode = diffCode.replace(/^```[^\r\n]*\r?\n/, '').replace(/\r?\n```[^\r\n]*$/, '');
    }
    resolvedHeader += `<details open>\n<summary>Changes that fixed it</summary>\n\n\`\`\`diff\n${diffCode}\n\`\`\`\n</details>\n\n---\n\n`;
  } else if (resolution.explanation) {
    resolvedHeader += `> *${resolution.explanation}*\n\n---\n\n`;
  }

  // Prepend resolved header to existing comment content
  return `${resolvedHeader}${cleanExisting}`;
}

/**
 * Formats the single top-level PR Quality Gate comment matching Image 1
 */
export function toQualityGateMarkdown(report: PRReviewReport): string {
  const isBlocked = report.indicators.blockerCount > 0;
  const header = isBlocked
    ? `### ❌ AI quality gate: not ready to merge`
    : `### ✅ AI quality gate: good to merge`;

  const summary = isBlocked
    ? `${report.indicators.blockerCount} blocker(s) identified. Merge must be blocked.`
    : `All checks passed. Ready to merge.`;

  // Quality Gate indicators bar
  const reviewsBadge = report.indicators.reviews === 'pass' ? '✅ Reviews' : '🔴 Reviews';
  const testsBadge = report.indicators.tests === 'pass' ? '✅ Tests' : '⚠️ Tests';
  const obsBadge = report.indicators.observability === 'pass' ? '✅ Observability' : '⚠️ Observability';
  const indicatorsBar = `${reviewsBadge} · ${testsBadge} · ${obsBadge}`;

  let md = `${QUALITY_GATE_STICKY_MARKER}\n`;
  md += `${header}\n\n`;
  md += `${summary}\n\n`;

  // Tech stack & environment callout
  const hasLangs = report.detectedLanguages && report.detectedLanguages.length > 0;
  const hasFws = report.detectedFrameworks && report.detectedFrameworks.length > 0;
  if (hasLangs || hasFws) {
    const parts: string[] = [];
    if (hasLangs) parts.push(`**Languages:** ${report.detectedLanguages!.join(', ')}`);
    if (hasFws) parts.push(`**Frameworks / Stacks:** \`${report.detectedFrameworks!.join('`, `')}\``);
    md += `> 🛠️ **Environment:** ${parts.join(' | ')}\n\n`;
  }

  md += `${indicatorsBar}\n\n`;

  // Active blockers & findings
  const blockers = report.findings.filter(
    (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH' || f.severity === 'MEDIUM',
  );
  const worthALook = report.findings.filter((f) => f.severity === 'LOW');
  const infoFindings = report.findings.filter((f) => f.severity === 'INFORMATIONAL');

  if (blockers.length > 0) {
    md += `#### 🔴 Must fix before merge\n`;
    for (const f of blockers) {
      const lineStr = f.endLineNumber && f.endLineNumber > f.lineNumber
        ? `${f.lineNumber}-${f.endLineNumber}`
        : `${f.lineNumber}`;
      const fileLink = buildFileLink(report.repository, report.prNumber, report.commitSha, f.filePath, f.lineNumber);
      md += `• **${f.title}** · [${f.filePath}:${lineStr}](${fileLink}) ↗\n`;
    }
    md += `\n`;
  }

  if (worthALook.length > 0) {
    md += `#### 👀 Worth a look\n`;
    for (const f of worthALook) {
      const lineStr = f.endLineNumber && f.endLineNumber > f.lineNumber
        ? `${f.lineNumber}-${f.endLineNumber}`
        : `${f.lineNumber}`;
      const fileLink = buildFileLink(report.repository, report.prNumber, report.commitSha, f.filePath, f.lineNumber);
      md += `• ${f.title} · [${f.filePath}:${lineStr}](${fileLink}) ↗\n`;
    }
    md += `\n`;
  }

  if (infoFindings.length > 0 && blockers.length === 0 && worthALook.length === 0) {
    md += `#### 💡 Informational\n`;
    for (const f of infoFindings) {
      const lineStr = f.endLineNumber && f.endLineNumber > f.lineNumber
        ? `${f.lineNumber}-${f.endLineNumber}`
        : `${f.lineNumber}`;
      const fileLink = buildFileLink(report.repository, report.prNumber, report.commitSha, f.filePath, f.lineNumber);
      md += `• ${f.title} · [${f.filePath}:${lineStr}](${fileLink}) ↗\n`;
    }
    md += `\n`;
  }

  // Collapsible Resolved findings section
  if (report.resolvedFindings && report.resolvedFindings.length > 0) {
    md += `<details>\n<summary>✅ ${report.resolvedFindings.length} resolved</summary>\n\n`;
    for (const rf of report.resolvedFindings) {
      const lineStr = rf.endLineNumber && rf.endLineNumber > (rf.lineNumber || 0)
        ? `${rf.lineNumber}-${rf.endLineNumber}`
        : `${rf.lineNumber || 1}`;
      const resolvedCommit = rf.resolvedInCommit || report.shortCommitSha;
      const explanationText = rf.explanation ? ` — *${rf.explanation}*` : '';
      md += `• ~~${rf.title}~~ · \`${rf.filePath}:${lineStr}\` *(Resolved in ${resolvedCommit})*${explanationText}\n`;
    }
    md += `\n</details>\n\n`;
  }

  // Footer matching Image 1
  const runLink = report.runUrl
    ? `[Workflow run](${report.runUrl})`
    : `Workflow run`;
  md += `---\n${runLink} · reviewed \`${report.shortCommitSha}\`\n`;

  return md;
}

/**
 * Builds a direct link to a file and line on GitHub PR
 */
function buildFileLink(
  repo?: string,
  prNumber?: number,
  commitSha?: string,
  filePath?: string,
  lineNumber?: number,
): string {
  if (!filePath) return '#';
  if (repo && prNumber) {
    return `https://github.com/${repo}/pull/${prNumber}/files`;
  }
  if (repo && commitSha) {
    return `https://github.com/${repo}/blob/${commitSha}/${filePath}#L${lineNumber || 1}`;
  }
  return `#`;
}

/**
 * Formats report for terminal / ANSI output
 */
export function toConsole(report: PRReviewReport): string {
  const doubleHr = `${colors.bold}${'═'.repeat(70)}${colors.reset}`;
  const hr = `${colors.dim}${'─'.repeat(70)}${colors.reset}`;

  let out = '\n' + doubleHr + '\n';
  out += ` ${colors.bold}${colors.cyan}🤖 AI QUALITY GATE REPORT${colors.reset}\n`;
  out += doubleHr + '\n\n';

  const verdictText =
    report.verdict === 'APPROVE'
      ? `${colors.bgGreen}${colors.white}${colors.bold} PASS (Ready to Merge) ${colors.reset}`
      : `${colors.bgRed}${colors.white}${colors.bold} FAIL (Merge Blocked) ${colors.reset}`;

  out += `  ${colors.bold}Verdict:${colors.reset}       ${verdictText}\n`;
  out += `  ${colors.bold}Blockers:${colors.reset}      ${report.indicators.blockerCount}\n`;
  out += `  ${colors.bold}Reviewed Commit:${colors.reset} ${report.shortCommitSha}\n`;
  if (report.detectedLanguages && report.detectedLanguages.length > 0) {
    out += `  ${colors.bold}Languages:${colors.reset}     ${report.detectedLanguages.join(', ')}\n`;
  }
  if (report.detectedFrameworks && report.detectedFrameworks.length > 0) {
    out += `  ${colors.bold}Frameworks:${colors.reset}    ${colors.cyan}${report.detectedFrameworks.join(', ')}${colors.reset}\n`;
  }
  out += `  ${colors.bold}Files Changed:${colors.reset} ${report.stats.filesChanged} (+${report.stats.additions} / -${report.stats.deletions})\n\n`;

  out += `  ${colors.bold}Summary:${colors.reset}\n`;
  out += `  ${report.summary.replace(/\n/g, '\n  ')}\n\n`;

  if (report.findings.length > 0) {
    out += hr + '\n';
    out += `  ${colors.bold}Active Defects (${report.findings.length}):${colors.reset}\n\n`;
    report.findings.forEach((f, idx) => {
      out += `  ${idx + 1}. [${f.severity}] ${colors.bold}${f.title}${colors.reset} (${f.filePath}:${f.lineNumber})\n`;
      out += `     Problem: ${f.problem}\n`;
      if (f.recommendationDiff) {
        out += `     Fix: ${f.recommendationDiff.trim().split('\n')[0]}...\n`;
      }
      out += '\n';
    });
  } else {
    out += `  ${colors.green}✔ No defects identified. Clean PR diff!${colors.reset}\n\n`;
  }

  if (report.resolvedFindings && report.resolvedFindings.length > 0) {
    out += hr + '\n';
    out += `  ${colors.bold}${colors.green}✅ Resolved Defects (${report.resolvedFindings.length}):${colors.reset}\n\n`;
    report.resolvedFindings.forEach((rf, idx) => {
      out += `  ${idx + 1}. ~~${rf.title}~~ (${rf.filePath}:${rf.lineNumber}) - Resolved in ${rf.resolvedInCommit || report.shortCommitSha}\n`;
    });
    out += '\n';
  }

  out += doubleHr + '\n';
  return out;
}
