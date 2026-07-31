/**
 * Verify that lead.message (raw inquiry text) flows into AI script generation context.
 *
 * When a prospect submits an inquiry like "想咨询装修报价", the AI script generator
 * should receive this as prospectMessage so it can craft a targeted opening line.
 * Previously only lead.score_reason was available — now the prospect's actual words
 * are included in the prompt, enabling scripts like "看到您想咨询装修报价…"
 * instead of the generic "看到您可能需要相关服务".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('AIScriptGenerationContext includes prospectMessage field', () => {
  const context: import('../src/agent-runtime/ai-script-generator.js').AIScriptGenerationContext = {
    tenantId: 'test',
    runId: 'run_test',
    industry: '装修',
    location: '杭州',
    targetProfile: '杭州业主',
    leadReason: '总分 68',
    prospectMessage: '想咨询装修报价，3室2厅大概多少预算',
  };
  assert.equal(context.prospectMessage, '想咨询装修报价，3室2厅大概多少预算');
});

// The source-grep test for ai-script-async-builders.ts was removed: that
// builder lived under lead-acquisition, which was archived in 28f9aff
// ("archive legacy lead-acquisition module"). The prospectMessage mapping it
// verified is now exercised at runtime via ai-script-generator.ts (below).

test('AI script prompt includes prospect own words when provided', () => {
  const mainSource = readFileSync(
    join(repoRoot, 'src/agent-runtime/ai-script-generator.ts'),
    'utf8'
  );
  assert.match(mainSource, /prospectMessage/, 'AIScriptGenerationContext should have prospectMessage');
  assert.match(mainSource, /Prospect.*own words.*prospectMessage/, 'Prompt should include prospect own words');

  const intSource = readFileSync(
    join(repoRoot, 'src/agent-runtime/integrations/ai-script-generator.ts'),
    'utf8'
  );
  assert.match(intSource, /prospect_message/, 'Integration AIScriptContext should have prospect_message');
  assert.match(intSource, /Prospect.*own words/, 'Integration prompt should include prospect own words');
});
