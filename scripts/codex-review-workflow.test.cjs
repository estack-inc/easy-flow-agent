#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WORKFLOW_PATH = path.join(__dirname, '..', '.github', 'workflows', 'codex-review.yml');

function readWorkflowText() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

function extractStep(workflowText, stepName) {
  const startMarker = `      - name: ${stepName}`;
  const start = workflowText.indexOf(startMarker);
  assert.notEqual(start, -1, `step not found: ${stepName}`);

  const next = workflowText.indexOf('\n      - name:', start + startMarker.length);
  return next === -1 ? workflowText.slice(start) : workflowText.slice(start, next);
}

test('secret-bearing codex review step does not fall back to PR head CJS', () => {
  const step = extractStep(readWorkflowText(), 'Codex Review via connector bridge');

  assert.match(step, /REVIEW_WEBHOOK_TOKEN:/, 'test must cover the secret-bearing step');
  assert.doesNotMatch(
    step,
    /CJS="scripts\/codex-review-json\.cjs"/,
    'secret-bearing step must not keep PR head CJS as a fallback candidate',
  );
  assert.doesNotMatch(
    step,
    /using PR head copy/,
    'secret-bearing step must not allow initial-distribution PR head fallback',
  );
  assert.match(
    step,
    /trusted scripts\/codex-review-json\.cjs not found on base ref .* refusing to execute PR head copy/,
    'missing trusted base CJS must fail closed',
  );
});

test('secret-bearing codex review step emits failure outputs before preflight exits', () => {
  const step = extractStep(readWorkflowText(), 'Codex Review via connector bridge');
  const trapIndex = step.indexOf('trap write_codex_review_outputs EXIT');
  const firstPreflightExitIndex = step.indexOf('CODEX_REVIEW_WEBHOOK_URL is not set');

  assert.notEqual(trapIndex, -1, 'failure output trap must be installed');
  assert.notEqual(firstPreflightExitIndex, -1, 'test must cover a preflight exit path');
  assert.ok(
    trapIndex < firstPreflightExitIndex,
    'failure output trap must be installed before any preflight exit',
  );
  assert.match(step, /CURL_RC=127/, 'preflight failures must produce a non-zero curl_rc output');
  assert.match(step, /HTTP_STATUS=000/, 'preflight failures must produce an http_status output');
  assert.match(step, /schema_ok=\$SCHEMA_OK/, 'schema_ok output must be emitted on failure');
});

test('review JSON render step also fails closed without trusted base CJS', () => {
  const step = extractStep(readWorkflowText(), 'Validate and render review JSON');

  assert.doesNotMatch(
    step,
    /CJS="scripts\/codex-review-json\.cjs"/,
    'render step must not keep PR head CJS as a fallback candidate',
  );
  assert.doesNotMatch(
    step,
    /using PR head copy/,
    'render step must not allow initial-distribution PR head fallback',
  );
  assert.match(
    step,
    /trusted scripts\/codex-review-json\.cjs not found on base ref .* refusing to execute PR head copy/,
    'missing trusted base CJS must fail closed',
  );
});
