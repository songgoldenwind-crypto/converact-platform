import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8');
const stylesCss = readFileSync(new URL('../public/assets/styles.css', import.meta.url), 'utf8');
const httpTs = readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8');

test('ordinary user navigation only exposes Commander Today Result', () => {
  const navMatch = indexHtml.match(/<nav class="sidenav"[\s\S]*?<\/nav>/);
  assert.ok(navMatch, 'sidenav should exist');
  const nav = navMatch[0];

  assert.match(nav, /data-page-link="commander"/);
  assert.match(nav, /data-page-link="today"/);
  assert.match(nav, /data-page-link="result"/);
  assert.doesNotMatch(nav, /data-page-link="pipeline"/);
  assert.doesNotMatch(nav, /data-page-link="tools"/);
  assert.doesNotMatch(nav, /data-page-link="customers"/);
  assert.doesNotMatch(nav, /data-page-link="review"/);
});

test('lead run surface uses single-screen workbench mounts instead of long packet sections', () => {
  assert.match(indexHtml, /id="single-screen-workbench"/);
  assert.match(indexHtml, /id="workbench-run-header"/);
  assert.match(indexHtml, /id="workbench-focus-queue"/);
  assert.match(indexHtml, /id="workbench-action-stage"/);
  assert.match(indexHtml, /id="workbench-outcome-dock"/);
  assert.match(indexHtml, /id="workbench-detail-drawer"/);

  assert.doesNotMatch(indexHtml, /id="lead-run-discovery-plan"/);
  assert.doesNotMatch(indexHtml, /id="lead-run-quality-review"/);
  assert.doesNotMatch(indexHtml, /id="lead-run-outcome-review"/);
  assert.doesNotMatch(indexHtml, /id="lead-run-leads"/);
  assert.doesNotMatch(indexHtml, /id="lead-run-script"/);
  assert.doesNotMatch(indexHtml, /id="lead-run-next"/);
});

