#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/codex-review.yml');
const DISMISS_STALE_POST_TIME_STEP = 'Dismiss stale bot approval (PR no longer applicable at post time)';
const SUBMIT_REVIEW_VERDICT_STEP = 'Submit review verdict';

function readWorkflowText() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

function extractRunScript(stepName) {
  const lines = fs.readFileSync(WORKFLOW_PATH, 'utf8').split('\n');
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(stepIndex, -1, `step not found: ${stepName}`);

  const runIndex = lines.findIndex((line, index) => index > stepIndex && line.trim() === 'run: |');
  assert.notEqual(runIndex, -1, `run block not found: ${stepName}`);

  const block = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== '' && !line.startsWith('          ')) {
      break;
    }
    block.push(line.startsWith('          ') ? line.slice(10) : '');
  }
  return `${block.join('\n')}\n`.replaceAll('${{ github.base_ref }}', '${GITHUB_BASE_REF}');
}

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-workflow-test-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function prepareShellScript(t, script) {
  const dir = makeTempDir(t);
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const scriptPath = path.join(dir, 'step.sh');
  const outputPath = path.join(dir, 'github-output');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return {
    dir,
    binDir,
    scriptPath,
    outputPath,
  };
}

test('recheck not-applicable cleanup dismisses stale bot approvals without submitting a review', (t) => {
  const script = extractRunScript(DISMISS_STALE_POST_TIME_STEP);
  const result = prepareShellScript(t, script);

  writeExecutable(
    path.join(result.binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${result.dir}/gh.log"
if [[ "$*" == *"/reviews --jq"* ]]; then
  printf '101\\n202\\n'
  exit 0
fi
if [[ "$*" == *"/reviews/"*"/dismissals"* ]]; then
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "review" ]]; then
  exit 99
fi
exit 1
`,
  );

  const rerun = spawnSync('bash', ['-e', result.scriptPath], {
    cwd: result.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${result.binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: result.outputPath,
      RUNNER_TEMP: result.dir,
      GH_TOKEN: 'token',
      REPO: 'estack-inc/easy-flow-agent',
      PR_NUM: '176',
      REASON: 'head SHA drift (new-sha)',
    },
  });

  assert.equal(rerun.status, 0, rerun.stderr);
  const ghLog = fs.readFileSync(path.join(result.dir, 'gh.log'), 'utf8');
  assert.match(ghLog, /repos\/estack-inc\/easy-flow-agent\/pulls\/176\/reviews --jq/);
  assert.match(ghLog, /repos\/estack-inc\/easy-flow-agent\/pulls\/176\/reviews\/101\/dismissals/);
  assert.match(ghLog, /repos\/estack-inc\/easy-flow-agent\/pulls\/176\/reviews\/202\/dismissals/);
  assert.doesNotMatch(ghLog, /pr review/);
});

test('recheck not-applicable cleanup fails closed when stale approval listing fails', (t) => {
  const script = extractRunScript(DISMISS_STALE_POST_TIME_STEP);
  const result = prepareShellScript(t, script);

  writeExecutable(
    path.join(result.binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${result.dir}/gh.log"
exit 1
`,
  );

  const rerun = spawnSync('bash', ['-e', result.scriptPath], {
    cwd: result.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${result.binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: result.outputPath,
      RUNNER_TEMP: result.dir,
      GH_TOKEN: 'token',
      REPO: 'estack-inc/easy-flow-agent',
      PR_NUM: '176',
      REASON: 'draft PR',
    },
  });

  assert.equal(rerun.status, 1);
  assert.match(rerun.stdout, /review listing/);
});

