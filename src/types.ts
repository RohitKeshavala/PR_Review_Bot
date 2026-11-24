/**
 * Core type definitions and data contracts for Universal AI PR Review Bot
 */

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';

export type FindingCategory =
  | 'Security'
  | 'Performance'
  | 'Correctness'
  | 'Error Handling'
  | 'API Design'
  | 'Maintainability'
  | 'Testing';

export type ReviewVerdict = 'APPROVE' | 'APPROVE_WITH_COMMENTS' | 'CHANGES_REQUESTED';

export type DiffChangeType = 'add' | 'del' | 'context';

export interface ChangedLine {
  type: DiffChangeType;
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ChangedLine[];
}

export interface FileDiff {
  oldPath?: string;
  newPath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface PRFinding {
  id?: string;
  commentId?: number;
  filePath: string;
  lineNumber: number;
  endLineNumber?: number;
  inDiffHunk: boolean;
  title: string;
  severity: Severity;
  category: FindingCategory;
  problem: string;
  whyItMatters: string;
  recommendationDiff?: string;
}

export interface ResolvedFinding {
  id?: string;
  commentId?: number;
  filePath: string;
  lineNumber?: number;
  endLineNumber?: number;
  title: string;
  severity: Severity;
  category: FindingCategory;
  explanation?: string;
  fixDiffSnippet?: string;
  resolvedInCommit?: string;
  resolvedAt?: string;
}

export interface BotReviewComment {
  id: number;
  path: string;
  line: number;
  start_line?: number;
  body: string;
  title: string;
  problem: string;
  severity: Severity;
  category: FindingCategory;
  status: 'active' | 'resolved';
  resolvedInCommit?: string;
}

export interface ResolvedCommentResolution {
  commentId: number;
  explanation: string;
  fixDiffSnippet?: string;
}

export interface QualityGateIndicators {
  reviews: 'pass' | 'fail';
  tests: 'pass' | 'warn';
  observability: 'pass' | 'warn';
  blockerCount: number;
}

export interface PRReviewStats {
  filesChanged: number;
  additions: number;
  deletions: number;
  criticalIssues: number;
  highIssues: number;
  mediumIssues: number;
  lowIssues: number;
  informationalIssues: number;
}

export interface PRReviewReport {
  verdict: ReviewVerdict;
  summary: string;
  commitSha: string;
  shortCommitSha: string;
  runUrl?: string;
  stats: PRReviewStats;
  findings: PRFinding[];
  resolvedFindings: ResolvedFinding[];
  indicators: QualityGateIndicators;
  detectedLanguages?: string[];
  detectedFrameworks?: string[];
  targetPath?: string;
  baseBranch?: string;
  headBranch?: string;
  prNumber?: number;
  repository?: string;
  generatedAt: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  start_line?: number;
  start_side?: 'RIGHT' | 'LEFT';
  side?: 'RIGHT' | 'LEFT';
  body: string;
}

export interface AppConfig {
  geminiApiKey?: string;
  geminiModel?: string;
  geminiFallbackModel?: string;
  githubToken?: string;
  githubRepository?: string;
  targetProjectPath: string;
  dryRun: boolean;
  outputReportPath: string;
  failOnChanges: boolean;
  baseBranch?: string;
  headBranch?: string;
  prNumber?: number;
  postToGitHub: boolean;
  commitSha?: string;
  shortCommitSha?: string;
  runUrl?: string;
}