test('frontend renderer prefers workbench view and keeps packet detail in drawers', () => {
  assert.match(appJs, /function renderActiveLeadRun\(\)/);
  assert.match(appJs, /lead_acquisition_workbench_view/);
  assert.match(appJs, /function renderLeadAcquisitionWorkbenchView/);
  assert.match(appJs, /function renderWorkbenchDetailDrawer/);
  assert.doesNotMatch(appJs, /renderLeadDiscoveryPlan\(run\.discovery_plan/);
  assert.doesNotMatch(appJs, /renderLeadOutcomeReview\(run\.outcome_review/);
  assert.doesNotMatch(appJs, /renderLeadRunLeadCard\)\.join\(''\)/);
});

test('approval action refreshes both lead run and user workbench surfaces', () => {
  const approvalActionBranch = appJs.match(/if \(action === 'approval-action'\) \{[\s\S]*?return;\n  \}/);
  assert.ok(approvalActionBranch, 'approval-action handler should exist');
  assert.match(approvalActionBranch[0], /syncActiveLeadRun\(result\.run\)/);
  assert.match(approvalActionBranch[0], /renderActiveLeadRun\(\)/);
  assert.match(approvalActionBranch[0], /renderUserWorkbench\(\)/);
});

test('single-screen workbench CSS exists with responsive no-long-scroll layout', () => {
  assert.match(stylesCss, /\.single-screen-workbench/);
  assert.match(stylesCss, /\.workbench-action-stage/);
  assert.match(stylesCss, /\.workbench-outcome-dock/);
  assert.match(stylesCss, /\.workbench-detail-drawer/);
  assert.match(stylesCss, /body\[data-page="commander"\]\s*\{[^}]*overflow:\s*hidden/);
  assert.match(stylesCss, /\.single-screen-workbench\s*\{[^}]*height:\s*100vh/);
  assert.match(stylesCss, /\.single-screen-workbench\s*\{[^}]*grid-template-areas:\s*\n?\s*"assets entity agent"/);
  assert.match(stylesCss, /\.workbench-focus-queue\s*\{[^}]*grid-area:\s*assets/);
  assert.match(stylesCss, /\.workbench-action-stage\s*\{[^}]*grid-area:\s*entity/);
  assert.match(stylesCss, /\.workbench-outcome-dock\s*\{[^}]*grid-area:\s*agent/);
  assert.match(stylesCss, /@media \(max-width: 760px\)/);
});

test('reference-image interaction maps to assets, business entity and agent work zones', () => {
  assert.match(indexHtml, /data-reference-layout="tob-ai-three-zone"/);
  assert.match(indexHtml, /aria-label="资产管理与历史记录"/);
  assert.match(indexHtml, /aria-label="一切业务抽象实体"/);
  assert.match(indexHtml, /aria-label="Agent 干活区"/);

  assert.match(appJs, /function renderAgentWorkArea/);
  assert.match(appJs, /data-agent-workbench-action="create-run"/);
  assert.match(appJs, /data-agent-workbench-action="refresh"/);
  assert.match(appJs, /data-agent-workbench-action="open-drawer"/);
  assert.match(appJs, /function handleAgentWorkbenchAction/);
});

test('Commander no longer exposes long-scroll support sections as primary interaction', () => {
  assert.match(stylesCss, /body\[data-page="commander"\]\s+\.commander-stage\s*\{[^}]*display:\s*none/);
  assert.match(stylesCss, /body\[data-page="commander"\]\s+\.recipes-band/);
  assert.match(stylesCss, /body\[data-page="commander"\]\s+\.tool-node-section/);
  assert.match(stylesCss, /body\[data-page="commander"\]\s+\.marketing-journey-section/);
  assert.match(stylesCss, /body\[data-page="commander"\]\s+\.user-workbench/);
});

test('Result surface stays delivery-focused instead of becoming a report center', () => {
  const outcomeDockRenderer = appJs.match(/function renderWorkbenchOutcomeDock\(outcome\) \{[\s\S]*?\n\}/);
  assert.ok(outcomeDockRenderer, 'workbench outcome dock renderer should exist');

  assert.match(appJs, /sellable_delivery_pack/);
  assert.match(appJs, /next_revenue_action_card/);
  assert.match(appJs, /sellable_delivery/);
  assert.match(appJs, /learning_delta/);
  assert.doesNotMatch(indexHtml, /报表中心|\bBI\b|dashboard|metric-tile|admin-panel/i);
  assert.doesNotMatch(outcomeDockRenderer[0], /报表中心|\bBI\b|dashboard|metric-tile|admin-panel/i);
  assert.doesNotMatch(outcomeDockRenderer[0], /<small>\$\{escapeHtml\(outcome\.next_task\.reason \|\| ''\)\}<\/small>/);
});

test('revenue continuation UI does not introduce channel console or inbox drift', () => {
  assert.match(appJs, /revenue_action_execution_pack/);
  assert.match(appJs, /next_batch_learning_profile/);
  assert.match(appJs, /next_batch_launch_plan/);
  assert.match(appJs, /next_batch_run_request/);
  assert.match(appJs, /next_batch_launch_writeback/);
  assert.match(appJs, /next-batch-launch/);
  assert.match(appJs, /next_batch_launch:\s*'下一批启动'/);
  assert.match(appJs, /channel_adapter_execution_request/);
  assert.doesNotMatch(indexHtml, /渠道后台|消息中心|provider console|channel-console|message-inbox/i);
  assert.doesNotMatch(appJs, /渠道后台|消息中心|provider console|channel-console|message-inbox/i);
});

test('Commander desktop fills viewport with three zones only (no topbar / sidebar / page-intro)', () => {
  assert.match(indexHtml, /<body data-page="commander">/);
  assert.match(stylesCss, /body\[data-page="commander"\][^{]*\.topbar[^{]*\{[^}]*display:\s*none/);
  assert.match(stylesCss, /body\[data-page="commander"\][^{]*\.sidebar[^{]*\{[^}]*display:\s*none/);
  assert.match(stylesCss, /body\[data-page="commander"\][^{]*\.page-intro[^{]*\{[^}]*display:\s*none/);
  assert.match(stylesCss, /body\[data-page="commander"\]\s+\.app-shell\s*\{[^}]*height:\s*100vh/);
  assert.match(stylesCss, /body\[data-page="commander"\]\s+main\s*\{[^}]*height:\s*100vh/);
  assert.match(stylesCss, /body\[data-page="commander"\]\s+#active-lead-run\s*\{[^}]*height:\s*100vh/);
});

test('browser deep links and stale home tab state still land on three-zone workbench', () => {
  assert.match(httpTs, /'\/today'/);
  assert.match(httpTs, /'\/result'/);
  assert.match(appJs, /'\/today':\s*'commander'/);
  assert.match(appJs, /'\/result':\s*'commander'/);
  assert.match(indexHtml, /\/assets\/styles\.css\?v=three-zone-20260527-ui6/);
  assert.match(indexHtml, /\/assets\/app\.js\?v=three-zone-20260527-ui6/);
  assert.match(appJs, /function currentHomePanel\(\) \{[\s\S]*?return 'workflow';/);
  assert.match(appJs, /function applyHomePanel\(\) \{[\s\S]*?section\.id === 'active-lead-run'/);
});

test('left zone renders Converact brand status header and asset history tabs', () => {
  assert.match(appJs, /key:\s*'runs'/);
  assert.match(appJs, /key:\s*'leads'/);
  assert.match(appJs, /key:\s*'calls'/);
  assert.match(appJs, /key:\s*'scripts'/);
  assert.match(appJs, /data-asset-tab="\$\{tab\.key\}"/);
  assert.match(appJs, /workbench-assets-brand/);
  assert.match(appJs, /function handleAssetTabSwitch/);
});

test('left asset tab choice persists across refreshes', () => {
  assert.match(appJs, /assetTab:\s*persistedCommander\.assetTab\s*\|\|\s*'runs'/);
  assert.match(appJs, /assetTab:\s*state\.commander\.assetTab/);
  assert.match(
    appJs,
    /function handleAssetTabSwitch\(tab\)\s*\{[\s\S]*state\.commander\.assetTab\s*=\s*tab;[\s\S]*persistCommanderState\(\);[\s\S]*renderWorkbenchFocusQueue/
  );
});

test('right zone Agent area exposes call action and writeback action', () => {
  assert.match(appJs, /data-agent-workbench-action="call"/);
  assert.match(appJs, /data-agent-workbench-action="writeback"/);
});

test('workbench keeps full mainline content and a real call console visible', () => {
  assert.match(appJs, /renderTodayContextHeaderCard\(run,\s*model\)/);
  assert.match(appJs, /renderTodayEvidenceReasonCard\(run,\s*model\)/);
  assert.match(appJs, /renderTodayScriptActionStrip\(run,\s*model\)/);
  assert.match(appJs, /workbench-call-console/);
  assert.match(appJs, /data-agent-call-phone/);
  assert.match(appJs, /data-agent-workbench-action="agent-call"/);
  assert.match(appJs, /placeOutboundCall\(\)/);
});

test('workbench adapts to browser width without horizontal overflow', () => {
  assert.match(stylesCss, /\.single-screen-workbench\s*\{[^}]*width:\s*100%/);
  assert.match(stylesCss, /\.single-screen-workbench\s*\{[^}]*max-width:\s*100vw/);
  assert.match(stylesCss, /\.single-screen-workbench\s*\{[^}]*height:\s*100dvh/);
  assert.match(stylesCss, /\.single-screen-workbench\s*\{[^}]*grid-template-columns:[^;]*clamp/);
  assert.doesNotMatch(stylesCss, /@media \(max-width:\s*1180px\)[\s\S]*grid-template-areas:\s*"assets entity"[\s\S]*"agent agent"/);
  assert.match(stylesCss, /@media \(max-width:\s*760px\)[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(stylesCss, /\.workbench-action-stage-content\s*\{[^}]*max-width:\s*none/);
});

test('mobile Agent dock keeps call console in normal flow instead of collapsing', () => {
  const mobileBlocks = [...stylesCss.matchAll(/@media \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/g)];
  assert.equal(mobileBlocks.length, 1, 'mobile workbench rules should live in one breakpoint to avoid cascade conflicts');
  const mobileCss = mobileBlocks[0][1];

  assert.match(mobileCss, /\.single-screen-workbench\s*\{[\s\S]*display:\s*flex/);
  assert.doesNotMatch(mobileCss, /\.single-screen-workbench\s*\{[\s\S]*display:\s*grid/);
  assert.match(mobileCss, /\.workbench-outcome-dock\s*\{[\s\S]*position:\s*relative/);
  assert.match(mobileCss, /\.workbench-outcome-dock\s*\{[\s\S]*overflow:\s*visible/);
  assert.match(mobileCss, /\.workbench-outcome-dock-content\s*\{[\s\S]*flex:\s*initial/);
  assert.match(mobileCss, /\.workbench-call-console\s*\{[\s\S]*min-height:\s*0/);
});

test('taste refresh strengthens action-stage hierarchy without dashboard drift', () => {
  assert.match(stylesCss, /--surface-raised:/);
  assert.match(stylesCss, /\.workbench-action-stage\s*\{[^}]*background:\s*var\(--surface-raised\)[^}]*\}/);
  assert.match(stylesCss, /\.workbench-outcome-dock\s*\{[^}]*position:\s*relative[^}]*\}/);
  assert.match(stylesCss, /\.focus-queue-item:active/);
  assert.match(stylesCss, /@media \(max-width: 760px\)[\s\S]*\.workbench-outcome-dock/);
  assert.doesNotMatch(stylesCss, /dashboard-gradient|metric-tile|admin-panel/i);
});

test('P0 Today cockpit makes priority, evidence chain, execution and learning visible in one screen', () => {
  assert.match(appJs, /function renderTodayCockpitPriorityStack/);
  assert.match(appJs, /function renderTodayEvidenceChainCard/);
  assert.match(appJs, /function renderAgentOutcomeRail/);
  assert.match(appJs, /data-today-cockpit="priority-stack"/);
  assert.match(appJs, /data-evidence-chain/);
  assert.match(appJs, /证据链/);
  assert.match(appJs, /证据强度/);
  assert.match(appJs, /接通-感兴趣/);
  assert.match(appJs, /要资料/);
  assert.match(appJs, /拒绝/);
  assert.match(appJs, /未接/);
  assert.match(appJs, /下一批为什么更准/);
  assert.match(appJs, /renderTodayCockpitPriorityStack\(run,\s*model\)/);
  assert.match(appJs, /renderTodayEvidenceChainCard\(run,\s*model\)/);
  assert.match(appJs, /renderAgentOutcomeRail\(run\)/);
  assert.match(stylesCss, /\.today-cockpit-priority-stack/);
  assert.match(stylesCss, /\.today-evidence-chain-card/);
  assert.match(stylesCss, /\.agent-outcome-rail/);
  assert.match(stylesCss, /\.agent-learning-preview/);
});

test('Agent work area feels like an intelligent execution agent, not a static button dock', () => {
  assert.match(appJs, /function buildAgentPresenceSteps/);
  assert.match(appJs, /function agentPresenceToneClass/);
  assert.match(appJs, /function renderAgentPresenceRail/);
  assert.match(appJs, /function renderAgentIntelligenceBrief/);
  assert.match(appJs, /Agent 正在做什么/);
  assert.match(appJs, /已理解/);
  assert.match(appJs, /正在判断/);
  assert.match(appJs, /等待你确认/);
  assert.match(appJs, /确认后继续/);
  assert.match(appJs, /不是聊天框/);
  assert.match(appJs, /智能执行感/);
  assert.match(appJs, /renderAgentPresenceRail\(run,\s*outcome,\s*action\)/);
  assert.match(appJs, /renderAgentIntelligenceBrief\(run,\s*outcome,\s*action\)/);
  assert.match(appJs, /new Set\(\['ready',\s*'working',\s*'waiting',\s*'next'\]\)/);
  assert.match(appJs, /agent-presence-step \$\{agentPresenceToneClass\(step\.tone\)\}/);
  assert.doesNotMatch(appJs, /agent-presence-step \$\{escapeHtml\(step\.tone\)\}/);
  assert.match(stylesCss, /\.agent-presence-rail/);
  assert.match(stylesCss, /\.agent-presence-step/);
  assert.match(stylesCss, /\.agent-intelligence-brief/);
  assert.match(stylesCss, /\.agent-thinking-line/);
});
