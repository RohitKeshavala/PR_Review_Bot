import fs from 'node:fs';
import path from 'node:path';
import { retry } from '@octokit/plugin-retry';
import { Octokit } from '@octokit/rest';
import {
  formatResolvedComment,
  INLINE_COMMENT_MARKER_PREFIX,
  QUALITY_GATE_STICKY_MARKER,
  toInlineComment,
} from './formatter.js';
import { normalizePath } from './git-service.js';
import type {
  BotReviewComment,
  FindingCategory,
  PRFinding,
  PRReviewReport,
  ResolvedCommentResolution,
  Severity,
} from './types.js';

const RetryOctokit = Octokit.plugin(retry);

/**
 * Creates an authenticated Octokit client with automatic rate-limit and network retry handling
 */
export function getOctokitClient(token: string): Octokit {
  return new RetryOctokit({
    auth: token,
    userAgent: 'universal-pr-review-bot/2.0.0',
    retry: {
      enabled: true,
      retries: 3,
      retryAfterBaseValue: 1000,
      doNotRetry: [400, 401, 404, 422],
    },
  }) as unknown as Octokit;
}

/**
 * Parses GitHub repository string ("owner/repo") into components
 */
export function parseRepoString(repoString?: string): { owner: string; repo: string } {
  if (!repoString || !repoString.includes('/')) {
    throw new Error(`Invalid GitHub repository format: "${repoString}". Expected "owner/repo".`);
  }
  const [owner, repo] = repoString.split('/');
  return { owner, repo };
}

/**
 * Pulls PR unified diff text via GitHub REST API
 */
export async function fetchRemotePullRequestDiff(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string> {
  const octokit = getOctokitClient(token);

  try {
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      headers: {
        accept: 'application/vnd.github.v3.diff',
      },
    });

    return response.data as unknown as string;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch PR diff for ${owner}/${repo}#${pullNumber}: ${message}`);
  }
}

/**
 * Fetches PR head commit SHA via GitHub REST API
 */