test('recheck not-applicable cleanup fails closed when stale approval dismissal fails', (t) => {
  const script = extractRunScript(DISMISS_STALE_POST_TIME_STEP);
  const result = prepareShellScript(t, script);

  writeExecutable(
    path.join(result.binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${result.dir}/gh.log"
if [[ "$*" == *"/reviews --jq"* ]]; then
  printf '101\\n'
  exit 0
fi
if [[ "$*" == *"/reviews/"*"/dismissals"* ]]; then
  exit 1
fi
exit 1
`,
  );

  const rerun = spawnSync('bash', ['-e', result.scriptPath], {
    cwd: result.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${result.binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: result.outputPath,
      RUNNER_TEMP: result.dir,
      GH_TOKEN: 'token',
      REPO: 'estack-inc/easy-flow-agent',
      PR_NUM: '176',
      REASON: 'auto-spec-sync label',
    },
  });

  assert.equal(rerun.status, 1);
  assert.match(rerun.stdout, /review dismiss/);
});

test('submit verdict keeps same SHA blocking review when approve posting fails', (t) => {
  const script = extractRunScript(SUBMIT_REVIEW_VERDICT_STEP);
  const result = prepareShellScript(t, script);

  writeExecutable(
    path.join(result.binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${result.dir}/gh.log"
if [[ "$1" == "api" && "$*" == *"pulls/176 --jq {head_sha:"* ]]; then
  printf '{"head_sha":"head-sha","draft":false,"labels":[]}\\n'
  exit 0
fi
if [[ "$1" == "api" && "$*" == *"/reviews --jq"* ]]; then
  count_file="${result.dir}/review-list-count"
  count=0
  if [[ -f "$count_file" ]]; then
    count=$(<"$count_file")
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  case "$count" in
    1) printf '301\\n' ;;
    3) printf '401\\n' ;;
    4) printf '501\\n' ;;
  esac
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "review" ]]; then
  exit 88
fi
if [[ "$*" == *"/reviews/"*"/dismissals"* ]]; then
  exit 0
fi
exit 1
`,
  );

  const reviewCommentPath = '/tmp/review-comment.md';
  fs.writeFileSync(reviewCommentPath, 'review body\n');
  t.after(() => {
    fs.rmSync(reviewCommentPath, { force: true });
  });

  const rerun = spawnSync('bash', ['-e', result.scriptPath], {
    cwd: result.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${result.binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: result.outputPath,
      RUNNER_TEMP: result.dir,
      GH_TOKEN: 'token',
      REPO: 'estack-inc/easy-flow-agent',
      PR_NUM: '176',
      PR_HEAD_SHA: 'head-sha',
      VERDICT: 'approved',
    },
  });

  assert.equal(rerun.status, 1);
  assert.match(rerun.stdout, /latest review 投稿に失敗しました/);

  const ghLog = fs.readFileSync(path.join(result.dir, 'gh.log'), 'utf8');
  const approveIndex = ghLog.indexOf('pr review 176 --repo estack-inc/easy-flow-agent --approve');
  assert.notEqual(approveIndex, -1, ghLog);
  assert.doesNotMatch(ghLog.slice(0, approveIndex), /reviews\/401\/dismissals/);
  assert.doesNotMatch(ghLog, /reviews\/401\/dismissals/);
  assert.match(ghLog, /reviews\/301\/dismissals/);
  assert.match(ghLog, /reviews\/501\/dismissals/);
});

test('submit verdict skips posting and dismisses stale approvals after head drift', (t) => {
  const script = extractRunScript(SUBMIT_REVIEW_VERDICT_STEP);
  const result = prepareShellScript(t, script);

  writeExecutable(
    path.join(result.binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${result.dir}/gh.log"
if [[ "$1" == "api" && "$*" == *"pulls/176 --jq {head_sha:"* ]]; then
  printf '{"head_sha":"new-head","draft":false,"labels":[]}\\n'
  exit 0
fi
if [[ "$1" == "api" && "$*" == *"/reviews --jq"* ]]; then
  if [[ "$*" != *'env.PRESERVE_SHA'* ]]; then
    printf '777\\n'
  else
    printf '601\\n'
  fi
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "review" ]]; then
  exit 99
fi
if [[ "$*" == *"/reviews/"*"/dismissals"* ]]; then
  exit 0
fi
exit 1
`,
  );

  const reviewCommentPath = '/tmp/review-comment.md';
  fs.writeFileSync(reviewCommentPath, 'review body\n');
  t.after(() => {
    fs.rmSync(reviewCommentPath, { force: true });
  });

  const rerun = spawnSync('bash', ['-e', result.scriptPath], {
    cwd: result.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${result.binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: result.outputPath,
      RUNNER_TEMP: result.dir,
      GH_TOKEN: 'token',
      REPO: 'estack-inc/easy-flow-agent',
      PR_NUM: '176',
      PR_HEAD_SHA: 'old-head',
      VERDICT: 'approved',
    },
  });

  assert.equal(rerun.status, 1);
  assert.match(rerun.stdout, /head SHA drift/);

  const ghLog = fs.readFileSync(path.join(result.dir, 'gh.log'), 'utf8');
  assert.match(ghLog, /pulls\/176 --jq \{head_sha:/);
  assert.match(ghLog, /env\.PRESERVE_SHA/);
  assert.match(ghLog, /reviews\/601\/dismissals/);
  assert.doesNotMatch(ghLog, /reviews\/777\/dismissals/);
  assert.doesNotMatch(ghLog, /pr review/);
});

test('submit verdict skips posting and dismisses stale approvals when PR became draft', (t) => {
  const script = extractRunScript(SUBMIT_REVIEW_VERDICT_STEP);
  const result = prepareShellScript(t, script);

  writeExecutable(
    path.join(result.binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${result.dir}/gh.log"
if [[ "$1" == "api" && "$*" == *"pulls/176 --jq {head_sha:"* ]]; then
  printf '{"head_sha":"head-sha","draft":true,"labels":[]}\\n'
  exit 0
fi
if [[ "$1" == "api" && "$*" == *"/reviews --jq"* ]]; then
  printf '701\\n702\\n'
  exit 0
fi
if [[ "$*" == *"/reviews/"*"/dismissals"* ]]; then
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "review" ]]; then
  exit 99
fi
exit 1
`,
  );

  const reviewCommentPath = '/tmp/review-comment.md';
  fs.writeFileSync(reviewCommentPath, 'review body\n');
  t.after(() => {
    fs.rmSync(reviewCommentPath, { force: true });
  });

  const rerun = spawnSync('bash', ['-e', result.scriptPath], {
    cwd: result.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${result.binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: result.outputPath,
      RUNNER_TEMP: result.dir,
      GH_TOKEN: 'token',
      REPO: 'estack-inc/easy-flow-agent',
      PR_NUM: '176',
      PR_HEAD_SHA: 'head-sha',
      VERDICT: 'approved',
    },
  });

  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /review skipped \(reason: draft PR\)/);

  const ghLog = fs.readFileSync(path.join(result.dir, 'gh.log'), 'utf8');
  assert.match(ghLog, /pulls\/176 --jq \{head_sha:/);
  assert.match(ghLog, /reviews\/701\/dismissals/);
  assert.match(ghLog, /reviews\/702\/dismissals/);
  assert.doesNotMatch(ghLog, /pr review/);
});

