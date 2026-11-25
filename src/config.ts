import path from 'node:path';
import dotenv from 'dotenv';
import type { AppConfig } from './types.js';

// Load environment variables from .env file if present
dotenv.config();

export interface CliOptions {
  target?: string;
  base?: string;
  head?: string;
  pr?: string | number;
  repo?: string;
  postToGithub?: boolean;
  dryRun?: boolean;
  failOnChanges?: boolean;
  output?: string;
  commit?: string;
  runUrl?: string;
}

/**
 * Loads configuration merged from default values, environment variables,
 * and command-line options.
 */
export function loadConfig(cliOptions: CliOptions = {}): AppConfig {
  const env = process.env;

  const targetPathRaw = cliOptions.target || env.TARGET_PROJECT_PATH || '.';
  const targetProjectPath = path.isAbsolute(targetPathRaw)
    ? targetPathRaw
    : path.resolve(process.cwd(), targetPathRaw);

  const dryRun = cliOptions.dryRun ?? (env.DRY_RUN === 'true' || env.DRY_RUN === '1');
  const postToGitHub = cliOptions.postToGithub ?? (env.POST_TO_GITHUB === 'true');
  const failOnChanges = cliOptions.failOnChanges ?? (env.FAIL_ON_CHANGES === 'true');

  const prNumber = cliOptions.pr
    ? Number.parseInt(String(cliOptions.pr), 10)
    : env.PR_NUMBER
      ? Number.parseInt(env.PR_NUMBER, 10)
      : undefined;

  const repo = cliOptions.repo || env.GITHUB_REPOSITORY;
  const commitSha = cliOptions.commit || env.COMMIT_SHA;

  let runUrl = cliOptions.runUrl;
  if (!runUrl && env.GITHUB_SERVER_URL && repo && env.GITHUB_RUN_ID) {
    runUrl = `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  }

  const config: AppConfig = {
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    geminiFallbackModel: env.GEMINI_FALLBACK_MODEL,
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN,
    githubRepository: repo,
    targetProjectPath,
    dryRun,
    outputReportPath: cliOptions.output || env.OUTPUT_REPORT_PATH || './PR_REVIEW_REPORT.md',
    failOnChanges,
    baseBranch: cliOptions.base || env.BASE_BRANCH,
    headBranch: cliOptions.head || env.HEAD_BRANCH,
    prNumber,
    postToGitHub,
    commitSha,
    shortCommitSha: commitSha ? commitSha.slice(0, 7) : undefined,
    runUrl,
  };

  return config;
}

/**
 * Validates configuration based on execution mode.
 */
export function validateConfig(config: AppConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.dryRun && !config.geminiApiKey) {
    errors.push('GEMINI_API_KEY is required unless running in --dry-run mode.');
  }

  if (config.postToGitHub) {
    if (!config.githubToken) {
      errors.push('GITHUB_TOKEN (or GH_TOKEN) is required when --post-to-github is set.');
    }
    if (!config.githubRepository) {
      errors.push('GITHUB_REPOSITORY (e.g. "owner/repo") is required when --post-to-github is set.');
    }
    if (!config.prNumber) {
      errors.push('PR number (--pr) is required when --post-to-github is set.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