export async function fetchPullRequestHeadCommit(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ commitSha: string; shortCommitSha: string }> {
  const octokit = getOctokitClient(token);

  try {
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const commitSha = response.data.head.sha;
    const shortCommitSha = commitSha.slice(0, 7);
    return { commitSha, shortCommitSha };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ Could not fetch PR head commit from GitHub API: ${message}`);
    return { commitSha: '', shortCommitSha: '' };
  }
}

/**
 * Fetches all review comments posted by this bot on the PR and partitions them into active and resolved.
 * Robust parser handles both new comments with metadata markers and existing bot comments.
 */
export async function fetchExistingBotReviewComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{
  activeComments: BotReviewComment[];
  resolvedComments: BotReviewComment[];
}> {
  const octokit = getOctokitClient(token);
  const activeComments: BotReviewComment[] = [];
  const resolvedComments: BotReviewComment[] = [];

  try {
    const reviewComments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    for (const c of reviewComments) {
      const body = c.body || '';

      // Identify bot comments: by marker, by Finding detail section, or by Suggested fix block
      const isBotComment =
        body.includes(INLINE_COMMENT_MARKER_PREFIX) ||
        body.includes('Finding detail') ||
        body.includes('Suggested fix') ||
        body.includes('Suggested change') ||
        body.includes('<!-- ai-review-comment');

      if (!isBotComment) {
        continue;
      }

      // Parse metadata marker order-independently:
      // <!-- ai-review-comment: id=defect-1, status=active, severity=HIGH, category=Security -->
      const markerBlockMatch = body.match(/<!--\s*ai-review-comment:\s*([\s\S]*?)-->/);
      const markerAttrs = markerBlockMatch ? markerBlockMatch[1] : '';
      const getMarkerAttr = (key: string): string | undefined => {
        const attrMatch = markerAttrs.match(new RegExp(`(?:^|,)\\s*${key}=([^,]+)`, 'i'));
        return attrMatch ? attrMatch[1].trim() : undefined;
      };

      const rawStatus = getMarkerAttr('status')?.toLowerCase();
      let status: 'active' | 'resolved' = rawStatus === 'resolved' ? 'resolved' : 'active';

      const validSeverities = new Set<Severity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL']);
      const rawSeverity = getMarkerAttr('severity')?.toUpperCase() as Severity | undefined;
      let severity: Severity;
      if (rawSeverity && validSeverities.has(rawSeverity)) {
        severity = rawSeverity;
      } else {
        // Fallback inference from severity badge/pill or emoji if marker attribute is missing
        const badgeMatch = body.match(/(?:\[|`)(CRITICAL|HIGH|MEDIUM|LOW|INFORMATIONAL)(?:\]|`)/i);
        if (badgeMatch) {
          severity = badgeMatch[1].toUpperCase() as Severity;
        } else if (body.includes('🚨')) {
          severity = 'CRITICAL';
        } else if (body.includes('🔴')) {
          severity = 'HIGH';
        } else if (body.includes('🟠') || body.includes('⚡')) {
          severity = 'MEDIUM';
        } else if (body.includes('🟡') || body.includes('🔍')) {
          severity = 'LOW';
        } else if (body.includes('💡')) {
          severity = 'INFORMATIONAL';
        } else {
          severity = 'MEDIUM';
        }
      }

      const category: FindingCategory =
        (getMarkerAttr('category') as FindingCategory | undefined) || 'Maintainability';
      const resolvedInCommit = getMarkerAttr('resolved_in');

      // Extract title: handles "🟠 `MEDIUM` **Title**", "⚡ **[MEDIUM] Title**", "⚡ **Title**", etc.
      let title = 'Review Finding';
      const titleMatch =
        body.match(/(?:🚨|🔴|🟠|🟡|⚡|🔍|💡)\s*(?:`[^`]+`\s*)?(?:\*\*\[[^\]]+\]\*\*\s*)?\*\*([^*\r\n]+)\*\*/) ||
        body.match(/(?:🚨|🔴|🟠|🟡|⚡|🔍|💡)\s*([^\r\n<]+)/) ||
        body.match(/\*\*([^*\r\n]+)\*\*/);
      if (titleMatch) {
        title = titleMatch[1]
          .replace(/^[#* \t]+/, '')
          .replace(/[#* \t]+$/, '')
          .replace(/^(?:\[|`)(?:CRITICAL|HIGH|MEDIUM|LOW|INFORMATIONAL)(?:\]|`)\s*/i, '')
          .trim();
      }

      // Extract problem detail: from <summary>Finding detail</summary> or plain Finding detail text
      let problem = '';
      const problemMatch =
        body.match(/<summary>Finding detail<\/summary>\s*([\s\S]*?)(?:\n\n(?:\*\*)?Impact(?:\*\*)?:|\n<\/details>)/i) ||
        body.match(/Finding detail\s*[\r\n]+([\s\S]*?)(?:\n\n(?:\*\*)?Impact(?:\*\*)?:|\n\n(?:\*\*)?Suggested fix(?:\*\*)?:|\n<\/details>)/i);
      if (problemMatch) {
        problem = problemMatch[1].trim();
      }

      // Detect if comment is marked resolved (either in marker or in body header)
      if (body.includes('✅ **Resolved in') || body.includes('✅ Resolved in')) {
        status = 'resolved';
      }

      const botComment: BotReviewComment = {
        id: c.id,
        path: normalizePath(c.path),
        line: c.line || c.original_line || 1,
        start_line: c.start_line || c.original_start_line || undefined,
        body,
        title,
        problem,
        severity,
        category,
        status,
        resolvedInCommit,
      };

      if (status === 'resolved') {
        resolvedComments.push(botComment);
      } else {
        activeComments.push(botComment);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to list existing review comments from GitHub after retries: ${msg}`);
  }

  return { activeComments, resolvedComments };
}

/**
 * Creates new inline review comments on GitHub only for brand-new findings
 */
export async function postNewInlineComments(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  newFindings: PRFinding[],
  dryRun = false,
): Promise<number[]> {
  const createdIds: number[] = [];

  const eligibleFindings = newFindings.filter((f) => f.inDiffHunk && f.lineNumber > 0);
  if (eligibleFindings.length === 0) {
    return createdIds;
  }

  if (dryRun) {
    console.log(`[DRY-RUN] Would create ${eligibleFindings.length} new inline comment(s) on GitHub.`);
    return createdIds;
  }

  const octokit = getOctokitClient(token);

  for (const finding of eligibleFindings) {
    const isMultiLine = Boolean(finding.endLineNumber && finding.endLineNumber > finding.lineNumber);
    const line = isMultiLine ? finding.endLineNumber! : finding.lineNumber;
    const startLine = isMultiLine ? finding.lineNumber : undefined;

    const body = toInlineComment(finding);

    try {
      console.log(`Posting inline review comment on ${finding.filePath}:${line} (${finding.severity})...`);
      const createParams: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id: string;
        path: string;
        line: number;
        body: string;
        side: 'RIGHT';
        start_line?: number;
        start_side?: 'RIGHT';
      } = {
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitSha,
        path: normalizePath(finding.filePath),
        line,
        side: 'RIGHT',
        body,
      };

      if (isMultiLine && startLine) {
        createParams.start_line = startLine;
        createParams.start_side = 'RIGHT';
      }

      const res = await octokit.rest.pulls.createReviewComment(createParams);
      createdIds.push(res.data.id);
      console.log(`✔ Created inline comment (ID: ${res.data.id}) on ${finding.filePath}:${line}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ Failed to post inline comment on ${finding.filePath}:${line}: ${msg}`);
    }
  }

  return createdIds;
}

/**
 * Updates existing inline comments directly when defects are verified resolved (Option A)
 */
export async function updateResolvedInlineComments(
  token: string,
  owner: string,
  repo: string,
  resolvedResolutions: ResolvedCommentResolution[],
  activeBotComments: BotReviewComment[],
  shortCommitSha: string,
  dryRun = false,
): Promise<void> {
  if (resolvedResolutions.length === 0) {
    return;
  }

  if (dryRun) {
    console.log(
      `[DRY-RUN] Would update ${resolvedResolutions.length} resolved comment(s) with 'Resolved in ${shortCommitSha}'.`,
    );
    return;
  }

  const octokit = getOctokitClient(token);

  for (const res of resolvedResolutions) {
    const existing = activeBotComments.find((c) => c.id === res.commentId);
    if (!existing) {
      continue;
    }

    const updatedBody = formatResolvedComment(existing.body, res, shortCommitSha);

    try {
      console.log(`Updating inline comment (ID: ${res.commentId}) to mark as Resolved in ${shortCommitSha}...`);
      await octokit.rest.pulls.updateReviewComment({
        owner,
        repo,
        comment_id: res.commentId,
        body: updatedBody,
      });
      console.log(`✔ Successfully marked comment (ID: ${res.commentId}) as Resolved in ${shortCommitSha}.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ Warning: Could not update comment (ID: ${res.commentId}): ${msg}`);
    }
  }
}

/**
 * Finds or creates the single persistent Quality Gate comment on the PR issue
 */
export async function syncQualityGateStickyComment(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  markdownBody: string,
  dryRun = false,
): Promise<void> {
  if (dryRun) {
    const payloadPath = path.resolve(process.cwd(), 'PR_REVIEW_GITHUB_PAYLOAD.json');
    fs.writeFileSync(payloadPath, JSON.stringify({ markdownBody }, null, 2), 'utf-8');
    console.log(`[DRY-RUN] Saved Quality Gate markdown report to: ${payloadPath}`);
    return;
  }

  const octokit = getOctokitClient(token);

  try {
    const issueComments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });

    const existingComment =
      issueComments.find((c) => c.body?.includes(QUALITY_GATE_STICKY_MARKER)) ||
      issueComments.find(
        (c) =>
          Boolean(c.body?.includes('AI quality gate:')) &&
          (Boolean(c.user?.login?.endsWith('[bot]')) || c.user?.login === 'github-actions[bot]'),
      );

    if (existingComment) {
      console.log(`Updating existing Quality Gate PR comment (ID: ${existingComment.id}) in-place...`);
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body: markdownBody,
      });
      console.log(`✔ Successfully updated Quality Gate comment (ID: ${existingComment.id}) in-place.`);
    } else {
      console.log(`Creating initial Quality Gate PR comment on ${owner}/${repo}#${pullNumber}...`);
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: markdownBody,
      });
      console.log(`✔ Successfully created initial Quality Gate PR comment.`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ Warning: Failed to sync Quality Gate sticky comment: ${msg}`);
  }
}

/**
 * Submits a formal GitHub Pull Request Review verdict (APPROVE / CHANGES_REQUESTED / COMMENT).
 * This ensures the GitHub review status, verdict badge, and reviewer state are properly registered.
 */
export async function submitPullRequestReviewVerdict(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
  report: PRReviewReport,
  dryRun = false,
): Promise<void> {
  let targetEvent: 'REQUEST_CHANGES' | 'APPROVE' | 'COMMENT';
  if (report.verdict === 'CHANGES_REQUESTED') {
    targetEvent = 'REQUEST_CHANGES';
  } else if (report.verdict === 'APPROVE') {
    targetEvent = 'APPROVE';
  } else {
    targetEvent = 'COMMENT';
  }

  const verdictText =
    report.verdict === 'APPROVE'
      ? '✅ **APPROVE** (Ready to merge)'
      : report.verdict === 'APPROVE_WITH_COMMENTS'
        ? '⚠️ **APPROVE WITH COMMENTS**'
        : '❌ **CHANGES REQUESTED** (Merge blocked)';

  let reviewBody = `### AI PR Review Verdict: ${verdictText}\n\n`;
  reviewBody += `${report.summary}\n\n`;

  const blockers = report.findings.filter(
    (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH' || f.severity === 'MEDIUM',
  );
  if (blockers.length > 0) {
    reviewBody += `* **Active Blockers:** ${blockers.length} issue(s) must be fixed before merge.\n`;
  }
  if (report.resolvedFindings && report.resolvedFindings.length > 0) {
    reviewBody += `* **Resolved Issues:** ${report.resolvedFindings.length} issue(s) verified resolved.\n`;
  }
  reviewBody += `\n*See the persistent Quality Gate status comment at the top of the PR conversation and inline code comments for full details.*`;

  if (dryRun) {
    console.log(
      `[DRY-RUN] Would submit GitHub PR Review (${targetEvent}) on commit ${commitSha || 'latest'}.`,
    );
    return;
  }

  const octokit = getOctokitClient(token);

  let currentLogin = 'github-actions[bot]';
  try {
    const userResp = await octokit.rest.users.getAuthenticated();
    if (userResp.data?.login) {
      currentLogin = userResp.data.login;
    }
  } catch {
    // Default to github-actions[bot]
  }

  const targetStateMap: Record<string, string> = {
    REQUEST_CHANGES: 'CHANGES_REQUESTED',
    APPROVE: 'APPROVED',
    COMMENT: 'COMMENTED',
  };
  const expectedState = targetStateMap[targetEvent] || 'COMMENTED';

  let existingBotReviews: Array<{ id: number; state: string; commit_id?: string | null }> = [];
  try {
    const allReviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    existingBotReviews = allReviews.filter(
      (r) =>
        r.user?.login === currentLogin ||
        r.user?.login === 'github-actions[bot]' ||
        Boolean(r.user?.login?.endsWith('[bot]')),
    );
  } catch (listErr: unknown) {
    const msg = listErr instanceof Error ? listErr.message : String(listErr);
    console.warn(`⚠️ Warning: Could not list existing PR reviews: ${msg}`);
  }

  const latestReview =
    existingBotReviews.length > 0 ? existingBotReviews[existingBotReviews.length - 1] : undefined;

  // If a review already exists and state matches, update the existing review in-place
  if (latestReview && latestReview.state === expectedState) {
    try {
      console.log(
        `Updating existing PR Review (ID: ${latestReview.id}, State: ${latestReview.state}) body...`,
      );
      await octokit.rest.pulls.updateReview({
        owner,
        repo,
        pull_number: pullNumber,
        review_id: latestReview.id,
        body: reviewBody,
      });
      console.log(`✔ Successfully updated PR Review (ID: ${latestReview.id}) in-place.`);
      return;
    } catch (updateErr: unknown) {
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      console.warn(
        `⚠️ Warning: Could not update existing review (ID: ${latestReview.id}): ${msg}. Submitting new review instead.`,
      );
    }
  }

  // Otherwise, submit a new formal review (first review, state changed, or update fallback)
  const submitReview = async (eventToSubmit: 'REQUEST_CHANGES' | 'APPROVE' | 'COMMENT') => {
    const params: {
      owner: string;
      repo: string;
      pull_number: number;
      event: 'REQUEST_CHANGES' | 'APPROVE' | 'COMMENT';
      body: string;
      commit_id?: string;
    } = {
      owner,
      repo,
      pull_number: pullNumber,
      event: eventToSubmit,
      body: reviewBody,
    };
    if (commitSha) {
      params.commit_id = commitSha;
    }
    return await octokit.rest.pulls.createReview(params);
  };

  try {
    console.log(`Submitting formal PR Review (${targetEvent}) on commit ${commitSha || 'latest'}...`);
    const res = await submitReview(targetEvent);
    console.log(`✔ Successfully submitted PR Review (ID: ${res.data.id}, Event: ${targetEvent}).`);
  } catch (primaryErr: unknown) {
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.warn(`⚠️ Warning: Could not submit review as ${targetEvent}: ${msg}`);

    // If APPROVE or REQUEST_CHANGES failed (e.g. permissions, reviewing own PR), fallback to COMMENT
    if (targetEvent !== 'COMMENT') {
      try {
        console.log(`Retrying review submission as COMMENT...`);
        const fallbackRes = await submitReview('COMMENT');
        console.log(`✔ Gracefully submitted PR Review as COMMENT (ID: ${fallbackRes.data.id}).`);
      } catch (fallbackErr: unknown) {
        const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        console.warn(`⚠️ Warning: Fallback review submission as COMMENT also failed: ${fallbackMsg}`);
      }
    }
  }
}
