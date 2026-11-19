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

export type ReviewGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

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
  healthScore: number;
  grade: ReviewGrade;
  verdict: ReviewVerdict;
  summary: string;
  stats: PRReviewStats;
  findings: PRFinding[];
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

export interface ReviewPayload {
  owner: string;
  repo: string;
  pull_number: number;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body: string;
  comments?: ReviewComment[];
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
}

