import fs from 'node:fs';
import path from 'node:path';
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
  ResolvedCommentResolution,
  Severity,
} from './types.js';

/**
 * Creates an authenticated Octokit client
 */
export function getOctokitClient(token: string): Octokit {
  return new Octokit({
    auth: token,
    userAgent: 'universal-pr-review-bot/2.0.0',
  });
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
 * Fetches all review comments posted by this bot on the PR and partitions them into active and resolved
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
    const commentsResp = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    for (const c of commentsResp.data) {
      const body = c.body || '';
      // Only process comments originating from our bot
      if (!body.includes(INLINE_COMMENT_MARKER_PREFIX)) {
        continue;
      }

      // Parse metadata marker: <!-- ai-review-comment: id=defect-1, status=active, severity=HIGH, category=Security -->
      const markerMatch = body.match(
        /<!-- ai-review-comment:\s*id=([^,]+),\s*status=([^,]+)(?:,\s*severity=([^,]+))?(?:,\s*category=([^,]+))?(?:,\s*resolved_in=([^,]+))?(?:.*?)-->/,
      );

      const status = markerMatch && markerMatch[2] ? (markerMatch[2].trim() as 'active' | 'resolved') : 'active';
      const severity = markerMatch && markerMatch[3] ? (markerMatch[3].trim() as Severity) : 'MEDIUM';
      const category = markerMatch && markerMatch[4] ? (markerMatch[4].trim() as FindingCategory) : 'Maintainability';
      const resolvedInCommit = markerMatch && markerMatch[5] ? markerMatch[5].trim() : undefined;

      // Extract title: e.g. 🔴 **Hardcoded Guid.Empty for new announcements**
      const titleMatch = body.match(/(?:🚨|🔴|⚡|🔍|💡)?\s*\*\*([^*]+)\*\*/);
      const title = titleMatch ? titleMatch[1].trim() : 'Review Finding';

      // Extract problem detail from <summary>Finding detail</summary>
      const problemMatch = body.match(/<summary>Finding detail<\/summary>\s*([\s\S]*?)(?:\n\n\*\*Impact:|\n<\/details>)/);
      const problem = problemMatch ? problemMatch[1].trim() : '';

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

      if (status === 'resolved' || body.includes('✅ **Resolved in')) {
        resolvedComments.push({ ...botComment, status: 'resolved' });
      } else {
        activeComments.push(botComment);
      }
    }
  } catch (err) {
    console.warn(`⚠️ Warning: Could not list review comments: ${err}`);
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
    const commentsResp = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });

    const existingComment = commentsResp.data.find(
      (c) =>
        c.body &&
        (c.body.includes(QUALITY_GATE_STICKY_MARKER) || c.body.includes('AI quality gate')),
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
