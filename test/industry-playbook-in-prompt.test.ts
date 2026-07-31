/**
 * Verify industry playbook (opening_hooks, message_angles, objection_patterns)
 * flows into AI script generation prompt.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('AIScriptGenerationContext includes industryPlaybook field', () => {
  const source = readFileSync(join(repoRoot, 'src/agent-runtime/ai-script-generator.ts'), 'utf8');
  assert.match(source, /industryPlaybook/, 'AIScriptGenerationContext should have industryPlaybook');
  assert.match(source, /openingHooks/, 'should include openingHooks');
  assert.match(source, /messageAngles/, 'should include messageAngles');
  assert.match(source, /objectionPatterns/, 'should include objectionPatterns');
});

test('AI prompt builder renders industry playbook sections', () => {
  const source = readFileSync(join(repoRoot, 'src/agent-runtime/ai-script-generator.ts'), 'utf8');
  assert.match(source, /Industry playbook opening strategy/, 'Prompt should include opening strategy');
  assert.match(source, /Industry playbook message angles/, 'Prompt should include message angles');
  assert.match(source, /Industry playbook objection responses/, 'Prompt should include objection responses');
});

// The source-grep test for ai-script-async-builders.ts was removed: that
// builder lived under lead-acquisition, which was archived in 28f9aff
// ("archive legacy lead-acquisition module"). The industryPlaybook extraction
// it verified is now covered by the ai-script-generator.ts checks above.
