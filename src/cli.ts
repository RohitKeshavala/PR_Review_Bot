#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig, validateConfig } from './config.js';
import { buildReviewContext } from './context-builder.js';
import { toConsole, toGitHubMarkdown } from './formatter.js';
import {
  extractReviewStateFromFile,
  fetchPreviousReviewState,
  fetchRemotePullRequestDiff,
  parseRepoString,
  postOrUpdateStickyComment,
  submitPullRequestReview,
} from './github-service.js';
import { getDiff, parseDiff } from './git-service.js';
import { performAIReview } from './reviewer.js';
import type { FileDiff, PRFinding, ResolvedFinding } from './types.js';

const program = new Command();

program
  .name('pr-review-bot')
  .description('Autonomous polyglot AI PR Review Bot powered by Google Gemini and GitHub Actions')
  .version('1.0.0')
  .option('-t, --target <path>', 'Target project path', '.')
  .option('-b, --base <branch>', 'Base branch for local diff')
  .option('--head <branch>', 'Head branch for local diff')
  .option('-p, --pr <number>', 'GitHub PR number')
  .option('--repo <owner/repo>', 'GitHub repository (owner/repo)')
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

      console.log('🚀 Initializing Universal AI PR Review Bot...');
      console.log(`   Target Directory: ${config.targetProjectPath}`);
      console.log(`   AI Engine:        Google Gemini (Dynamic Fallback Chain)`);
      console.log(`   Mode:             ${config.dryRun ? 'DRY-RUN (Simulation)' : 'LIVE'}`);

      // 1. Acquire diff (Remote PR diff if available and requested, otherwise local git diff)
      let rawDiff = '';
      if (config.prNumber && config.githubRepository && config.githubToken && config.postToGitHub) {
        try {
          const { owner, repo } = parseRepoString(config.githubRepository);
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
        console.log(`🔍 Extracting local git diff in ${config.targetProjectPath}...`);
        rawDiff = getDiff(config.baseBranch, config.headBranch, config.targetProjectPath);
      }

      // 2. Parse diff
      const fileDiffs: FileDiff[] = parseDiff(rawDiff);
      console.log(`📁 Analyzed diff: ${fileDiffs.length} file(s) changed.`);

      // 3. Build context
      console.log('🧠 Building multi-file review context & detecting frameworks...');
      const context = buildReviewContext(config.targetProjectPath, fileDiffs);
      if (context.detectedFrameworks.length > 0) {
        console.log(`🎯 Detected Frameworks: ${context.detectedFrameworks.join(', ')}`);
      }

      // 4. Fetch previous review state to verify active defects across review rounds
      let previousState = {
        previousFindings: [] as PRFinding[],
        previouslyResolved: [] as ResolvedFinding[],
      };

      if (config.prNumber && config.githubRepository && config.githubToken) {
        try {
          const { owner, repo } = parseRepoString(config.githubRepository);
          previousState = await fetchPreviousReviewState(
            config.githubToken,
            owner,
            repo,
            config.prNumber,
          );
        } catch (fetchPrevErr) {
          console.warn(`⚠️ Warning: Could not fetch previous review state from GitHub: ${fetchPrevErr}`);
        }
      } else {
        const localReportPath = path.resolve(process.cwd(), config.outputReportPath);
        previousState = extractReviewStateFromFile(localReportPath);
      }

      if (previousState.previousFindings.length > 0) {
        console.log(`📋 Found ${previousState.previousFindings.length} active defect(s) from previous review to verify.`);
      }

      // 5. Perform AI Review Reasoning with Semantic Defect Verification
      console.log('✨ Performing AI review analysis with Google Gemini...');
      const report = await performAIReview(
        context,
        config,
        previousState.previousFindings,
        previousState.previouslyResolved,
      );

      if (report.resolvedFindings && report.resolvedFindings.length > 0) {
        console.log(`✅ Tracked ${report.resolvedFindings.length} resolved defect(s) across review rounds.`);
      }

      // 6. Format and display console output
      const consoleOutput = toConsole(report);
      console.log(consoleOutput);

      // 6. Write Markdown Report
      const markdownOutput = toGitHubMarkdown(report);
      const outputPath = path.resolve(process.cwd(), config.outputReportPath);
      fs.writeFileSync(outputPath, markdownOutput, 'utf-8');
      console.log(`📄 Markdown report saved to: ${outputPath}`);

      // 7. Post to GitHub if requested or simulate if dry-run
      if (config.postToGitHub || config.dryRun) {
        if (config.githubRepository && config.prNumber) {
          const { owner, repo } = parseRepoString(config.githubRepository);

          // Submit formal PR Review (with inline comments and in-place updates)
          const reviewSubmitted = await submitPullRequestReview(
            config.githubToken || '',
            owner,
            repo,
            config.prNumber,
            report,
            markdownOutput,
            config.dryRun,
          );

          // Update sticky summary comment if an existing one is already present
          // (or if review submission was skipped/failed)
          await postOrUpdateStickyComment(
            config.githubToken || '',
            owner,
            repo,
            config.prNumber,
            markdownOutput,
            config.dryRun,
            reviewSubmitted,
          );
        } else if (config.postToGitHub) {
          console.warn('⚠️ --post-to-github specified but repository or PR number was not provided.');
        }
      }

      // 8. CI Gate evaluation
      if (config.failOnChanges && report.verdict === 'CHANGES_REQUESTED') {
        console.error('❌ CI Gate Failed: Review verdict is CHANGES_REQUESTED.');
        process.exit(1);
      }

      console.log('✔ Review bot finished successfully.');
      process.exit(0);
    } catch (err: unknown) {
      console.error('\n❌ Fatal error running Universal PR Review Bot:');
      console.error(err instanceof Error ? err.stack || err.message : String(err));
      process.exit(1);
    }
  });

program.parse(process.argv);

