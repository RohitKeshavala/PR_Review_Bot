#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, validateConfig } from './config.js';
import { buildReviewContext } from './context-builder.js';
import { toConsole, toQualityGateMarkdown } from './formatter.js';
import {
  fetchExistingBotReviewComments,
  fetchPullRequestHeadCommit,
  fetchRemotePullRequestDiff,
  parseRepoString,
  postNewInlineComments,
  submitPullRequestReviewVerdict,
  syncQualityGateStickyComment,
  updateResolvedInlineComments,
} from './github-service.js';
import { getDiff, parseDiff } from './git-service.js';
import { performAIReview } from './reviewer.js';
import type { BotReviewComment, FileDiff } from './types.js';

/**
 * Resolves fallback commit SHA when neither explicit --commit/COMMIT_SHA
 * nor GitHub API PR head lookup provided one.
 */
function resolveFallbackCommitSha(targetProjectPath: string): string {
  if (process.env.GITHUB_EVENT_PATH) {
    try {
      const eventPayload = JSON.parse(
        fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8'),
      ) as {
        pull_request?: { head?: { sha?: string } };
      };
      if (eventPayload.pull_request?.head?.sha) {
        return eventPayload.pull_request.head.sha;
      }
    } catch {
      // Ignore malformed or unreadable GitHub event payload
    }
  }

  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }

  try {
    return execSync('git rev-parse HEAD', {
      cwd: targetProjectPath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'latest';
  }
}

const program = new Command();

program
  .name('pr-review-bot')
  .description('Autonomous polyglot AI PR Review Bot powered by Google Gemini and GitHub Actions')
  .version('2.0.0')
  .option('-t, --target <path>', 'Target project path', '.')
  .option('-b, --base <branch>', 'Base branch for local diff')
  .option('--head <branch>', 'Head branch for local diff')
  .option('-p, --pr <number>', 'GitHub PR number')
  .option('--repo <owner/repo>', 'GitHub repository (owner/repo)')
  .option('--commit <sha>', 'Commit SHA being reviewed')
  .option('--run-url <url>', 'GitHub Actions workflow run URL')
  .option('--post-to-github', 'Submit live review via Octokit')
  .option('--dry-run', 'Simulate review and save local payload JSON')
  .option('--fail-on-changes', 'Exit code 1 on CHANGES_REQUESTED (CI gate)')
  .option('-o, --output <path>', 'Markdown report path', './PR_REVIEW_REPORT.md')
  .action(async (options) => {
    try {
      const config = loadConfig(options);
      const validation = validateConfig(config);

      if (!validation.valid) {
        console.error('Configuration errors:');
        for (const err of validation.errors) {
          console.error(` - ${err}`);
        }
        process.exit(1);
      }

      console.log('🚀 Initializing AI PR Quality Gate...');
      console.log(`   Target Directory: ${config.targetProjectPath}`);
      console.log(`   AI Engine:        Google Gemini (Dynamic Fallback Chain)`);
      console.log(`   Mode:             ${config.dryRun ? 'DRY-RUN (Simulation)' : 'LIVE'}`);

      // 1. Acquire diff & commit SHA
      let rawDiff = '';
      if (config.prNumber && config.githubRepository && config.githubToken) {
        const { owner, repo } = parseRepoString(config.githubRepository);

        // Fetch PR head commit SHA if not explicitly provided
        if (!config.commitSha) {
          const { commitSha } = await fetchPullRequestHeadCommit(
            config.githubToken,
            owner,
            repo,
            config.prNumber,
          );
          if (commitSha) {
            config.commitSha = commitSha;
          }
        }

        if (config.postToGitHub) {
          try {
            console.log(`📥 Fetching remote diff for ${owner}/${repo}#${config.prNumber} from GitHub API...`);
            rawDiff = await fetchRemotePullRequestDiff(
              config.githubToken,
              owner,
              repo,
              config.prNumber,
            );
          } catch (fetchErr) {
            console.warn(`⚠️ Could not fetch remote diff via GitHub API, falling back to local git diff: ${fetchErr}`);
            rawDiff = getDiff(config.baseBranch, config.headBranch, config.targetProjectPath);
          }
        } else {
          rawDiff = getDiff(config.baseBranch, config.headBranch, config.targetProjectPath);
        }
      } else {
        console.log(`🔍 Extracting local git diff in ${config.targetProjectPath}...`);
        rawDiff = getDiff(config.baseBranch, config.headBranch, config.targetProjectPath);
      }

      // Fallback commit SHA resolution (GITHUB_EVENT_PATH -> GITHUB_SHA -> git rev-parse HEAD)
      if (!config.commitSha) {
        config.commitSha = resolveFallbackCommitSha(config.targetProjectPath);
      }

      const shortCommitSha = config.commitSha ? config.commitSha.slice(0, 7) : 'latest';
      config.shortCommitSha = shortCommitSha;
      console.log(`📌 Reviewed Commit SHA: ${shortCommitSha}`);

      // 2. Parse diff
      const fileDiffs: FileDiff[] = parseDiff(rawDiff);
      console.log(`📁 Analyzed diff: ${fileDiffs.length} file(s) changed.`);

      // 3. Build context
      console.log('🧠 Building multi-file review context & detecting frameworks...');
      const context = buildReviewContext(config.targetProjectPath, fileDiffs);
      if (context.detectedFrameworks.length > 0) {
        console.log(`🎯 Detected Frameworks: ${context.detectedFrameworks.join(', ')}`);
      }

      // 4. Fetch existing review comments from Octokit (Active vs Resolved)
      let activeComments: BotReviewComment[] = [];
      let resolvedComments: BotReviewComment[] = [];

      if (config.prNumber && config.githubRepository && config.githubToken) {
        const { owner, repo } = parseRepoString(config.githubRepository);
        console.log(`🔎 Fetching existing PR review comments for ${owner}/${repo}#${config.prNumber}...`);
        const commentData = await fetchExistingBotReviewComments(
          config.githubToken,
          owner,
          repo,
          config.prNumber,
        );
        activeComments = commentData.activeComments;
        resolvedComments = commentData.resolvedComments;
        console.log(
          `📋 Found ${activeComments.length} active comment(s) and ${resolvedComments.length} resolved comment(s).`,
        );
      }

      // 5. Perform AI Review Reasoning with Semantic Defect Verification
      console.log('✨ Performing AI review analysis with Google Gemini...');
      const { report, newFindings, resolvedResolutions } = await performAIReview(
        context,
        config,
        activeComments,
        resolvedComments,
      );

      console.log(`📊 Review Verdict: ${report.verdict} (${report.indicators.blockerCount} blocker(s))`);
      if (resolvedResolutions.length > 0) {
        console.log(`✅ Verified ${resolvedResolutions.length} previously reported defect(s) now resolved!`);
      }
      if (newFindings.length > 0) {
        console.log(`🚨 Identified ${newFindings.length} brand-new finding(s).`);
      }

      // 6. Format and display console output
      const consoleOutput = toConsole(report);
      console.log(consoleOutput);

      // 7. Write Markdown Report
      const markdownOutput = toQualityGateMarkdown(report);
      const outputPath = path.resolve(process.cwd(), config.outputReportPath);
      fs.writeFileSync(outputPath, markdownOutput, 'utf-8');
      console.log(`📄 Quality Gate markdown report saved to: ${outputPath}`);

      // 8. Post to GitHub (Option A) or simulate if dry-run
      if (config.postToGitHub || config.dryRun) {
        if (config.githubRepository && config.prNumber) {
          const { owner, repo } = parseRepoString(config.githubRepository);

          // 8a. Update or create the single persistent Quality Gate comment on the PR issue FIRST.
          // On First review, creating this before inline comments ensures it stays at the top of the PR thread.
          await syncQualityGateStickyComment(
            config.githubToken || '',
            owner,
            repo,
            config.prNumber,
            markdownOutput,
            config.dryRun,
          );

          // 8b. Update resolved comments directly with 'Resolved in <commit>' (Option A)
          if (resolvedResolutions.length > 0) {
            await updateResolvedInlineComments(
              config.githubToken || '',
              owner,
              repo,
              resolvedResolutions,
              activeComments,
              shortCommitSha,
              config.dryRun,
            );
          }

          // 8c. Create new inline comments for brand-new findings (added AFTER the top comment)
          if (newFindings.length > 0) {
            await postNewInlineComments(
              config.githubToken || '',
              owner,
              repo,
              config.prNumber,
              config.commitSha,
              newFindings,
              config.dryRun,
            );
          }

          // 8d. Submit formal GitHub Pull Request Review verdict (APPROVE / CHANGES_REQUESTED / COMMENT)
          await submitPullRequestReviewVerdict(
            config.githubToken || '',
            owner,
            repo,
            config.prNumber,
            config.commitSha || '',
            report,
            config.dryRun,
          );
        } else if (config.postToGitHub) {
          console.warn('⚠️ --post-to-github specified but repository or PR number was not provided.');
        }
      }

      // 9. CI Gate evaluation
      if (config.failOnChanges && report.verdict === 'CHANGES_REQUESTED') {
        console.error('❌ CI Gate Failed: Review verdict is CHANGES_REQUESTED.');
        process.exit(1);
      }

      console.log('✔ AI Quality Gate finished successfully.');
      process.exit(0);
    } catch (err: unknown) {
      console.error('\n❌ Fatal error running AI PR Quality Gate:');
      console.error(err instanceof Error ? err.stack || err.message : String(err));
      process.exit(1);
    }
  });

program.parse(process.argv);
