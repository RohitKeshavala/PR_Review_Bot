import fs from 'node:fs';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import { toInlineComment } from './formatter.js';
import { normalizePath } from './git-service.js';
import { isSameDefect } from './reviewer.js';
import type {
  FindingCategory,
  PRFinding,
  PRReviewReport,
  ResolvedFinding,
  ReviewComment,
  ReviewPayload,
  Severity,
} from './types.js';

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
  previouslyResolved: ResolvedFinding[] = [],
): Promise<boolean> {
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
    .map((f) => {
      const isMultiLine = Boolean(f.endLineNumber && f.endLineNumber > f.lineNumber);
      const comment: ReviewComment = {
        path: normalizePath(f.filePath),
        line: isMultiLine ? f.endLineNumber! : f.lineNumber,
        side: 'RIGHT' as const,
        body: toInlineComment(f),
      };

      if (isMultiLine) {
        comment.start_line = f.lineNumber;
        comment.start_side = 'RIGHT' as const;
      }

      return comment;
    });

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
    return true;
  }

  const octokit = getOctokitClient(token);

  // 1. Fetch existing reviews by the bot to allow in-place updates or superseding
  let existingBotReviews: Array<{
    id: number;
    state: string;
    body: string;
  }> = [];

  try {
    const reviewsResponse = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    existingBotReviews = reviewsResponse.data.filter(
      (r) =>
        r.body &&
        (r.body.includes(STICKY_COMMENT_MARKER) || r.body.includes(REVIEW_TITLE_MARKER)) &&
        r.state !== 'DISMISSED',
    );
  } catch (listErr) {
    console.warn(`⚠️ Warning: Could not list existing PR reviews: ${listErr}`);
  }

  const latestReview =
    existingBotReviews.length > 0 ? existingBotReviews[existingBotReviews.length - 1] : null;

  // 2. Fetch existing review comments on the PR to know if all inline comments are already posted
  let existingReviewComments: Array<{
    id: number;
    pull_request_review_id: number | null;
    path?: string;
    line?: number;
    start_line?: number | null;
    position?: number | null;
  }> = [];
  try {
    const commentsResp = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    existingReviewComments = commentsResp.data;
  } catch (listCommentsErr) {
    console.warn(`⚠️ Warning: Could not list review comments: ${listCommentsErr}`);
  }

  // Active comments on the current PR review (not outdated or from dismissed reviews)
  const activeExistingComments = existingReviewComments.filter((c) => {
    if (latestReview && c.pull_request_review_id !== latestReview.id) {
      return false;
    }
    // In GitHub REST API, position === null indicates the comment is Outdated on the diff
    if (c.position === null) {
      return false;
    }
    if (c.line === null || c.line === undefined) {
      return false;
    }
    return true;
  });

  // Check if any finding in inlineComments requires posting a NEW comment on GitHub:
  // 1. Any re-introduced defect (previously marked resolved) requires a new active comment!
  // 2. Any finding that does NOT already have an active comment on GitHub requires a comment!
  const hasNewInlineComments = inlineComments.some((f) => {
    const isReintroduced = (previouslyResolved || []).some((r) =>
      isSameDefect(r, { filePath: f.path, lineNumber: f.line, endLineNumber: f.line }),
    );
    if (isReintroduced) {
      return true;
    }

    const hasActiveComment = activeExistingComments.some((c) => {
      const commentPath = c.path ? normalizePath(c.path) : '';
      return isSameDefect(
        { filePath: f.path, lineNumber: f.line, endLineNumber: f.line },
        { filePath: commentPath, lineNumber: c.start_line || c.line || 0, endLineNumber: c.line || 0 },
      );
    });

    return !hasActiveComment;
  });

  const stateMatches =
    latestReview &&
    ((latestReview.state === 'CHANGES_REQUESTED' && event === 'REQUEST_CHANGES') ||
      (latestReview.state !== 'CHANGES_REQUESTED' && event === 'COMMENT'));

  // In-place update: If an existing review exists, state does not conflict, and NO NEW inline comments
  // need to be posted, update the existing review in-place rather than creating a new review thread.
  if (latestReview && !hasNewInlineComments && stateMatches) {
    try {
      console.log(`Updating existing PR Review (ID: ${latestReview.id}) in-place with latest report...`);
      await octokit.rest.pulls.updateReview({
        owner,
        repo,
        pull_number: pullNumber,
        review_id: latestReview.id,
        body: markdownSummary,
      });
      console.log(`✔ Successfully updated existing PR Review (ID: ${latestReview.id}) in-place.`);
      return true;
    } catch (updateErr) {
      console.warn(`⚠️ In-place review update failed: ${updateErr}. Falling back to review submission...`);
    }
  }

  // 3. If a new review must be submitted (brand-new inline comments or verdict state changed):
  // Dismiss previous bot reviews, delete stale comments to avoid duplicate stacking in Files Changed,
  // and collapse review bodies.
  if (existingBotReviews.length > 0) {
    for (const oldReview of existingBotReviews) {
      try {
        console.log(`Dismissing previous PR Review (ID: ${oldReview.id}) to prevent duplicate review threads...`);
        await octokit.rest.pulls.dismissReview({
          owner,
          repo,
          pull_number: pullNumber,
          review_id: oldReview.id,
          message: 'Superseded by updated AI review for the latest commit.',
        });
      } catch (dismissErr) {
        console.warn(`⚠️ Warning: Could not dismiss previous review (ID: ${oldReview.id}): ${dismissErr}`);
      }

      // Delete old inline comments ONLY for still-active defects being re-posted,
      // and NEVER delete comments for resolved defects (preserving the full audit trail in GitHub).
      const commentsToDelete = existingReviewComments.filter((c) => {
        if (c.pull_request_review_id !== oldReview.id) return false;

        const commentPath = c.path ? normalizePath(c.path) : '';
        const commentFinding = {
          filePath: commentPath,
          lineNumber: c.start_line || c.line || 0,
          endLineNumber: c.line || 0,
        };

        // 1. If this comment belongs to a resolved defect, KEEP IT (do not delete)!
        const isResolved = (report.resolvedFindings || []).some((rf) =>
          isSameDefect(rf, commentFinding),
        );
        if (isResolved) {
          return false;
        }

        // 2. Only clean up if this defect is still active and is being re-posted on the latest commit
        const isStillActiveAndRePosted = report.findings.some(
          (f) => f.inDiffHunk && isSameDefect(f, commentFinding),
        );

        return isStillActiveAndRePosted;
      });
      for (const c of commentsToDelete) {
        try {
          await octokit.rest.pulls.deleteReviewComment({
            owner,
            repo,
            comment_id: c.id,
          });
        } catch {
          // Best effort comment cleanup
        }
      }

      try {
        const oldStateMatch = oldReview.body.match(/<!-- ai-review-state:\s*([\s\S]*?)\s*-->/);
        const stateTag = oldStateMatch ? `\n${oldStateMatch[0]}` : '';
        await octokit.rest.pulls.updateReview({
          owner,
          repo,
          pull_number: pullNumber,
          review_id: oldReview.id,
          body: `<details>\n<summary>📦 Outdated AI Review Report (Superseded)</summary>\n\n*(This review was superseded by the latest review).*</details>${stateTag}`,
        });
      } catch {
        // Best effort body collapse
      }
    }
  }

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

  // 4. Primary Attempt (Original Event + Inline Comments)
  try {
    console.log(`Submitting formal PR Review (${event}) with ${inlineComments.length} inline comments...`);
    await attemptReview(event, true);
    console.log(`✔ Successfully posted PR Review to ${owner}/${repo}#${pullNumber}`);
    return true;
  } catch (primaryErr: unknown) {
    const errorMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    console.warn(`⚠️ Warning: Primary review submission failed (${errorMsg}). Attempting fallback...`);

    // 5. Fallback Attempt 1: Retry with 'COMMENT'
    const fallbackEvent = 'COMMENT' as const;

    try {
      console.log(`Retrying PR Review submission as (${fallbackEvent}) with inline comments...`);
      await attemptReview(fallbackEvent, true);
      console.log(`✔ Gracefully posted PR Review as (${fallbackEvent}) to ${owner}/${repo}#${pullNumber}`);
      return true;
    } catch (secondErr: unknown) {
      const secondMsg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      console.warn(`⚠️ Warning: Secondary review submission failed (${secondMsg}). Retrying without inline comments...`);
    }

    // 6. Fallback Attempt 2: Post review without inline comments (avoids 422 line mismatches)
    try {
      console.log(`Retrying PR Review submission as (${fallbackEvent}) without inline comments...`);
      await attemptReview(fallbackEvent, false);
      console.log(`✔ Gracefully posted PR Review (top-level summary) to ${owner}/${repo}#${pullNumber}`);
      return true;
    } catch (thirdErr: unknown) {
      const thirdMsg = thirdErr instanceof Error ? thirdErr.message : String(thirdErr);
      console.warn(`⚠️ Warning: Formal PR review failed (${thirdMsg}). Falling back to PR issue comment...`);
    }

    // 7. Final Fallback: Post as a standard PR issue comment
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: markdownSummary,
      });
      console.log(`✔ Successfully posted PR Review as top-level comment to ${owner}/${repo}#${pullNumber}`);
      return true;
    } catch (finalErr: unknown) {
      const finalMsg = finalErr instanceof Error ? finalErr.message : String(finalErr);
      console.error(`❌ Error: All review posting methods failed: ${finalMsg}`);
      return false;
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
  onlyIfExisting = false,
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
    } else if (!onlyIfExisting) {
      console.log(`Creating new sticky PR review comment on ${owner}/${repo}#${pullNumber}...`);
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });
      console.log(`✔ Successfully created sticky PR review comment.`);
    } else {
      console.log(`ℹ️ Sticky comment creation skipped because formal review is already active.`);
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ Warning: Failed to post/update sticky comment: ${errorMsg}`);
  }
}

/**
 * Extracts previous findings and previously resolved defects from a review markdown body
 */
export function extractReviewState(body: string): {
  previousFindings: PRFinding[];
  previouslyResolved: ResolvedFinding[];
} {
  // 1. Check for embedded machine-readable state payload
  const match = body.match(/<!-- ai-review-state:\s*([\s\S]*?)\s*-->/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      return {
        previousFindings: Array.isArray(data.findings) ? data.findings : [],
        previouslyResolved: Array.isArray(data.resolved) ? data.resolved : [],
      };
    } catch {
      // Fall through to markdown table parsing
    }
  }

  // 2. Fallback: Parse markdown table rows from previous review body
  const findings: PRFinding[] = [];
  const resolved: ResolvedFinding[] = [];

  // Parse Resolved Defects section if present
  const resolvedSectionMatch = body.match(/### ✅ Resolved Defects[^\n]*\n([\s\S]*?)(?:\n### |\n---|$)/);
  if (resolvedSectionMatch) {
    const resolvedTable = resolvedSectionMatch[1];
    const resolvedRowRegex =
      /\|\s*\d+\s*\|\s*`([A-Z]+)`\s*\|\s*([^|]+)\s*\|\s*`([^`:]+)(?::(\d+)(?:-(\d+))?)?`\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g;
    let rMatch;
    while ((rMatch = resolvedRowRegex.exec(resolvedTable)) !== null) {
      const severity = rMatch[1] as Severity;
      const category = rMatch[2].trim() as FindingCategory;
      const filePath = rMatch[3].trim();
      const startLine = rMatch[4] ? Number(rMatch[4]) : 1;
      const endLine = rMatch[5] ? Number(rMatch[5]) : undefined;
      const title = rMatch[6].replace(/^~~/, '').replace(/~~$/, '').trim();
      const statusText = rMatch[7].trim();

      resolved.push({
        filePath,
        lineNumber: startLine,
        endLineNumber: endLine,
        title,
        severity,
        category,
        explanation: statusText
          .replace(/^✅\s*\*\*Resolved:\*\*\s*/, '')
          .replace(/^✅\s*\*\*Resolved\*\*/, '')
          .trim(),
        resolvedAt: new Date().toISOString(),
      });
    }
  }

  // Parse Review Findings section if present
  const findingsSectionMatch = body.match(/### 🔎 Review Findings[^\n]*\n([\s\S]*?)(?:\n### |\n---|$)/);
  const findingsTable = findingsSectionMatch ? findingsSectionMatch[1] : (resolvedSectionMatch ? '' : body);
  const tableRowRegex =
    /\|\s*\d+\s*\|\s*`([A-Z]+)`\s*\|\s*([^|]+)\s*\|\s*`([^`:]+)(?::(\d+)(?:-(\d+))?)?`\s*\|\s*([^|]+)\s*\|/g;
  let rowMatch;
  while ((rowMatch = tableRowRegex.exec(findingsTable)) !== null) {
    const severity = rowMatch[1] as Severity;
    const category = rowMatch[2].trim() as FindingCategory;
    const filePath = rowMatch[3].trim();
    const startLine = rowMatch[4] ? Number(rowMatch[4]) : 1;
    const endLine = rowMatch[5] ? Number(rowMatch[5]) : undefined;
    const title = rowMatch[6].trim();

    findings.push({
      filePath,
      lineNumber: startLine,
      endLineNumber: endLine,
      title,
      severity,
      category,
      inDiffHunk: true,
      problem: '',
      whyItMatters: '',
    });
  }

  return { previousFindings: findings, previouslyResolved: resolved };
}

/**
 * Reads previous review state from local markdown report file
 */
export function extractReviewStateFromFile(filePath: string): {
  previousFindings: PRFinding[];
  previouslyResolved: ResolvedFinding[];
} {
  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return extractReviewState(content);
    } catch {
      // ignore
    }
  }
  return { previousFindings: [], previouslyResolved: [] };
}

/**
 * Fetches previous review state from GitHub PR reviews or sticky comments
 */
export async function fetchPreviousReviewState(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ previousFindings: PRFinding[]; previouslyResolved: ResolvedFinding[] }> {
  try {
    const octokit = getOctokitClient(token);

    // 1. Check existing reviews (iterate from newest to oldest)
    const reviewsResponse = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });

    const botReviews = reviewsResponse.data
      .filter(
        (r) =>
          r.body &&
          (r.body.includes(STICKY_COMMENT_MARKER) || r.body.includes(REVIEW_TITLE_MARKER)),
      )
      .sort((a, b) => a.id - b.id);

    for (let i = botReviews.length - 1; i >= 0; i--) {
      const review = botReviews[i];
      const parsed = extractReviewState(review.body || '');
      if (parsed.previousFindings.length > 0 || parsed.previouslyResolved.length > 0) {
        return parsed;
      }
    }

    // 2. Check issue comments as fallback (iterate from newest to oldest)
    const commentsResponse = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
    });

    const botComments = commentsResponse.data
      .filter(
        (c) =>
          c.body &&
          (c.body.includes(STICKY_COMMENT_MARKER) || c.body.includes(REVIEW_TITLE_MARKER)),
      )
      .sort((a, b) => a.id - b.id);

    for (let i = botComments.length - 1; i >= 0; i--) {
      const comment = botComments[i];
      const parsed = extractReviewState(comment.body || '');
      if (parsed.previousFindings.length > 0 || parsed.previouslyResolved.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn(`⚠️ Warning: Could not fetch previous review state: ${err}`);
  }

  return { previousFindings: [], previouslyResolved: [] };
}

/**
 * Calculates resolved findings by comparing previous findings against current findings,
 * while carrying forward all previously resolved defects across all reviews on this PR.
 */
export function calculateResolvedFindings(
  previousFindings: PRFinding[],
  currentFindings: PRFinding[],
  previouslyResolved: ResolvedFinding[] = [],
): ResolvedFinding[] {
  // 1. Identify which previous findings are no longer present in current findings (newly resolved)
  const newlyResolved: ResolvedFinding[] = [];
  for (const prev of previousFindings) {
    const stillActive = currentFindings.some((curr) => isSameDefect(prev, curr));
    if (!stillActive) {
      newlyResolved.push({
        id: prev.id,
        filePath: prev.filePath,
        lineNumber: prev.lineNumber,
        endLineNumber: prev.endLineNumber,
        title: prev.title,
        severity: prev.severity,
        category: prev.category,
        explanation: 'Verified: Defect no longer detected in latest code changes.',
        resolvedAt: new Date().toISOString(),
      });
    }
  }

  // 2. Combine previously resolved with newly resolved
  const allResolvedMap = new Map<string, ResolvedFinding>();

  for (const res of previouslyResolved) {
    // If a previously resolved finding is re-introduced in current findings, don't keep it resolved
    const reIntroduced = currentFindings.some((curr) => isSameDefect(res, curr));
    if (!reIntroduced) {
      allResolvedMap.set(res.id || `${normalizePath(res.filePath)}::${res.title.toLowerCase().trim()}`, res);
    }
  }

  for (const res of newlyResolved) {
    allResolvedMap.set(res.id || `${normalizePath(res.filePath)}::${res.title.toLowerCase().trim()}`, res);
  }

  return Array.from(allResolvedMap.values());
}

