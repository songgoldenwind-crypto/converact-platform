import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Commander homepage minimal glass selectors exist', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/assets/styles.css', import.meta.url), 'utf8');

  assert.match(html, /id="commander-hero-shell"/);
  assert.match(html, /id="commander-command-deck"/);
  assert.match(html, /id="commander-summary-rail"/);
  assert.match(html, /id="commander-workflow-rail"/);
  assert.match(css, /--glass-card-bg:/);
  assert.match(css, /\.commander-homepage\b/);
  assert.match(css, /\.commander-hero-shell\b/);
  assert.match(css, /\.commander-command-deck\b/);
  assert.match(css, /\.commander-summary-rail\b/);
  assert.match(css, /\.commander-workflow-rail\b/);
});

test('Commander homepage keeps workflow and motion safety rules', () => {
  const css = readFileSync(new URL('../public/assets/styles.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');

  assert.match(css, /#commander-workflow-rail/);
  assert.match(css, /\.mobile-mainline-dock-card\b/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.prompt-chip:hover/);
  assert.match(js, /renderCommanderHome\(/);
});

test('taste refresh keeps Commander focused on lead acquisition instead of platform marketing OS', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');

  assert.doesNotMatch(js, /One-person company marketing OS/);
  assert.doesNotMatch(js, /营销驾驶舱：一句话启动一整套营销工作流/);
  assert.doesNotMatch(js, /内容、页面、客服\/外呼、CRM/);
  assert.doesNotMatch(js, /说一句目标，Converact 帮你组装营销工具流/);
  assert.doesNotMatch(html, /生成一周内容并承接到落地页/);

  assert.match(js, /一人公司的 AI 获客与跟进助手/);
  assert.match(js, /今天先打哪几个客户/);
  assert.match(js, /templateKey:\s*persistedCommander\.templateKey\s*\|\|\s*'lead_acquisition'/);
});

test('taste refresh adds warm depth tokens and keeps motion accessible', () => {
  const css = readFileSync(new URL('../public/assets/styles.css', import.meta.url), 'utf8');

  assert.match(css, /--surface-raised:/);
  assert.match(css, /--surface-inset:/);
  assert.match(css, /--motion-quick:/);
  assert.match(css, /text-wrap:\s*balance/);
  assert.match(css, /button:active/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /#E11D48|#FB7185|#881337/i);
});
