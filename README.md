# Universal AI Pull Request Review Bot

[![CI / Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)]()
[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-green.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue.svg)]()
[![Gemini](https://img.shields.io/badge/AI%20Engine-Google%20Gemini-orange.svg)]()

An autonomous, polyglot AI Pull Request reviewer engineered to run across any codebase (TypeScript, Python, Go, Rust, Java, etc.) via GitHub Actions `workflow_call` or local CLI.

---

## 🚀 Key Highlights & Architecture

- **Zero External Dependencies in Target Repos**: Caller repositories only require a 15-line `.github/workflows/ai-review.yml` caller file. No Node.js or bot packages are installed into the caller repository.
- **Embedded 12-Step Universal Principles**: Hardened in-memory engineering principles cover layer separation, null safety, async/concurrency, security & IDOR, N+1 queries, API breaking changes, and observability.
- **422 Unprocessable Entity Immunity**: Parses unified diff hunks into AST line mappings to guarantee inline comments only attach to actual added/changed lines in the PR diff. If a line mismatch occurs, a resilient top-level fallback comment is submitted.
- **In-Place Sticky PR Commenting**: Updates existing PR review summary comments in place to eliminate comment spam across iterative commits.
- **Polyglot Workspace Inspection**: Automatically detects and executes environment build, test, and lint scripts across Node.js (`npm`), Python (`pytest`, `ruff`), Go (`go test`), and Rust (`cargo test`).
- **Resilient AI Reasoning Engine**: Dual-SDK integration (`@google/genai` and `@google/generative-ai`) backed by an automated model fallback chain (`gemini-2.5-flash` ➔ `gemini-flash-latest` ➔ `gemini-1.5-flash`) with structured JSON schema outputs.

---

## 📁 Repository Directory Structure

```text
PR_Review_Bot/
├── .github/
│   └── workflows/
│       ├── reusable-pr-review.yml    # Central reusable workflow (workflow_call)
│       └── ai-review.example.yml     # Example caller workflow template
├── src/
│   ├── types.ts                      # Core interfaces, severity, categories & data contracts
│   ├── config.ts                     # Environment & CLI options configuration loader
│   ├── git-service.ts                # Diff extraction, parsing & hunk boundary validation
│   ├── checks-runner.ts              # Polyglot test/build/lint dynamic runner
│   ├── context-builder.ts            # Embedded 12-step review rules & caller context
│   ├── reviewer.ts                   # Gemini AI reasoner, scoring & verdict engine
│   ├── formatter.ts                  # ANSI terminal, Markdown & inline suggestion formatter
│   ├── github-service.ts             # Octokit PR review & sticky comment updater
│   └── cli.ts                        # Command-line entrypoint (Commander)
├── .env.example                      # Template for local environment variables
├── .gitignore
├── eslint.config.js                  # TypeScript ESLint flat configuration
├── package.json
└── tsconfig.json
```

---

## 🛠️ Local Development & Quickstart

### 1. Prerequisites
- Node.js v20 or higher
- npm v10 or higher
- Git

### 2. Installation
```bash
npm install
npm run build
```

### 3. Environment Setup
Copy `.env.example` to `.env` and provide your credentials:
```bash
cp .env.example .env
```

```env
# Google Gemini API Key
GEMINI_API_KEY=your-gemini-api-key-here
GEMINI_MODEL=gemini-2.5-flash

# GitHub Integration (Required for remote posting)
GITHUB_TOKEN=your-personal-access-token
GITHUB_REPOSITORY=owner/repository-name

# Options
TARGET_PROJECT_PATH=.
DRY_RUN=false
OUTPUT_REPORT_PATH=./PR_REVIEW_REPORT.md
```

### 4. Running Locally in Dry-Run Mode
Test diff extraction, hunk validation, and simulated reviews locally without consuming Gemini tokens:
```bash
npm run dev -- --target . --base HEAD~1 --dry-run
```
Or with compiled artifacts:
```bash
node dist/src/cli.js --target . --base HEAD~1 --dry-run
```

---

## 📊 Health Scoring Rubric & Review Verdicts

### Scoring Formula
$$\text{Health Score} = 100 - (\text{Critical} \times 30 + \text{High} \times 15 + \text{Medium} \times 7 + \text{Low} \times 3 + \text{FailedChecks} \times 25)$$
*Clamped between 0 and 100.*

### Letter Grades
| Health Score | Grade |
| :---: | :---: |
| 95 – 100 | **A+** |
| 85 – 94 | **A** |
| 70 – 84 | **B** |
| 55 – 69 | **C** |
| 40 – 54 | **D** |
| < 40 | **F** |

### Verdict Engine
- `CHANGES_REQUESTED`: Issued if $\ge 1$ Critical defect, $\ge 1$ High defect, or any automated tooling check failed.
- `APPROVE_WITH_COMMENTS`: Issued if only Medium or Low issues are identified.
- `APPROVE`: Clean diff with 0 defects.

---

## 🔄 Reusable GitHub Actions Workflow Integration

### Step 1: Central Bot Workflow (`.github/workflows/reusable-pr-review.yml`)
Included in this repository:
- Checks out target repository code.
- Checks out the review bot engine into `.pr-bot-runner`.
- Builds the engine and executes the review targeting the workspace.
- Posts top-level sticky summaries and inline code review comments.

### Step 2: Caller Repository Configuration
In any caller repository, create `.github/workflows/ai-review.yml`:

```yaml
name: AI Pull Request Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    uses: your-org/universal-pr-bot/.github/workflows/reusable-pr-review.yml@main
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    with:
      target-path: '.'
      fail-on-changes: false
```

---

## 💻 CLI Reference

```text
Usage: pr-review-bot [options]

Options:
  -V, --version        Output the version number
  -t, --target <path>  Target project path (default: ".")
  -b, --base <branch>  Base branch for local diff
  --head <branch>      Head branch for local diff
  -p, --pr <number>    GitHub PR number
  --repo <owner/repo>  GitHub repository (owner/repo)
  --post-to-github     Submit live review via Octokit
  --dry-run            Simulate review and save local payload JSON
  --fail-on-changes    Exit code 1 on CHANGES_REQUESTED (CI gate)
  -o, --output <path>  Markdown report path (default: "./PR_REVIEW_REPORT.md")
  -h, --help           Display help for command
```

---

## 📜 License
MIT License. Built for autonomous continuous integration workflows.

