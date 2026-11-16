import fs from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import { toInlineComment } from './formatter.js';
import { normalizePath } from './git-service.js';
import type { PRReviewReport, ReviewComment, ReviewPayload } from './types.js';

const STICKY_COMMENT_MARKER = '<!-- ai-pr-review-bot-sticky -->';
const REVIEW_TITLE_MARKER = 'AI Pull Request Code Review';

/**
 * Creates an authenticated Octokit client
 */
export function getOctokitClient(token: string): Octokit {
  return new Octokit({
    auth: token,
    userAgent: 'universal-pr-review-bot/1.0.0',
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
 * Submits formal pull request review with inline comments and 422 safety fallback
 */
export async function submitPullRequestReview(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  report: PRReviewReport,
  markdownSummary: string,
  dryRun = false,
): Promise<void> {
  // Map internal review verdict to GitHub event.
  // Instead of a direct formal 'APPROVE' (which GitHub Actions default token forbids),
  // submit as 'COMMENT' with a clear, positive "All looks good" review summary.
  let event: 'REQUEST_CHANGES' | 'COMMENT';
  if (report.verdict === 'CHANGES_REQUESTED') {
    event = 'REQUEST_CHANGES';
  } else {
    event = 'COMMENT';
  }

  // Filter inline comments to only findings validated to be within diff hunks
  const inlineComments: ReviewComment[] = report.findings
    .filter((f) => f.inDiffHunk && f.lineNumber > 0)
    .map((f) => ({
      path: normalizePath(f.filePath),
      line: f.lineNumber,
      side: 'RIGHT' as const,
      body: toInlineComment(f),
    }));

  const payload: ReviewPayload = {
    owner,
    repo,
    pull_number: pullNumber,
    event,
    body: markdownSummary,
    comments: inlineComments.length > 0 ? inlineComments : undefined,
  };

  if (dryRun) {
    const payloadPath = path.resolve(process.cwd(), 'PR_REVIEW_GITHUB_PAYLOAD.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`[DRY-RUN] Saved GitHub Review payload to: ${payloadPath}`);
    return;
  }

  const octokit = getOctokitClient(token);

  // Helper to post review safely
  const attemptReview = async (reviewEvent: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', withComments: boolean) => {
    return await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: reviewEvent,
      body: markdownSummary,
      comments: withComments && inlineComments.length > 0 ? inlineComments : undefined,
    });
  };

  // 1. Primary Attempt (Original Event + Inline Comments)
  try {
    console.log(`Submitting formal PR Review (${event}) with ${inlineComments.length} inline comments...`);
    await attemptReview(event, true);
    console.log(`✔ Successfully posted PR Review to ${owner}/${repo}#${pullNumber}`);
    return;
  } catch (primaryErr: unknown) {
    const errorMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.warn(`⚠️ Warning: Primary review submission failed (${errorMsg}). Attempting fallback...`);

    // 2. Fallback Attempt 1: Retry with 'COMMENT'
    const fallbackEvent = 'COMMENT' as const;

    try {
      console.log(`Retrying PR Review submission as (${fallbackEvent}) with inline comments...`);
      await attemptReview(fallbackEvent, true);
      console.log(`✔ Gracefully posted PR Review as (${fallbackEvent}) to ${owner}/${repo}#${pullNumber}`);
      return;
    } catch (secondErr: unknown) {
      const secondMsg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      console.warn(`⚠️ Warning: Secondary review submission failed (${secondMsg}). Retrying without inline comments...`);
    }

    // 3. Fallback Attempt 2: Post review without inline comments (avoids 422 line mismatches)
    try {
      console.log(`Retrying PR Review submission as (${fallbackEvent}) without inline comments...`);
      await attemptReview(fallbackEvent, false);
      console.log(`✔ Gracefully posted PR Review (top-level summary) to ${owner}/${repo}#${pullNumber}`);
      return;
    } catch (thirdErr: unknown) {
      const thirdMsg = thirdErr instanceof Error ? thirdErr.message : String(thirdErr);
      console.warn(`⚠️ Warning: Formal PR review failed (${thirdMsg}). Falling back to PR issue comment...`);
    }

    // 4. Final Fallback: Post as a standard PR issue comment
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: markdownSummary,
      });
      console.log(`✔ Successfully posted PR Review as top-level comment to ${owner}/${repo}#${pullNumber}`);
    } catch (finalErr: unknown) {
      const finalMsg = finalErr instanceof Error ? finalErr.message : String(finalErr);
      console.error(`❌ Error: All review posting methods failed: ${finalMsg}`);
    }
  }
}

/**
 * Searches existing issue comments for "AI Pull Request Code Review" and updates in-place
 * to prevent PR thread spam across multiple commits.
 */
export async function postOrUpdateStickyComment(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
  dryRun = false,
): Promise<void> {
  if (dryRun) {
    console.log(`[DRY-RUN] Skipped sticky comment post/update to ${owner}/${repo}#${pullNumber}`);
    return;
  }

  const octokit = getOctokitClient(token);

  try {
    // List comments on the PR (PRs are issues in the GitHub comments API)
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });

    const existingComment = comments.data.find(
      (c) =>
        c.body &&
        (c.body.includes(STICKY_COMMENT_MARKER) || c.body.includes(REVIEW_TITLE_MARKER)),
    );

    if (existingComment) {
      console.log(`Updating existing sticky PR review comment (ID: ${existingComment.id})...`);
      await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingComment.id,
        body,
      });
      console.log(`✔ Successfully updated sticky PR review comment in-place.`);
    } else {
      console.log(`Creating new sticky PR review comment on ${owner}/${repo}#${pullNumber}...`);
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });
      console.log(`✔ Successfully created sticky PR review comment.`);
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ Warning: Failed to post/update sticky comment: ${errorMsg}`);
  }
}