test('submit verdict skips posting and dismisses stale approvals when auto-spec-sync label appears', (t) => {
  const script = extractRunScript(SUBMIT_REVIEW_VERDICT_STEP);
  const result = prepareShellScript(t, script);

  writeExecutable(
    path.join(result.binDir, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${result.dir}/gh.log"
if [[ "$1" == "api" && "$*" == *"pulls/176 --jq {head_sha:"* ]]; then
  printf '{"head_sha":"head-sha","draft":false,"labels":["auto-spec-sync"]}\\n'
  exit 0
fi
if [[ "$1" == "api" && "$*" == *"/reviews --jq"* ]]; then
  printf '801\\n'
  exit 0
fi
if [[ "$*" == *"/reviews/"*"/dismissals"* ]]; then
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "review" ]]; then
  exit 99
fi
exit 1
`,
  );

  const reviewCommentPath = '/tmp/review-comment.md';
  fs.writeFileSync(reviewCommentPath, 'review body\n');
  t.after(() => {
    fs.rmSync(reviewCommentPath, { force: true });
  });

  const rerun = spawnSync('bash', ['-e', result.scriptPath], {
    cwd: result.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${result.binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: result.outputPath,
      RUNNER_TEMP: result.dir,
      GH_TOKEN: 'token',
      REPO: 'estack-inc/easy-flow-agent',
      PR_NUM: '176',
      PR_HEAD_SHA: 'head-sha',
      VERDICT: 'changes_requested',
    },
  });

  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /review skipped \(reason: auto-spec-sync label\)/);

  const ghLog = fs.readFileSync(path.join(result.dir, 'gh.log'), 'utf8');
  assert.match(ghLog, /pulls\/176 --jq \{head_sha:/);
  assert.match(ghLog, /reviews\/801\/dismissals/);
  assert.doesNotMatch(ghLog, /pr review/);
});

test('cost record step materializes trusted script from base branch', (t) => {
  const script = extractRunScript('Record AI review cost');
  const result = prepareShellScript(t, script);

  writeExecutable(
    path.join(result.binDir, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${result.dir}/git.log"
if [[ "$1" == "fetch" ]]; then
  exit 0
fi
if [[ "$1" == "show" && "$2" == "origin/main:scripts/ai_review_cost.py" ]]; then
  cat <<'PY'
import json
print(json.dumps({"source": "base-branch"}))
PY
  exit 0
fi
exit 1
`,
  );

  const rerun = spawnSync('bash', ['-e', result.scriptPath], {
    cwd: result.dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${result.binDir}:${process.env.PATH}`,
      GITHUB_OUTPUT: result.outputPath,
      RUNNER_TEMP: result.dir,
      GITHUB_BASE_REF: 'main',
      GITHUB_REPOSITORY: 'estack-inc/easy-flow-agent',
      PR_NUMBER: '176',
      PR_HEAD_SHA: 'event-sha',
      WORKFLOW_NAME: 'codex-review',
      REVIEW_JSON_PATH: '/tmp/review-result.json',
      DIFF_FILES_CHANGED: '1',
      DIFF_ADDITIONS: '2',
      DIFF_DELETIONS: '3',
      WEBHOOK_HTTP_STATUS: '200',
      VERDICT_OVERRIDE: 'approved',
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
    },
  });

  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(fs.readFileSync(path.join(result.dir, 'git.log'), 'utf8'), /show origin\/main:scripts\/ai_review_cost\.py/);
  assert.match(fs.readFileSync(result.outputPath, 'utf8'), /record_exists=true/);
  assert.match(fs.readFileSync(result.outputPath, 'utf8'), /record_path=/);
});

test('review request includes a strict JSON-only no-findings example', () => {
  const workflow = readWorkflowText();

  assert.match(workflow, /no_findings_json_example:/);
  assert.match(workflow, /reviewed_head_sha: \$head_sha/);
  assert.match(workflow, /checklist: \(\$checklist_names\[0\] \| map/);
  assert.match(workflow, /最初の文字は `\{`、最後の文字は `\}`/);
  assert.match(workflow, /`指摘事項はありません。` のような自然文だけの応答も契約違反/);
});
