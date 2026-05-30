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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stepBlock(workflowText, stepName) {
  const match = workflowText.match(
    new RegExp(
      `\\n      - name: ${escapeRegExp(stepName)}\\n[\\s\\S]*?(?=\\n      - name: |\\n      # BEGIN:|\\n      # END:|\\n$)`,
    ),
  );
  assert.ok(match, `step not found: ${stepName}`);
  return match[0];
}

test('schema retry validates first successful JSON with checklist names env', () => {
  const codexReviewStep = stepBlock(readWorkflowText(), 'Codex Review via connector bridge');

  assert.match(
    codexReviewStep,
    /REQUIRED_CHECKLIST_NAMES_FILE=\/tmp\/codex-review-required-checklist-names\.json node "\$TRUSTED_REVIEW_JSON_SCRIPT" validate \/tmp\/review-result\.json >/,
  );
  assert.match(
    codexReviewStep,
    /if \[ "\$SCHEMA_RC" -eq 0 \]; then\s+SCHEMA_OK=1\s+echo "Codex review JSON schema validation passed on attempt \$ATTEMPT\."\s+break/,
  );
});

test('secret-bearing review steps execute trusted temp validator copy, not workspace script', () => {
  const workflowText = readWorkflowText();
  const codexReviewStep = stepBlock(workflowText, 'Codex Review via connector bridge');
  const validateAndRenderStep = stepBlock(workflowText, 'Validate and render review JSON');

  for (const [name, block] of [
    ['Codex Review via connector bridge', codexReviewStep],
    ['Validate and render review JSON', validateAndRenderStep],
  ]) {
    assert.match(
      block,
      /git show "origin\/\$\{\{ github\.base_ref \}\}:scripts\/codex-review-json\.cjs" > "\$TRUSTED_REVIEW_JSON_SCRIPT"/,
      `${name} must fetch validator from the trusted base branch`,
    );
    assert.doesNotMatch(
      block,
      /\bnode\s+scripts\/codex-review-json\.cjs\b/,
      `${name} must not execute the PR checkout validator directly`,
    );
  }

  assert.match(validateAndRenderStep, /node "\$TRUSTED_REVIEW_JSON_SCRIPT" validate \/tmp\/review-result\.json/);
  assert.match(validateAndRenderStep, /node "\$TRUSTED_REVIEW_JSON_SCRIPT" render \/tmp\/review-result\.json/);
  assert.match(validateAndRenderStep, /node "\$TRUSTED_REVIEW_JSON_SCRIPT" verdict \/tmp\/review-result\.json/);
});
