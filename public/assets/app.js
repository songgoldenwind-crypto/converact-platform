const persistedCommander = JSON.parse(localStorage.getItem('opc.commander') || 'null') || {};
const state = {
  tenant: JSON.parse(localStorage.getItem('opc.tenant') || 'null'),
  channel: null,
  sourceTag: null,
  page: null,
  data: {
    tasks: [],
    completedTasks: [],
    inquiries: [],
    leads: [],
    sourceTags: [],
    pages: [],
    channels: [],
    weeklyReport: null,
    funnel: null,
    workbench: null,
    callCenter: null,
    leadRuns: [],
    activeLeadRun: null,
    leadRunQueueSkips: null,
    ops: null,
    p1: null
  },
  commander: {
    ...persistedCommander,
    templateKey: persistedCommander.templateKey || 'lead_acquisition',
    activeRecipe: persistedCommander.activeRecipe || 'ten-consultations',
    activeLeadRunId: persistedCommander.activeLeadRunId || '',
    lastLeadRun: persistedCommander.lastLeadRun || null,
    goal: persistedCommander.goal || '',
    lastPlan: persistedCommander.lastPlan || null,
    lastRun: persistedCommander.lastRun || null,
    assetTab: persistedCommander.assetTab || 'runs'
  },
  campaign: {
    snapshot: null,
    runner: null,
    history: []
  },
  ui: {
    focusedWorkbenchTaskId: null,
    focusedWorkbenchTaskContext: null,
    focusedCallContext: null,
    focusedCallSessionId: null,
    latestCallWritebackReview: null,
    activePublicSourceTaskId: null,
    pendingWorkbenchTaskScroll: false
  },
  taskOutcome: {
    taskId: null,
    presetResult: ''
  }
};

const $ = (selector) => document.querySelector(selector);
const PAGE_CONFIG = {
  commander: {
    path: '/',
    title: '一人公司的 AI 获客与跟进助手',
    eyebrow: 'Lead acquisition desk',
    copy: '今天只围绕三件事：找到更可能成交的客户、准备开口话术、联系后写回下一步。'
  },
  today: {
    path: '/today',
    title: 'Today：联系、记录、下一步',
    eyebrow: 'Single-screen workbench',
    copy: '今天只处理一个当前主动作：看推荐理由、照读开口、完成联系，然后立刻记录结果。'
  },
  result: {
    path: '/result',
    title: 'Result：交付状态与明天继续',
    eyebrow: 'Delivery result',
    copy: '只看本轮完成了什么、是否可交付、明天继续跟谁和下一批先补什么。'
  },
  pipeline: {
    path: '/pipeline',
    title: '获客执行 support shell',
    eyebrow: 'Support shell',
    copy: '这里保留获客执行相关的支撑入口，但主产品层仍然是 Commander / Today / Result。'
  },
  tools: {
    path: '/tools',
    title: '支撑节点 support shell',
    eyebrow: 'Support shell',
    copy: '这些工具只服务获客执行主链，不代表独立平台。'
  },
  customers: {
    path: '/customers',
    title: '客户与任务 support shell',
    eyebrow: 'Support shell',
    copy: '这里只承接今天必须处理的客户、任务、咨询、呼叫和下一步，不做复杂 CRM 后台。'
  },
  review: {
    path: '/review',
    title: '复盘 support shell',
    eyebrow: 'Support shell',
    copy: '这里只看结果、下一步和简单复盘，不做大而全报表中心。'
  },
  campaign: {
    path: '/campaign',
    title: '获客流水线 support shell',
    eyebrow: 'Support shell',
    copy: '旧链接已映射为获客执行的支撑页，避免回到孤立模块视角。'
  },
  workbench: {
    path: '/workbench',
    title: '客户与任务 support shell',
    eyebrow: 'Support shell',
    copy: '旧链接已映射为客户与任务的支撑页。'
  },
  'call-center': {
    path: '/call-center',
    title: '呼叫 support shell',
    eyebrow: 'Support shell',
    copy: '呼叫只是线索跟进、客服转人工、预约确认、客户维护里的执行节点。'
  },
  'demo-flow': {
    path: '/demo-flow',
    title: '流程补录 support shell',
    eyebrow: 'Support shell',
    copy: '这一页只保留补录入口，用来补齐来源、页面和咨询数据，不作为最终主界面。'
  },
  support: {
    path: '/support',
    title: '支撑运营 support shell',
    eyebrow: 'Support shell',
    copy: '这里只放支撑运营层与底座信号，不替代最终用户主界面。'
  },
  resources: {
    path: '/resources',
    title: '资源 support shell',
    eyebrow: 'Support shell',
    copy: '这里只看来源标签、落地页和公开访问资源，避免跟 Commander 和工作台挤在一起。'
  }
};
const CURRENT_PAGE = resolveCurrentPage(window.location.pathname);
const PENDING_COMMANDER_INTENT_KEY = 'opc.pendingCommanderIntent';
const HOME_PANEL_KEY = 'opc.homePanel';

const COMMANDER_TEMPLATES = {
  lead_acquisition: {
    goal: '我是做财税服务的，帮我在杭州找 20 家可能需要代理记账的小公司，并安排今天要联系的客户',
    fields: [
      { name: 'industry', label: '行业', placeholder: '例如 财税服务 / 装修 / 教培' },
      { name: 'location', label: '区域', placeholder: '例如 杭州 / 深圳 / 成都' },
      { name: 'target_customer_profile', label: '目标客户画像', type: 'textarea', rows: 3, placeholder: '例如 刚注册公司、可能需要代理记账的小微企业主' },
      { name: 'lead_count_target', label: '目标线索数', placeholder: '例如 20' }
    ]
  },
  weekly_review: {
    goal: '帮我生成本周复盘',
    fields: []
  },
  crm_followup: {
    goal: '帮我创建一个跟进任务',
    fields: [
      {
        name: 'object_type',
        label: '对象类型',
        type: 'select',
        options: [
          ['lead', 'Lead'],
          ['inquiry', 'Inquiry'],
          ['opportunity', 'Opportunity']
        ]
      },
      { name: 'object_id', label: '对象 ID', placeholder: '例如 lead_001' },
      { name: 'title', label: '任务标题', placeholder: '例如 30 分钟内联系该线索' },
      {
        name: 'priority',
        label: '优先级',
        type: 'select',
        options: [
          ['P1', 'P1'],
          ['P2', 'P2'],
          ['P3', 'P3']
        ]
      }
    ]
  },
  voice_followup: {
    goal: '给这个线索安排一次外呼跟进',
    fields: [
      { name: 'lead_id', label: '线索 ID', placeholder: '填写需要外呼的线索 ID' },
      { name: 'phone', label: '联系电话', placeholder: '填写需要联系的号码' },
      { name: 'script', label: '外呼脚本', type: 'textarea', rows: 4, placeholder: '一句话说明这通电话要确认什么' }
    ]
  },
  growth_loop: {
    goal: '帮我跑一个默认获客流程',
    fields: [
      {
        name: 'platform_code',
        label: '渠道平台',
        type: 'select',
        options: [
          ['linkedin', 'LinkedIn'],
          ['xiaohongshu', '小红书'],
          ['reddit', 'Reddit'],
          ['tiktok', 'TikTok'],
          ['google', 'Google SEO']
        ]
      },
      { name: 'entry_point', label: '入口', placeholder: '例如 bio_link' },
      { name: 'landing_page.title', label: '落地页标题', placeholder: '例如 免费增长诊断' },
      { name: 'landing_page.slug', label: '落地页 slug', placeholder: '例如 growth-diagnosis' },
      { name: 'landing_page.headline', label: '主标题', placeholder: '例如 帮你判断下一步最值得做的获客动作' },
      { name: 'landing_page.subheadline', label: '副标题', placeholder: '例如 留下联系方式后系统会自动跟进' },
      { name: 'inquiry.name', label: '客户姓名', placeholder: '填写咨询人的称呼' },
      { name: 'inquiry.email', label: '客户邮箱', placeholder: '填写可联系邮箱' },
      { name: 'inquiry.phone', label: '客户电话', placeholder: '填写可联系手机号' },
      { name: 'inquiry.message', label: '客户诉求', type: 'textarea', rows: 4, placeholder: '填写客户当前问题或目标' }
    ]
  },
  integration_stack: {
    goal: '帮我推荐适合 OPC 的开源工具组合',
    fields: []
  }
};

const DEFAULT_RECIPES = [
  {
    id: 'ten-consultations',
    title: '本周多拿 10 个高质量咨询',
    copy: '先筛出值得今天联系的人，给出推荐理由、开口话术和跟进安排。',
    templateKey: 'lead_acquisition',
    goal: '我是做企业服务的，帮我本周找到 10 个高质量咨询，并安排今天优先联系的客户',
    outcome: '获客执行 + 今日跟进'
  },
  {
    id: 'map-to-call',
    title: '从地图找客户并预约',
    copy: '把地图获客作为起点，筛选潜在客户，生成触达材料，再进入 AI/人工外呼和 CRM 跟进。',
    templateKey: 'lead_acquisition',
    goal: '我是做财税服务的，帮我在杭州找 20 家可能需要代理记账的小公司，并安排外呼预约',
    outcome: '地图获客 + 外呼 + 预约'
  },
  {
    id: 'evidence-to-call',
    title: '先补证据再联系',
    copy: '当线索理由不够稳时，先补来源证据、痛点角度和异议处理，再进入今天联系。',
    templateKey: 'lead_acquisition',
    goal: '帮我先补齐这批线索的联系理由和开口依据，再安排今天最该联系的客户',
    outcome: '补证据 + 跟进'
  },
  {
    id: 'voice-qualify',
    title: '先筛高意向线索再外呼',
    copy: '把已有线索按优先级进入外呼节点，识别预约、回拨、转人工和放弃。',
    templateKey: 'lead_acquisition',
    goal: '帮我筛出今天最值得外呼的高意向线索，并把结果回写到下一步跟进',
    outcome: '外呼筛选 + 回写'
  },
  {
    id: 'conversion-review',
    title: '复盘哪些动作值得继续',
    copy: '读取线索、呼叫和任务结果，生成明天继续跟谁以及下一批先补什么。',
    templateKey: 'weekly_review',
    goal: '帮我复盘本周哪些获客和跟进动作有效，并生成下周动作建议',
    outcome: '复盘 + 下一步'
  }
];

applyPageShell();

bind('#bootstrap', 'click', bootstrapTenant);
bind('#refresh', 'click', refresh);
bind('#source-form', 'submit', createSourceFlow);
bind('#page-form', 'submit', createLandingFlow);
bind('#inquiry-form', 'submit', submitInquiryFlow);
bind('#commander-form', 'submit', planCommanderFlow);
bind('#commander-run', 'click', runCommanderFlow);
bind('#commander-goal', 'input', handleCommanderGoalDraftChange);
bind('#commander-field-grid', 'input', handleCommanderFieldDraftChange);
bind('#commander-field-grid', 'change', handleCommanderFieldDraftChange);
bind('#task-outcome-form', 'submit', submitTaskOutcome);
bind('#task-outcome-cancel', 'click', closeTaskOutcomeDialog);
bind('#task-outcome-result', 'change', syncTaskOutcomeDefaults);
bind('#task-outcome-next-step', 'change', syncTaskOutcomeHint);
bind('#call-outbound-form', 'submit', startOutboundCall);
bind('#call-inbound-form', 'submit', createInboundCall);
bind('#call-disposition-form', 'submit', completeActiveCall);
bind('#call-disposition', 'change', handleActiveCallDispositionChange);
bind('#call-disposition-form textarea[name="summary"]', 'input', handleActiveCallSummaryInput);
bind('#call-next-step-due-at', 'input', handleActiveCallDueAtInput);
bind('#task-outcome-dialog', 'close', () => {
  state.taskOutcome.taskId = null;
  state.taskOutcome.presetResult = '';
});

document.querySelectorAll('[data-commander-template]').forEach((button) => {
  button.addEventListener('click', () => {
    applyCommanderTemplate(button.dataset.commanderTemplate || 'growth_loop');
  });
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action="complete-task"]');
  if (!button) return;
  try {
    ensureTenant();
    openTaskOutcomeDialog(button.dataset.taskId);
  } catch (error) {
    showError(error);
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-task-outcome-quick]');
  if (!button) return;
  try {
    ensureTenant();
    openTaskOutcomeDialog(button.dataset.taskId, button.dataset.outcomeValue || '');
  } catch (error) {
    showError(error);
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-workbench-call-lead]');
  if (!button) return;
  try {
    ensureTenant();
    callFocusedWorkbenchLead(button);
  } catch (error) {
    showError(error);
  }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action="delay-task"]');
  if (!button) return;
  try {
    ensureTenant();
    const delayHours = Number(button.dataset.delayHours || 24);
    const result = await api(`/api/tasks/${button.dataset.taskId}/reschedule`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        delay_hours: delayHours,
        reschedule_reason: `主界面快速延后 ${delayHours} 小时`
      }
    });
    toast(`任务已延后到 ${formatDate(result.due_at)}`);
    await refresh();
  } catch (error) {
    showError(error);
  }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-next-command]');
  if (!button) return;
  const templateKey = button.dataset.commanderTemplate || inferCommanderTemplateKey(button.dataset.nextCommand) || 'crm_followup';
  openCommanderIntent(button.dataset.nextCommand || COMMANDER_TEMPLATES[templateKey].goal, templateKey, button.dataset.prefillJson || '');
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-recipe-id]');
  if (!button) return;
  const recipe = DEFAULT_RECIPES.find((item) => item.id === button.dataset.recipeId);
  if (!recipe) return;
  applyRecipe(recipe);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-result-action]');
  if (!button) return;
  handleResultAction(button.dataset.resultAction);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-lead-run-action]');
  if (!button) return;
  Promise.resolve(handleLeadRunAction(button.dataset.leadRunAction, button)).catch(showError);
});


document.addEventListener('click', (event) => {
  const drawerButton = event.target.closest('[data-workbench-drawer]');
  if (drawerButton) {
    openWorkbenchDrawer(drawerButton.dataset.workbenchDrawer);
    return;
  }
  const closeButton = event.target.closest('[data-workbench-drawer-close]');
  if (closeButton) {
    closeWorkbenchDrawer();
    return;
  }
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-call-writeback-option]');
  if (!button) return;
  Promise.resolve(completeActiveCallWithOption(button)).catch(showError);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-fill-import-example]');
  if (!button) return;
  const textarea = $('#lead-run-import-lines');
  if (!textarea) return;
  const example = button.dataset.fillImportExample || '';
  state.ui.activePublicSourceTaskId = button.dataset.sourceTaskId || state.ui.activePublicSourceTaskId;
  textarea.value = textarea.value.trim() ? `${textarea.value.trim()}\n${example}` : example;
  textarea.focus();
  updateLeadRunImportHintPreview();
  toast(state.ui.activePublicSourceTaskId
    ? '已选择这个来源任务，并把模板放入导入框'
    : '已把示例线索放入导入框，请替换成真实客户信息');
});

document.addEventListener('input', (event) => {
  if (!(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) return;
  if (!['lead-run-import-lines', 'lead-run-live-source-url'].includes(event.target.id)) return;
  updateLeadRunImportHintPreview();
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-lead-run-repair-queue]');
  if (!button) return;
  Promise.resolve(repairLeadRunQueueItem(button)).catch(showError);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-repair-review-action]');
  if (!button) return;
  Promise.resolve(handleRepairReviewAction(button)).catch(showError);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-campaign-action]');
  if (!button) return;
  Promise.resolve(handleCampaignAction(button.dataset.campaignAction)).catch(showError);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-campaign-history-id]');
  if (!button) return;
  const artifactId = button.dataset.campaignHistoryId;
  const artifact = state.campaign.history.find((item) => item.id === artifactId);
  if (!artifact?.payload) return;
  state.campaign.snapshot = artifact.payload;
  state.commander.activeRecipe = artifact.payload.recipeId || state.commander.activeRecipe;
  const templateKey = DEFAULT_RECIPES.find((recipe) => recipe.id === state.commander.activeRecipe)?.templateKey || state.commander.templateKey;
  applyCommanderTemplate(templateKey, { preserveGoal: true });
  if (artifact.payload.goal) {
    $('#commander-goal').value = artifact.payload.goal;
  }
  state.campaign.runner = artifact.payload.runner || null;
  renderDefaultRecipes();
  renderCommanderHome();
  renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
  renderUserWorkbench();
  renderWeeklyCampaign();
  toast('已恢复这个战役版本');
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-home-tab]');
  if (!button) return;
  setHomePanel(button.dataset.homeTab || 'workflow');
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-mainline-scroll]');
  if (!button) return;
  const panel = button.dataset.mainlinePanel || '';
  if (panel) setHomePanel(panel);
  const targetId = button.dataset.mainlineScroll || '';
  if (!targetId) return;
  window.setTimeout(() => {
    const target = document.getElementById(targetId);
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 60);
});

document.addEventListener('click', (event) => {
  const dialButton = event.target.closest('[data-dial-key]');
  if (!dialButton) return;
  const phoneInput = $('#call-phone');
  if (!phoneInput) return;
  phoneInput.value = `${phoneInput.value || ''}${dialButton.dataset.dialKey || ''}`;
  phoneInput.focus();
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-call-action]');
  if (!button) return;
  Promise.resolve(handleCallAction(button.dataset.callAction, button)).catch(showError);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-agent-workbench-action]');
  if (!button) return;
  Promise.resolve(handleAgentWorkbenchAction(button.dataset.agentWorkbenchAction, button)).catch(showError);
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-asset-tab]');
  if (!button) return;
  handleAssetTabSwitch(button.dataset.assetTab);
});

document.addEventListener('click', (event) => {
  const popover = $('#call-dialpad-popover');
  if (!popover || popover.hidden) return;
  if (event.target.closest('.callbar-call-wrap') || event.target.closest('#call-phone')) return;
  closeCallDialpad();
});

applyCommanderTemplate(state.commander.templateKey);
if (state.commander.goal) {
  $('#commander-goal').value = state.commander.goal;
}
consumePendingCommanderIntent();
renderDefaultRecipes();

if (state.tenant) {
  renderTenantStatus();
  restoreCampaignSnapshot()
    .catch((error) => console.warn('[opc] failed to restore campaign snapshot', error))
    .finally(() => refresh().catch(showError));
} else {
  renderEmptyState();
}

async function createWorkspaceIfNeeded(preferredName = '默认工作区') {
  if (state.tenant) return state.tenant;
  state.tenant = await api('/api/tenants', {
    method: 'POST',
    body: { name: preferredName }
  });
  localStorage.setItem('opc.tenant', JSON.stringify(state.tenant));
  renderTenantStatus();
  return state.tenant;
}

async function bootstrapTenant() {
  if (state.tenant) {
    toast('当前工作区已就绪');
    return;
  }
  await createWorkspaceIfNeeded();
  toast('默认工作区已创建');
  await refresh();
}

async function createSourceFlow(event) {
  event.preventDefault();
  await createWorkspaceIfNeeded();
  const form = Object.fromEntries(new FormData(event.target));

  state.channel = await api('/api/channels', {
    method: 'POST',
    body: {
      tenant_id: state.tenant.id,
      platform_code: form.platform_code,
      target_goal: 'lead'
    }
  });
  state.sourceTag = await api('/api/source-tags', {
    method: 'POST',
    body: {
      tenant_id: state.tenant.id,
      channel_id: state.channel.id,
      entry_point: form.entry_point,
      slug: state.page?.slug || 'growth-diagnosis'
    }
  });

  output('#source-output', state.sourceTag);
  renderLinks();
  toast('来源链接已创建');
  await refresh();
}

async function createLandingFlow(event) {
  event.preventDefault();
  await createWorkspaceIfNeeded();
  const form = Object.fromEntries(new FormData(event.target));

  state.page = await api('/api/landing-pages', {
    method: 'POST',
    body: {
      tenant_id: state.tenant.id,
      source_tag_id: state.sourceTag?.id,
      lead_acquisition_run_id: state.data.activeLeadRun?.id || state.commander.activeLeadRunId || '',
      title: form.title,
      slug: form.slug,
      headline: form.headline,
      subheadline: '提交后系统会自动识别来源、打分、创建跟进任务。',
      status: 'live'
    }
  });

  output('#page-output', {
    ...state.page,
    public_url: landingUrl()
  });
  renderLinks();
  toast('落地页已创建');
  await refresh();
}

async function submitInquiryFlow(event) {
  event.preventDefault();
  await createWorkspaceIfNeeded();
  const form = Object.fromEntries(new FormData(event.target));
  const result = await api('/api/forms/submit', {
    method: 'POST',
    body: {
      tenant_id: state.tenant.id,
      landing_page_id: state.page?.id,
      source_tag_id: state.sourceTag?.id,
      lead_acquisition_run_id: state.page?.lead_acquisition_run_id || state.data.activeLeadRun?.id || state.commander.activeLeadRunId || '',
      ...form
    }
  });
  output('#inquiry-output', result);
  toast(result.lead_run_bridge?.linked ? '咨询已提交并接入当前获客执行' : '咨询已提交并自动评分');
  await refresh();
}

async function planCommanderFlow(event) {
  event.preventDefault();
  await createWorkspaceIfNeeded();
  const payload = buildCommanderPayload();
  const result = await commanderRequest('/api/commander/plan', payload);
  syncCommanderResponse(result.data);
  renderCommanderHome();
  renderCommanderResults(result.data, null);
  setHomePanel('results');
  renderUserWorkbench();
  renderCustomerTimeline();
  toast(result.ok ? '执行计划已生成' : '还缺少少量上下文');
}

async function runCommanderFlow() {
  await createWorkspaceIfNeeded();
  const payload = buildCommanderPayload();
  if (shouldUseLeadAcquisitionRun(payload)) {
    const result = await executeLeadAcquisitionRun(payload);
    syncActiveLeadRun(result.run);
    renderCommanderHome();
    renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
    renderActiveLeadRun();
    renderUserWorkbench();
    renderWeeklyCampaign();
    renderCustomerTimeline();
    setHomePanel('results');
    toast(result.attached_leads > 0 ? '获客执行已创建，话术和今日跟进队列已生成' : '获客执行已创建，下一步先导入或发现线索');
    await refresh();
    return;
  }
  const result = await commanderRequest('/api/commander/run', payload);
  syncCommanderResponse(result.data);
  renderCommanderHome();
  renderCommanderResults(result.data?.plan || state.commander.lastPlan, result.data);
  setHomePanel('results');
  renderUserWorkbench();
  renderWeeklyCampaign();
  renderCustomerTimeline();
  toast(result.ok ? 'Commander 已执行完成' : '还缺少少量上下文');
  if (result.ok && result.data?.status !== 'blocked_missing_context') {
    await refresh();
  }
}

async function executeLeadAcquisitionRun(payload) {
  const run = await api('/api/lead-acquisition-runs', {
    method: 'POST',
    body: buildLeadAcquisitionPayload(payload)
  });
  let detail = run;
  const existingLeads = chooseLeadsForAcquisitionRun(payload);
  if (existingLeads.length) {
    const added = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/leads`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        leads: existingLeads.map((lead) => ({ lead_id: lead.id }))
      }
    });
    detail = added.run || detail;
  }
  const scriptResult = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/script`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });
  detail = scriptResult.run || detail;
  if (existingLeads.length) {
    const queue = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/followup-queue`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id, min_score: 40 }
    });
    detail = queue.run || detail;
  }
  detail = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/refresh-summary`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });

  const syntheticPlan = buildLeadAcquisitionCommanderPlan(payload, detail);
  state.commander.lastPlan = syntheticPlan;
  state.commander.lastRun = {
    status: 'completed',
    plan: syntheticPlan,
    route: syntheticPlan.route,
    artifacts: [],
    step_outputs: {
      lead_acquisition_run: detail
    }
  };
  return {
    run: detail,
    attached_leads: existingLeads.length
  };
}

async function startOutboundCall(event) {
  event.preventDefault();
  await placeOutboundCall();
}

async function placeOutboundCall() {
  await createWorkspaceIfNeeded();
  const formElement = $('#call-outbound-form');
  const form = formElement ? Object.fromEntries(new FormData(formElement)) : {};
  const phone = String($('#call-phone')?.value || form.phone || '').trim();
  if (!phone) {
    openCallDialpad();
    $('#call-phone')?.focus();
    return false;
  }
  const callContext = activeCallContextForForm(form, phone);
  const result = await api('/api/voice/manual-outbound', {
    method: 'POST',
    body: {
      tenant_id: state.tenant.id,
      workspace_id: 'default',
      phone,
      lead_id: form.lead_id || '',
      script: form.script || '',
      notes: callContext ? callContextSummary(callContext) : '',
      ...callContextPayload(callContext),
      agent_id: 'manual-agent'
    }
  });
  if (callContext) {
    state.ui.focusedCallSessionId = result.call_session?.id || null;
    state.ui.focusedCallContext = {
      ...callContext,
      callReadinessPack: callContext.callReadinessPack || result.writeback_starter?.call_readiness_pack || null,
      liveCallGuidancePack: callContext.liveCallGuidancePack || result.writeback_starter?.live_call_guidance_pack || null,
      writebackStarterTemplate: result.writeback_starter || callContext.writebackStarterTemplate || null,
      writebackPreview: deriveLeadWritebackPreview(callContext.writebackPreview, result.writeback_starter || callContext.writebackStarterTemplate || null)
    };
  }
  toast('外呼会话已创建，请记录通话结果');
  closeCallDialpad();
  selectActiveCall(result.call_session);
  await refresh();
  return true;
}

async function createInboundCall(event) {
  event.preventDefault();
  await createWorkspaceIfNeeded();
  const form = Object.fromEntries(new FormData(event.target));
  if (!String(form.phone || '').trim()) throw new Error('请输入来电号码');
  await api('/api/voice/inbound', {
    method: 'POST',
    body: {
      tenant_id: state.tenant.id,
      workspace_id: 'default',
      phone: form.phone,
      caller_name: form.caller_name || '',
      intent: form.intent || '',
      required_skills: ['inbound'],
      agent_id: 'manual-agent'
    }
  });
  event.target.reset();
  toast('呼入已进入待接听队列');
  await refresh();
}

async function completeActiveCall(event) {
  event.preventDefault();
  ensureTenant();
  const form = Object.fromEntries(new FormData(event.target));
  if (!form.call_session_id) throw new Error('请先选择一个当前通话');
  const { body, callContext } = buildActiveCallCompletionPayload({
    sessionId: form.call_session_id,
    form
  });
  const result = await api(`/api/voice/sessions/${encodeURIComponent(form.call_session_id)}/complete`, {
    method: 'POST',
    body
  });
  await focusCallFollowupTask(result, callContext);
  toast(result.followup_task ? '通话已结束，并已创建下一步任务' : '通话已结束并回写记录');
  event.target.reset();
  $('#call-session-id').value = '';
  await refresh();
}

async function completeActiveCallWithOption(button) {
  ensureTenant();
  const sessionId = $('#call-session-id')?.value || state.ui.focusedCallSessionId || '';
  if (!sessionId) {
    throw new Error('请先从顶部呼叫栏发起或选择一通电话');
  }
  const resolvedOption = resolveCallWritebackOptionFromButton(button, sessionId);
  const { body, callContext } = buildActiveCallCompletionPayload({
    sessionId,
    option: resolvedOption
  });
  const result = await api(`/api/voice/sessions/${encodeURIComponent(sessionId)}/complete`, {
    method: 'POST',
    body
  });
  await focusCallFollowupTask(result, callContext);
  $('#call-disposition-form')?.reset();
  if ($('#call-session-id')) $('#call-session-id').value = '';
  toast(result.followup_task ? '通话结果已一键回写，并接上下一步任务' : '通话结果已一键回写');
  await refresh();
}

async function handleCallAction(action, button) {
  const phoneInput = $('#call-phone');
  if (action === 'quick-call') {
    await placeOutboundCall();
    return;
  }
  if (action === 'delete-digit') {
    if (!phoneInput) return;
    phoneInput.value = String(phoneInput.value || '').slice(0, -1);
    phoneInput.focus();
    return;
  }
  if (action === 'clear-dial') {
    if (!phoneInput) return;
    phoneInput.value = '';
    phoneInput.focus();
    return;
  }
  if (action === 'hangup-active-call') {
    await hangupActiveCall();
    return;
  }
  if (action === 'select-call') {
    const session = (state.data.callCenter?.recent_sessions || []).find((item) => item.id === button.dataset.callSessionId);
    if (session) selectActiveCall(session);
    return;
  }
  if (action === 'answer-call') {
    ensureTenant();
    const session = await api(`/api/voice/sessions/${encodeURIComponent(button.dataset.callSessionId)}/answer`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        workspace_id: 'default',
        agent_id: 'manual-agent'
      }
    });
    selectActiveCall(session);
    toast('呼入已接听');
    await refresh();
  }
}

function openCallDialpad() {
  const popover = $('#call-dialpad-popover');
  if (!popover) return;
  popover.hidden = false;
  $('#callbar-call-button')?.setAttribute('aria-expanded', 'true');
}

function closeCallDialpad() {
  const popover = $('#call-dialpad-popover');
  if (!popover) return;
  popover.hidden = true;
  $('#callbar-call-button')?.setAttribute('aria-expanded', 'false');
}

async function hangupActiveCall() {
  ensureTenant();
  const sessionId = $('#call-session-id')?.value;
  if (!sessionId) throw new Error('当前没有可挂断的通话');
  const form = Object.fromEntries(new FormData($('#call-disposition-form')));
  const { body, callContext } = buildActiveCallCompletionPayload({
    sessionId,
    form: {
      ...form,
      summary: String(form.summary || '').trim() || '从固定呼叫栏挂断'
    }
  });
  const result = await api(`/api/voice/sessions/${encodeURIComponent(sessionId)}/complete`, {
    method: 'POST',
    body
  });
  await focusCallFollowupTask(result, callContext);
  toast(result.followup_task ? '通话已挂断，并已创建下一步任务' : '通话已挂断并回写记录');
  $('#call-disposition-form')?.reset();
  if ($('#call-session-id')) $('#call-session-id').value = '';
  await refresh();
}

function selectActiveCall(session) {
  if (!session) return;
  $('#call-session-id').value = session.id;
  renderActiveCallCard(session);
  syncActiveCallWritebackForm();
  renderCallContextSurfaces();
}

function activeCallContextForForm(form = {}, phone = '') {
  const context = state.ui.focusedCallContext;
  if (!context) return null;
  const formLeadId = String(form.lead_id || '');
  const contextLeadId = String(context.leadId || '');
  if (formLeadId && contextLeadId && formLeadId === contextLeadId) return context;
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const contextPhone = String(context.phone || '').replace(/\D/g, '');
  if (cleanPhone && contextPhone && cleanPhone === contextPhone) return context;
  return null;
}

function findCallSessionById(sessionId) {
  if (!sessionId) return null;
  return [
    ...asArray(state.data.callCenter?.active_calls),
    ...asArray(state.data.callCenter?.recent_sessions),
    ...asArray(state.data.callCenter?.inbound_queue)
  ].find((session) => String(session.id || '') === String(sessionId)) || null;
}

function callContextFromSession(session) {
  if (!session) return null;
  const meta = session.metadata || {};
  if (!meta.lead_run_context_kind && !meta.lead_run_id && !meta.lead_run_reason) return null;
  return {
    runId: meta.lead_run_id || '',
    leadId: session.lead_id || '',
    leadName: meta.lead_run_lead_name || meta.contact_name || session.lead_id || '这条线索',
    phone: session.phone || '',
    taskId: meta.lead_run_task_id || meta.task_id || '',
    contextKind: meta.lead_run_context_kind || 'lead_run_contact',
    routeLabel: meta.lead_run_route_label || '',
    outcomeTag: meta.lead_run_outcome_tag || '',
    reason: meta.lead_run_reason || '这通电话来自获客执行的修复入队链路。',
    nextAction: meta.lead_run_next_action || meta.next_action || '通话结束后回写结果并接下一步。',
    callReadinessPack: meta.lead_run_call_readiness_pack || meta.lead_run_writeback_starter?.call_readiness_pack || null,
    liveCallGuidancePack: meta.lead_run_live_call_guidance_pack || meta.lead_run_writeback_starter?.live_call_guidance_pack || meta.draft_context?.live_call_guidance_pack || null,
    writebackPreview: meta.lead_run_writeback_preview || null,
    writebackStarterTemplate: meta.lead_run_writeback_starter || null
  };
}

function activeCallContextForSession(sessionId) {
  if (!sessionId) return null;
  if (String(state.ui.focusedCallSessionId || '') === String(sessionId) && state.ui.focusedCallContext) {
    return state.ui.focusedCallContext;
  }
  const persistedContext = callContextFromSession(findCallSessionById(sessionId));
  if (persistedContext) {
    state.ui.focusedCallSessionId = sessionId;
    state.ui.focusedCallContext = persistedContext;
  }
  return persistedContext;
}

function callContextSummary(context) {
  if (!context) return '';
  return `${context.leadName || '这条线索'} 来自${callContextKindLabel(context)}；${context.reason || '已进入今日可联系队列'}；${context.nextAction || '通话结束后回写结果并接下一步'}`;
}

function callContextPayload(context) {
  if (!context) return {};
  const writebackPreview = deriveLeadWritebackPreview(context.writebackPreview, context.writebackStarterTemplate);
  return {
    task_id: context.taskId || '',
    lead_run_context_kind: context.contextKind || 'lead_run_contact',
    lead_run_id: context.runId || '',
    lead_run_task_id: context.taskId || '',
    lead_run_lead_name: context.leadName || '',
    lead_run_reason: context.reason || '',
    lead_run_next_action: context.nextAction || '',
    lead_run_route_label: context.routeLabel || '',
    lead_run_outcome_tag: context.outcomeTag || '',
    lead_run_call_readiness_pack: context.callReadinessPack || null,
    lead_run_live_call_guidance_pack: context.liveCallGuidancePack || null,
    lead_run_writeback_preview: writebackPreview || null
  };
}

function callWritebackStarterFromSession(session) {
  const starter = session?.metadata?.lead_run_writeback_starter;
  return starter && typeof starter === 'object' ? starter : null;
}

function activeCallWritebackStarter(sessionId = '') {
  const resolvedSessionId = String(sessionId || $('#call-session-id')?.value || state.ui.focusedCallSessionId || '');
  if (!resolvedSessionId) return null;
  const focused = String(state.ui.focusedCallSessionId || '') === resolvedSessionId ? state.ui.focusedCallContext : null;
  if (focused?.writebackStarterTemplate) return focused.writebackStarterTemplate;
  return callWritebackStarterFromSession(findCallSessionById(resolvedSessionId));
}

function activeCallSummaryField() {
  return document.querySelector('#call-disposition-form textarea[name="summary"]');
}

function activeCallDueAtField() {
  return $('#call-next-step-due-at');
}

function normalizeCallWritebackOption(option = {}) {
  return {
    label: String(option.label || option.tag || option.outcomeTag || option.request_body?.outcome_tag || ''),
    tag: String(option.tag || option.outcomeTag || option.request_body?.outcome_tag || ''),
    disposition: String(option.disposition || option.request_body?.disposition || 'completed'),
    next_step_type: String(option.next_step_type || option.nextStepType || option.request_body?.next_step_type || ''),
    default_delay_hours: Number(option.default_delay_hours || option.defaultDelayHours || option.delayHours || 0),
    summary: String(option.summary || option.request_body?.summary || ''),
    reason_examples: asArray(option.reason_examples || option.reasonExamples).slice(0, 4),
    reason_hint: String(option.reason_hint || option.reasonHint || ''),
    due_required: option.due_required === true || option.due_required === 'true' || option.dueRequired === true || option.dueRequired === 'true'
  };
}

function genericCallWritebackOptions() {
  return [
    { label: '已接通并预约', disposition: 'connected_booked', next_step_type: 'appointment', default_delay_hours: 24, due_required: true },
    { label: '已接通，客户要求回拨', disposition: 'connected_callback', next_step_type: 'callback', default_delay_hours: 24, due_required: true },
    { label: '已接通，继续跟进', disposition: 'completed', next_step_type: 'followup', default_delay_hours: 24, due_required: true },
    { label: '未接通，需重拨', disposition: 'no_answer', next_step_type: 'callback', default_delay_hours: 4, due_required: true },
    { label: '需要升级人工/主管', disposition: 'transfer_required', next_step_type: 'followup', default_delay_hours: 24, due_required: true },
    { label: '暂不考虑', disposition: 'connected_not_interested', next_step_type: 'none', default_delay_hours: 0, due_required: false },
    { label: '号码无效', disposition: 'invalid_number', next_step_type: 'none', default_delay_hours: 0, due_required: false }
  ].map(normalizeCallWritebackOption);
}

function activeCallOutcomeField() {
  return $('#call-disposition');
}

function activeCallOutcomeLabel() {
  return $('#call-outcome-select-label');
}

function activeCallDueLabel() {
  return $('#call-next-step-due-label-text');
}

function activeCallSubmitButton() {
  return $('#call-disposition-submit');
}

function callWritebackOptionValue(option, index) {
  return `${option.tag || option.disposition || 'option'}::${option.next_step_type || 'none'}::${index}`;
}

function selectedCallWritebackOption() {
  const field = activeCallOutcomeField();
  const option = field?.selectedOptions?.[0];
  if (!option) return null;
  return normalizeCallWritebackOption({
    label: option.dataset.label || option.textContent || '',
    tag: option.dataset.outcomeTag || '',
    disposition: option.dataset.disposition || '',
    next_step_type: option.dataset.nextStepType || '',
    default_delay_hours: option.dataset.defaultDelayHours || 0,
    summary: option.dataset.summary || '',
    reason_examples: option.dataset.reasonExamples ? option.dataset.reasonExamples.split('|').filter(Boolean) : [],
    reason_hint: option.dataset.reasonHint || '',
    due_required: option.dataset.dueRequired || ''
  });
}

function sameCallWritebackOption(left, right) {
  if (!left || !right) return false;
  return String(left.tag || '') === String(right.tag || '')
    && String(left.disposition || '') === String(right.disposition || '')
    && String(left.next_step_type || '') === String(right.next_step_type || '');
}

function renderActiveCallOutcomeSelector(starter, context, preferredOption = null) {
  const field = activeCallOutcomeField();
  if (!field) return preferredOption;
  const options = starter
    ? collectWritebackOptionSurface(starter.option_surface?.options || starter.outcome_options, starter, { providedSurface: starter.option_surface }).options
    : genericCallWritebackOptions();
  if (!options.length) {
    field.innerHTML = '';
    return null;
  }
  const selected = preferredOption && options.some((option) => sameCallWritebackOption(option, preferredOption))
    ? preferredOption
    : options[0];
  const selectedValue = callWritebackOptionValue(selected, options.findIndex((option) => sameCallWritebackOption(option, selected)));
  field.innerHTML = options.map((option, index) => {
    const label = option.label || option.tag || callDispositionText(option.disposition);
    const dueLabel = callWritebackDueRequired(starter, option) ? ' · 需补时间' : '';
    return `
      <option value="${escapeHtml(callWritebackOptionValue(option, index))}"
        data-label="${escapeHtml(label)}"
        data-outcome-tag="${escapeHtml(option.tag || '')}"
        data-disposition="${escapeHtml(option.disposition || 'completed')}"
        data-next-step-type="${escapeHtml(option.next_step_type || '')}"
        data-default-delay-hours="${escapeHtml(String(option.default_delay_hours ?? 0))}"
        data-summary="${escapeHtml(option.summary || '')}"
        data-reason-examples="${escapeHtml(asArray(option.reason_examples).join('|'))}"
        data-reason-hint="${escapeHtml(option.reason_hint || '')}"
        data-due-required="${option.due_required ? 'true' : 'false'}"
        ${sameCallWritebackOption(option, selected) ? 'selected' : ''}>${escapeHtml(label + dueLabel)}</option>
    `;
  }).join('');
  const routeLabel = starter?.context?.route_label || context?.routeLabel || '';
  const outcomeLabel = activeCallOutcomeLabel();
  if (outcomeLabel) {
    outcomeLabel.textContent = routeLabel ? `${routeLabel}结果` : '通话结果';
  }
  return selectedCallWritebackOption() || selected;
}

function findCallWritebackOption(starter, { tag = '', disposition = '' } = {}) {
  const options = collectWritebackOptionSurface(starter?.option_surface?.options || starter?.outcome_options, starter, { providedSurface: starter?.option_surface }).options;
  if (!options.length) return null;
  const desiredTag = String(tag || '');
  if (desiredTag) {
    const byTag = options.find((option) => option.tag === desiredTag);
    if (byTag) return byTag;
  }
  const desiredDisposition = String(disposition || starter?.default_body?.disposition || '');
  if (desiredDisposition) {
    const byDisposition = options.find((option) => option.disposition === desiredDisposition);
    if (byDisposition) return byDisposition;
  }
  const defaultTag = String(starter?.default_body?.outcome_tag || '');
  if (defaultTag) {
    const byDefaultTag = options.find((option) => option.tag === defaultTag);
    if (byDefaultTag) return byDefaultTag;
  }
  return options[0];
}

function callWritebackDueRequired(starter, option) {
  if (option?.due_required != null) return Boolean(option.due_required);
  const outcomeTag = String(option?.tag || '');
  if (!starter || !outcomeTag) {
    return Boolean(option?.next_step_type) && option.next_step_type !== 'none';
  }
  return asArray(starter.conditional_fields).some((field) => field?.field === 'next_step_due_at' && asArray(field.when_tags).includes(outcomeTag));
}

function writebackOptionDisplayLabel(option) {
  return option?.label || option?.tag || callDispositionText(option?.disposition);
}

function writebackOptionNeedsDueTime(starterTemplate, option) {
  if (callWritebackDueRequired(starterTemplate, option)) return true;
  return !starterTemplate && Boolean(option?.next_step_type) && option.next_step_type !== 'none';
}

function collectWritebackOptionSurface(options, starterTemplate = null, { compact = false, providedSurface = null } = {}) {
  if (providedSurface?.options?.length) {
    const normalizedOptions = asArray(providedSurface.options)
      .map(normalizeCallWritebackOption)
      .filter((option) => option.tag || option.disposition || option.label)
      .slice(0, compact ? 3 : 5);
    return {
      options: normalizedOptions,
      labels: asArray(providedSurface.option_labels).length
        ? asArray(providedSurface.option_labels).slice(0, compact ? 3 : 5)
        : normalizedOptions.map(writebackOptionDisplayLabel).filter(Boolean),
      dueLabels: asArray(providedSurface.due_required_labels).length
        ? asArray(providedSurface.due_required_labels).slice(0, compact ? 2 : 4)
        : normalizedOptions
          .filter((option) => writebackOptionNeedsDueTime(starterTemplate, option))
          .map(writebackOptionDisplayLabel)
          .filter(Boolean)
          .slice(0, compact ? 2 : 4),
      dueNote: String(providedSurface.due_required_note || '')
    };
  }
  const normalized = asArray(options)
    .map(normalizeCallWritebackOption)
    .filter((option) => option.tag || option.disposition)
    .slice(0, compact ? 3 : 5);
  return {
    options: normalized,
    labels: normalized.map(writebackOptionDisplayLabel).filter(Boolean),
    dueLabels: normalized
      .filter((option) => writebackOptionNeedsDueTime(starterTemplate, option))
      .map(writebackOptionDisplayLabel)
      .filter(Boolean)
      .slice(0, compact ? 2 : 4),
    dueNote: ''
  };
}

function renderWritebackOptionDueNote(options, starterTemplate = null, { compact = false, fallbackText = '', providedSurface = null } = {}) {
  const surface = collectWritebackOptionSurface(options, starterTemplate, { compact, providedSurface });
  if (surface.dueNote) return surface.dueNote;
  if (surface.dueLabels.length) {
    return `这些结果要补下一次时间：${surface.dueLabels.join('、')}`;
  }
  return fallbackText;
}

function defaultLocalDateTimeForWritebackOption(option) {
  const delayHours = Number(option?.default_delay_hours || 0);
  if (delayHours > 0) {
    return formatLocalDateTimeInput(Date.now() + delayHours * 60 * 60 * 1000);
  }
  const nextStepType = String(option?.next_step_type || '');
  if (!nextStepType || nextStepType === 'none') return '';
  return defaultLocalDateTimeForStep(nextStepType);
}

function setAutoFilledFieldValue(field, value, datasetKey) {
  if (!field) return;
  const current = String(field.value || '');
  const lastAuto = String(field.dataset?.[datasetKey] || '');
  if (current && current !== lastAuto) return;
  field.value = value;
  field.dataset[datasetKey] = value;
}

function resetCallWritebackQuickActions() {
  const quickActions = $('#call-writeback-quick-actions');
  if (quickActions) quickActions.innerHTML = '';
  const outcomeLabel = activeCallOutcomeLabel();
  if (outcomeLabel) outcomeLabel.textContent = '通话结果';
  const hint = $('#call-writeback-hint');
  if (hint) hint.textContent = '结束后回写结果，系统会自动接下一步。';
  const dueLabel = activeCallDueLabel();
  if (dueLabel) dueLabel.textContent = '下一步时间（可选）';
  const dueField = activeCallDueAtField();
  if (dueField) {
    dueField.disabled = false;
    dueField.dataset.autoDueAt = '';
  }
  const submitButton = activeCallSubmitButton();
  if (submitButton) submitButton.textContent = '结束并回写 CRM';
  const summaryField = activeCallSummaryField();
  if (summaryField) summaryField.dataset.autoSummary = '';
  if ($('#call-outcome-tag')) $('#call-outcome-tag').value = '';
  if ($('#call-next-step-type')) $('#call-next-step-type').value = '';
}

function buildCallDispositionSummaryPrefix(context, starter) {
  const leadName = context?.leadName || starter?.context?.lead_name || '这条线索';
  const routeLabel = starter?.context?.route_label || context?.routeLabel || '';
  const reason = context?.reason || starter?.reason || starter?.route_hint || '';
  const intro = `${leadName}${routeLabel ? `（${routeLabel}）` : ''}`;
  return `${[intro, reason].filter(Boolean).join('；')}；本次通话结果：`;
}

function buildActiveCallWritebackSummary(context, starter, option = null) {
  const prefix = buildCallDispositionSummaryPrefix(context, starter);
  const detail = option?.summary || option?.tag || callDispositionText(option?.disposition || starter?.default_body?.disposition || 'completed');
  return `${prefix}${detail}`;
}

function resolveCallWritebackOptionFromButton(button, sessionId) {
  const starter = activeCallWritebackStarter(sessionId);
  if (button.dataset.useActiveWriteback === 'true') {
    return findCallWritebackOption(starter, {
      tag: button.dataset.outcomeTag || '',
      disposition: button.dataset.disposition || ''
    }) || normalizeCallWritebackOption(button.dataset);
  }
  return normalizeCallWritebackOption(button.dataset);
}

function renderWritebackOptionButtons(options, { title = '', starterTemplate = null, activeOption = null, useActiveWriteback = false, compact = false, optionSurface = null } = {}) {
  const surface = collectWritebackOptionSurface(options, starterTemplate, { compact, providedSurface: optionSurface });
  if (!surface.options.length) return '';
  const note = renderWritebackOptionDueNote(surface.options, starterTemplate, { compact, providedSurface: optionSurface });
  return `
    <div class="one-click-outcomes">
      ${title ? `<small>${escapeHtml(title)}</small>` : ''}
      ${surface.options.map((option) => `
        <button type="button" class="button ${sameCallWritebackOption(option, activeOption) ? 'secondary' : 'ghost'}" data-call-writeback-option ${useActiveWriteback ? 'data-use-active-writeback="true"' : ''}
          data-outcome-tag="${escapeHtml(option.tag || '')}"
          data-disposition="${escapeHtml(option.disposition || 'completed')}"
          data-next-step-type="${escapeHtml(option.next_step_type || '')}"
          data-delay-hours="${escapeHtml(String(option.default_delay_hours ?? 0))}"
          data-summary="${escapeHtml(option.summary || option.tag || '')}"
          data-due-required="${option.due_required ? 'true' : 'false'}">${escapeHtml(writebackOptionDisplayLabel(option))}</button>
      `).join('')}
      ${note ? `<small>${escapeHtml(note)}</small>` : ''}
    </div>
  `;
}

function renderActiveCallWritebackQuickActions(starter, currentOption) {
  const container = $('#call-writeback-quick-actions');
  if (!container) return;
  container.innerHTML = renderWritebackOptionButtons(starter?.option_surface?.options || starter?.outcome_options, {
    title: '一键回写这通电话',
    starterTemplate: starter,
    activeOption: currentOption,
    useActiveWriteback: true,
    optionSurface: starter?.option_surface || null
  });
}

function renderActiveCallWritebackHint(context, starter, option) {
  const hint = $('#call-writeback-hint');
  if (!hint) return;
  const dueField = activeCallDueAtField();
  if (dueField && starter) {
    dueField.disabled = !option?.next_step_type || option.next_step_type === 'none';
  }
  const readinessPack = starter?.call_readiness_pack || context?.callReadinessPack || null;
  const blockedClaims = asArray(readinessPack?.blocked_claims).slice(0, 1);
  const notes = [
    readinessPack?.desired_outcome?.label ? `这通电话先争取「${readinessPack.desired_outcome.label}」。` : '',
    blockedClaims.length ? `先别默认说「${blockedClaims.map((item) => item.claim_label || '').filter(Boolean).join('；')}」。` : '',
    starter?.route_hint || context?.writebackPreview?.route_hint || '',
    callWritebackDueRequired(starter, option)
      ? `当前结果“${option?.label || option?.tag || '这项'}”需要补下一次时间。`
      : option?.next_step_type && option.next_step_type !== 'none'
        ? `如不手动修改，系统会默认安排 ${humanTaskStepLabel(option.next_step_type)} 时间。`
        : '这次结果不要求补下一次时间。',
    option?.reason_hint || (asArray(option?.reason_examples).length ? `常见原因：${asArray(option.reason_examples).join(' / ')}` : ''),
    starter?.next_action || context?.nextAction || ''
  ].filter(Boolean);
  hint.textContent = notes.join(' ');
}

function syncActiveCallDueLabel(starter, option) {
  const label = activeCallDueLabel();
  if (!label) return;
  if (!option?.next_step_type || option.next_step_type === 'none') {
    label.textContent = '下一步时间（不需要）';
    return;
  }
  const stepLabel = humanTaskStepLabel(option.next_step_type);
  label.textContent = callWritebackDueRequired(starter, option)
    ? `${stepLabel}时间（必填）`
    : `${stepLabel}时间（建议）`;
}

function syncActiveCallSubmitButton(option) {
  const button = activeCallSubmitButton();
  if (!button) return;
  if (!option) {
    button.textContent = '结束并回写 CRM';
    return;
  }
  const resultLabel = option.label || option.tag || callDispositionText(option.disposition);
  button.textContent = option.next_step_type && option.next_step_type !== 'none'
    ? `记录“${resultLabel}”并接${humanTaskStepLabel(option.next_step_type)}`
    : `记录“${resultLabel}”`;
}

function syncActiveCallWritebackForm() {
  const sessionId = String($('#call-session-id')?.value || state.ui.focusedCallSessionId || '');
  if (!sessionId) {
    resetCallWritebackQuickActions();
    return;
  }
  const context = activeCallContextForSession(sessionId) || state.ui.focusedCallContext || null;
  const starter = activeCallWritebackStarter(sessionId) || context?.writebackStarterTemplate || null;
  const summaryField = activeCallSummaryField();
  const dueField = activeCallDueAtField();
  if (!starter) {
    const selectedFallbackOption = renderActiveCallOutcomeSelector(null, context, selectedCallWritebackOption());
    renderActiveCallWritebackQuickActions(null, null);
    if ($('#call-outcome-tag')) $('#call-outcome-tag').value = selectedFallbackOption?.tag || '';
    if ($('#call-next-step-type')) $('#call-next-step-type').value = selectedFallbackOption?.next_step_type || '';
    const fallbackSummary = context || selectedFallbackOption
      ? buildActiveCallWritebackSummary(context, null, selectedFallbackOption)
      : '';
    if (fallbackSummary) {
      setAutoFilledFieldValue(summaryField, fallbackSummary, 'autoSummary');
    }
    if (dueField) {
      const autoDueAt = defaultLocalDateTimeForWritebackOption(selectedFallbackOption);
      if (selectedFallbackOption?.next_step_type && selectedFallbackOption.next_step_type !== 'none') {
        setAutoFilledFieldValue(dueField, autoDueAt, 'autoDueAt');
        dueField.disabled = false;
      } else {
        dueField.disabled = true;
        if (String(dueField.value || '') === String(dueField.dataset.autoDueAt || '')) {
          dueField.value = '';
          dueField.dataset.autoDueAt = '';
        }
      }
    }
    syncActiveCallDueLabel(null, selectedFallbackOption);
    syncActiveCallSubmitButton(selectedFallbackOption);
    renderActiveCallWritebackHint(context, null, selectedFallbackOption);
    return;
  }
  const selectedFieldOption = selectedCallWritebackOption();
  const option = findCallWritebackOption(starter, {
    tag: $('#call-outcome-tag')?.value || selectedFieldOption?.tag || starter.default_body?.outcome_tag || '',
    disposition: selectedFieldOption?.disposition || starter.default_body?.disposition || ''
  }) || selectedFieldOption || findCallWritebackOption(starter, {});
  const renderedOption = renderActiveCallOutcomeSelector(starter, context, option);
  if ($('#call-outcome-tag')) $('#call-outcome-tag').value = renderedOption?.tag || starter.default_body?.outcome_tag || '';
  if ($('#call-next-step-type')) $('#call-next-step-type').value = renderedOption?.next_step_type || starter.default_body?.next_step_type || '';
  renderActiveCallWritebackQuickActions(starter, renderedOption);
  if (dueField) {
    const autoDueAt = defaultLocalDateTimeForWritebackOption(renderedOption);
    if (renderedOption?.next_step_type && renderedOption.next_step_type !== 'none') {
      setAutoFilledFieldValue(dueField, autoDueAt, 'autoDueAt');
    } else if (String(dueField.value || '') === String(dueField.dataset.autoDueAt || '')) {
      dueField.value = '';
      dueField.dataset.autoDueAt = '';
    }
  }
  setAutoFilledFieldValue(summaryField, buildActiveCallWritebackSummary(context, starter, renderedOption), 'autoSummary');
  syncActiveCallDueLabel(starter, renderedOption);
  syncActiveCallSubmitButton(renderedOption);
  renderActiveCallWritebackHint(context, starter, renderedOption);
}

function handleActiveCallSummaryInput(event) {
  if (String(event.target.value || '') !== String(event.target.dataset.autoSummary || '')) {
    event.target.dataset.autoSummary = '';
  }
}

function handleActiveCallDispositionChange() {
  const selectedOption = selectedCallWritebackOption();
  if ($('#call-outcome-tag')) $('#call-outcome-tag').value = selectedOption?.tag || '';
  if ($('#call-next-step-type')) $('#call-next-step-type').value = selectedOption?.next_step_type || '';
  syncActiveCallWritebackForm();
}

function handleActiveCallDueAtInput(event) {
  if (String(event.target.value || '') !== String(event.target.dataset.autoDueAt || '')) {
    event.target.dataset.autoDueAt = '';
  }
}

function isoDateTimeFromLocalInput(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function buildActiveCallCompletionPayload({ sessionId, form = {}, option = null } = {}) {
  const callContext = activeCallContextForSession(sessionId);
  const starter = activeCallWritebackStarter(sessionId);
  const selectedFieldOption = selectedCallWritebackOption();
  const disposition = option?.disposition || selectedFieldOption?.disposition || String(starter?.default_body?.disposition || 'completed');
  const resolvedOption = option || selectedFieldOption || findCallWritebackOption(starter, {
    tag: form.outcome_tag || $('#call-outcome-tag')?.value || '',
    disposition
  });
  const summaryOption = resolvedOption || { disposition };
  const resolvedNextStepType = String(resolvedOption?.next_step_type || form.next_step_type || $('#call-next-step-type')?.value || '');
  const localDueAt = String(form.next_step_due_at || activeCallDueAtField()?.value || '').trim();
  const nextStepDueAt = resolvedNextStepType && resolvedNextStepType !== 'none'
    ? isoDateTimeFromLocalInput(localDueAt || defaultLocalDateTimeForWritebackOption(resolvedOption))
    : '';
  const summary = String(form.summary || activeCallSummaryField()?.value || '').trim()
    || buildActiveCallWritebackSummary(callContext, starter, summaryOption);
  return {
    callContext,
    body: {
      tenant_id: state.tenant.id,
      workspace_id: 'default',
      disposition: resolvedOption?.disposition || disposition,
      outcome_tag: resolvedOption?.tag || String(form.outcome_tag || ''),
      next_step_type: resolvedNextStepType && resolvedNextStepType !== 'none' ? resolvedNextStepType : '',
      next_step_due_at: nextStepDueAt,
      summary,
      task_id: callContext?.taskId || '',
      lead_run_task_id: callContext?.taskId || ''
    }
  };
}

function renderCallContextCard(context, { compact = false } = {}) {
  if (!context) return '';
  const preview = deriveLeadWritebackPreview(context.writebackPreview, context.writebackStarterTemplate);
  const readinessPack = context.callReadinessPack || context.writebackStarterTemplate?.call_readiness_pack || null;
  const liveCallGuidancePack = context.liveCallGuidancePack || context.writebackStarterTemplate?.live_call_guidance_pack || null;
  return `
    <div class="call-run-context ${compact ? 'compact' : ''}">
      <span class="chip success">${escapeHtml(callContextKindLabel(context))}</span>
      <strong>${escapeHtml(context.leadName || '获客线索')}</strong>
      <p>${escapeHtml(context.reason || '已进入今天可联系队列。')}</p>
      ${renderLeadLiveCallGuidancePack(liveCallGuidancePack, { mode: 'call', compact: true, asArticle: false })}
      ${!liveCallGuidancePack ? renderLeadCallReadinessPack(readinessPack, { mode: 'call', compact: true, asArticle: false }) : ''}
      ${preview ? renderLeadWritebackPreviewBrief(preview, { compact, starterTemplate: context.writebackStarterTemplate || null }) : ''}
      <small>${escapeHtml(context.nextAction || '打完后记录结果，系统会自动接下一步。')}${context.taskId ? ' · 点结果后自动完成当前任务' : ''}</small>
    </div>
  `;
}

function callContextKindLabel(context) {
  if (context?.contextKind === 'today_carryover') return '明天队列承接';
  if (context?.contextKind === 'repair_requeue') return '修复线索呼叫';
  return '获客执行呼叫';
}

function renderCallContextSurfaces() {
  const activeSessionId = $('#call-session-id')?.value || '';
  const context = activeCallContextForSession(activeSessionId) || state.ui.focusedCallContext;
  const pill = $('#call-context-pill');
  if (pill) {
    pill.hidden = !context;
    pill.textContent = context ? `${callContextKindLabel(context)} · ${context.leadName || '线索'}` : '';
    pill.title = context ? callContextSummary(context) : '';
  }
  const runContext = $('#call-run-context');
  if (runContext) runContext.innerHTML = context ? renderCallContextCard(context) : '';
  const activeContext = $('#active-call-context');
  if (activeContext) {
    activeContext.innerHTML = activeCallContextForSession(activeSessionId)
      ? renderCallContextCard(context, { compact: true })
      : '';
  }
}

async function focusCallFollowupTask(result, callContext) {
  if (!callContext) return;
  state.ui.latestCallWritebackReview = {
    runId: callContext.runId || '',
    leadName: callContext.leadName || '这条线索',
    disposition: result.call_session?.metadata?.disposition || '',
    nextAction: result.next_action || '',
    followupTaskTitle: result.followup_task?.title || '',
    generatedAt: new Date().toISOString()
  };
  const refreshedRun = await refreshLeadRunOutcomeFromCall(callContext);
  const writebackPreview = result.followup_task?.id
    ? findLeadRunWritebackPreviewForTask(refreshedRun, result.followup_task.id)
    : null;
  state.ui.latestCallWritebackReview = {
    ...state.ui.latestCallWritebackReview,
    writebackPreview
  };
  renderActiveLeadRun();
  if (result.followup_task?.id) {
    setWorkbenchTaskFocus(result.followup_task.id, {
      title: result.followup_task.title || '通话后的下一步任务',
      leadName: callContext.leadName || '这条线索',
      reason: `已回写通话结果“${callDispositionText(result.call_session?.metadata?.disposition || '')}”，系统已接上下一步。`,
      nextAction: result.next_action || '继续处理这条线索的下一步。',
      writebackPreview
    });
    setHomePanel('today');
    renderUserWorkbench();
  }
  state.ui.focusedCallContext = null;
  state.ui.focusedCallSessionId = null;
  renderCallContextSurfaces();
}

async function refreshLeadRunOutcomeFromCall(callContext) {
  if (!callContext?.runId) return;
  const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(callContext.runId)}/outcome-review`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });
  if (result.run) syncActiveLeadRun(result.run);
  renderActiveLeadRun();
  return result.run || null;
}

function applyCommanderTemplate(templateKey, { preserveGoal = false } = {}) {
  const key = COMMANDER_TEMPLATES[templateKey] ? templateKey : 'growth_loop';
  state.commander.templateKey = key;
  const template = COMMANDER_TEMPLATES[key];
  if (!preserveGoal || !$('#commander-goal')?.value.trim()) {
    $('#commander-goal').value = template.goal;
  }
  renderCommanderFields(key, mergeCommanderMissingInputs(key));
  renderCommanderHome();
}

function applyCommanderPrefill(prefillJson) {
  if (!prefillJson) return;
  try {
    const prefill = JSON.parse(prefillJson);
    Object.entries(prefill).forEach(([name, value]) => {
      const field = document.querySelector(`[name="${CSS.escape(name)}"]`);
      if (field && value != null) {
        field.value = String(value);
      }
    });
  } catch (error) {
    console.warn('[opc] invalid prefill payload', error);
  }
}

function resolveCurrentPage(pathname) {
  const aliases = {
    '/today': 'commander',
    '/result': 'commander',
    '/recipes': 'commander',
    '/results': 'commander',
    '/timeline': 'customers',
    '/workbench': 'customers',
    '/campaign': 'pipeline',
    '/resources': 'tools'
  };
  return aliases[pathname] || Object.entries(PAGE_CONFIG).find(([, page]) => page.path === pathname)?.[0] || 'commander';
}

function applyPageShell() {
  const page = PAGE_CONFIG[CURRENT_PAGE] || PAGE_CONFIG.commander;
  document.title = `OPC Commander · ${page.title}`;
  document.body.dataset.page = CURRENT_PAGE;
  $('#workspace-eyebrow').textContent = page.eyebrow;
  $('#workspace-title').textContent = page.title;
  $('#workspace-copy').textContent = page.copy;

  document.querySelectorAll('[data-page-link]').forEach((link) => {
    link.classList.toggle('active', link.dataset.pageLink === CURRENT_PAGE);
  });

  document.querySelectorAll('[data-pages]').forEach((section) => {
    const pages = String(section.dataset.pages || '')
      .split(/\s+/)
      .filter(Boolean);
    section.hidden = !pages.includes(CURRENT_PAGE);
  });

  applyHomePanel();
}

function currentHomePanel() {
  if (CURRENT_PAGE === 'commander') return 'workflow';
  const stored = localStorage.getItem(HOME_PANEL_KEY);
  const valid = new Set(['workflow', 'templates', 'tools', 'today', 'results']);
  return valid.has(stored) ? stored : 'workflow';
}

function setHomePanel(panel) {
  localStorage.setItem(HOME_PANEL_KEY, panel);
  applyHomePanel();
  if (panel === 'results') {
    void prefetchProspectOutreachSummaryForActiveRun();
  }
}

function applyHomePanel() {
  // Commander owns the forced workflow panel; support pages keep their own shell visibility.
  if (CURRENT_PAGE !== 'commander') return;
  let panel = currentHomePanel();
  if (panel === 'results' && !document.body.classList.contains('has-result')) {
    panel = 'workflow';
  }
  document.querySelectorAll('[data-home-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.homeTab === panel);
  });
  document.querySelectorAll('[data-home-panel]').forEach((section) => {
    if (section.id === 'active-lead-run') {
      section.hidden = false;
      return;
    }
    section.hidden = section.dataset.homePanel !== panel;
  });
  renderMobileMainlineDock();
}

function persistCommanderState() {
  localStorage.setItem(
    'opc.commander',
    JSON.stringify({
      templateKey: state.commander.templateKey,
      activeRecipe: state.commander.activeRecipe,
      activeLeadRunId: state.commander.activeLeadRunId,
      lastLeadRun: state.commander.lastLeadRun,
      goal: state.commander.goal || $('#commander-goal')?.value || '',
      lastPlan: state.commander.lastPlan,
      lastRun: state.commander.lastRun,
      assetTab: state.commander.assetTab
    })
  );
}

function openCommanderIntent(command, templateKey, prefillJson = '') {
  const nextTemplateKey = templateKey || inferCommanderTemplateKey(command) || 'crm_followup';
  const payload = { command, templateKey: nextTemplateKey, prefillJson };
  if (CURRENT_PAGE === 'commander' || CURRENT_PAGE === 'recipes') {
    applyCommanderTemplate(nextTemplateKey);
    $('#commander-goal').value = command || COMMANDER_TEMPLATES[nextTemplateKey].goal;
    state.commander.goal = $('#commander-goal').value;
    applyCommanderPrefill(prefillJson);
    persistCommanderState();
    $('#commander-center').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  sessionStorage.setItem(PENDING_COMMANDER_INTENT_KEY, JSON.stringify(payload));
  window.location.assign('/');
}

function consumePendingCommanderIntent() {
  if (CURRENT_PAGE !== 'commander' && CURRENT_PAGE !== 'recipes') return;
  const raw = sessionStorage.getItem(PENDING_COMMANDER_INTENT_KEY);
  if (!raw) return;
  sessionStorage.removeItem(PENDING_COMMANDER_INTENT_KEY);
  try {
    const payload = JSON.parse(raw);
    openCommanderIntent(payload.command, payload.templateKey, payload.prefillJson || '');
  } catch (error) {
    console.warn('[opc] invalid pending commander intent', error);
  }
}

function openTaskOutcomeDialog(taskId, presetResult = '') {
  const task = findTaskById(taskId);
  if (!task) {
    throw new Error('找不到这个任务');
  }
  state.taskOutcome.taskId = taskId;
  state.taskOutcome.presetResult = String(presetResult || '');
  const focusContext = buildTaskOutcomeFocusContext(task);
  $('#task-outcome-title').textContent = task.title || '记录任务结果';
  $('#task-outcome-meta').textContent = `${task.priority || 'P2'} · ${task.object_type || 'task'} · ${formatDate(task.due_at)}`;
  $('#task-outcome-context').innerHTML = focusContext ? renderTaskOutcomeFocusContext(focusContext) : '';
  renderTaskOutcomeResultSelector(task, focusContext);
  syncTaskOutcomeDefaults();
  $('#task-outcome-reason').value = focusContext ? defaultTaskOutcomeReason(focusContext) : '';
  const dialog = $('#task-outcome-dialog');
  if (dialog.open && typeof dialog.close === 'function') {
    dialog.close();
  }
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', 'open');
  }
}

function buildTaskOutcomeFocusContext(task) {
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const review = run?.repair_requeue_review || null;
  const todayCard = run?.today_contact_card || null;
  const isFocusedTask = isFocusedWorkbenchTask(task.id);
  const isRepairTask = Boolean(review?.task?.id) && String(review.task.id) === String(task.id);
  const isTodayTask = Boolean(todayCard?.task_id) && String(todayCard.task_id) === String(task.id);
  if (!isFocusedTask && !isRepairTask && !isTodayTask) return null;
  const context = state.ui.focusedWorkbenchTaskContext || {};
  if (isTodayTask) {
    const todayWritebackPreview = context.writebackPreview
      || findLeadRunWritebackPreviewForTask(run, task.id)
      || deriveLeadWritebackPreview(null, todayCard?.writeback_starter_template || null);
    return {
      sourceLabel: '来自 Today 主链',
      leadName: context.leadName || todayCard?.lead_name || task.object_id || '这条线索',
      title: context.title || todayCard?.task_title || task.title || '今日跟进任务',
      reason: context.reason || todayCard?.reason || todayCard?.summary || '记录本次联系结果，并让系统自动接下一步。',
      nextAction: context.nextAction || todayCard?.next_action || '记录本次跟进结果，并让系统自动安排下一步。',
      microScript: context.microScript || todayCard?.micro_script || null,
      writebackPreview: todayWritebackPreview,
      writebackOptionSurface: context.writebackOptionSurface || todayCard?.writeback_option_surface || todayWritebackPreview?.option_surface || null
    };
  }
  const writebackPreview = context.writebackPreview || (isFocusedTask ? findLeadRunWritebackPreviewForTask(run, task.id) : null);
  return {
    sourceLabel: isRepairTask ? '来自修复入队' : '来自 Today 聚焦',
    leadName: context.leadName || review?.lead_name || task.object_id || '这条线索',
    title: context.title || task.title || review?.task?.title || '今日跟进任务',
    reason: context.reason || review?.admission_reason || '补齐阻断信息后，已进入今天可处理队列。',
    nextAction: context.nextAction || review?.next_action || '记录本次跟进结果，并让系统自动安排下一步。',
    microScript: context.microScript || null,
    writebackPreview,
    writebackOptionSurface: context.writebackOptionSurface || writebackPreview?.option_surface || null
  };
}

function renderTaskOutcomeFocusContext(context) {
  return `
    <div class="task-outcome-context">
      <span class="chip success">${escapeHtml(context.sourceLabel || '来自 Today 主链')}</span>
      <strong>${escapeHtml(context.leadName)}</strong>
      <p>${escapeHtml(context.reason)}</p>
      ${context.microScript ? renderLeadMicroScriptBrief(context.microScript) : ''}
      ${context.writebackPreview ? renderLeadWritebackPreviewBrief(context.writebackPreview, { compact: true }) : ''}
      <small>${escapeHtml(context.nextAction)}</small>
    </div>
  `;
}

function defaultTaskOutcomeReason(context) {
  const hintSource = context.microScript?.result_hint || context.writebackPreview?.route_hint || '';
  const hint = hintSource ? `；${hintSource}` : '';
  return `${context.leadName} 已由获客执行进入下一步；${context.reason}${hint} 本次跟进结果：`;
}

function taskOutcomeResultField() {
  return $('#task-outcome-result');
}

function normalizeTaskOutcomeOption(option = {}) {
  return {
    value: String(option.value || option.result || option.tag || option.outcomeTag || 'completed'),
    label: String(option.label || option.result || option.tag || option.value || '任务已完成'),
    next_step_type: String(option.next_step_type || option.nextStepType || 'none'),
    default_delay_hours: Number(option.default_delay_hours || option.defaultDelayHours || option.delayHours || 0),
    due_required: option.due_required === true || option.due_required === 'true' || option.dueRequired === true || option.dueRequired === 'true'
  };
}

function genericTaskOutcomeOptions() {
  return [
    { value: 'contacted', label: '已联系上，继续推进', next_step_type: 'followup', default_delay_hours: 24, due_required: true },
    { value: 'callback_requested', label: '客户要求回拨', next_step_type: 'callback', default_delay_hours: 4, due_required: true },
    { value: 'appointment_booked', label: '已经约好沟通', next_step_type: 'appointment', default_delay_hours: 24, due_required: true },
    { value: 'no_response', label: '暂未联系上', next_step_type: 'callback', default_delay_hours: 24, due_required: true },
    { value: 'disqualified', label: '暂不继续跟进', next_step_type: 'none', default_delay_hours: 0, due_required: false },
    { value: 'won', label: '已成交', next_step_type: 'none', default_delay_hours: 0, due_required: false },
    { value: 'completed', label: '仅标记已完成', next_step_type: 'none', default_delay_hours: 0, due_required: false }
  ].map(normalizeTaskOutcomeOption);
}

function taskOutcomeOptionsFromContext(context = null) {
  const surfaceOptions = asArray(context?.writebackOptionSurface?.options).map(normalizeTaskOutcomeOption).filter((option) => option.value);
  return surfaceOptions.length ? surfaceOptions : genericTaskOutcomeOptions();
}

function renderTaskOutcomeQuickButtons(taskId, context = null, { title = '打完后直接点结果' } = {}) {
  const options = taskOutcomeOptionsFromContext(context).slice(0, 5);
  if (!taskId || !options.length) return '';
  const dueLabels = options.filter((option) => option.due_required).map((option) => option.label).slice(0, 3);
  return `
    <div class="one-click-outcomes">
      ${title ? `<small>${escapeHtml(title)}</small>` : ''}
      ${options.map((option) => `
        <button type="button" class="button ghost" data-task-outcome-quick data-task-id="${escapeHtml(taskId)}" data-outcome-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>
      `).join('')}
      ${dueLabels.length ? `<small>${escapeHtml(`这些结果要补下一次时间：${dueLabels.join('、')}`)}</small>` : ''}
    </div>
  `;
}

function selectedTaskOutcomeOption() {
  const field = taskOutcomeResultField();
  const option = field?.selectedOptions?.[0];
  if (!option) return null;
  return normalizeTaskOutcomeOption({
    value: option.value || '',
    label: option.dataset.label || option.textContent || '',
    next_step_type: option.dataset.nextStepType || 'none',
    default_delay_hours: option.dataset.defaultDelayHours || 0,
    due_required: option.dataset.dueRequired || 'false'
  });
}

function renderTaskOutcomeResultSelector(task, context = null) {
  const field = taskOutcomeResultField();
  if (!field) return null;
  const options = taskOutcomeOptionsFromContext(context);
  const presetValue = String(state.taskOutcome.presetResult || '');
  const defaultValue = String(task?.completion_result || defaultCompletionResultForTask(task));
  const selected = options.find((option) => option.value === presetValue)
    || options.find((option) => option.value === defaultValue)
    || options[0]
    || null;
  field.innerHTML = options.map((option) => `
    <option value="${escapeHtml(option.value)}"
      data-label="${escapeHtml(option.label)}"
      data-next-step-type="${escapeHtml(option.next_step_type || 'none')}"
      data-default-delay-hours="${escapeHtml(String(option.default_delay_hours ?? 0))}"
      data-due-required="${option.due_required ? 'true' : 'false'}"
      ${option.value === selected?.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>
  `).join('');
  return selectedTaskOutcomeOption() || selected;
}

function closeTaskOutcomeDialog() {
  state.taskOutcome.taskId = null;
  state.taskOutcome.presetResult = '';
  const dialog = $('#task-outcome-dialog');
  if (dialog?.open && typeof dialog.close === 'function') {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
}

function syncTaskOutcomeDefaults() {
  const selectedOption = selectedTaskOutcomeOption();
  const result = selectedOption?.value || $('#task-outcome-result').value || 'completed';
  const step = selectedOption?.next_step_type || defaultNextStepTypeForResult(result);
  $('#task-outcome-next-step').value = step || 'none';
  const dueField = $('#task-outcome-due-at');
  const autoDueAt = step && step !== 'none'
    ? (selectedOption?.default_delay_hours
      ? formatLocalDateTimeInput(Date.now() + selectedOption.default_delay_hours * 60 * 60 * 1000)
      : defaultLocalDateTimeForStep(step))
    : '';
  if (dueField) {
    const lastAuto = String(dueField.dataset.autoDueAt || '');
    if (!dueField.value || dueField.value === lastAuto || step === 'none') {
      dueField.value = autoDueAt;
      dueField.dataset.autoDueAt = autoDueAt;
    }
  }
  syncTaskOutcomeHint();
}

function syncTaskOutcomeHint() {
  const selectedOption = selectedTaskOutcomeOption();
  const result = selectedOption?.label || readableTaskResult($('#task-outcome-result').value || 'completed');
  const nextStep = $('#task-outcome-next-step').value || 'none';
  const dueField = $('#task-outcome-due-at');
  if (dueField) dueField.disabled = nextStep === 'none';
  $('#task-outcome-hint').textContent = nextStep === 'none'
    ? `系统会记录“${result}”，并把当前任务归档为已完成。`
    : selectedOption?.due_required
      ? `系统会记录“${result}”，并自动创建一条“${humanTaskStepLabel(nextStep)}”任务；请补明确时间。`
      : `系统会记录“${result}”，并自动创建一条“${humanTaskStepLabel(nextStep)}”任务。`;
}

async function submitTaskOutcome(event) {
  event.preventDefault();
  ensureTenant();
  const taskId = state.taskOutcome.taskId;
  if (!taskId) throw new Error('没有可提交的任务');
  const task = findTaskById(taskId);
  const focusContext = task ? buildTaskOutcomeFocusContext(task) : null;
  const form = new FormData(event.target);
  const nextStepType = String(form.get('next_step_type') || 'none');
  const nextStepDueAt = String(form.get('next_step_due_at') || '').trim();
  const payload = {
    tenant_id: state.tenant.id,
    completion_result: String(form.get('completion_result') || 'completed'),
    completion_reason: String(form.get('completion_reason') || '').trim(),
    next_step_type: nextStepType,
    next_step_due_at: nextStepType === 'none' ? '' : nextStepDueAt ? new Date(nextStepDueAt).toISOString() : ''
  };
  const result = await api(`/api/tasks/${taskId}/complete`, {
    method: 'POST',
    body: payload
  });
  closeTaskOutcomeDialog();
  await refresh();
  const refreshedRun = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const writebackPreview = result.followup_task?.id
    ? findLeadRunWritebackPreviewForTask(refreshedRun, result.followup_task.id)
    : null;
  if (focusContext && result.followup_task?.id) {
    setWorkbenchTaskFocus(result.followup_task.id, {
      title: result.followup_task.title || '下一步跟进任务',
      leadName: focusContext.leadName,
      reason: `已回写“${readableTaskResult(payload.completion_result)}”，系统已把下一步接上。`,
      nextAction: `继续处理：${humanTaskStepLabel(result.task?.next_step_type || nextStepType)}`,
      writebackPreview
    });
    setHomePanel('today');
    renderUserWorkbench();
  } else if (focusContext) {
    setWorkbenchTaskFocus('', {});
    renderUserWorkbench();
  }
  toast(result.followup_task ? `任务已完成，已自动创建${humanTaskStepLabel(result.task.next_step_type)}任务` : '任务结果已记录');
}

function applyRecipe(recipe) {
  applyCommanderTemplate(recipe.templateKey);
  $('#commander-goal').value = recipe.goal;
  state.commander.activeRecipe = recipe.id;
  renderCommanderFields(recipe.templateKey, mergeCommanderMissingInputs(recipe.templateKey));
  renderCommanderHome();
  renderDefaultRecipes();
  renderWeeklyCampaign();
  persistCampaignSnapshot(buildWeeklyCampaign());
  $('#commander-center').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(`已套用模板：${recipe.title}`);
}

async function handleCampaignAction(action) {
  if (action === 'restore') {
    if (!restoreCampaignSnapshot()) {
      toast('还没有可恢复的战役记录');
      return;
    }
    renderDefaultRecipes();
    renderCommanderHome();
    renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
    renderUserWorkbench();
    renderWeeklyCampaign();
    renderCustomerTimeline();
    toast('已恢复上次战役');
    return;
  }
  await runWeeklyCampaignFlow();
}

function syncCommanderResponse(data) {
  if (!data) return;
  const route = data.route || data.plan?.route || null;
  const templateKey = route?.playbook_id ? templateFromPlaybookId(route.playbook_id) : inferCommanderTemplateKey($('#commander-goal')?.value || '');
  if (templateKey) {
    state.commander.templateKey = templateKey;
  }
  state.commander.lastPlan = data.plan || (data.dag ? data : data.status ? data : null);
  state.commander.lastRun = data.workflow_run || data.agent_run || data.step_outputs || data.artifacts ? data : null;
  renderCommanderFields(state.commander.templateKey, mergeCommanderMissingInputs(state.commander.templateKey, route?.missing_inputs || data.missing_inputs || []));
}

function mergeProspectOutreachQuerySlice(run, slice) {
  if (!run || !slice) return run;
  return {
    ...run,
    ...slice,
    lead_acquisition_workbench_view:
      slice.lead_acquisition_workbench_view || run.lead_acquisition_workbench_view,
    prospect_outreach_packs: slice.prospect_outreach_packs || run.prospect_outreach_packs,
    primary_prospect_outreach_pack:
      slice.primary_prospect_outreach_pack || run.primary_prospect_outreach_pack
  };
}

async function refreshProspectOutreachWorkbenchOnRun(run) {
  if (!run?.id || !state.tenant?.id) return run;
  const slice = await api(
    `/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/prospect-outreach/workbench?tenant_id=${encodeURIComponent(state.tenant.id)}&workspace_id=default`
  );
  return mergeProspectOutreachQuerySlice(run, slice);
}

async function refreshProspectOutreachSummaryOnRun(run) {
  if (!run?.id || !state.tenant?.id) return run;
  const slice = await api(
    `/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/prospect-outreach/summary?tenant_id=${encodeURIComponent(state.tenant.id)}&workspace_id=default`
  );
  return mergeProspectOutreachQuerySlice(run, slice);
}

async function prefetchProspectOutreachSummaryForActiveRun() {
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (!run?.id || run.prospect_outreach_result_summary?.packet_id) return;
  try {
    const merged = await refreshProspectOutreachSummaryOnRun(run);
    syncActiveLeadRun(merged, { persist: false });
    renderActiveLeadRun();
    renderUserWorkbench();
    renderCommanderHome();
  } catch (error) {
    console.warn('[opc] prospect outreach summary prefetch failed', error);
  }
}

function syncActiveLeadRun(run, { persist = true } = {}) {
  if (!run?.id) return;
  state.commander.activeLeadRunId = run.id;
  state.commander.lastLeadRun = run;
  state.data.activeLeadRun = run;
  if (state.data.leadRuns.some((item) => item.id === run.id)) {
    state.data.leadRuns = state.data.leadRuns.map((item) => (item.id === run.id ? run : item));
  } else {
    state.data.leadRuns = [run, ...state.data.leadRuns];
  }
  if (state.commander.lastRun?.step_outputs?.lead_acquisition_run?.id === run.id) {
    state.commander.lastRun.step_outputs.lead_acquisition_run = run;
  }
  if (persist) persistCommanderState();
}

function renderCommanderFields(templateKey, missingInputs = []) {
  const key = COMMANDER_TEMPLATES[templateKey] ? templateKey : 'growth_loop';
  const template = COMMANDER_TEMPLATES[key];
  const defaults = defaultCommanderValues(key);
  const currentValues = Object.fromEntries(new FormData($('#commander-form') || document.createElement('form')));
  const fieldNames = missingInputs.length ? expandCommanderMissingFields(key, missingInputs) : template.fields.map((field) => field.name);
  const fields = template.fields.filter((field) => fieldNames.includes(field.name));
  $('#commander-field-grid').innerHTML = fields.length
    ? fields.map((field) => renderCommanderField(field, currentValues[field.name] ?? readPath(defaults, field.name))).join('')
    : '<div class="command-help">这个目标当前不需要额外补字段，直接生成计划或执行即可。</div>';
}

function renderCommanderField(field, value) {
  const currentValue = value ?? '';
  if (field.type === 'select') {
    return `
      <label>
        ${escapeHtml(field.label)}
        <select name="${escapeHtml(field.name)}">
          ${asArray(field.options)
            .map(([optionValue, optionLabel]) => {
              const selected = String(optionValue) === String(currentValue) ? ' selected' : '';
              return `<option value="${escapeHtml(optionValue)}"${selected}>${escapeHtml(optionLabel)}</option>`;
            })
            .join('')}
        </select>
      </label>
    `;
  }
  if (field.type === 'textarea') {
    return `
      <label class="span-2">
        ${escapeHtml(field.label)}
        <textarea name="${escapeHtml(field.name)}" rows="${escapeHtml(String(field.rows || 4))}" placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(String(currentValue))}</textarea>
      </label>
    `;
  }
  return `
    <label>
      ${escapeHtml(field.label)}
      <input name="${escapeHtml(field.name)}" value="${escapeHtml(String(currentValue))}" placeholder="${escapeHtml(field.placeholder || '')}" />
    </label>
  `;
}

function buildCommanderPayload() {
  const goal = $('#commander-goal')?.value.trim();
  if (!goal) {
    throw new Error('请先输入一句话目标');
  }
  const inferredKey = inferCommanderTemplateKey(goal) || state.commander.templateKey;
  if (inferredKey) {
    state.commander.templateKey = inferredKey;
  }
  const payload = {
    tenant_id: state.tenant.id,
    goal
  };
  const defaults = inferredKey ? clone(defaultCommanderValues(inferredKey)) : {};
  mergeRecord(payload, defaults);
  const form = new FormData($('#commander-form'));
  for (const [name, rawValue] of form.entries()) {
    if (name === 'goal') continue;
    const value = String(rawValue).trim();
    if (!value) continue;
    writePath(payload, name, value);
  }
  return payload;
}

function shouldUseLeadAcquisitionRun(payload) {
  if (state.commander.templateKey === 'lead_acquisition') return true;
  if (!['growth_loop'].includes(state.commander.templateKey)) return false;
  const goal = String(payload.goal || '').toLowerCase();
  return /获客|线索|客户|咨询|预约|外呼|lead|acquisition/.test(goal) && !/复盘|report|分析/.test(goal);
}

function buildLeadAcquisitionPayload(payload) {
  const goal = payload.goal;
  return {
    tenant_id: state.tenant.id,
    workspace_id: 'default',
    goal,
    industry: payload.industry || inferIndustryFromGoal(goal),
    location: payload.location || inferLocationFromGoal(goal),
    target_customer_profile: payload.target_customer_profile || defaultTargetProfile(goal),
    source_strategy: payload.source_strategy || defaultSourceStrategy(goal),
    lead_count_target: Number(payload.lead_count_target || inferLeadCountFromGoal(goal) || 10),
    next_run_bootstrap_packet: payload.next_run_bootstrap_packet || null
  };
}

function chooseLeadsForAcquisitionRun(payload) {
  if (payload?.skip_auto_attach_leads || payload?.next_run_bootstrap_packet) {
    return [];
  }
  const target = Number(payload.lead_count_target || inferLeadCountFromGoal(payload.goal) || 5);
  return [...state.data.leads]
    .filter((lead) => lead.id)
    .sort((a, b) => Number(b.score_total || 0) - Number(a.score_total || 0))
    .slice(0, Math.max(1, Math.min(target, 8)));
}

function buildLeadNextRunBootstrapPayload(packet, run = null) {
  const bootstrap = packet || {};
  const goal = bootstrap.inherited_goal || run?.goal || COMMANDER_TEMPLATES.lead_acquisition.goal;
  return {
    tenant_id: state.tenant.id,
    goal,
    industry: bootstrap.inherited_industry || run?.industry || inferIndustryFromGoal(goal),
    location: bootstrap.inherited_location || run?.location || inferLocationFromGoal(goal),
    target_customer_profile: bootstrap.inherited_target_customer_profile || run?.target_customer_profile || defaultTargetProfile(goal),
    lead_count_target: Number(bootstrap.inherited_lead_count_target || run?.lead_count_target || inferLeadCountFromGoal(goal) || 10),
    next_run_bootstrap_packet: bootstrap,
    skip_auto_attach_leads: true
  };
}

function buildLeadAcquisitionCommanderPlan(payload, run) {
  return {
    status: 'completed',
    goal: payload.goal,
    plan_summary: `已创建获客执行「${run.goal || payload.goal}」，当前阶段 ${leadRunStageLabel(run.current_stage)}。`,
    next_required_action: run.next_recommended_action || '查看获客执行并处理今日跟进任务。',
    expected_artifacts: ['lead_acquisition_run', 'followup_script', 'followup_queue'],
    approval_points: [],
    risk_summary: {
      max_risk_level: 'R2',
      external_actions: []
    },
    route: {
      agent_id: 'orchestration_agent',
      playbook_id: 'lead_acquisition.run_execute.v1',
      missing_inputs: []
    }
  };
}

function defaultCommanderValues(templateKey) {
  const latestLead = state.data.leads[0] || {};
  const latestInquiry = state.data.inquiries[0] || {};
  const activePage = state.page || state.data.pages[0] || {};
  const activeSourceTag = state.sourceTag || state.data.sourceTags[0] || {};

  if (templateKey === 'weekly_review') {
    return {};
  }
  if (templateKey === 'lead_acquisition') {
    const goal = $('#commander-goal')?.value?.trim() || COMMANDER_TEMPLATES.lead_acquisition.goal;
    return {
      industry: inferIndustryFromGoal(goal),
      location: inferLocationFromGoal(goal),
      target_customer_profile: defaultTargetProfile(goal),
      lead_count_target: inferLeadCountFromGoal(goal)
    };
  }
  if (templateKey === 'crm_followup') {
    return {
      object_type: latestLead.id ? 'lead' : latestInquiry.id ? 'inquiry' : 'lead',
      object_id: latestLead.id || latestInquiry.id || '',
      title: latestLead.contact_name
        ? `跟进 ${latestLead.contact_name} 的最新需求`
        : latestInquiry.contact_name
          ? `跟进 ${latestInquiry.contact_name} 的咨询`
          : '',
      priority: 'P1'
    };
  }
  if (templateKey === 'voice_followup') {
    return {
      lead_id: latestLead.id || '',
      phone: latestLead.contact_phone || latestInquiry.contact_phone || latestInquiry.phone || '',
      script: latestInquiry.message
        ? `请先确认对方的需求重点：${latestInquiry.message}`
        : '先确认需求、预算和可沟通时间，再约下一步动作。'
    };
  }
  if (templateKey === 'integration_stack') {
    return {};
  }
  return {
    platform_code: activeSourceTag.platform || 'linkedin',
    entry_point: activeSourceTag.entry_point || 'bio_link',
    landing_page: {
      title: activePage.title || '免费增长诊断',
      slug: activePage.slug || 'growth-diagnosis',
      headline: activePage.headline || '告诉我目标，我来给你下一步最值得做的获客动作',
      subheadline: activePage.subheadline || '提交后系统会自动创建页面、线索和后续跟进任务。'
    },
    inquiry: {
      name: latestInquiry.contact_name || latestLead.contact_name || '',
      email: latestInquiry.contact_email || latestLead.contact_email || '',
      phone: latestInquiry.contact_phone || latestLead.contact_phone || latestInquiry.phone || '',
      message: latestInquiry.message || ''
    }
  };
}

function inferCommanderTemplateKey(goal) {
  const normalized = String(goal || '').toLowerCase();
  if (/weekly|复盘|分析|report|analytics/.test(normalized)) return 'weekly_review';
  if (/voice|call|phone|外呼|电话|呼叫/.test(normalized)) return 'voice_followup';
  if (/crm|follow.?up|task|跟进|任务/.test(normalized)) return 'crm_followup';
  if (/open.?source|integration|connector|mcp|skill|开源|集成|工具/.test(normalized)) return 'integration_stack';
  if (/获客|线索|客户|咨询|预约|lead|acquisition/.test(normalized)) return 'lead_acquisition';
  if (/lead|线索|获客|咨询|growth|source|landing/.test(normalized)) return 'growth_loop';
  return null;
}

function templateFromPlaybookId(playbookId) {
  if (playbookId === 'analytics_agent.weekly_review.v1') return 'weekly_review';
  if (playbookId === 'crm_agent.create_followup_task.v1') return 'crm_followup';
  if (playbookId === 'voice_agent.queue_followup_call.v1') return 'voice_followup';
  if (playbookId === 'orchestration_agent.integration_stack_recommendation.v1') return 'integration_stack';
  if (playbookId === 'lead_acquisition.run_execute.v1') return 'lead_acquisition';
  if (playbookId === 'orchestration_agent.growth_loop_intake.v1') return 'growth_loop';
  return state.commander.templateKey;
}

function expandCommanderMissingFields(templateKey, missingInputs) {
  const key = COMMANDER_TEMPLATES[templateKey] ? templateKey : 'growth_loop';
  const fields = COMMANDER_TEMPLATES[key].fields.map((field) => field.name);
  const expanded = new Set();
  asArray(missingInputs).forEach((name) => {
    if (fields.includes(name)) {
      expanded.add(name);
      return;
    }
    fields
      .filter((fieldName) => fieldName === name || fieldName.startsWith(`${name}.`))
      .forEach((fieldName) => expanded.add(fieldName));
  });
  return expanded.size ? [...expanded] : fields;
}

async function commanderRequest(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

async function runCommanderTemplate(templateKey, goal, overrides = {}) {
  const payload = {
    tenant_id: state.tenant.id,
    goal
  };
  mergeRecord(payload, clone(defaultCommanderValues(templateKey)));
  mergeRecord(payload, clone(overrides));
  if (templateKey === 'lead_acquisition') {
    const result = await executeLeadAcquisitionRun(payload);
    syncActiveLeadRun(result.run);
    return { ok: true, status: 200, data: state.commander.lastRun };
  }
  return commanderRequest('/api/commander/run', payload);
}

async function runWeeklyCampaignFlow() {
  await createWorkspaceIfNeeded();
  const recipe = activeRecipe();
  state.commander.activeRecipe = recipe.id;
  state.campaign.runner = {
    status: 'running',
    recipeId: recipe.id,
    title: recipe.title,
    startedAt: new Date().toISOString(),
    steps: []
  };
  renderWeeklyCampaign();

  const chain = campaignChainForRecipe(recipe.id);
  for (const step of chain) {
    state.campaign.runner.steps.push({
      label: step.label,
      status: 'running',
      detail: step.goal
    });
    renderWeeklyCampaign();
    const result = await runCommanderTemplate(step.templateKey, step.goal, step.overrides ? step.overrides() : {});
    const runnerStep = state.campaign.runner.steps.at(-1);
    runnerStep.status = result.ok && result.data?.status !== 'blocked_missing_context' ? 'completed' : 'blocked';
    runnerStep.detail = result.data?.next_required_action || result.data?.status || 'completed';
    syncCommanderResponse(result.data);
    renderCommanderHome();
    renderCommanderResults(result.data?.plan || state.commander.lastPlan, result.data);
    if (result.ok && result.data?.status !== 'blocked_missing_context') {
      await refresh();
    } else {
      renderUserWorkbench();
      renderWeeklyCampaign();
      persistCampaignSnapshot(buildWeeklyCampaign());
      toast('战役执行到需要你补充或确认的步骤，已停在当前状态');
      return;
    }
  }

  state.campaign.runner.status = 'completed';
  state.campaign.runner.finishedAt = new Date().toISOString();
  renderUserWorkbench();
  renderWeeklyCampaign();
  renderCustomerTimeline();
  persistCampaignSnapshot(buildWeeklyCampaign());
  toast(`本周战役已跑完：${recipe.title}`);
}

function activeRecipe() {
  return DEFAULT_RECIPES.find((recipe) => recipe.id === state.commander.activeRecipe) || DEFAULT_RECIPES[0];
}

function campaignChainForRecipe(recipeId) {
  const defaultFollowup = () => ({
    object_type: defaultCommanderValues('crm_followup').object_type,
    object_id: defaultCommanderValues('crm_followup').object_id,
    title: defaultCommanderValues('crm_followup').title,
    priority: 'P1'
  });
  const chains = {
    'ten-consultations': [
      { label: '建立获客执行', templateKey: 'lead_acquisition', goal: '我是做企业服务的，帮我本周找到 10 个高质量咨询，并安排今天优先联系的客户' },
      { label: '生成复盘', templateKey: 'weekly_review', goal: '帮我生成本周复盘' },
      { label: '安排跟进', templateKey: 'crm_followup', goal: '帮我创建一个跟进任务', overrides: defaultFollowup }
    ],
    'map-to-call': [
      { label: '生成地图获客链路', templateKey: 'lead_acquisition', goal: '我是做财税服务的，帮我在杭州找一批本地潜在客户，筛选高意向对象，并安排外呼预约' },
      { label: '安排外呼节点', templateKey: 'voice_followup', goal: '给这个线索安排一次外呼跟进' },
      { label: '回写跟进任务', templateKey: 'crm_followup', goal: '帮我把外呼结果转成 CRM 下一步任务', overrides: defaultFollowup }
    ],
    'conversion-review': [
      { label: '复盘有效动作', templateKey: 'weekly_review', goal: '帮我复盘本周哪些获客和跟进动作有效，并生成下周动作建议' },
      { label: '安排补救动作', templateKey: 'crm_followup', goal: '帮我把复盘建议转成一个跟进任务', overrides: defaultFollowup }
    ],
    'evidence-to-call': [
      { label: '补齐联系依据', templateKey: 'lead_acquisition', goal: '帮我先补齐这批线索的联系理由和开口依据，再安排今天最该联系的客户' },
      { label: '安排今日跟进', templateKey: 'lead_acquisition', goal: '把证据更稳的线索排进今天联系队列，并给出开口话术' }
    ],
    'voice-qualify': [
      { label: '筛出外呼对象', templateKey: 'lead_acquisition', goal: '帮我筛出今天最值得外呼的高意向线索，并把结果回写到下一步跟进' },
      { label: '回写下一步', templateKey: 'lead_acquisition', goal: '根据外呼结果生成回拨、预约或放弃的下一步建议' }
    ]
  };
  return chains[recipeId] || chains['ten-consultations'];
}

async function refresh() {
  ensureTenant();
  renderLoading();
  const tenantId = encodeURIComponent(state.tenant.id);

  const data = await settle({
    ops: api(`/api/admin/operations/overview?tenant_id=${tenantId}&timeout_ms=80`),
    p1: api(`/api/admin/p1-foundation/overview?tenant_id=${tenantId}`),
    workbench: api(`/api/workbench/today?tenant_id=${tenantId}`),
    callCenter: api(`/api/voice/call-center/workbench?tenant_id=${tenantId}&workspace_id=default`),
    funnel: api(`/api/analytics/funnel?tenant_id=${tenantId}`),
    channels: api(`/api/analytics/channels?tenant_id=${tenantId}`),
    tasks: api(`/api/tasks?tenant_id=${tenantId}&status=open`),
    completedTasks: api(`/api/tasks?tenant_id=${tenantId}&status=done`),
    inquiries: api(`/api/inquiries?tenant_id=${tenantId}`),
    leads: api(`/api/leads?tenant_id=${tenantId}`),
    leadRuns: api(`/api/lead-acquisition-runs?tenant_id=${tenantId}&workspace_id=default`),
    sourceTags: api(`/api/source-tags?tenant_id=${tenantId}`),
    pages: api(`/api/landing-pages?tenant_id=${tenantId}`),
    weeklyReport: api(`/api/analytics/weekly-report?tenant_id=${tenantId}`),
    campaignArtifact: api(`/api/campaign-artifacts/latest?tenant_id=${tenantId}`),
    campaignArtifacts: api(`/api/artifacts?tenant_id=${tenantId}&type=marketing_campaign_snapshot&limit=3`)
  });

  if (data.sourceTags?.[0]) state.sourceTag ||= data.sourceTags[0];
  if (data.pages?.[0]) state.page ||= data.pages[0];
  const activeLeadRunId = state.commander.activeLeadRunId || data.leadRuns?.[0]?.id || '';
  if (activeLeadRunId) {
    try {
      data.activeLeadRun = await api(`/api/lead-acquisition-runs/${encodeURIComponent(activeLeadRunId)}?tenant_id=${tenantId}&workspace_id=default`);
    } catch (error) {
      console.warn('[opc] failed to load active lead acquisition run', error);
      data.activeLeadRun = null;
    }
  }
  state.data = {
    tasks: data.tasks || [],
    completedTasks: data.completedTasks || [],
    inquiries: data.inquiries || [],
    leads: data.leads || [],
    leadRuns: data.leadRuns || [],
    activeLeadRun: data.activeLeadRun || null,
    sourceTags: data.sourceTags || [],
    pages: data.pages || [],
    channels: data.channels || [],
    weeklyReport: data.weeklyReport || null,
    funnel: data.funnel || null,
    workbench: data.workbench || null,
    callCenter: data.callCenter || null,
    ops: data.ops || null,
    p1: data.p1 || null
  };
  state.campaign.snapshot = data.campaignArtifact?.artifact?.payload || state.campaign.snapshot;
  state.campaign.history = data.campaignArtifacts || [];
  if (state.campaign.snapshot?.recipeId) {
    state.commander.activeRecipe = state.campaign.snapshot.recipeId;
  }
  if (state.data.activeLeadRun) {
    syncActiveLeadRun(state.data.activeLeadRun, { persist: false });
  }

  renderTenantStatus();
  renderLinks();
  renderCommanderHome();
  renderDefaultRecipes();
  renderUserWorkbench();
  renderCallCenter();
  renderActiveLeadRun();
  renderWeeklyCampaign();
  renderCustomerTimeline();
  renderAdminOps(data.ops, data.p1);
  renderBusinessSummary(data.workbench?.summary, data.funnel);
  renderTasks(data.tasks || []);
  renderInquiries(data.inquiries || []);
  renderLeads(data.leads || []);
  renderWeeklyReport(data.weeklyReport);
  renderFunnel(data.funnel);
  renderChannels(data.channels || []);
  renderSourceTags(data.sourceTags || []);
  renderPages(data.weeklyReport?.pages || data.pages || []);
  renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
  renderDefaultRecipes();
  renderUserWorkbench();
  renderCallCenter();
  renderActiveLeadRun();
  renderWeeklyCampaign();
  renderCustomerTimeline();
  $('#ops-updated').textContent = `已刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
}

function renderCommanderHome() {
  const goal = $('#commander-goal')?.value.trim();
  const plan = state.commander.lastRun?.plan || state.commander.lastPlan;
  const run = state.commander.lastRun;
  const route = run?.route || plan?.route || null;
  const missingInputs = asArray(run?.missing_inputs || route?.missing_inputs);
  renderCommanderGoalGuard();
  renderCommanderRunBrief(plan, run);
  renderCommanderPriorityEntry();
  const health = !state.tenant ? 'not_configured' : run?.status || plan?.status || 'ready';
  $('#commander-mode-chip').className = `chip ${toneForStatus(String(health))}`;
  $('#commander-mode-chip').textContent = !state.tenant ? '等待开始' : run ? readableAction(run.status) : plan ? '计划已生成' : 'Command Center';

  if (!state.tenant) {
    $('#commander-title').textContent = '今天先打哪几个客户？';
    $('#commander-copy').textContent = '首次执行会自动创建工作区，然后把目标拆成线索、推荐理由、开口话术、联系动作和结果回写。';
  } else if (run) {
    $('#commander-title').textContent = goal || '获客执行已有结果';
    $('#commander-copy').textContent = run.status === 'blocked_missing_context'
      ? '系统已经理解你的目标，但还需要少量上下文才能继续跑完整流程。'
      : '系统已经把推荐线索、联系动作、回写结果和下一步建议收回到获客执行。';
  } else if (plan) {
    $('#commander-title').textContent = goal || '获客执行已生成';
    $('#commander-copy').textContent = missingInputs.length
      ? `当前还缺少 ${missingInputs.length} 个关键字段，补完即可执行。`
      : '系统已完成路由和风险识别，现在可以直接执行。';
  } else {
    $('#commander-title').textContent = '说一句目标，OPC 帮你排出今天先联系谁';
    $('#commander-copy').textContent = `当前已有 ${state.data.leads.length} 条线索、${state.data.tasks.length} 个待办、${state.data.inquiries.length} 条咨询，可直接接入下一轮获客跟进。`;
  }

  const progressItems = !state.tenant
    ? [
        ['等待开始', '首次执行时系统会自动建立工作区和作用域。', 'info'],
        ['推荐先跑默认获客流程', '先生成来源、页面、咨询、线索和任务，最接近最终主路径。', 'info']
      ]
    : run
      ? buildCommanderRunProgress(run)
      : plan
        ? buildCommanderPlanProgress(plan)
        : [
            ['理解目标', '用一句话表达经营目标，系统自动选择合适 playbook。', 'success'],
            ['自动补关键字段', '只在必须时展示 2-4 个关键字段，不把用户丢进复杂后台。', 'info'],
            ['返回结果和下一步', '结果页会直接告诉你已完成什么、还要确认什么、接下来做什么。', 'info']
          ];
  $('#commander-progress-list').innerHTML = progressItems.map(([title, copy, tone]) => renderCommanderNoteItem({ title, copy, tone })).join('');
}

function handleCommanderGoalDraftChange() {
  const goal = $('#commander-goal')?.value || '';
  state.commander.goal = goal;
  const inferredKey = inferCommanderTemplateKey(goal);
  if (inferredKey && inferredKey !== state.commander.templateKey) {
    state.commander.templateKey = inferredKey;
  }
  renderCommanderFields(state.commander.templateKey, mergeCommanderMissingInputs(state.commander.templateKey));
  renderCommanderHome();
  persistCommanderState();
}

function handleCommanderFieldDraftChange() {
  state.commander.goal = $('#commander-goal')?.value || '';
  renderCommanderHome();
  persistCommanderState();
}

function currentCommanderGoalContext() {
  const goal = $('#commander-goal')?.value.trim() || '';
  const templateKey = inferCommanderTemplateKey(goal) || state.commander.templateKey || 'growth_loop';
  const form = new FormData($('#commander-form') || document.createElement('form'));
  const read = (name) => String(form.get(name) || '').trim();
  const industry = read('industry') || inferIndustryFromGoal(goal);
  const location = read('location') || inferLocationFromGoal(goal);
  const explicitProfile = read('target_customer_profile');
  const profile = explicitProfile || (industry ? defaultTargetProfile(goal) : '');
  const missing = [];
  if (templateKey === 'lead_acquisition' && goal) {
    if (!industry) missing.push({ name: 'industry', label: '行业', hint: '例如 财税服务 / 装修 / 教培' });
    if (!location) missing.push({ name: 'location', label: '区域', hint: '例如 杭州 / 深圳 / 成都' });
    if (!profile) missing.push({ name: 'target_customer_profile', label: '客户画像', hint: '例如 刚注册公司、正在比较代理记账报价的小微企业主' });
  }
  const goalClarificationBrief = templateKey === 'lead_acquisition' && goal
    ? buildCommanderGoalClarificationBrief({
        goal,
        industry,
        location,
        profile,
        missing,
        leadCountTarget: Number(read('lead_count_target') || inferLeadCountFromGoal(goal) || 0)
      })
    : null;
  return {
    goal,
    templateKey,
    industry,
    location,
    profile,
    missing,
    leadCountTarget: Number(read('lead_count_target') || inferLeadCountFromGoal(goal) || 0),
    goal_clarification_brief: goalClarificationBrief
  };
}

function mergeCommanderMissingInputs(templateKey, missingInputs = []) {
  const context = currentCommanderGoalContext();
  const derived = context.templateKey === templateKey ? context.missing.map((item) => item.name) : [];
  return [...new Set([...asArray(missingInputs), ...derived])];
}

function renderCommanderGoalGuard() {
  const el = $('#commander-goal-guard');
  if (!el) return;
  const context = currentCommanderGoalContext();
  if (!context.goal || context.templateKey !== 'lead_acquisition') {
    el.innerHTML = '';
    return;
  }
  const brief = context.goal_clarification_brief;
  const tone = brief?.missing_inputs?.length ? 'warning' : 'success';
  const items = [
    {
      label: '行业判断',
      value: brief?.industry_guess?.value || context.industry || '待补充',
      hint: brief?.industry_guess?.reason || (context.industry ? '已可用于筛线索和排序' : '请补充你服务的行业'),
      missing: !brief?.industry_guess?.value || brief?.industry_guess?.value === '待补充'
    },
    {
      label: '区域范围',
      value: brief?.location_scope?.value || context.location || '待补充',
      hint: brief?.location_scope?.summary || (context.location ? '已可用于找本地/区域线索' : '请补充今天想打的地区'),
      missing: !brief?.location_scope?.value || brief?.location_scope?.value === '未限定城市'
    },
    {
      label: '客户画像',
      value: brief?.target_profile_hypotheses?.[0] || context.profile || '待补充',
      hint: brief?.target_profile_hypotheses?.[1] || (context.profile ? '已可用于推荐话术和优先级' : '请补充最想找的客户类型'),
      missing: !(brief?.target_profile_hypotheses?.[0] || context.profile)
    },
    {
      label: '缺口提示',
      value: brief?.missing_inputs?.[0] || '信息已够，直接开始采第一批线索',
      hint: brief?.missing_inputs?.[1] || '不会强迫你补表单，信息够了就直接进入采集和排序。',
      missing: Boolean(brief?.missing_inputs?.length)
    },
    {
      label: '下一步采集',
      value: brief?.collection_advice || '先补一句目标后再生成采集建议',
      hint: `优先来源：${(brief?.search_seed_pack?.preferred_sources || []).slice(0, 2).join('、') || '公开来源'}`,
      missing: false
    },
    {
      label: '搜索种子',
      value: (brief?.search_seed_pack?.collection_keywords || []).slice(0, 3).join('、') || '待生成',
      hint: `问题簇：${(brief?.search_seed_pack?.query_clusters || []).slice(0, 2).join('、') || '等待补充目标'}`,
      missing: false
    }
  ];
  el.innerHTML = `
    <section class="commander-guard-card ${escapeHtml(tone)}">
      <div class="commander-guard-head">
        <div>
          <strong>获客目标缺口提示</strong>
          <p>${escapeHtml(brief?.summary || '先补齐一句话目标里的关键信息，再把第一批线索排进今天。')}</p>
        </div>
        <span class="chip ${escapeHtml(tone)}">${brief?.missing_inputs?.length ? `还差 ${brief.missing_inputs.length} 处` : '可直接创建'}</span>
      </div>
      <div class="commander-guard-grid">
        ${items.map((item) => `
          <article class="commander-guard-item ${item.missing ? 'missing' : ''}">
            <small>${escapeHtml(item.label)}</small>
            <strong>${escapeHtml(item.value)}</strong>
            <small>${escapeHtml(item.hint)}</small>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderCommanderRunBrief(planInput, runInput) {
  const el = $('#commander-run-brief');
  if (!el) return;
  const leadRun = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const context = currentCommanderGoalContext();
  const plan = runInput?.plan || planInput || null;
  if (!leadRun && !context.goal && !plan) {
    el.innerHTML = '';
    return;
  }
  const workbench = leadRun?.today_workbench || null;
  const brief = leadRun?.goal_clarification_brief || context.goal_clarification_brief || null;
  const captureProof = leadRun?.capture_proof_surface || null;
  const executionFlowBridge = leadRun?.execution_flow_bridge || null;
  const founderPulsePacket = leadRun?.founder_pulse_packet || null;
  const contextHandoffBridge = leadRun?.context_handoff_bridge || null;
  const leadThreadBrief = leadRun?.lead_thread_brief || null;
  const mainlineMemoryFabric = leadRun?.mainline_memory_fabric || null;
  const skillProof = leadRun?.skill_proof_surface || null;
  const experimentQueue = leadRun?.mainline_experiment_queue || null;
  const defaultActivation = leadRun?.mainline_default_activation_brief || null;
  const defaultConfidenceBand = leadRun?.default_confidence_band || null;
  const nextRunLearningPriorityPack = leadRun?.next_run_learning_priority_pack || null;
  const founderWeeklyDecisionRollup = leadRun?.founder_weekly_decision_rollup || null;
  const founderDecisionActionQueue = leadRun?.founder_decision_action_queue || null;
  const defaultUnlockImpactBrief = leadRun?.default_unlock_impact_brief || null;
  const sourceDefaultActivation = leadRun?.source_default_activation_card || null;
  const scriptDefaultActivation = leadRun?.script_default_activation_card || null;
  const founderDecisionDigest = leadRun?.founder_default_decision_digest || null;
  const openIndustryAutostartPacket = leadRun?.open_industry_autostart_packet || null;
  const primaryAction = normalizeLeadRunActionPacket(workbench?.primary_action);
  const metrics = leadRun
    ? [
        { label: '当前阶段', value: leadRunStageLabel(leadRun.current_stage) },
        { label: '今日目标', value: workbench?.headline || leadRun.summary || leadRun.goal || '继续推进获客执行' },
        { label: '主动作', value: primaryAction?.label || leadRun.next_recommended_action || leadRun.computed_next_recommended_action || '继续下一步' }
      ]
    : [
        { label: '当前阶段', value: plan ? '待执行' : '待创建获客执行' },
        {
          label: '今日目标',
          value: context.goal
            ? context.missing.length
              ? '先补齐行业/区域/画像，再生成今日优先 lead'
              : `先筛出 ${context.leadCountTarget || 10} 条线索里的高优先级对象`
            : '输入一句话目标后，这里固定显示今天该做什么'
        },
        {
          label: '主动作',
          value: plan?.next_required_action || (context.missing.length ? '补齐关键上下文' : '创建获客执行')
        }
      ];
  const summary = leadRun
    ? `${leadRun.goal || '当前获客执行'}`
    : context.goal || plan?.goal || '这里会固定显示 run 当前阶段、今日目标和主动作。';
  const briefMetrics = brief
    ? [
        { label: '行业判断', value: brief.industry_guess?.value || '待补充' },
        { label: brief.missing_inputs?.length ? '缺口提示' : '下一步采集', value: brief.missing_inputs?.[0] || brief.collection_advice || '继续当前主线' },
        { label: '搜索种子', value: (brief.search_seed_pack?.collection_keywords || []).slice(0, 3).join('、') || '待生成' }
      ]
    : [];
  el.innerHTML = `
    <section class="commander-mainline-card ${leadRun ? 'success' : context.missing.length ? 'warning' : 'info'}">
      <div class="commander-mainline-head">
        <div>
          <strong>当前 run 简报</strong>
          <p>${escapeHtml(summary)}</p>
        </div>
        <span class="chip ${leadRun ? 'success' : context.missing.length ? 'warning' : 'info'}">${escapeHtml(leadRun ? '固定主线' : '创建前预览')}</span>
      </div>
      <div class="commander-mainline-metrics">
        ${metrics.map((item) => `
          <article class="commander-mainline-metric">
            <span>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(String(item.value || '-'))}</strong>
          </article>
        `).join('')}
      </div>
      ${briefMetrics.length ? `
        <div class="commander-mainline-metrics">
          ${briefMetrics.map((item) => `
            <article class="commander-mainline-metric">
              <span>${escapeHtml(item.label)}</span>
              <strong>${escapeHtml(String(item.value || '-'))}</strong>
            </article>
          `).join('')}
        </div>
      ` : ''}
      ${openIndustryAutostartPacket ? renderLeadOpenIndustryAutostartPacket(openIndustryAutostartPacket, { asArticle: false }) : ''}
      ${contextHandoffBridge ? renderLeadContextHandoffBridge(contextHandoffBridge, { asArticle: false, compact: true }) : ''}
      ${leadThreadBrief ? renderLeadThreadBrief(leadThreadBrief, { asArticle: false, compact: true }) : ''}
      ${founderPulsePacket ? renderLeadFounderPulsePacket(founderPulsePacket, { asArticle: false }) : ''}
      ${defaultActivation ? renderLeadMainlineDefaultActivationBrief(defaultActivation, { asArticle: false }) : ''}
      ${defaultConfidenceBand ? renderLeadDefaultConfidenceBand(defaultConfidenceBand, { asArticle: false }) : ''}
      ${nextRunLearningPriorityPack ? renderLeadNextRunLearningPriorityPack(nextRunLearningPriorityPack, { asArticle: false }) : ''}
      ${founderWeeklyDecisionRollup ? renderLeadFounderWeeklyDecisionRollup(founderWeeklyDecisionRollup, { asArticle: false }) : ''}
      ${founderDecisionActionQueue ? renderLeadFounderDecisionActionQueue(founderDecisionActionQueue, { asArticle: false }) : ''}
      ${leadRun?.founder_decision_writeback_packet ? renderLeadFounderDecisionWritebackPacket(leadRun.founder_decision_writeback_packet, { asArticle: false }) : ''}
      ${leadRun?.unresolved_decision_carryforward_packet ? renderLeadUnresolvedDecisionCarryforwardPacket(leadRun.unresolved_decision_carryforward_packet, { asArticle: false }) : ''}
      ${defaultUnlockImpactBrief ? renderLeadDefaultUnlockImpactBrief(defaultUnlockImpactBrief, { asArticle: false }) : ''}
      ${leadRun?.evidence_gap_closure_brief ? renderLeadEvidenceGapClosureBrief(leadRun.evidence_gap_closure_brief, { asArticle: false }) : ''}
      ${leadRun?.playbook_freshness_decay_packet ? renderLeadPlaybookFreshnessDecay(leadRun.playbook_freshness_decay_packet, { asArticle: false }) : ''}
      ${leadRun?.evidence_expiry_recheck_packet ? renderLeadEvidenceExpiryRecheck(leadRun.evidence_expiry_recheck_packet, { asArticle: false }) : ''}
      ${leadRun?.experiment_stoploss_guard ? renderLeadExperimentStoplossGuard(leadRun.experiment_stoploss_guard, { asArticle: false }) : ''}
      ${sourceDefaultActivation ? renderLeadSourceDefaultActivationCard(sourceDefaultActivation, { asArticle: false }) : ''}
      ${scriptDefaultActivation ? renderLeadScriptDefaultActivationCard(scriptDefaultActivation, { asArticle: false }) : ''}
      ${founderDecisionDigest ? renderLeadFounderDefaultDecisionDigest(founderDecisionDigest, { asArticle: false }) : ''}
      ${executionFlowBridge ? renderLeadExecutionFlowBridge(executionFlowBridge, { mode: 'commander' }) : ''}
      ${leadRun?.outcome_sop_rollup ? renderLeadOutcomeSopRollup(leadRun.outcome_sop_rollup, { mode: 'commander' }) : ''}
      ${mainlineMemoryFabric ? renderLeadMainlineMemoryFabric(mainlineMemoryFabric, { mode: 'commander' }) : ''}
      ${captureProof ? renderLeadCaptureProofSurface(captureProof, { mode: 'commander' }) : ''}
      ${skillProof ? renderLeadSkillProofSurface(skillProof, { mode: 'commander' }) : ''}
      ${experimentQueue ? renderLeadMainlineExperimentQueue(experimentQueue, { mode: 'commander' }) : ''}
    </section>
  `;
}

function buildCommanderPriorityEntry() {
  const leadRun = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (leadRun) {
    const founderPulsePacket = leadRun.founder_pulse_packet || null;
    const founderPulsePrimary = founderPulsePacket?.today_must_do_one || null;
    const contact = leadRun.today_contact_card || null;
    const workbench = leadRun.today_workbench || null;
    const primaryPacket = normalizeLeadRunActionPacket(workbench?.primary_action);
    if (founderPulsePrimary?.jump_target?.action) {
      return {
        tone: founderPulsePrimary.urgency_bucket === 'overdue' ? 'warning' : 'success',
        title: `现在先处理：${founderPulsePrimary.title || founderPulsePrimary.label || '当前主动作'}`,
        copy: founderPulsePrimary.why_now || founderPulsePacket?.pulse_summary || leadRun.summary || '系统已把当前最该先做的一件事主动推到首页。',
        meta: [
          { label: '级别', value: founderPulsePrimary.urgency_label || '今天处理' },
          { label: '对象', value: founderPulsePrimary.lead_name || founderPulsePrimary.title || leadRun.goal || '当前 run' },
          { label: '后果', value: founderPulsePrimary.business_consequence || '不处理，主链推进会继续变慢。' }
        ],
        actions: [
          renderLeadFounderPulseActionButton(founderPulsePrimary.jump_target, {
            tone: 'primary',
            label: founderPulsePrimary.jump_target?.label || '先处理这一件'
          }),
          '<button type="button" class="button ghost" data-home-tab="workflow">查看当前执行</button>'
        ]
      };
    }
    if (contact?.phone || contact?.lead_id) {
      return {
        tone: 'success',
        title: `直接开始：${contact.title || `联系 ${contact.lead_name || contact.phone || '当前优先线索'}`}`,
        copy: contact.reason || contact.summary || workbench?.summary || '这条线索已经排到今天最前，可以直接开口。',
        meta: [
          { label: '对象', value: contact.lead_name || contact.phone || '优先线索' },
          { label: '动作', value: contact.phone ? `呼叫 ${contact.phone}` : '打开今天处理' },
          { label: '原因', value: contact.route_label || contact.task_priority || '当前队列优先' }
        ],
        actions: [
          contact.phone
            ? `<button type="button" class="button primary" data-lead-run-action="call-lead" data-lead-id="${escapeHtml(contact.lead_id || '')}">呼叫 ${escapeHtml(contact.phone)}</button>`
            : '<button type="button" class="button primary" data-lead-run-action="today">打开今天处理</button>',
          '<button type="button" class="button ghost" data-home-tab="today">查看今日承接</button>'
        ]
      };
    }
    if (primaryPacket) {
      return {
        tone: 'warning',
        title: `直接推进：${primaryPacket.label || '处理当前主动作'}`,
        copy: primaryPacket.reason || workbench?.summary || leadRun.next_recommended_action || '继续推进当前获客执行。',
        meta: [
          { label: '阶段', value: leadRunStageLabel(leadRun.current_stage) },
          { label: '对象', value: primaryPacket.leadName || primaryPacket.title || leadRun.goal || '当前 run' },
          { label: '入口', value: primaryPacket.action || 'today' }
        ],
        actions: [
          `<button type="button" class="button primary" data-lead-run-action="${escapeHtml(primaryPacket.action || 'today')}" data-task-id="${escapeHtml(primaryPacket.taskId || '')}" data-lead-id="${escapeHtml(primaryPacket.leadId || '')}">${escapeHtml(primaryPacket.label || '继续下一步')}</button>`,
          '<button type="button" class="button ghost" data-home-tab="workflow">查看当前执行</button>'
        ]
      };
    }
  }

  const task = buildMustDoItems()[0] || null;
  if (task) {
    return {
      tone: 'warning',
      title: `直接进入任务：${task.title}`,
      copy: task.meta || '当前最该先处理的跟进任务。',
      meta: [
        { label: '类型', value: 'Task' },
        { label: '优先级', value: task.priority || 'P1' },
        { label: '动作', value: '继续处理 / 记录结果' }
      ],
      actions: [
        `<button type="button" class="button primary" data-next-command="${escapeHtml(task.command)}" data-commander-template="${escapeHtml(task.templateKey)}" data-prefill-json="${escapeHtml(JSON.stringify(task.prefill || {}))}">继续处理</button>`,
        '<button type="button" class="button ghost" data-home-tab="today">打开今天处理</button>'
      ]
    };
  }

  const lead = buildHighIntentItems()[0] || null;
  if (lead) {
    return {
      tone: 'info',
      title: `直接跟进线索：${lead.title}`,
      copy: lead.meta || '当前最高分线索，建议先转成今日动作。',
      meta: [
        { label: '类型', value: 'Lead' },
        { label: '动作', value: '创建高优先级跟进' },
        { label: '原因', value: '高意向线索已浮到最前' }
      ],
      actions: [
        `<button type="button" class="button primary" data-next-command="${escapeHtml(lead.command)}" data-commander-template="${escapeHtml(lead.templateKey)}" data-prefill-json="${escapeHtml(JSON.stringify(lead.prefill || {}))}">安排跟进</button>`,
        '<button type="button" class="button ghost" data-home-tab="today">查看今日承接</button>'
      ]
    };
  }

  const context = currentCommanderGoalContext();
  if (!context.goal) {
    return null;
  }
  return {
    tone: context.missing.length ? 'warning' : 'info',
    title: context.missing.length ? '先补齐再创建获客执行' : '直接创建当前获客执行',
    copy: context.missing.length
      ? `还缺 ${context.missing.map((item) => item.label).join('、')}，补齐后更容易把今天第一条线索排出来。`
      : '创建后会直接生成当前阶段、今日主动作和优先进入对象。',
    meta: [
      { label: '目标', value: context.goal || '等待一句话目标' },
      { label: '模板', value: context.templateKey === 'lead_acquisition' ? '获客执行' : context.templateKey || 'growth_loop' },
      { label: '动作', value: context.missing.length ? '补齐关键信息' : '创建 run' }
    ],
    actions: [
      `<button type="button" class="button primary" data-lead-run-action="create">${escapeHtml(context.missing.length ? '按当前目标创建并继续补齐' : '创建获客执行')}</button>`
    ]
  };
}

function renderCommanderPriorityEntry() {
  const el = $('#commander-priority-entry');
  if (!el) return;
  const entry = buildCommanderPriorityEntry();
  if (!entry) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <section class="commander-mainline-card ${escapeHtml(entry.tone || 'info')}">
      <div class="commander-mainline-head">
        <div>
          <strong>最高优先入口</strong>
          <p>${escapeHtml(entry.copy || '直接进入当前最该做的动作。')}</p>
        </div>
        <span class="chip ${escapeHtml(entry.tone || 'info')}">${escapeHtml(entry.title || '直接处理')}</span>
      </div>
      <div class="commander-mainline-metrics">
        ${asArray(entry.meta).map((item) => `
          <article class="commander-mainline-metric">
            <span>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(String(item.value || '-'))}</strong>
          </article>
        `).join('')}
      </div>
      <div class="commander-priority-actions">
        ${asArray(entry.actions).join('')}
      </div>
    </section>
  `;
}

function renderDefaultRecipes() {
  $('#recipe-grid').innerHTML = DEFAULT_RECIPES.map((recipe) => {
    const active = state.commander.activeRecipe === recipe.id ? ' active' : '';
    return `
      <article class="recipe-card${active}">
        <div class="recipe-card-head">
          <span class="chip ${recipe.templateKey === 'growth_loop' ? 'success' : 'info'}">${escapeHtml(recipe.outcome)}</span>
        </div>
        <h3>${escapeHtml(recipe.title)}</h3>
        <p>${escapeHtml(recipe.copy)}</p>
        <button class="button secondary" data-recipe-id="${escapeHtml(recipe.id)}">套用这个目标</button>
      </article>
    `;
  }).join('');
}

function renderCommanderResults(planInput, runInput) {
  const plan = runInput?.plan || planInput || null;
  const run = runInput || null;
  const leadRun = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const leadSignalCard = leadRun ? renderLeadSignalPacket(leadRun.signal_packet, { mode: 'result' }) : '';
  document.body.classList.toggle('has-result', Boolean(plan || run || leadRun));
  const route = run?.route || plan?.route || null;
  const missingInputs = asArray(run?.missing_inputs || route?.missing_inputs);

  $('#commander-updated').textContent = run
    ? `执行状态 · ${readableAction(run.status)}`
    : plan
      ? `计划状态 · ${readableAction(plan.status)}`
      : leadRun
        ? `获客执行 · ${leadRunStageLabel(leadRun.current_stage)}`
        : '未执行';

  if (!plan && !leadRun) {
    $('#commander-plan-panel').innerHTML = renderEmpty('先输入一句话目标，再点击“先生成计划”或“直接执行”。');
    $('#commander-next-panel').innerHTML = renderEmpty('系统会在这里给出下一步动作、风险和确认提示。');
    $('#commander-summary-stack').innerHTML = renderEmpty('还没有 Commander 结果。');
    $('#commander-auto-panel').innerHTML = renderEmpty('执行后这里会列出系统已自动完成的动作。');
    $('#commander-confirm-panel').innerHTML = renderEmpty('如有审批或补充信息需求，会在这里显示。');
    $('#commander-suggestions-panel').innerHTML = renderSuggestedCommands(state.commander.templateKey);
    renderResultActions(null, null);
    return;
  }

  if (!plan && leadRun) {
    const founderBrief = leadRun.weekly_founder_brief || null;
    const nextRunBootstrap = leadRun.next_run_bootstrap_packet || null;
    const founderDecisionDigest = leadRun.founder_default_decision_digest || null;
    $('#commander-summary-stack').innerHTML = renderMetricStack([
      ['状态', leadRun.status || '-'],
      ['阶段', leadRunStageLabel(leadRun.current_stage)],
      ['线索', asArray(leadRun.leads).length],
      ['任务', asArray(leadRun.tasks).length],
      ['已通话', asArray(leadRun.call_sessions).filter((call) => call.status === 'completed').length]
    ]);
    $('#commander-plan-panel').innerHTML = renderMetricStack([
      ['目标', leadRun.goal],
      ['行业', leadRun.industry || '-'],
      ['区域', leadRun.location || '-'],
      ['目标线索数', leadRun.lead_count_target || '-']
    ]);
    $('#commander-next-panel').innerHTML = [
      renderCommanderNoteItem({
        title: '系统建议的下一步',
        copy: leadRun.next_recommended_action || leadRun.computed_next_recommended_action || '继续推进本轮获客执行。',
        tone: 'success'
      }),
      founderDecisionDigest
        ? renderCommanderNoteItem({
            title: '老板先拍板这几件事',
            copy: founderDecisionDigest.digest_summary || founderDecisionDigest.summary || '系统已把当前仍卡在审批和证据不足的关键决定收成老板决策摘要。',
            tone: 'warning'
          })
        : '',
      leadRun.default_confidence_band
        ? renderCommanderNoteItem({
            title: '默认动作现在能不能自动沿用',
            copy: leadRun.default_confidence_band.band_summary || leadRun.default_confidence_band.summary || '系统已把哪些默认动作能自动沿用、哪些只能先推荐、哪些仍要老板拍板收成一条默认置信带。',
            tone: asArray(leadRun.default_confidence_band.approval_only_defaults).length
              ? 'warning'
              : asArray(leadRun.default_confidence_band.recommend_only_defaults).length
                ? 'pending'
                : 'success'
          })
        : '',
      founderBrief
        ? renderCommanderNoteItem({
            title: '老板周简报',
            copy: founderBrief.summary || founderBrief.headline || '本周来源、话术和异议会在这里收成一份老板能看懂的简报。',
            tone: founderBrief.status === 'ready' ? 'info' : founderBrief.status === 'partial' ? 'warning' : 'pending'
          })
        : '',
      leadRun.playbook_freshness_decay_packet
        ? renderCommanderNoteItem({
            title: '当前打法新鲜度',
            copy: leadRun.playbook_freshness_decay_packet.freshness_summary || leadRun.playbook_freshness_decay_packet.summary || '系统已把当前行业打法还能不能继续默认沿用收成一份新鲜度判断。',
            tone: leadRun.playbook_freshness_decay_packet.freshness_band?.label === 'revalidate'
              ? 'warning'
              : leadRun.playbook_freshness_decay_packet.freshness_band?.label === 'watch'
                ? 'pending'
                : 'success'
          })
        : '',
      leadRun.evidence_expiry_recheck_packet
        ? renderCommanderNoteItem({
            title: '当前证据还能不能带',
            copy: leadRun.evidence_expiry_recheck_packet.expiry_summary || leadRun.evidence_expiry_recheck_packet.summary || '系统已把当前还能复用、已经变旧和下一步该去补证的业务证据收成一份复核包。',
            tone: asArray(leadRun.evidence_expiry_recheck_packet.blocked_reuse_claims).length
              ? 'warning'
              : asArray(leadRun.evidence_expiry_recheck_packet.expiring_claims).length
                ? 'pending'
                : 'success'
          })
        : '',
      leadRun.experiment_stoploss_guard
        ? renderCommanderNoteItem({
            title: '哪些实验现在先别烧了',
            copy: leadRun.experiment_stoploss_guard.stoploss_summary || leadRun.experiment_stoploss_guard.summary || '系统已把这轮该停、可继续观察和替代验证重点收成一份主链止损守门。',
            tone: asArray(leadRun.experiment_stoploss_guard.stop_now_experiments).length
              ? 'warning'
              : asArray(leadRun.experiment_stoploss_guard.safe_to_continue).length
                ? 'info'
                : 'pending'
            })
        : '',
      leadRun.next_run_learning_priority_pack
        ? renderCommanderNoteItem({
            title: '下一轮先补什么学习项',
            copy: leadRun.next_run_learning_priority_pack.priority_summary || leadRun.next_run_learning_priority_pack.summary || '系统已把下一轮最值得先补的未知、证据、实验和待放开默认项收成一份学习优先包。',
            tone: asArray(leadRun.next_run_learning_priority_pack.defaults_waiting_unlock).length
              ? 'warning'
              : asArray(leadRun.next_run_learning_priority_pack.evidence_to_collect_first).length
                ? 'info'
                : 'pending'
          })
        : '',
      founderWeeklyDecisionRollup
        ? renderCommanderNoteItem({
            title: '本周老板决策收口',
            copy: founderWeeklyDecisionRollup.rollup_summary || founderWeeklyDecisionRollup.summary || '系统已把这周已经拍板、仍在等待和下周该先盯的老板决策收成一份周度收口。',
            tone: asArray(founderWeeklyDecisionRollup.still_waiting_decisions).length
              ? 'warning'
              : asArray(founderWeeklyDecisionRollup.defaults_unlocked_this_week).length
                ? 'success'
                : 'info'
          })
        : '',
      founderDecisionActionQueue
        ? renderCommanderNoteItem({
            title: '老板接下来先处理什么',
            copy: founderDecisionActionQueue.queue_summary || founderDecisionActionQueue.summary || '系统已把待拍板、待补证和放开默认动作前的关键处理项收成一条动作队列。',
            tone: founderDecisionActionQueue.approval_required
              ? 'warning'
              : asArray(founderDecisionActionQueue.decision_items).length
                ? 'pending'
                : 'info'
          })
        : '',
      nextRunBootstrap
        ? renderCommanderNoteItem({
            title: '下一轮起跑包',
            copy: nextRunBootstrap.summary || nextRunBootstrap.why_this_bootstrap || '当前 run 已带上上一轮验证过的来源、问题簇和话术重点。',
            tone: nextRunBootstrap.status === 'inherited' ? 'success' : 'info'
          })
        : '',
      leadSignalCard
    ].filter(Boolean).join('');
    $('#commander-auto-panel').innerHTML = buildAgentCompletedItems().map((item) => renderCommanderNoteItem(item)).join('');
    $('#commander-confirm-panel').innerHTML = asArray(leadRun.leads).length
      ? renderEmpty('当前没有必须人工确认的动作。')
      : renderCommanderNoteItem({ title: '需要第一批真实线索', copy: '当前没有线索，先从地图获客、公开来源或已有名单导入。', tone: 'warning' });
    $('#commander-suggestions-panel').innerHTML = renderSuggestedCommands('lead_acquisition');
    renderResultActions(null, { status: 'completed', plan: buildLeadAcquisitionCommanderPlan({ goal: leadRun.goal }, leadRun), step_outputs: { lead_acquisition_run: leadRun } });
    return;
  }

  const summaryRows = [
    ['状态', run?.status || plan.status || '-'],
    ['Agent', route?.agent_id || '-'],
    ['Playbook', route?.playbook_id || '-'],
    ['风险等级', plan.risk_summary?.max_risk_level || '-'],
    ['待确认动作', asArray(plan.approval_points).length],
    ['预期产物', asArray(plan.expected_artifacts).length]
  ];
  $('#commander-summary-stack').innerHTML = renderMetricStack(summaryRows);

  const planRows = [
    ['目标', plan.goal || $('#commander-goal')?.value.trim() || '-'],
    ['下一个动作', plan.next_required_action || 'review_or_execute'],
    ['缺失字段', missingInputs.join(', ') || '无'],
    ['外部动作', asArray(plan.risk_summary?.external_actions).join(', ') || '无']
  ];
  $('#commander-plan-panel').innerHTML = `
    ${renderMetricStack(planRows)}
    ${plan.plan_summary ? `<div class="command-help"><strong>AI 计划摘要</strong><p>${escapeHtml(plan.plan_summary)}</p></div>` : ''}
  `;

  const nextItems = [
    leadSignalCard,
    plan.next_required_action
      ? renderCommanderNoteItem({
          title: '系统建议的下一步',
          copy: plan.next_required_action,
          tone: missingInputs.length ? 'warning' : 'success'
        })
      : '',
    missingInputs.length
      ? renderCommanderNoteItem({
          title: '还需要补这些字段',
          copy: missingInputs.join(', '),
          tone: 'warning'
        })
      : '',
    asArray(plan.approval_points).length
      ? renderCommanderNoteItem({
          title: '存在审批点',
          copy: asArray(plan.approval_points)
            .map((item) => `${item.tool_id} · ${item.reason}`)
            .join('；'),
          tone: 'pending'
        })
      : renderCommanderNoteItem({
          title: '当前无需人工审批',
          copy: '这个目标目前可以直接按计划执行。',
          tone: 'success'
        })
  ].filter(Boolean);
  $('#commander-next-panel').innerHTML = nextItems.join('');

  const autoItems = buildCommanderAutoItems(run, plan);
  $('#commander-auto-panel').innerHTML = autoItems.length
    ? autoItems.map((item) => renderCommanderNoteItem(item)).join('')
    : renderEmpty('计划已生成，但还没有自动执行的结果。');

  const confirmItems = buildCommanderConfirmItems(plan, run, missingInputs);
  $('#commander-confirm-panel').innerHTML = confirmItems.length
    ? confirmItems.map((item) => renderCommanderNoteItem(item)).join('')
    : renderEmpty('当前没有必须人工确认的动作。');

  $('#commander-suggestions-panel').innerHTML = renderSuggestedCommands(templateFromPlaybookId(route?.playbook_id || '') || state.commander.templateKey);
  renderResultActions(plan, run);
}

function renderResultActions(plan, run) {
  const hasResult = Boolean(plan || run);
  $('#commander-result-actions').innerHTML = `
    <button class="button primary" data-result-action="use" ${hasResult ? '' : 'disabled'}>直接使用</button>
    <button class="button secondary" data-result-action="modify" ${hasResult ? '' : 'disabled'}>修改后使用</button>
    <button class="button secondary" data-result-action="handoff" ${hasResult ? '' : 'disabled'}>交给下一个 Agent</button>
    <button class="button secondary" data-result-action="basis" ${hasResult ? '' : 'disabled'}>查看依据</button>
    <button class="button secondary danger-button" data-result-action="abandon" ${hasResult ? '' : 'disabled'}>放弃并记录原因</button>
  `;
  if (!hasResult) {
    $('#commander-basis-panel').hidden = true;
    $('#commander-basis-panel').innerHTML = '';
    return;
  }
  $('#commander-basis-panel').innerHTML = renderBasisPanel(plan, run);
}

function handleResultAction(action) {
  const plan = state.commander.lastRun?.plan || state.commander.lastPlan;
  const run = state.commander.lastRun;
  if (!plan && !run) {
    toast('先生成计划或执行一次 Commander');
    return;
  }
  if (action === 'use') {
    if (CURRENT_PAGE === 'workbench') {
      $('#today-workbench').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('已跳到今日工作台');
      return;
    }
    window.location.assign('/workbench');
    return;
  }
  if (action === 'modify') {
    $('#commander-center').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('可以直接修改一句话目标或补充字段');
    return;
  }
  if (action === 'handoff') {
    const command = nextCommandFromResult(plan, run);
    const templateKey = inferCommanderTemplateKey(command) || 'crm_followup';
    applyCommanderTemplate(templateKey);
    $('#commander-goal').value = command;
    $('#commander-center').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('已生成下一个 Agent 命令');
    return;
  }
  if (action === 'basis') {
    const panel = $('#commander-basis-panel');
    panel.hidden = !panel.hidden;
    return;
  }
  if (action === 'abandon') {
    const reason = window.prompt('放弃原因（可选）：', '暂不执行，稍后再看');
    if (reason === null) return;
    localStorage.setItem('opc.lastAbandonReason', reason.trim() || '未填写原因');
    toast('已记录放弃原因');
  }
}

function renderBasisPanel(plan, run) {
  const route = run?.route || plan?.route || {};
  const rows = [
    ['目标', plan?.goal || $('#commander-goal')?.value || '-'],
    ['Agent', route.agent_id || '-'],
    ['Playbook', route.playbook_id || '-'],
    ['风险', plan?.risk_summary?.max_risk_level || '-'],
    ['产物', asArray(run?.artifacts).map((artifact) => artifact.type || artifact.artifact_type).join(', ') || '暂无'],
    ['DAG 节点', asArray(plan?.dag?.nodes).map((node) => node.id).join(' → ') || '暂无']
  ];
  return `
    <div class="section-header compact-header">
      <div>
        <p class="eyebrow">Basis</p>
        <h3>执行依据</h3>
        <p class="section-desc">默认隐藏复杂细节，只在用户点击查看依据时展示。</p>
      </div>
    </div>
    ${renderMetricStack(rows)}
  `;
}

function nextCommandFromResult(plan, run) {
  const playbookId = run?.route?.playbook_id || plan?.route?.playbook_id || '';
  if (playbookId.includes('growth_loop')) return '帮我生成本周复盘，并找出今天最该跟进的客户';
  if (playbookId.includes('weekly_review')) return '帮我把复盘建议转成今日跟进任务';
  if (playbookId.includes('crm_agent')) return '给这个线索安排一次外呼跟进';
  if (playbookId.includes('voice_agent')) return '帮我记录外呼结果并安排下一步跟进';
  return '帮我根据当前结果安排下一步获客跟进';
}

function renderUserWorkbench() {
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const nextActions = buildNextActions().slice(0, 5);
  const completed = buildAgentCompletedItems().slice(0, 5);
  const confirmations = buildUserConfirmationItems().slice(0, 5);
  const handoffs = buildCrmHandoffItems().slice(0, 5);
  const mustDo = buildMustDoItems().slice(0, 4);
  const highIntent = buildHighIntentItems().slice(0, 4);
  const exceptions = buildExceptionItems().slice(0, 4);
  const autoCompleted = buildAutoCompletedRecords().slice(0, 5);
  const summary = buildWorkbenchSummary();

  $('#workbench-updated').textContent = state.tenant
    ? `已生成 · ${nextActions.length} 个建议动作`
    : '等待开始';
  $('#today-mainline-strip').innerHTML = renderTodayMainlineStrip(run);
  if ($('#today-inline-writeback-panel')) $('#today-inline-writeback-panel').innerHTML = renderTodayInlineWritebackPanel(run);
  if ($('#today-next-step-timer-card')) $('#today-next-step-timer-card').innerHTML = renderTodayNextStepTimerCard(run);
  $('#workbench-summary-strip').innerHTML = [
    renderFocusedWorkbenchTaskContext(),
    renderLeadIndustrySellableBrief(run, { compact: true }),
    renderLeadSignalPacket(run?.signal_packet, { mode: 'today', extraClass: 'span-2' }),
    renderLeadCaptureProofSurface(run?.capture_proof_surface, { mode: 'today', extraClass: 'span-2' }),
    ...summary.map(renderWorkbenchSummaryChip)
  ].filter(Boolean).join('');
  $('#next-action-list').innerHTML = nextActions.length
    ? nextActions.map(renderNextActionCard).join('')
    : renderEmpty('工作区就绪后，系统会把今日最该做的 3-5 件事放在这里。');
  $('#agent-completed-list').innerHTML = completed.length
    ? completed.map((item) => renderCommanderNoteItem(item)).join('')
    : renderEmpty('还没有自动完成记录；可以先让 Commander 跑一次复盘或获客闭环。');
  $('#user-confirm-list').innerHTML = confirmations.length
    ? confirmations.map((item) => renderCommanderNoteItem(item)).join('')
    : renderEmpty('当前没有必须人工确认的事项。');
  $('#crm-handoff-list').innerHTML = handoffs.length
    ? handoffs.map(renderCrmHandoffCard).join('')
    : renderEmpty('还没有线索或任务；可以先运行“默认获客流程”。');
  $('#must-do-list').innerHTML = mustDo.length
    ? mustDo.map(renderWorkbenchActionCard).join('')
    : renderEmpty('当前没有必须马上处理的任务。');
  $('#high-intent-list').innerHTML = highIntent.length
    ? highIntent.map(renderWorkbenchActionCard).join('')
    : renderEmpty('还没有进入高意向的线索。');
  $('#exception-list').innerHTML = exceptions.length
    ? exceptions.map(renderWorkbenchActionCard).join('')
    : renderEmpty('当前没有异常任务或阻断项。');
  $('#auto-completed-list').innerHTML = autoCompleted.length
    ? autoCompleted.map((item) => renderCommanderNoteItem(item)).join('')
    : renderEmpty('系统完成的动作会自动沉淀在这里。');
  renderMobileMainlineDock();
  applyWorkbenchTaskFocus();
}

function renderActiveLeadRun() {
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const updatedMount = $('#lead-run-updated');
  if (updatedMount) {
    updatedMount.textContent = run
      ? `${leadRunStageLabel(run.current_stage)} · ${asArray(run.leads).length} 条线索`
      : '等待执行';
  }

  const view = run?.lead_acquisition_workbench_view || buildClientLeadAcquisitionWorkbenchView(run);
  renderLeadAcquisitionWorkbenchView(view, run);
  renderMobileMainlineDock();
}

function renderMobileMainlineDock() {
  const mount = $('#mobile-mainline-dock');
  if (!mount) return;
  if (CURRENT_PAGE !== 'commander') {
    mount.hidden = true;
    mount.innerHTML = '';
    document.body.classList.remove('has-mobile-mainline-dock');
    return;
  }
  const panel = currentHomePanel();
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const founderPulsePacket = run?.founder_pulse_packet || null;
  const contextHandoffBridge = run?.context_handoff_bridge || null;
  const leadThreadBrief = run?.lead_thread_brief || null;
  let html = '';

  if (!run) {
    const goal = String($('#commander-goal')?.value || state.commander.goal || '').trim();
    html = panel === 'workflow' ? `
      <div class="mobile-mainline-dock-card">
        <div class="mobile-mainline-dock-head">
          <span class="chip info">手机连续动作</span>
          <small>先创建执行</small>
        </div>
        <strong>${escapeHtml(goal ? '先把这轮目标变成当前执行' : '先创建当前获客执行')}</strong>
        <p>${escapeHtml(goal || '输入一句目标后，手机上也能直接进入“联系 → 回写 → 下一步”的主链。')}</p>
        <div class="mobile-mainline-dock-actions single">
          <button class="button primary" data-lead-run-action="create">按当前目标创建执行</button>
        </div>
      </div>
    ` : '';
  } else if (panel === 'today') {
    const card = run.today_contact_card || null;
    const resumePack = run.mainline_checkpoint_resume_pack || null;
    const checkpoint = pickLeadResumeCheckpointForPanel(resumePack, panel);
    const pulseItem = pickLeadFounderPulseItem(founderPulsePacket, 'today');
    const handoffAction = contextHandoffBridge?.what_to_open_next?.action_target || null;
    const nextStepTitle = run.writeback_confirmation_card?.next_task?.title
      || run.outcome_route_card?.recommended_action
      || run.next_recommended_action
      || '';
    const meta = contextHandoffBridge
      ? [
          contextHandoffBridge.handoff_expiry?.label || contextHandoffBridge.handoff_expiry_label || '',
          contextHandoffBridge.what_just_happened?.label || contextHandoffBridge.what_just_happened_label || '',
          contextHandoffBridge.what_not_to_repeat?.label || contextHandoffBridge.what_not_to_repeat_label || ''
        ].filter(Boolean)
      : pulseItem
      ? [
          pulseItem.urgency_label || '',
          pulseItem.lead_name || '',
          pulseItem.business_consequence ? truncateText(pulseItem.business_consequence, 24) : ''
        ].filter(Boolean)
      : checkpoint
      ? leadResumeCheckpointMeta(checkpoint)
      : [
          card?.route_label || '',
          card?.phone ? `电话 ${card.phone}` : '',
          leadThreadBrief?.thread_state?.label || leadThreadBrief?.thread_state_label || '',
          nextStepTitle ? `下一步 ${truncateText(nextStepTitle, 20)}` : ''
        ].filter(Boolean);
    html = `
      <div class="mobile-mainline-dock-card">
        <div class="mobile-mainline-dock-head">
          <span class="chip success">Today 连续链路</span>
          <small>${escapeHtml(leadRunStageLabel(run.current_stage))}</small>
        </div>
        <strong>${escapeHtml(contextHandoffBridge?.what_to_open_next?.label || pulseItem?.title || checkpoint?.title || leadThreadBrief?.title || (card?.phone ? (card.title || `先联系 ${card.lead_name || '当前线索'}`) : '打完后直接回写结果'))}</strong>
        <p>${escapeHtml(contextHandoffBridge?.summary || contextHandoffBridge?.what_is_pending_now?.summary || pulseItem?.why_now || pulseItem?.summary || checkpoint?.summary || checkpoint?.next_action || leadThreadBrief?.summary || card?.next_action || card?.reason || '先完成联系，再在同一条链路里回写结果并确认下一步。')}</p>
        ${meta.length ? `<div class="keyword-list compact">${meta.map((item) => `<code>${escapeHtml(item)}</code>`).join('')}</div>` : ''}
        <div class="mobile-mainline-dock-actions">
          ${handoffAction?.action
            ? renderLeadFounderPulseActionButton(handoffAction, {
              tone: 'primary',
              label: handoffAction?.label || '先回到当前动作'
            })
            : pulseItem?.jump_target?.action
            ? renderLeadFounderPulseActionButton(pulseItem.jump_target, {
              tone: 'primary',
              label: pulseItem.jump_target?.label || '先处理这一件'
            })
            : checkpoint
            ? renderLeadRunResumeActionButton(checkpoint.action, { tone: 'primary', checkpoint })
            : card?.phone
              ? `<button class="button primary" data-lead-run-action="call-lead" data-lead-id="${escapeHtml(card.lead_id || '')}">呼叫 ${escapeHtml(card.phone)}</button>`
              : `<button class="button primary" data-mainline-panel="today" data-mainline-scroll="today-inline-writeback-panel">去结果回写</button>`}
          ${checkpoint?.key !== 'writeback'
            ? `<button class="button secondary" data-mainline-panel="today" data-mainline-scroll="${run.writeback_confirmation_card ? 'today-next-step-timer-card' : 'today-inline-writeback-panel'}">${escapeHtml(run.writeback_confirmation_card ? '看下一步' : '看回写区')}</button>`
            : '<button class="button secondary" data-mainline-panel="today" data-mainline-scroll="today-inline-writeback-panel">看回写区</button>'}
        </div>
      </div>
    `;
  } else if (panel === 'results') {
    const queue = run.tomorrow_queue || null;
    const plan = run.next_batch_plan || null;
    const review = run.outcome_review || null;
    const resumePack = run.mainline_checkpoint_resume_pack || null;
    const checkpoint = pickLeadResumeCheckpointForPanel(resumePack, panel);
    const pulseItem = pickLeadFounderPulseItem(founderPulsePacket, 'results');
    const handoffAction = contextHandoffBridge?.what_to_open_next?.action_target || null;
    const meta = contextHandoffBridge
      ? [
          contextHandoffBridge.handoff_expiry?.label || contextHandoffBridge.handoff_expiry_label || '',
          contextHandoffBridge.what_just_happened?.label || contextHandoffBridge.what_just_happened_label || '',
          contextHandoffBridge.what_not_to_repeat?.label || contextHandoffBridge.what_not_to_repeat_label || ''
        ].filter(Boolean)
      : pulseItem
      ? [
          pulseItem.urgency_label || '',
          pulseItem.lead_name || '',
          pulseItem.business_consequence ? truncateText(pulseItem.business_consequence, 24) : ''
        ].filter(Boolean)
      : checkpoint
      ? leadResumeCheckpointMeta(checkpoint)
      : [
          queue?.candidates?.length ? `明日 ${queue.candidates.length} 条` : '',
          plan?.batch_size ? `下一批 ${plan.batch_size} 条` : '',
          leadThreadBrief?.next_best_touch?.label || leadThreadBrief?.next_best_touch_label || '',
          review?.prompt_learning?.prompt_learning_phase ? `Prompt ${leadPromptPhaseLabel(review.prompt_learning.prompt_learning_phase)}` : ''
        ].filter(Boolean);
    html = `
      <div class="mobile-mainline-dock-card">
        <div class="mobile-mainline-dock-head">
          <span class="chip warning">结果页继续动作</span>
          <small>${escapeHtml(leadRunStageLabel(run.current_stage))}</small>
        </div>
        <strong>${escapeHtml(contextHandoffBridge?.what_to_open_next?.label || pulseItem?.title || checkpoint?.title || leadThreadBrief?.title || plan?.summary || queue?.summary || review?.summary || '结果已经回来，继续安排下一步')}</strong>
        <p>${escapeHtml(contextHandoffBridge?.summary || contextHandoffBridge?.what_is_pending_now?.summary || pulseItem?.why_now || pulseItem?.summary || checkpoint?.summary || checkpoint?.next_action || leadThreadBrief?.summary || plan?.next_action || queue?.summary || review?.next_action || run.next_recommended_action || '先整理明天继续跟的人，再补下一批真实线索。')}</p>
        ${meta.length ? `<div class="keyword-list compact">${meta.map((item) => `<code>${escapeHtml(item)}</code>`).join('')}</div>` : ''}
        <div class="mobile-mainline-dock-actions">
          ${handoffAction?.action
            ? renderLeadFounderPulseActionButton(handoffAction, {
              tone: 'primary',
              label: handoffAction?.label || '先回到当前动作'
            })
            : pulseItem?.jump_target?.action
            ? renderLeadFounderPulseActionButton(pulseItem.jump_target, {
              tone: 'primary',
              label: pulseItem.jump_target?.label || '先处理这一件'
            })
            : checkpoint
            ? renderLeadRunResumeActionButton(checkpoint.action, { tone: 'primary', checkpoint })
            : `<button class="button primary" data-lead-run-action="${escapeHtml(review ? 'tomorrow-queue' : 'outcome')}">${escapeHtml(review ? '整理明日队列' : '先复盘结果')}</button>`}
          ${checkpoint?.key !== 'next_batch'
            ? plan ? `
              <button class="button secondary" data-lead-run-action="import-next-batch"
                data-next-batch-source="${escapeHtml(plan.source || '')}"
                data-next-batch-target="${escapeHtml(plan.target_profile || '')}"
                data-next-batch-batch-size="${escapeHtml(String(plan.batch_size || ''))}">补下一批线索</button>
            ` : '<button class="button secondary" data-lead-run-action="next-batch" data-mainline-panel="workflow" data-mainline-scroll="lead-run-next">生成下一批清单</button>'
            : '<button class="button secondary" data-mainline-panel="workflow" data-mainline-scroll="lead-run-outcome-review">看结果复盘</button>'}
        </div>
      </div>
    `;
  } else {
    const card = run.today_contact_card || null;
    const resumePack = run.mainline_checkpoint_resume_pack || null;
    const checkpoint = pickLeadResumeCheckpointForPanel(resumePack, panel);
    const pulseItem = pickLeadFounderPulseItem(founderPulsePacket, 'workflow');
    const handoffAction = contextHandoffBridge?.what_to_open_next?.action_target || null;
    const meta = contextHandoffBridge
      ? [
          contextHandoffBridge.handoff_expiry?.label || contextHandoffBridge.handoff_expiry_label || '',
          contextHandoffBridge.what_just_happened?.label || contextHandoffBridge.what_just_happened_label || '',
          contextHandoffBridge.what_not_to_repeat?.label || contextHandoffBridge.what_not_to_repeat_label || ''
        ].filter(Boolean)
      : pulseItem
      ? [
          pulseItem.urgency_label || '',
          pulseItem.lead_name || '',
          pulseItem.business_consequence ? truncateText(pulseItem.business_consequence, 24) : ''
        ].filter(Boolean)
      : checkpoint
      ? leadResumeCheckpointMeta(checkpoint)
      : [
          card?.lead_name || '',
          card?.route_label || '',
          leadThreadBrief?.next_best_touch?.label || leadThreadBrief?.next_best_touch_label || '',
          card?.phone ? `电话 ${card.phone}` : ''
        ].filter(Boolean);
    html = `
      <div class="mobile-mainline-dock-card">
        <div class="mobile-mainline-dock-head">
          <span class="chip info">当前执行主线</span>
          <small>${escapeHtml(leadRunStageLabel(run.current_stage))}</small>
        </div>
        <strong>${escapeHtml(contextHandoffBridge?.what_to_open_next?.label || pulseItem?.title || checkpoint?.title || leadThreadBrief?.title || card?.title || run.next_recommended_action || '先回到当前执行')}</strong>
        <p>${escapeHtml(contextHandoffBridge?.summary || contextHandoffBridge?.what_is_pending_now?.summary || pulseItem?.why_now || pulseItem?.summary || checkpoint?.summary || checkpoint?.next_action || leadThreadBrief?.summary || card?.reason || run.summary || '手机上优先保住联系、回写和下一步，不去翻分散面板。')}</p>
        ${meta.length ? `<div class="keyword-list compact">${meta.map((item) => `<code>${escapeHtml(item)}</code>`).join('')}</div>` : ''}
        <div class="mobile-mainline-dock-actions">
          ${handoffAction?.action
            ? renderLeadFounderPulseActionButton(handoffAction, {
              tone: 'primary',
              label: handoffAction?.label || '先回到当前动作'
            })
            : pulseItem?.jump_target?.action
            ? renderLeadFounderPulseActionButton(pulseItem.jump_target, {
              tone: 'primary',
              label: pulseItem.jump_target?.label || '先处理这一件'
            })
            : checkpoint
            ? renderLeadRunResumeActionButton(checkpoint.action, { tone: 'primary', checkpoint })
            : card?.phone
              ? `<button class="button primary" data-lead-run-action="call-lead" data-lead-id="${escapeHtml(card.lead_id || '')}">呼叫 ${escapeHtml(card.phone)}</button>`
              : `<button class="button primary" data-home-tab="today">打开今天处理</button>`}
          <button class="button secondary" data-home-tab="${escapeHtml(checkpoint?.key === 'next_batch' ? 'workflow' : 'today')}">${escapeHtml(checkpoint?.key === 'next_batch' ? '看当前执行' : '看今天处理')}</button>
        </div>
      </div>
    `;
  }

  mount.innerHTML = html;
  mount.hidden = !html;
  document.body.classList.toggle('has-mobile-mainline-dock', Boolean(html));
}

function pickLeadResumeCheckpointForPanel(pack, panel) {
  const checkpoints = asArray(pack?.checkpoints);
  if (!checkpoints.length) return null;
  if (panel === 'today') {
    return checkpoints.find((item) => item.key === 'today')
      || checkpoints.find((item) => item.key === 'writeback')
      || checkpoints[0];
  }
  if (panel === 'results') {
    return checkpoints.find((item) => item.key === 'next_batch')
      || checkpoints.find((item) => item.key === 'writeback')
      || checkpoints[0];
  }
  return checkpoints.find((item) => item.key === pack?.current_checkpoint_key) || checkpoints[0];
}

async function handleLeadRunAction(action, button = null) {
  await createWorkspaceIfNeeded();
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const actionPacket = resolveLeadRunActionPacket(run, action, button);
  if (action === 'create') {
    const payload = buildCommanderPayload();
    const result = await executeLeadAcquisitionRun(payload);
    syncActiveLeadRun(result.run);
    renderActiveLeadRun();
    setHomePanel('workflow');
    toast('获客执行已创建');
    await refresh();
    return;
  }
  if (action === 'import' || action === 'import-and-queue') {
    await importProspectsToLeadRun({ buildQueue: action === 'import-and-queue' });
    return;
  }
  if (action === 'discovery') {
    await planLeadRunDiscovery();
    return;
  }
  if (action === 'quality') {
    await reviewLeadRunQuality();
    return;
  }
  if (!run?.id) throw new Error('请先创建获客执行');
  if (action === 'public-source') {
    await runPublicSourceAdapter(run);
    return;
  }
  if (action === 'advance-today') {
    await advanceImportedLeadsToToday(run);
    return;
  }
  if (action === 'import-review') {
    await reviewLeadRunImportCandidate(run, button);
    return;
  }
  if (action === 'script') {
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/script`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id }
    });
    syncActiveLeadRun(result.run);
    renderActiveLeadRun();
    toast('话术已生成并回写到获客执行');
    return;
  }
  if (action === 'queue') {
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/followup-queue`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id, min_score: 40 }
    });
    syncActiveLeadRun(result.run);
    recordLeadRunQueueSkips(run.id, result);
    renderActiveLeadRun();
    const skipped = asArray(result.skipped_leads).length;
    const nextBatchBlocked = asArray(result.skipped_leads).filter((lead) => lead.reason === 'missing_next_batch_evidence').length;
    const memoryGuidedCreated = asArray(result.created_tasks).filter((task) => task.memory_guidance_match?.matched).length;
    const memoryText = memoryGuidedCreated ? `，其中 ${memoryGuidedCreated} 个按长期记忆优先处理` : '';
    toast(skipped
      ? nextBatchBlocked
        ? `已创建 ${asArray(result.created_tasks).length} 个跟进任务${memoryText}，${nextBatchBlocked} 条下一批线索需补需求/来源证据`
        : `已创建 ${asArray(result.created_tasks).length} 个跟进任务${memoryText}，${skipped} 条需先补联系方式`
      : `已创建 ${asArray(result.created_tasks).length} 个跟进任务${memoryText}`);
    await refresh();
    return;
  }
  if (action === 'outcome') {
    await reviewLeadRunOutcomes();
    return;
  }
  if (action === 'weekly-review') {
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/weekly-review`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id }
    });
    syncActiveLeadRun(result.run);
    renderActiveLeadRun();
    renderUserWorkbench();
    toast('轻量周复盘已生成');
    return;
  }
  if (action === 'human-feedback') {
    const targetKind = button?.dataset?.feedbackTargetKind || '';
    const targetId = button?.dataset?.feedbackTargetId || '';
    const targetLabel = button?.dataset?.feedbackTargetLabel || '';
    const feedbackType = button?.dataset?.feedbackType || 'useful';
    const impactSummary = button?.dataset?.feedbackImpact || '';
    if (!targetKind || !targetId) {
      throw new Error('请先指定要校准的来源、话术、异议回答或周简报对象');
    }
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/human-feedback`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        target_kind: targetKind,
        target_id: targetId,
        target_label: targetLabel,
        feedback_type: feedbackType,
        impact_summary: impactSummary
      }
    });
    syncActiveLeadRun(result.run);
    renderActiveLeadRun();
    renderUserWorkbench();
    toast(result.feedback_entry?.impact_summary || '老板轻反馈已写回主链');
    return;
  }
  if (action === 'next-loop') {
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/next-loop-plan`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id }
    });
    syncActiveLeadRun(result.run);
    renderActiveLeadRun();
    renderUserWorkbench();
    toast('下一轮获客行动已生成');
    return;
  }
  if (action === 'script-refresh') {
    const weakRouteType = button?.dataset?.weakRouteType || '';
    if (!weakRouteType) {
      throw new Error('请指定需要修正的微话术路由类型');
    }
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/script-refresh`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id, weak_route_type: weakRouteType }
    });
    syncActiveLeadRun(result.run);
    renderActiveLeadRun();
    renderUserWorkbench();
    const improvements = asArray(result.improvements || []);
    const improvementText = improvements.length > 0 ? `（${improvements[0]}）` : '';
    toast(`已为「${result.weak_route_type || weakRouteType}」生成改进建议${improvementText}，可在下次生成话术时采用`);
    return;
  }
  if (action === 'export-result-pack') {
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/delivery-result-pack?tenant_id=${encodeURIComponent(state.tenant.id)}`);
    downloadJsonFile(result.file_name || `${run.id}-delivery-result-pack.json`, result.delivery_result_pack || result);
    toast('客户交付版结果包已导出');
    return;
  }
  if (action === 'next-run-bootstrap') {
    if (!run.next_run_bootstrap_packet) {
      throw new Error('请先完成本轮复盘，系统才能收出口径稳定的下一轮起跑包');
    }
    const result = await executeLeadAcquisitionRun(buildLeadNextRunBootstrapPayload(run.next_run_bootstrap_packet, run));
    syncActiveLeadRun(result.run);
    renderCommanderHome();
    renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
    renderActiveLeadRun();
    renderUserWorkbench();
    renderWeeklyCampaign();
    renderCustomerTimeline();
    setHomePanel('results');
    toast('已按本轮结论启动下一轮获客执行');
    await refresh();
    return;
  }
  if (action === 'create_new_run_from_reactivation' || action === 'append_to_existing_run') {
    const leadId = button?.dataset?.leadId || '';
    if (!leadId) {
      throw new Error('请先选择要桥接回主链的老客户');
    }
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/reactivation-bridge`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        lead_id: leadId,
        action,
        target_run_id: button?.dataset?.targetRunId || run.id
      }
    });
    const targetRun = result.target_run || result.run;
    syncActiveLeadRun(targetRun);
    renderCommanderHome();
    renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
    renderActiveLeadRun();
    renderUserWorkbench();
    renderWeeklyCampaign();
    renderCustomerTimeline();
    setHomePanel('results');
    toast(action === 'create_new_run_from_reactivation'
      ? '已按这条老客户启动新的获客执行'
      : '已把这条老客户追加回当前执行');
    await refresh();
    return;
  }
  if (action === 'next-batch') {
    await planLeadRunNextBatch();
    return;
  }
  if (action === 'next-batch-launch') {
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/next-batch-launch`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id }
    });
    const sourceRun = result.source_run || result.run || null;
    if (sourceRun) {
      syncActiveLeadRun(sourceRun);
      renderActiveLeadRun();
      renderUserWorkbench();
    }
    toast(result.launched_run?.id ? `已启动下一批：${result.launched_run.id}` : '已启动下一批');
    return;
  }
  if (action === 'open-launched-run') {
    const launchedRunId = run.next_batch_launch_writeback?.launched_run_id || '';
    if (!launchedRunId) {
      throw new Error('当前没有可打开的下一批 run');
    }
    const launchedRun = await api(
      `/api/lead-acquisition-runs/${encodeURIComponent(launchedRunId)}?tenant_id=${encodeURIComponent(state.tenant.id)}&workspace_id=default`
    );
    syncActiveLeadRun(launchedRun);
    renderActiveLeadRun();
    renderUserWorkbench();
    toast('已打开下一轮获客执行');
    return;
  }
  if (action === 'collect-more-evidence') {
    setHomePanel('today');
    renderUserWorkbench();
    toast('请先补齐收入动作回写和执行回执，再启动下一批');
    return;
  }
  if (action === 'import-next-batch') {
    focusLeadRunImportBridge({
      source: button?.dataset?.nextBatchSource || run.next_batch_plan?.source || '',
      targetProfile: button?.dataset?.nextBatchTarget || run.next_batch_plan?.target_profile || '',
      batchSize: button?.dataset?.nextBatchBatchSize || run.next_batch_plan?.batch_size || 0,
      brief: run.next_batch_plan?.next_batch_collection_brief || null
    });
    toast('已定位到下一批导入区');
    return;
  }
  if (action === 'tomorrow-queue') {
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/tomorrow-queue`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id }
    });
    syncActiveLeadRun(result.run);
    renderActiveLeadRun();
    renderUserWorkbench();
    toast(`明日队列已整理，新增 ${asArray(result.created_tasks).length} 个任务`);
    await refresh();
    return;
  }
  if (action === 'refresh') {
    const refreshed = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/refresh-summary`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id }
    });
    syncActiveLeadRun(refreshed);
    renderActiveLeadRun();
    renderUserWorkbench();
    toast('获客执行已刷新');
    return;
  }
  if (action === 'approval-action') {
    const approvalRequestId = run.approval_safe_action_bridge?.approval_request_id || '';
    if (!approvalRequestId) {
      throw new Error('缺少审批请求，刷新后再试');
    }
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/approval-action`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        approval_request_id: approvalRequestId,
        decision: 'approved',
        actor_id: 'founder'
      }
    });
    if (result.run) {
      syncActiveLeadRun(result.run);
      renderActiveLeadRun();
      renderUserWorkbench();
      toast('已批准，首触达行动继续推进');
    }
    return;
  }
  if (action === 'queue-ai-outbound-approval' || action === 'queue-reactivation-approval') {
    const approvalPayload = resolveLeadRunApprovalPayload(run, action, button);
    if (!approvalPayload?.endpoint) {
      throw new Error(action === 'queue-reactivation-approval' ? '当前还没有可提交审批的唤醒草案' : '当前还没有可提交审批的 AI 外呼草案');
    }
    const result = await api(approvalPayload.endpoint, {
      method: 'POST',
      body: {
        ...(approvalPayload.body || {}),
        tenant_id: state.tenant.id,
        agent_id: 'voice_agent'
      }
    });
    const approvalId = result.approval_request?.id || '';
    if (result.run) {
      syncActiveLeadRun(result.run);
      renderActiveLeadRun();
      renderUserWorkbench();
    }
    toast(result.status === 'blocked_pending_approval'
      ? approvalId
        ? `已提交审批请求：${approvalId}`
        : '已提交审批请求'
      : '外呼已进入队列');
    return;
  }
  if (action === 'resume-ai-outbound-execution') {
    const bridge = resolveLeadRunAiOutboundExecutionBridge(run);
    const resumePayload = bridge?.resume_payload || null;
    if (!resumePayload?.endpoint) throw new Error('当前没有可继续推进的已审批 AI 外呼');
    const resumed = await api(resumePayload.endpoint, {
      method: 'POST',
      body: {
        ...(resumePayload.body || {}),
        tenant_id: state.tenant.id,
        workspace_id: run.workspace_id || 'default',
        agent_id: 'voice_agent'
      }
    });
    const refreshedRun = resumed.output?.run || bridge?.run || null;
    if (refreshedRun) {
      syncActiveLeadRun(refreshedRun);
      renderActiveLeadRun();
      renderUserWorkbench();
    }
    toast(resumed.output?.call_session?.id ? 'AI 外呼已推进到执行队列' : '已继续推进已审批外呼');
    return;
  }
  if (action === 'focus-task') {
    if (startLeadRunCallFromPacket(run, actionPacket)) return;
    const taskId = button?.dataset?.taskId || actionPacket?.taskId || run.writeback_confirmation_card?.primary_action?.task_id || '';
    const microScript = run.writeback_confirmation_card?.micro_script || run.today_contact_card?.micro_script || null;
    setWorkbenchTaskFocus(taskId, {
      title: button?.dataset?.focusTitle || actionPacket?.title || run.writeback_confirmation_card?.primary_action?.title || '下一步任务',
      leadName: button?.dataset?.focusLead || actionPacket?.leadName || run.writeback_confirmation_card?.lead_name || '',
      reason: button?.dataset?.focusReason || actionPacket?.reason || run.writeback_confirmation_card?.primary_action?.reason || '结果已回写，继续处理下一步任务。',
      nextAction: actionPacket?.nextAction || run.writeback_confirmation_card?.next_action || '',
      microScript,
      writebackPreview: actionPacket?.writebackPreview || deriveLeadWritebackPreview(null, actionPacket?.writebackStarterTemplate || null)
    });
    setHomePanel('today');
    renderUserWorkbench();
    toast(taskId ? '已定位到下一步任务' : '已切到今天处理');
    return;
  }
  if (action === 'call-first') {
    if (startLeadRunCallFromPacket(run, actionPacket)) return;
    const lead = selectLeadForImmediateCall(run);
    if (!lead) throw new Error('当前执行还没有可呼叫线索');
    preloadLeadRunCall(run, lead, buildLeadRunCallContext(run, lead));
    return;
  }
  if (action === 'outreach-writeback') {
    if (!run?.id) throw new Error('请先创建获客执行');
    const outcomeKey = button?.dataset?.writebackKey || 'interested';
    const outcomeLabel = button?.dataset?.writebackLabel || '已回写';
    const packId = button?.dataset?.packId || button?.dataset?.leadId || '';
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/prospect-outreach-writeback`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        pack_id: packId || run.primary_prospect_outreach_pack?.pack_id || run.primary_prospect_outreach_pack?.lead_id || '',
        lead_id: button?.dataset?.leadId || run.primary_prospect_outreach_pack?.lead_id || '',
        outcome_key: outcomeKey
      }
    });
    const mergedRun = await refreshProspectOutreachWorkbenchOnRun(result.run || run);
    syncActiveLeadRun(mergedRun);
    renderActiveLeadRun();
    renderUserWorkbench();
    toast(`已回写「${outcomeLabel}」，Agent 会刷新下一步建议`);
    await refresh();
    return;
  }
  if (action === 'outreach-live-demo-acceptance') {
    if (!run?.id) throw new Error('请先创建获客执行');
    const form = button?.closest?.('form.prospect-outreach-live-attestation-form') || null;
    const attestationItems = asArray(run.prospect_outreach_live_demo_attestation_items).length
      ? run.prospect_outreach_live_demo_attestation_items
      : PROSPECT_OUTREACH_LIVE_DEMO_ATTESTATION_ITEMS_FALLBACK;
    const attestations = {};
    attestationItems.forEach((item) => {
      const key = String(item?.key || '').trim();
      if (!key) return;
      const input = form?.querySelector(`[name="attestation_${CSS.escape(key)}"]`);
      attestations[key] = input?.checked === true;
    });
    const operatorFromForm = form?.querySelector('[name="operator_name"]')?.value?.trim() || '';
    const browserConfirmed = form?.querySelector('[name="browser_session_confirmed"]')?.checked === true;
    const operator = operatorFromForm || window.prompt('验收人姓名', '') || '';
    if (!operator) throw new Error('请填写验收人姓名');
    const missing = attestationItems.filter((item) => !attestations[item.key]).map((item) => item.label);
    if (missing.length) {
      throw new Error(`请勾选全部 B 层验收项：${missing.join('、')}`);
    }
    if (!browserConfirmed) {
      throw new Error('请确认已在真机 Chrome 完成浏览器会话绑定或勾选「已确认 Chrome 会话」');
    }
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/prospect-outreach-live-demo-acceptance`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        operator_name: operator,
        browser_session_confirmed: true,
        attestations
      }
    });
    const acceptance = result.prospect_outreach_live_demo_acceptance || result.run?.prospect_outreach_live_demo_acceptance || null;
    const mergedRun = await refreshProspectOutreachWorkbenchOnRun(result.run || result);
    syncActiveLeadRun(mergedRun);
    renderActiveLeadRun();
    renderUserWorkbench();
    if (acceptance?.status === 'accepted') {
      toast(`B 层真机验收已记账（${operator}）${acceptance.force_accepted ? ' · 开发强制' : ''}`);
    } else {
      const warnings = asArray(acceptance?.warnings).join('；') || '请修正 run 信号或 attestation 后重试';
      toast(`B 层验收待通过：${warnings}`);
    }
    await refresh();
    return;
  }
  if (action === 'outreach-channel-receipt') {
    if (!run?.id) throw new Error('请先创建获客执行');
    const packId = button?.dataset?.packId || button?.dataset?.leadId || '';
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/prospect-outreach-channel-adapter`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        pack_id: packId || run.primary_prospect_outreach_pack?.pack_id || run.primary_prospect_outreach_pack?.lead_id || '',
        receipt_status: 'manual_fallback_required',
        failure_reason: button?.dataset?.receiptNote || '已复制话术并手动发送'
      }
    });
    const mergedRun = await refreshProspectOutreachWorkbenchOnRun(result.run || run);
    syncActiveLeadRun(mergedRun);
    renderActiveLeadRun();
    renderUserWorkbench();
    toast('已记录手动发送回执，触达状态已更新');
    await refresh();
    return;
  }
  if (action === 'outreach-contact') {
    const pack = run?.primary_prospect_outreach_pack
      || run?.lead_acquisition_workbench_view?.primary_prospect_outreach_pack
      || actionPacket?.prospectOutreachPack
      || null;
    const opening = button?.dataset?.outreachOpening
      || pack?.outreach_script?.opening
      || run?.lead_acquisition_workbench_view?.current_action?.script_excerpt
      || run?.today_contact_card?.script
      || '';
    const channelLabel = button?.dataset?.outreachChannel
      || pack?.contact_plan?.recommended_channel_label
      || '推荐渠道';
    if (opening && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(opening);
      toast(`已复制${channelLabel}开口话术，请到对应平台发送`);
    } else if (opening) {
      toast(`建议开口：${truncateText(opening, 72)}`);
    } else {
      toast(`请通过${channelLabel}联系当前对象`);
    }
    setHomePanel('today');
    renderUserWorkbench();
    return;
  }
  if (action === 'call-lead') {
    if (startLeadRunCallFromPacket(run, actionPacket)) return;
    const leadId = button?.dataset?.leadId || actionPacket?.leadId || run.today_contact_card?.lead_id || '';
    const lead = asArray(run.leads).find((item) => String(item.id || '') === String(leadId)) || selectLeadForImmediateCall(run);
    if (!lead) throw new Error('当前执行还没有可呼叫线索');
    preloadLeadRunCall(run, lead, buildLeadRunCallContext(run, lead, run.today_contact_card));
    return;
  }
  if (action === 'today') {
    setHomePanel('today');
    toast('已切到今天处理');
  }
}

function normalizeLeadRunActionPacket(packet = null) {
  if (!packet || typeof packet !== 'object') return null;
  const launchPayload = packet.launch_payload || null;
  const body = launchPayload?.body || {};
  return {
    action: packet.action || '',
    label: packet.label || '',
    title: packet.title || '',
    reason: packet.reason || body.lead_run_reason || '',
    leadId: packet.lead_id || body.lead_id || '',
    taskId: packet.task_id || body.task_id || body.lead_run_task_id || '',
    leadName: packet.lead_name || body.lead_run_lead_name || '',
    nextAction: packet.next_action || body.lead_run_next_action || '',
    launchPayload,
    writebackStarterTemplate: packet.writeback_starter_template || null,
    writebackPreview: packet.writeback_preview || body.lead_run_writeback_preview || null,
    callReadinessPack: packet.call_readiness_pack || body.lead_run_call_readiness_pack || packet.writeback_starter_template?.call_readiness_pack || null,
    liveCallGuidancePack: packet.live_call_guidance_pack || body.lead_run_live_call_guidance_pack || packet.writeback_starter_template?.live_call_guidance_pack || null,
    launchReady: Boolean(packet.launch_ready || launchPayload)
  };
}

function matchLeadRunActionPacket(packet, button = null) {
  if (!packet) return false;
  const buttonLeadId = String(button?.dataset?.leadId || '');
  const buttonTaskId = String(button?.dataset?.taskId || '');
  if (buttonLeadId && packet.leadId && String(packet.leadId) !== buttonLeadId) return false;
  if (buttonTaskId && packet.taskId && String(packet.taskId) !== buttonTaskId) return false;
  return true;
}

function resolveLeadRunActionPacket(run, action, button = null) {
  if (!run) return null;
  const candidates = [];
  const pushPacket = (packet, options = {}) => {
    const normalized = normalizeLeadRunActionPacket({
      ...packet,
      ...(options.lead_name ? { lead_name: options.lead_name } : {}),
      ...(options.next_action ? { next_action: options.next_action } : {})
    });
    if (!normalized) return;
    if (normalized.action === action || (action === 'call-first' && normalized.launchReady)) {
      candidates.push(normalized);
    }
  };

  pushPacket(run.today_workbench?.primary_action);
  pushPacket(run.today_workbench?.writeback_handoff?.primary_action, {
    lead_name: run.today_workbench?.writeback_handoff?.lead_name || '',
    next_action: run.today_workbench?.writeback_handoff?.summary || ''
  });
  pushPacket(run.writeback_confirmation_card?.primary_action, {
    lead_name: run.writeback_confirmation_card?.lead_name || '',
    next_action: run.writeback_confirmation_card?.next_action || ''
  });
  pushPacket({
    action: run.today_contact_card?.contact_action?.action || 'call-lead',
    label: run.today_contact_card?.contact_action?.label || '',
    title: run.today_contact_card?.title || '',
    reason: run.today_contact_card?.reason || run.today_contact_card?.summary || '',
    lead_id: run.today_contact_card?.lead_id || '',
    task_id: run.today_contact_card?.task_id || '',
    lead_name: run.today_contact_card?.lead_name || '',
    next_action: run.today_contact_card?.next_action || '',
    launch_ready: Boolean(run.today_contact_card?.launch_payload),
    launch_payload: run.today_contact_card?.launch_payload || null,
    writeback_starter_template: run.today_contact_card?.writeback_starter_template || null,
    writeback_preview: deriveLeadWritebackPreview(null, run.today_contact_card?.writeback_starter_template || null)
  });
  pushPacket({
    action: run.today_workbench?.today_carryover?.phone ? 'call-lead' : 'today',
    label: run.today_workbench?.today_carryover?.phone ? '呼叫这条线索' : '打开今天处理',
    title: run.today_workbench?.today_carryover?.title || '',
    reason: run.today_workbench?.today_carryover?.summary || '',
    lead_id: run.today_workbench?.today_carryover?.lead_id || '',
    task_id: run.today_workbench?.today_carryover?.task_id || '',
    lead_name: run.today_workbench?.today_carryover?.lead_name || ''
  });

  return candidates.find((packet) => matchLeadRunActionPacket(packet, button) && packet.launchReady)
    || candidates.find((packet) => matchLeadRunActionPacket(packet, button))
    || candidates.find((packet) => packet.launchReady)
    || candidates[0]
    || null;
}

function resolveLeadRunApprovalPayload(run, action, button = null) {
  if (!run) return null;
  const leadId = String(button?.dataset?.leadId || '');
  if (action === 'queue-ai-outbound-approval') {
    const draft = run.today_contact_card?.ai_outbound_approved_draft || null;
    if (leadId && String(draft?.lead_id || '') !== leadId) return null;
    return draft?.approval_payload || null;
  }
  if (action === 'queue-reactivation-approval') {
    const candidates = asArray(run.customer_reactivation_packet?.candidates);
    const matched = candidates.find((item) => !leadId || String(item.lead_id || '') === leadId)
      || run.customer_reactivation_packet?.selected_candidate
      || null;
    return matched?.approval_payload || null;
  }
  return null;
}

function resolveLeadRunAiOutboundExecutionBridge(run) {
  if (!run) return null;
  return run.today_contact_card?.ai_outbound_approved_draft?.execution_bridge
    || run.today_contact_card?.ai_outbound_execution_bridge
    || run.ai_outbound_execution_bridge
    || run.result_feedback_packet?.ai_outbound_execution_bridge
    || null;
}

function buildLeadRunCallContextFromLaunchPayload(run, lead, launchPayload, writebackStarterTemplate = null, fallback = {}) {
  const body = launchPayload?.body || {};
  return {
    runId: body.lead_run_id || run?.id || fallback.runId || '',
    leadId: lead?.id || body.lead_id || fallback.leadId || '',
    leadName: body.lead_run_lead_name || fallback.leadName || leadDisplayName(lead),
    phone: lead?.contact_phone || body.phone || fallback.phone || '',
    taskId: body.lead_run_task_id || body.task_id || fallback.taskId || '',
    contextKind: body.lead_run_context_kind || fallback.contextKind || 'lead_run_contact',
    routeLabel: body.lead_run_route_label || fallback.routeLabel || '',
    outcomeTag: body.lead_run_outcome_tag || fallback.outcomeTag || '',
    reason: body.lead_run_reason || fallback.reason || '这是当前获客执行推荐优先联系的线索。',
    nextAction: body.lead_run_next_action || fallback.nextAction || '通话结束后用一键结果回写，并让系统生成明天继续跟进的人。',
    callReadinessPack: body.lead_run_call_readiness_pack || writebackStarterTemplate?.call_readiness_pack || fallback.callReadinessPack || null,
    liveCallGuidancePack: body.lead_run_live_call_guidance_pack || writebackStarterTemplate?.live_call_guidance_pack || fallback.liveCallGuidancePack || null,
    script: body.script || '',
    launchPayload,
    writebackStarterTemplate,
    writebackPreview: body.lead_run_writeback_preview || fallback.writebackPreview || deriveLeadWritebackPreview(null, writebackStarterTemplate)
  };
}

function startLeadRunCallFromPacket(run, packet = null) {
  if (!packet?.launchPayload?.body) return false;
  const body = packet.launchPayload.body;
  const todayCard = run?.today_contact_card || null;
  let lead = asArray(run?.leads).find((item) => String(item.id || '') === String(packet.leadId || body.lead_id || '')) || null;
  if (!lead && body.phone) {
    lead = {
      id: packet.leadId || body.lead_id || '',
      contact_phone: body.phone || '',
      contact_name: packet.leadName || body.lead_run_lead_name || '',
      contact_email: '',
      platform_account: ''
    };
  }
  if (!lead?.contact_phone) return false;
  const matchedTodayCard = todayCard
    && (
      String(todayCard.lead_id || '') === String(lead.id || '')
      || String(todayCard.task_id || '') === String(packet.taskId || body.lead_run_task_id || body.task_id || '')
    )
      ? todayCard
      : null;
  preloadLeadRunCall(run, lead, buildLeadRunCallContextFromLaunchPayload(run, lead, packet.launchPayload, packet.writebackStarterTemplate, {
    ...packet,
    callReadinessPack: packet.callReadinessPack || matchedTodayCard?.call_readiness_pack || null,
    liveCallGuidancePack: packet.liveCallGuidancePack || matchedTodayCard?.live_call_guidance_pack || null
  }));
  return true;
}

async function handleRepairReviewAction(button) {
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (!run?.id) throw new Error('请先创建获客执行');
  const action = button.dataset.repairReviewAction || '';
  const taskId = button.dataset.taskId || '';
  if (action === 'today') {
    setWorkbenchTaskFocus(taskId, {
      title: button.dataset.focusTitle || '',
      leadName: button.dataset.focusLead || '',
      reason: button.dataset.focusReason || '',
      nextAction: button.dataset.focusNext || ''
    });
    setHomePanel('today');
    renderUserWorkbench();
    toast(taskId ? '已切到今天处理并定位到该任务' : '已切到今天处理');
    return;
  }
  if (action === 'call-lead') {
    const leadId = button.dataset.leadId || '';
    const lead = asArray(run.leads).find((item) => item.id === leadId);
    if (!lead) throw new Error('当前执行里找不到这条线索');
    preloadLeadRunCall(run, lead, buildRepairLeadCallContext(run, lead));
  }
}

function selectLeadForImmediateCall(run) {
  const leads = asArray(run.leads);
  const byId = new Map(leads.map((lead) => [lead.id, lead]));
  const cardLead = byId.get(run?.today_contact_card?.lead_id);
  if (cardLead?.contact_phone) return cardLead;
  const qualityLead = asArray(run.quality_review?.top_leads)
    .map((item) => byId.get(item.lead_id))
    .find((lead) => lead?.contact_phone);
  if (qualityLead) return qualityLead;
  return [...leads]
    .filter((lead) => lead.contact_phone)
    .sort((a, b) => Number(b.score_total || 0) - Number(a.score_total || 0))[0]
    || leads.find((lead) => lead.contact_phone)
    || null;
}

function setWorkbenchTaskFocus(taskId, context = {}) {
  state.ui.focusedWorkbenchTaskId = taskId || null;
  state.ui.focusedWorkbenchTaskContext = taskId ? context : null;
  state.ui.pendingWorkbenchTaskScroll = Boolean(taskId);
}

function isFocusedWorkbenchTask(taskId) {
  return Boolean(taskId) && Boolean(state.ui.focusedWorkbenchTaskId) && String(taskId) === String(state.ui.focusedWorkbenchTaskId);
}

function applyWorkbenchTaskFocus() {
  const taskId = state.ui.focusedWorkbenchTaskId;
  if (!taskId) return;
  if (currentHomePanel() !== 'today') return;
  const target = Array.from(document.querySelectorAll('[data-workbench-task-id]'))
    .find((node) => String(node.dataset.workbenchTaskId || '') === String(taskId));
  if (!target) {
    state.ui.pendingWorkbenchTaskScroll = false;
    return;
  }
  if (!state.ui.pendingWorkbenchTaskScroll) return;
  state.ui.pendingWorkbenchTaskScroll = false;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function buildRepairLeadCallContext(run, lead) {
  const review = run?.repair_requeue_review || {};
  return {
    runId: run?.id || '',
    leadId: lead?.id || review.lead_id || '',
    leadName: review.lead_name || leadDisplayName(lead),
    phone: lead?.contact_phone || '',
    taskId: review.task?.id || '',
    contextKind: 'repair_requeue',
    reason: review.admission_reason || review.summary || '补齐阻断信息后，已进入今天可联系队列。',
    nextAction: review.next_action || '先按话术联系，通话后回写结果并接下一步。'
  };
}

function buildLeadRunCallContext(run, lead, contactCard = null) {
  const task = asArray(run?.tasks).find((item) => item.id === contactCard?.task_id)
    || asArray(run?.tasks).find((item) => item.object_id === lead?.id || item.run_metadata?.lead_id === lead?.id);
  const isCarryover = contactCard?.carryover_source === 'tomorrow_queue';
  return {
    runId: run?.id || '',
    leadId: lead?.id || '',
    leadName: leadDisplayName(lead),
    phone: lead?.contact_phone || '',
    taskId: task?.id || '',
    contextKind: isCarryover ? 'today_carryover' : 'lead_run_contact',
    routeLabel: contactCard?.route_label || '',
    outcomeTag: contactCard?.outcome_tag || '',
    reason: contactCard?.reason || lead?.run_metadata?.admission_reason || lead?.run_metadata?.recommendation_reason || lead?.score_reason || '这是当前获客执行推荐优先联系的线索。',
    nextAction: contactCard?.next_action || '通话结束后用一键结果回写，并让系统生成明天继续跟进的人。',
    callReadinessPack: contactCard?.call_readiness_pack || contactCard?.launch_payload?.body?.lead_run_call_readiness_pack || contactCard?.writeback_starter_template?.call_readiness_pack || null,
    liveCallGuidancePack: contactCard?.live_call_guidance_pack || contactCard?.launch_payload?.body?.lead_run_live_call_guidance_pack || contactCard?.writeback_starter_template?.live_call_guidance_pack || null,
    script: contactCard?.launch_payload?.body?.script || '',
    launchPayload: contactCard?.launch_payload || null,
    writebackStarterTemplate: contactCard?.writeback_starter_template || null,
    writebackPreview: contactCard?.launch_payload?.body?.lead_run_writeback_preview || deriveLeadWritebackPreview(null, contactCard?.writeback_starter_template || null)
  };
}

function preloadLeadRunCall(run, lead, context = null) {
  $('#call-phone').value = lead.contact_phone || '';
  const scriptField = document.querySelector('#call-outbound-form textarea[name="script"]');
  const launchScript = String(context?.script || context?.launchPayload?.body?.script || '').trim();
  if (scriptField) scriptField.value = launchScript || run.script || `先确认 ${leadDisplayName(lead)} 的需求和可沟通时间。`;
  const leadSelect = $('#call-lead-select');
  if (leadSelect) leadSelect.value = lead.id || '';
  if (context) {
    state.ui.focusedCallContext = context;
    state.ui.focusedCallSessionId = null;
    renderCallContextSurfaces();
  }
  toast(lead.contact_phone ? '已把线索填入顶部呼叫栏' : '该线索缺少电话，请先补充联系方式');
}

async function planLeadRunDiscovery() {
  await createWorkspaceIfNeeded();
  let run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (!run?.id) {
    const payload = buildCommanderPayload();
    run = await api('/api/lead-acquisition-runs', {
      method: 'POST',
      body: buildLeadAcquisitionPayload(payload)
    });
    syncActiveLeadRun(run);
  }
  const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/discovery-plan`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });
  syncActiveLeadRun(result.run);
  renderActiveLeadRun();
  renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
  toast('找线索清单已生成，可按清单收集真实名单后导入');
  await refresh();
}

async function reviewLeadRunQuality() {
  await createWorkspaceIfNeeded();
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (!run?.id) throw new Error('请先创建获客执行');
  if (!asArray(run.leads).length) throw new Error('请先导入至少 1 条真实线索');
  const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/quality-review`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });
  syncActiveLeadRun(result.run);
  renderActiveLeadRun();
  renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
  renderUserWorkbench();
  toast('线索质量检查已完成');
  await refresh();
}

async function reviewLeadRunImportCandidate(run, button) {
  await createWorkspaceIfNeeded();
  if (!run?.id) throw new Error('请先创建获客执行');
  const candidateId = String(button?.dataset?.candidateId || '').trim();
  const decisionAction = String(button?.dataset?.importReviewAction || '').trim();
  if (!candidateId || !decisionAction) throw new Error('缺少候选项或处理动作，无法执行导入前判断');
  button.disabled = true;
  try {
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/import-review`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        candidate_id: candidateId,
        decision_action: decisionAction
      }
    });
    syncActiveLeadRun(result.run);
    const packet = result.import_review_packet || result.run?.import_review_packet || null;
    $('#lead-run-import-hint').textContent = packet?.next_action || result.decision?.explanation || '导入前判断已更新。';
    renderActiveLeadRun();
    renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
    renderUserWorkbench();
    const toastCopy = {
      import: '候选已通过并导入当前 run',
      merge_then_import: '候选已合并到现有线索',
      accept_repair_then_import: '已接受最小联系人修复并导入当前 run',
      hold_for_repair: '候选已暂挂到修复列表',
      hold_for_manual_repair: '候选已转到人工修复列表',
      reject: '候选已从当前 run 的导入候选里拒绝'
    }[decisionAction] || '导入前判断已更新';
    toast(toastCopy);
    await refresh();
  } finally {
    button.disabled = false;
  }
}

async function reviewLeadRunOutcomes() {
  await createWorkspaceIfNeeded();
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (!run?.id) throw new Error('请先创建获客执行');
  const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/outcome-review`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });
  syncActiveLeadRun(result.run);
  renderActiveLeadRun();
  renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
  renderUserWorkbench();
  renderWeeklyCampaign();
  toast('获客结果复盘已生成');
  await refresh();
}

async function planLeadRunNextBatch() {
  await createWorkspaceIfNeeded();
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (!run?.id) throw new Error('请先创建获客执行');
  const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/next-batch-plan`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });
  syncActiveLeadRun(result.run);
  renderActiveLeadRun();
  renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
  const textarea = $('#lead-run-import-lines');
  if (textarea) textarea.focus();
  toast('下一批真实线索采集清单已生成');
  await refresh();
}

function focusLeadRunImportBridge(options = {}) {
  setHomePanel('workflow');
  const textarea = $('#lead-run-import-lines');
  const source = String(options.source || '').trim();
  const targetProfile = String(options.targetProfile || '').trim();
  const batchSize = Math.max(0, Number(options.batchSize || 0) || 0);
  const brief = options.brief || null;
  const includePatterns = asArray(brief?.include_patterns).slice(0, 2);
  const excludePatterns = asArray(brief?.exclude_patterns).slice(0, 1);
  const keywords = asArray(brief?.collection_keywords).slice(0, 3);
  const hint = [
    batchSize ? `下一批先补 ${batchSize} 条真实线索` : '下一批先补真实线索',
    source ? `来源优先「${source}」` : '',
    targetProfile ? `目标画像：${targetProfile}` : '',
    includePatterns[0]?.pattern ? `优先补：${includePatterns.map((item) => item.pattern).filter(Boolean).join('、')}` : '',
    excludePatterns[0]?.pattern ? `先排除：${excludePatterns.map((item) => item.pattern).filter(Boolean).join('、')}` : '',
    keywords.length ? `可搜：${keywords.join('、')}` : '',
    '补完后直接点“导入并生成跟进队列”。'
  ].filter(Boolean).join('；');
  if ($('#lead-run-import-hint')) $('#lead-run-import-hint').textContent = hint;
  if (textarea) {
    textarea.focus();
    textarea.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function recordLeadRunQueueSkips(runId, queueResult) {
  state.data.leadRunQueueSkips = {
    run_id: runId,
    created_count: asArray(queueResult?.created_tasks).length,
    skipped_leads: asArray(queueResult?.skipped_leads)
  };
}

async function repairLeadRunQueueItem(button) {
  await createWorkspaceIfNeeded();
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (!run?.id) throw new Error('请先创建获客执行');
  const leadId = button.dataset.leadRunRepairQueue;
  if (!leadId) throw new Error('缺少线索标识，无法修复入队阻断');
  const repairReason = String(button.dataset.repairReason || '');
  const card = button.closest('.gate-card');
  const contactValue = String(card?.querySelector('[data-lead-run-contact-input]')?.value || '').trim();
  const textarea = card?.querySelector('textarea[data-lead-run-evidence-input]');
  const evidence = String(textarea?.value || '').trim();
  const repairHint = String(button.dataset.repairHint || '').trim();
  if (!contactValue && !evidence) {
    throw new Error(repairHint || (repairReason === 'missing_contact' ? '请先补一个电话、微信或邮箱' : '请先补一句最近需求或来源证据'));
  }
  button.disabled = true;
  try {
    const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/lead-repair-queue`, {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        lead_id: leadId,
        contact_value: contactValue,
        import_message: evidence,
        source_evidence: evidence,
        min_score: Number(run.queue_gate_review?.min_score || 40)
      }
    });
    syncActiveLeadRun(result.run);
    recordLeadRunQueueSkips(run.id, result);
    const skippedCount = asArray(result.skipped_leads).length;
    $('#lead-run-import-hint').textContent = skippedCount
      ? `已修复并重建队列，但仍有 ${skippedCount} 条线索未满足入队条件。`
      : `已修复并重建队列，${asArray(result.created_tasks).length} 条线索已进入今日跟进。`;
    renderActiveLeadRun();
    renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
    renderUserWorkbench();
    toast(skippedCount
      ? `已修复并重建队列，仍有 ${skippedCount} 条线索待补齐`
      : `已修复并重建队列，新增 ${asArray(result.created_tasks).length} 个跟进任务`);
    await refresh();
  } finally {
    button.disabled = false;
  }
}

async function importProspectsToLeadRun({ buildQueue = false } = {}) {
  const lines = $('#lead-run-import-lines')?.value || '';
  const prospects = parseProspectLines(lines);
  const preview = buildProspectImportPreview(prospects);
  if (!prospects.length) {
    throw new Error('请先粘贴至少 1 条真实线索，每行包含公司/姓名/电话/需求中的至少两项');
  }
  await createWorkspaceIfNeeded();
  let run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (!run?.id) {
    const payload = buildCommanderPayload();
    const created = await executeLeadAcquisitionRun(payload);
    run = created.run;
    syncActiveLeadRun(run);
  }
  const added = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/leads`, {
    method: 'POST',
    body: {
      tenant_id: state.tenant.id,
      leads: prospects
    }
  });
  run = added.run || run;
  const quality = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/quality-review`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });
  run = quality.run || run;
  const scriptResult = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/script`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });
  run = scriptResult.run || run;
  let queueResult = null;
  if (buildQueue) {
    const queue = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/followup-queue`, {
      method: 'POST',
      body: { tenant_id: state.tenant.id, min_score: 40 }
    });
    queueResult = queue;
    run = queue.run || run;
  }
  const refreshed = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/refresh-summary`, {
    method: 'POST',
    body: { tenant_id: state.tenant.id }
  });
  syncActiveLeadRun(refreshed);
  if (queueResult) {
    recordLeadRunQueueSkips(run.id, queueResult);
  } else {
    state.data.leadRunQueueSkips = null;
  }
  $('#lead-run-import-lines').value = '';
  updateLeadRunImportHintPreview();
  const skippedCount = asArray(queueResult?.skipped_leads).length;
  const nextBatchBlocked = asArray(queueResult?.skipped_leads).filter((lead) => lead.reason === 'missing_next_batch_evidence').length;
  const importSummary = added.import_summary || {};
  const mergedCount = Number(importSummary.merged_count || preview.duplicate_count || 0);
  const createdCount = Number(importSummary.created_count || prospects.length);
  const repairHints = asArray(quality.quality_review?.fix_queue).slice(0, 2);
  const primaryRepairHint = repairHints[0];
  const repairSummary = repairHints.length
    ? `先补：${repairHints.map((item) => `${item.name || '线索'}${item.issue ? `（${item.issue}）` : ''}`).join('、')}`
    : '';
  $('#lead-run-import-hint').textContent = buildQueue
    ? skippedCount
      ? `已新增 ${createdCount} 条线索${mergedCount ? `，自动合并 ${mergedCount} 条重复线索` : ''}；${skippedCount} 条未进队列，${primaryRepairHint?.hint || (nextBatchBlocked ? '需补需求/来源证据。' : '需先补联系方式。')}${repairSummary ? ` ${repairSummary}` : ''}`
      : `已新增 ${createdCount} 条线索${mergedCount ? `，自动合并 ${mergedCount} 条重复线索` : ''}，并生成今日跟进队列。`
    : `已新增 ${createdCount} 条线索${mergedCount ? `，自动合并 ${mergedCount} 条重复线索` : ''}，并完成评分与话术刷新。${repairSummary ? ` ${repairSummary}` : ''}`;
  renderActiveLeadRun();
  renderCommanderResults(state.commander.lastPlan, state.commander.lastRun);
  renderUserWorkbench();
  renderWeeklyCampaign();
  renderCustomerTimeline();
  toast(buildQueue
    ? skippedCount
      ? `已新增 ${createdCount} 条线索${mergedCount ? `，合并 ${mergedCount} 条重复` : ''}，${skippedCount} 条需补齐后再排队`
      : `已新增 ${createdCount} 条线索${mergedCount ? `，合并 ${mergedCount} 条重复` : ''}并创建跟进队列`
    : `已新增 ${createdCount} 条线索${mergedCount ? `，合并 ${mergedCount} 条重复` : ''}`);
  await refresh();
}

async function runPublicSourceAdapter(run) {
  const rawText = $('#lead-run-import-lines')?.value || '';
  const feedUrl = $('#lead-run-live-source-url')?.value || '';
  const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/public-source`, {
    method: 'POST',
    body: {
      tenant_id: state.tenant.id,
      raw_text: rawText,
      feed_url: feedUrl,
      source_task_id: state.ui.activePublicSourceTaskId || '',
      import_candidates: false
    }
  });
  syncActiveLeadRun(result.run);
  const adapter = result.public_source_adapter || {};
  const packet = result.run?.import_review_packet || adapter.import_review_packet || null;
  if (Number(adapter.imported_count || 0) > 0) {
    $('#lead-run-import-lines').value = '';
    state.ui.activePublicSourceTaskId = adapter.source_pack?.next_task_id || adapter.source_pack?.preferred_task_id || '';
  }
  $('#lead-run-import-hint').textContent = packet?.summary
    || adapter.next_action
    || '请先粘贴公开来源结果，再进入导入前质量门。';
  renderActiveLeadRun();
  renderUserWorkbench();
  toast(asArray(packet?.reviews).length
    ? `已生成 ${asArray(packet.reviews).length} 条候选，先过导入前质量门`
    : '公开来源采集指令已生成');
  await refresh();
}

async function advanceImportedLeadsToToday(run) {
  const result = await api(`/api/lead-acquisition-runs/${encodeURIComponent(run.id)}/advance-today`, {
    method: 'POST',
    body: {
      tenant_id: state.tenant.id,
      min_score: 40
    }
  });
  syncActiveLeadRun(result.run);
  renderActiveLeadRun();
  renderUserWorkbench();
  const created = asArray(result.created_tasks).length;
  const skipped = asArray(result.skipped_leads).length;
  toast(created
    ? `已推进 ${created} 条导入线索到今日跟进`
    : skipped
      ? `${skipped} 条导入线索需先补证据或联系方式`
      : '已完成质量检查和话术准备');
  await refresh();
}

function parseProspectLines(rawText) {
  return String(rawText || '')
    .split(/\n+/)
    .map((line) => parseProspectLine(line))
    .filter(Boolean);
}

function normalizeProspectIdentityText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_.·,，。:：;；'"“”‘’()（）【】\[\]{}<>《》]/g, '');
}

function buildProspectIdentityKeys(prospect) {
  const companyKey = normalizeProspectIdentityText(prospect?.company_name || '');
  const contactKey = normalizeProspectIdentityText(prospect?.contact_name || '');
  const phoneKey = String(prospect?.contact_phone || '').trim();
  const emailKey = String(prospect?.contact_email || '').trim().toLowerCase();
  const accountKey = String(prospect?.platform_account || '').trim().toLowerCase();
  return [
    phoneKey ? `phone:${phoneKey}` : '',
    emailKey ? `email:${emailKey}` : '',
    accountKey ? `account:${accountKey}` : '',
    companyKey && contactKey ? `company_contact:${companyKey}:${contactKey}` : '',
    companyKey ? `company:${companyKey}` : ''
  ].filter(Boolean);
}

function buildProspectImportPreview(prospects) {
  const seen = new Set();
  let duplicateCount = 0;
  let missingContactCount = 0;
  let manualSourceCount = 0;
  asArray(prospects).forEach((prospect) => {
    if (!prospect.contact_phone && !prospect.contact_email && !prospect.platform_account) {
      missingContactCount += 1;
    }
    if (!prospect.source_evidence && !prospect.source_url) {
      manualSourceCount += 1;
    }
    const keys = buildProspectIdentityKeys(prospect);
    if (keys.some((key) => seen.has(key))) {
      duplicateCount += 1;
    }
    keys.forEach((key) => seen.add(key));
  });
  return {
    total: asArray(prospects).length,
    duplicate_count: duplicateCount,
    missing_contact_count: missingContactCount,
    manual_source_count: manualSourceCount
  };
}

function updateLeadRunImportHintPreview() {
  const hint = $('#lead-run-import-hint');
  const textarea = $('#lead-run-import-lines');
  const liveSourceUrl = $('#lead-run-live-source-url');
  if (!hint || !textarea) return;
  const feedUrl = String(liveSourceUrl?.value || '').trim();
  const prospects = parseProspectLines(textarea.value || '');
  if (!prospects.length) {
    if (feedUrl) {
      hint.textContent = '已填公开 feed URL；点击“公开来源识别并导入”后，系统会 live 拉取真实公开条目并回写候选来源。';
    }
    return;
  }
  const preview = buildProspectImportPreview(prospects);
  hint.textContent = [
    `已识别 ${preview.total} 条线索`,
    preview.duplicate_count ? `${preview.duplicate_count} 条疑似重复，导入时会自动合并` : '',
    preview.missing_contact_count ? `${preview.missing_contact_count} 条缺联系方式，至少补一个电话/微信/邮箱` : '',
    preview.manual_source_count ? `${preview.manual_source_count} 条未写来源，建议补名单名、页面位置或链接` : '',
    feedUrl ? '也可直接用上方 feed URL live 拉取公开条目' : ''
  ].filter(Boolean).join('；');
}

function parseProspectLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return null;
  const phoneMatch = line.match(/(?:\+?\d[\d\s-]{6,}\d)/);
  const emailMatch = line.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const urlMatch = line.match(/https?:\/\/[^\s，,]+/i);
  const parts = line
    .split(/\s*[,\t|，｜]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const contactPhone = phoneMatch ? phoneMatch[0].replace(/[^\d+]/g, '') : '';
  const contactEmail = emailMatch ? emailMatch[0] : '';
  const sourceUrl = urlMatch ? urlMatch[0] : '';
  const nonContactParts = parts.filter((part) => part !== phoneMatch?.[0] && part !== emailMatch?.[0] && part !== sourceUrl);
  const companyName = nonContactParts.find((part) => /公司|科技|咨询|工作室|门店|中心|事务所|商贸|设计|教育|培训/.test(part)) || '';
  const contactName = nonContactParts.find((part) => part !== companyName && part.length <= 12 && !/[。！？]/.test(part)) || '';
  const platformAccount = nonContactParts.find((part) => /微信|vx|v信|账号|抖音号|小红书|企微/i.test(part)) || '';
  const sourceEvidence = nonContactParts.find((part) => /地图|名录|评论|问答|小红书|抖音|微信|企查查|天眼查|大众点评|高德|百度|来源|链接|地址/.test(part)) || '';
  const sourcePosition = nonContactParts.find((part) => /第\d+条|第\d+页|P\d+/i.test(part)) || '';
  const messageParts = nonContactParts.filter((part) => ![companyName, contactName, platformAccount, sourceEvidence, sourcePosition].includes(part));
  const message = messageParts.join('；') || line;
  const filled = [companyName, contactName, contactPhone, contactEmail, messageParts.join('')].filter(Boolean).length;
  if (filled < 2) return null;
  return {
    company_name: companyName,
    contact_name: contactName || companyName,
    contact_phone: contactPhone,
    contact_email: contactEmail,
    platform_account: platformAccount,
    message,
    source_url: sourceUrl,
    source_evidence: sourceEvidence,
    source_position: sourcePosition,
    recommendation_reason: '由用户粘贴的真实名单导入，已进入本轮获客执行评分。'
  };
}

function renderTodayAcquisitionWorkbench(run, dailySummary) {
  const workbench = run.today_workbench || null;
  if (!workbench) return '';
  const nextLead = workbench.next_lead || null;
  const primary = workbench.primary_action || {};
  const handoff = workbench.writeback_handoff || null;
  const checklist = asArray(workbench.checklist);
  const resultTags = asArray(workbench.result_tags).slice(0, 6);
  const outcomeSurface = workbench.call_outcome_surface || null;
  const outcomeOptions = asArray(outcomeSurface?.options).length
    ? asArray(outcomeSurface.options).slice(0, 5)
    : asArray(workbench.call_outcome_options).slice(0, 5);
  const tomorrowQueue = workbench.tomorrow_queue || null;
  const carryover = workbench.today_carryover || null;
  return `
    <section class="today-acquisition-workbench lead-run-summary-block">
      <div class="today-acquisition-hero">
        <div>
          <span class="chip success">今日获客工作台</span>
          <h3>${escapeHtml(workbench.headline || '今天先推进获客执行')}</h3>
          <p>${escapeHtml(workbench.summary || '按当前获客执行继续下一步。')}</p>
        </div>
        <button class="button primary" data-lead-run-action="${escapeHtml(primary.action || 'refresh')}" data-task-id="${escapeHtml(primary.task_id || '')}" data-lead-id="${escapeHtml(primary.lead_id || '')}">${escapeHtml(primary.label || '继续下一步')}</button>
      </div>
      <div class="today-acquisition-grid">
        <article class="mini-card">
          <strong>下一条要处理的线索</strong>
          ${nextLead ? `
            <p>${escapeHtml(nextLead.name || nextLead.lead_id)} · 评分 ${escapeHtml(String(nextLead.score_total ?? '-'))}</p>
            <small>${nextLead.route_label ? `${escapeHtml(nextLead.route_label)} · ` : ''}${escapeHtml(nextLead.reason || '按当前评分和队列优先级推荐。')}</small>
            ${nextLead.lead_execution_proof_summary ? `<small>${escapeHtml(nextLead.lead_execution_proof_summary)}</small>` : ''}
            ${nextLead.phone ? `<button class="button secondary" data-lead-run-action="call-first" data-lead-id="${escapeHtml(nextLead.lead_id || '')}">呼叫 ${escapeHtml(nextLead.phone)}</button>` : ''}
          ` : `
            <p>还没有可直接联系的线索。</p>
            <small>先按采集动作收集真实名单并导入。</small>
          `}
        </article>
        <article class="mini-card">
          <strong>今天照这个顺序做</strong>
          <div class="today-checklist">
            ${checklist.map((item) => `
              <button class="today-check ${escapeHtml(item.status || 'todo')}" data-lead-run-action="${escapeHtml(item.action || 'refresh')}">
                <span>${escapeHtml(todayCheckStatusLabel(item.status))}</span>
                <strong>${escapeHtml(item.label || '')}</strong>
              </button>
            `).join('')}
          </div>
        </article>
        <article class="mini-card">
          <strong>话术与结果标签</strong>
          ${workbench.script_preview ? `<p>${escapeHtml(workbench.script_preview)}</p>` : '<p>生成话术后，这里会显示开口理由和异议处理。</p>'}
          ${resultTags.length ? `<div class="keyword-list compact">${resultTags.map((tag) => `<code>${escapeHtml(tag)}</code>`).join('')}</div>` : ''}
          ${outcomeOptions.length ? renderWritebackOptionButtons(outcomeOptions, { title: '通话后一键回写', optionSurface: outcomeSurface }) : ''}
        </article>
      </div>
      ${handoff?.status === 'ready' ? renderWorkbenchWritebackHandoff(handoff, { deferred: workbench.status === 'carryover_today' }) : ''}
      ${dailySummary ? renderDailyConversionSummary(dailySummary) : ''}
      ${carryover?.status === 'due_today' ? renderTodayCarryoverCard(carryover) : ''}
      ${tomorrowQueue ? renderTomorrowQueueMini(tomorrowQueue) : ''}
    </section>
  `;
}

function renderLeadMainlineCheckpointResumePack(pack) {
  if (!pack || !asArray(pack.checkpoints).length) return '';
  const checkpoints = asArray(pack.checkpoints).slice(0, 3);
  const primaryCheckpoint = checkpoints.find((item) => item.key === pack.current_checkpoint_key) || checkpoints[0] || null;
  return `
    <div class="lead-run-mainline-resume-pack">
      <div>
        <span class="chip info">主链恢复包</span>
        <strong>${escapeHtml(pack.title || '离开后回来，从这一步继续')}</strong>
        <p>${escapeHtml(pack.summary || '系统已经把当前主链动作位收成可继续执行包。')}</p>
        ${pack.heartbeat_summary ? `<small>${escapeHtml(pack.heartbeat_summary)}</small>` : ''}
      ${pack.learning_summary ? `<small>${escapeHtml(pack.learning_summary)}</small>` : ''}
      ${pack.execution_flow_summary ? `<small>当前 flow：${escapeHtml(pack.execution_flow_summary)}</small>` : ''}
        ${pack.flow_resume_summary ? `<small>恢复提示：${escapeHtml(pack.flow_resume_summary)}</small>` : ''}
      ${pack.mainline_memory_summary ? `<small>主链记忆：${escapeHtml(pack.mainline_memory_summary)}</small>` : ''}
        ${pack.result_proof_handoff_summary ? `<small>结果交接：${escapeHtml(pack.result_proof_handoff_summary)}</small>` : ''}
        ${pack.context_handoff_summary ? `<small>上下文交接：${escapeHtml(pack.context_handoff_summary)}</small>` : ''}
        ${pack.founder_default_decision_summary ? `<small>老板决策：${escapeHtml(pack.founder_default_decision_summary)}</small>` : ''}
        ${pack.founder_weekly_decision_summary ? `<small>本周决策收口：${escapeHtml(pack.founder_weekly_decision_summary)}</small>` : ''}
        ${pack.founder_decision_action_summary ? `<small>老板待处理动作：${escapeHtml(pack.founder_decision_action_summary)}</small>` : ''}
        ${pack.founder_pulse_summary ? `<small>当前提醒：${escapeHtml(pack.founder_pulse_summary)}</small>` : ''}
        ${pack.unresolved_decision_carryforward_summary ? `<small>未完成决策续桥：${escapeHtml(pack.unresolved_decision_carryforward_summary)}</small>` : ''}
        ${pack.learning_priority_summary ? `<small>下一轮学习重点：${escapeHtml(pack.learning_priority_summary)}</small>` : ''}
        ${pack.context_handoff_bridge ? renderLeadContextHandoffBridge(pack.context_handoff_bridge, { title: '回来先接这一步', compact: true, asArticle: false }) : ''}
        ${pack.lead_thread_brief ? renderLeadThreadBrief(pack.lead_thread_brief, { title: '当前 lead 线程', compact: true, asArticle: false }) : ''}
        ${pack.promise_fulfillment_pack ? renderLeadPromiseFulfillmentPack(pack.promise_fulfillment_pack, { title: '当前承诺兑现', compact: true, asArticle: false }) : ''}
        ${renderLeadRunResumeActionButton(pack.primary_action, { tone: 'primary', checkpoint: primaryCheckpoint })}
      </div>
      <div class="action-stack compact-stack">
        ${checkpoints.map((checkpoint) => renderLeadMainlineResumeCheckpoint(checkpoint)).join('')}
      </div>
    </div>
  `;
}

function renderLeadMainlineCheckpointHero(pack) {
  if (!pack?.primary_action?.action) return '';
  const primaryCheckpoint = asArray(pack.checkpoints).find((item) => item.key === pack.current_checkpoint_key)
    || asArray(pack.checkpoints)[0]
    || null;
  const meta = leadResumeCheckpointMeta(primaryCheckpoint);
  return `
    <div class="lead-run-mainline-resume-pack lead-run-summary-block">
      <div>
        <span class="chip info">继续刚才这一步</span>
        <strong>${escapeHtml(primaryCheckpoint?.title || pack.title || '回到当前主链动作位')}</strong>
        <p>${escapeHtml(primaryCheckpoint?.summary || pack.summary || '离开后回来，继续从这里推进。')}</p>
        ${pack.heartbeat_summary ? `<small>${escapeHtml(pack.heartbeat_summary)}</small>` : ''}
        ${pack.learning_summary ? `<small>${escapeHtml(pack.learning_summary)}</small>` : ''}
        ${pack.execution_flow_summary ? `<small>当前 flow：${escapeHtml(pack.execution_flow_summary)}</small>` : ''}
        ${pack.flow_resume_summary ? `<small>恢复提示：${escapeHtml(pack.flow_resume_summary)}</small>` : ''}
        ${pack.mainline_memory_summary ? `<small>主链记忆：${escapeHtml(pack.mainline_memory_summary)}</small>` : ''}
        ${pack.result_proof_handoff_summary ? `<small>结果交接：${escapeHtml(pack.result_proof_handoff_summary)}</small>` : ''}
        ${pack.context_handoff_summary ? `<small>上下文交接：${escapeHtml(pack.context_handoff_summary)}</small>` : ''}
        ${pack.founder_default_decision_summary ? `<small>老板决策：${escapeHtml(pack.founder_default_decision_summary)}</small>` : ''}
        ${pack.founder_weekly_decision_summary ? `<small>本周决策收口：${escapeHtml(pack.founder_weekly_decision_summary)}</small>` : ''}
        ${pack.founder_decision_action_summary ? `<small>老板待处理动作：${escapeHtml(pack.founder_decision_action_summary)}</small>` : ''}
        ${pack.founder_pulse_summary ? `<small>当前提醒：${escapeHtml(pack.founder_pulse_summary)}</small>` : ''}
        ${pack.unresolved_decision_carryforward_summary ? `<small>未完成决策续桥：${escapeHtml(pack.unresolved_decision_carryforward_summary)}</small>` : ''}
        ${pack.learning_priority_summary ? `<small>下一轮学习重点：${escapeHtml(pack.learning_priority_summary)}</small>` : ''}
        ${pack.context_handoff_bridge ? renderLeadContextHandoffBridge(pack.context_handoff_bridge, { title: '回来先接这一步', compact: true, asArticle: false }) : ''}
        ${pack.lead_thread_brief ? renderLeadThreadBrief(pack.lead_thread_brief, { title: '当前 lead 线程', compact: true, asArticle: false }) : ''}
        ${pack.promise_fulfillment_pack ? renderLeadPromiseFulfillmentPack(pack.promise_fulfillment_pack, { title: '当前承诺兑现', compact: true, asArticle: false }) : ''}
      </div>
      <div class="action-stack compact-stack">
        ${meta.length ? `<div class="keyword-list compact">${meta.map((item) => `<code>${escapeHtml(item)}</code>`).join('')}</div>` : ''}
        ${renderLeadRunResumeActionButton(pack.primary_action, { tone: 'primary', checkpoint: primaryCheckpoint })}
      </div>
    </div>
  `;
}

function renderLeadMainlineResumeCheckpoint(checkpoint) {
  if (!checkpoint) return '';
  const meta = leadResumeCheckpointMeta(checkpoint);
  const feedbackPacket = checkpoint.review_feedback_packet || null;
  const signalGuidance = checkpoint.signal_guidance_snapshot || feedbackPacket?.signal_guidance_snapshot || null;
  const queryClusters = asArray(signalGuidance?.query_clusters).slice(0, 1);
  const sourcePriorityReason = String(signalGuidance?.source_priority_reason || asArray(signalGuidance?.preferred_sources)[0]?.source_priority_reason || '').trim();
  const nextExperiments = asArray(checkpoint.next_experiments || feedbackPacket?.next_experiments).slice(0, 1);
  const riskFlags = asArray(checkpoint.risk_flags || feedbackPacket?.risk_flags).slice(0, 1);
  return `
    <article class="mini-card">
      <span class="chip ${escapeHtml(leadResumeTone(checkpoint.status))}">${escapeHtml(leadResumeStatusLabel(checkpoint.status))}</span>
      <strong>${escapeHtml(checkpoint.title || '继续当前动作')}</strong>
      <p>${escapeHtml(checkpoint.summary || checkpoint.next_action || '')}</p>
      ${meta.length ? `<div class="keyword-list compact">${meta.map((item) => `<code>${escapeHtml(item)}</code>`).join('')}</div>` : ''}
      ${checkpoint.writeback_preview?.route_label ? `<small>回写提示：${escapeHtml(checkpoint.writeback_preview.route_label)}</small>` : ''}
      ${checkpoint.key === 'next_batch' && leadQueryClusterLine(queryClusters) ? `<small>${escapeHtml(leadQueryClusterLine(queryClusters))}</small>` : ''}
      ${checkpoint.key === 'next_batch' && leadSourcePriorityReasonLine(sourcePriorityReason) ? `<small>${escapeHtml(leadSourcePriorityReasonLine(sourcePriorityReason))}</small>` : ''}
      ${checkpoint.key === 'next_batch' && nextExperiments[0]?.instruction ? `<small>先测：${escapeHtml(nextExperiments[0].instruction)}</small>` : ''}
      ${checkpoint.key === 'next_batch' && riskFlags[0]?.label ? `<small>风险：${escapeHtml(riskFlags.map((item) => `${item.label}${item.action ? ` → ${item.action}` : ''}`).join('；'))}</small>` : ''}
      ${checkpoint.result_proof_handoff_summary ? `<small>结果交接：${escapeHtml(checkpoint.result_proof_handoff_summary)}</small>` : ''}
      ${checkpoint.founder_weekly_decision_summary ? `<small>本周决策收口：${escapeHtml(checkpoint.founder_weekly_decision_summary)}</small>` : ''}
      ${checkpoint.founder_decision_action_summary ? `<small>老板待处理动作：${escapeHtml(checkpoint.founder_decision_action_summary)}</small>` : ''}
      ${checkpoint.unresolved_decision_carryforward_summary ? `<small>未完成决策续桥：${escapeHtml(checkpoint.unresolved_decision_carryforward_summary)}</small>` : ''}
      ${checkpoint.learning_priority_summary ? `<small>下一轮学习重点：${escapeHtml(checkpoint.learning_priority_summary)}</small>` : ''}
      ${checkpoint.next_action ? `<small>${escapeHtml(checkpoint.next_action)}</small>` : ''}
      ${renderLeadRunResumeActionButton(checkpoint.action, { tone: 'secondary', checkpoint })}
    </article>
  `;
}

function renderLeadRunResumeActionButton(action, { tone = 'secondary', checkpoint = null } = {}) {
  if (!action?.action) return '';
  const attrs = leadRunResumeActionAttrs(action, checkpoint);
  return `<button class="button ${escapeHtml(tone)}" data-lead-run-action="${escapeHtml(action.action || '')}"${attrs ? ` ${attrs}` : ''}>${escapeHtml(action.label || '继续')}</button>`;
}

function leadRunResumeActionAttrs(action = {}, checkpoint = null) {
  const attrs = [];
  const leadId = checkpoint?.lead_id || action.lead_id || '';
  const taskId = checkpoint?.task_id || action.task_id || '';
  const focusTitle = checkpoint?.title || action.title || '';
  const focusLead = checkpoint?.lead_name || action.lead_name || '';
  const focusReason = checkpoint?.summary || action.reason || '';
  const focusNext = checkpoint?.next_action || action.next_action || '';
  const nextBatchSource = checkpoint?.source || action.next_batch_source || '';
  const nextBatchTarget = checkpoint?.target_profile || action.next_batch_target || '';
  const nextBatchBatchSize = checkpoint?.batch_size || action.next_batch_batch_size || '';
  const navigation = leadRunResumeNavigation(action, checkpoint);
  if (leadId) attrs.push(`data-lead-id="${escapeHtml(String(leadId))}"`);
  if (taskId) attrs.push(`data-task-id="${escapeHtml(String(taskId))}"`);
  if (focusTitle) attrs.push(`data-focus-title="${escapeHtml(String(focusTitle))}"`);
  if (focusLead) attrs.push(`data-focus-lead="${escapeHtml(String(focusLead))}"`);
  if (focusReason) attrs.push(`data-focus-reason="${escapeHtml(String(focusReason))}"`);
  if (focusNext) attrs.push(`data-focus-next="${escapeHtml(String(focusNext))}"`);
  if (nextBatchSource) attrs.push(`data-next-batch-source="${escapeHtml(String(nextBatchSource))}"`);
  if (nextBatchTarget) attrs.push(`data-next-batch-target="${escapeHtml(String(nextBatchTarget))}"`);
  if (nextBatchBatchSize) attrs.push(`data-next-batch-batch-size="${escapeHtml(String(nextBatchBatchSize))}"`);
  if (navigation.panel) attrs.push(`data-mainline-panel="${escapeHtml(String(navigation.panel))}"`);
  if (navigation.scroll) attrs.push(`data-mainline-scroll="${escapeHtml(String(navigation.scroll))}"`);
  return attrs.join(' ');
}

function leadRunResumeNavigation(action = {}, checkpoint = null) {
  const actionName = String(action.action || '');
  const key = String(checkpoint?.key || '');
  if (actionName === 'import-next-batch') return { panel: 'workflow', scroll: 'lead-run-import-lines' };
  if (actionName === 'next-batch') return { panel: 'workflow', scroll: 'lead-run-next' };
  if (actionName === 'outcome' || actionName === 'tomorrow-queue') return { panel: 'workflow', scroll: 'lead-run-outcome-review' };
  if (key === 'writeback') return { panel: 'today', scroll: 'today-inline-writeback-panel' };
  if (actionName === 'focus-task') return { panel: 'today', scroll: 'today-next-step-timer-card' };
  if (actionName === 'today') return { panel: 'today', scroll: 'today-workbench' };
  if (actionName === 'call-first' || actionName === 'call-lead') return { panel: 'today', scroll: 'today-workbench' };
  return { panel: '', scroll: '' };
}

function leadResumeCheckpointMeta(checkpoint) {
  const signalGuidance = checkpoint?.signal_guidance_snapshot || checkpoint?.review_feedback_packet?.signal_guidance_snapshot || null;
  const preferredSourceLine = leadPreferredSourceLine(asArray(signalGuidance?.preferred_sources).slice(0, 1));
  const nextExperiment = asArray(checkpoint?.next_experiments || checkpoint?.review_feedback_packet?.next_experiments).slice(0, 1);
  if (checkpoint?.key === 'next_batch') {
    return [
      checkpoint?.batch_size ? `下一批 ${checkpoint.batch_size} 条` : '',
      preferredSourceLine,
      nextExperiment[0]?.instruction ? `先测 ${truncateText(nextExperiment[0].instruction, 18)}` : ''
    ].filter(Boolean).slice(0, 3);
  }
  return [
    checkpoint?.lead_name || '',
    checkpoint?.phone || '',
    checkpoint?.route_label || '',
    checkpoint?.source ? `来源 ${checkpoint.source}` : '',
    checkpoint?.batch_size ? `下一批 ${checkpoint.batch_size} 条` : ''
  ].filter(Boolean).slice(0, 3);
}

function leadResumeTone(status) {
  return {
    due_today: 'warning',
    ready: 'success',
    ready_to_import: 'success',
    ready_to_plan: 'info',
    needs_queue: 'info'
  }[status] || 'info';
}

function leadResumeStatusLabel(status) {
  return {
    due_today: '今天继续',
    ready: '可继续',
    ready_to_import: '可导入',
    ready_to_plan: '先生成',
    needs_queue: '待补今日动作'
  }[status] || '继续';
}

function renderDailyConversionSummary(summary) {
  if (!summary) return '';
  return `
    <div class="daily-conversion-summary">
      <div>
        <span class="chip success">今天联系转化</span>
        <strong>今天 ${summary.contacted_count} 次联系，${summary.converted_count} 次成交，转化率 ${summary.conversion_rate_pct}%</strong>
        <p>${escapeHtml(summary.next_batch_suggestion?.reasoning || '基于今天的联系结果，为下一批建议。')}</p>
        <small>下一批建议采集「${escapeHtml(summary.next_batch_suggestion?.source || '公开来源')}」线索（${summary.next_batch_suggestion?.batch_size || '3-5'} 条）</small>
      </div>
      <button class="button primary" data-lead-run-action="import-next-batch" data-next-batch-source="${escapeHtml(summary.next_batch_suggestion?.source || '')}">补下一批线索</button>
    </div>
  `;
}

function renderTodayCarryoverCard(card) {
  return `
    <div class="today-carryover-card">
      <div>
        <span class="chip warning">明天队列已到今天</span>
        <strong>${escapeHtml(card.title || '今天先处理明天队列')}</strong>
        <p>${escapeHtml(card.summary || '这条线索来自已到今天的明天继续跟谁队列。')}</p>
        <small>${escapeHtml(formatDateTime(card.due_at) || '今天')} · ${escapeHtml(card.route_label || '继续跟进')} · ${escapeHtml(card.due_count ? `${card.due_count} 条到期` : '已到期')}</small>
      </div>
      <button class="button primary" data-lead-run-action="${card.phone ? 'call-lead' : 'today'}" data-task-id="${escapeHtml(card.task_id || '')}" data-lead-id="${escapeHtml(card.lead_id || '')}">${card.phone ? `呼叫 ${escapeHtml(card.phone)}` : '打开今天处理'}</button>
    </div>
  `;
}

function renderTodayContactExecutionCard(card) {
  if (!card) return '';
  const optionSurface = card.writeback_option_surface || null;
  const options = asArray(optionSurface?.options).length
    ? asArray(optionSurface.options).slice(0, 5)
    : asArray(card.writeback_options).slice(0, 5);
  const approvedDraft = card.ai_outbound_approved_draft || null;
  const scriptExperimentCard = card.script_experiment_card || null;
  const proofCard = card.lead_execution_proof_card || null;
  if (card.status === 'needs_queue') {
    return `
      <section class="today-contact-card pending lead-run-summary-block">
        <div>
          <span class="chip info">今日联系执行卡</span>
          <h3>${escapeHtml(card.title || '还没有今日可联系线索')}</h3>
          <p>${escapeHtml(card.summary || '')}</p>
        </div>
        <button class="button secondary" data-lead-run-action="advance-today">推进到今日联系</button>
      </section>
    `;
  }
  
  // P17: Extract today_priority_signal for display
  const prioritySignal = card.priority_signal || null;
  let signalChip = '';
  if (prioritySignal) {
    if (prioritySignal.status === 'boost') {
      signalChip = `<span class="chip success">${escapeHtml(prioritySignal.label || '微话术已验证')}</span>`;
    } else if (prioritySignal.status === 'review') {
      signalChip = `<span class="chip warning">${escapeHtml(prioritySignal.label || '微话术待复盘')}</span>`;
    } else if (prioritySignal.status === 'verify') {
      signalChip = `<span class="chip info">${escapeHtml(prioritySignal.label || '待继续验证')}</span>`;
    }
  }
  
  return `
    <section class="today-contact-card ${escapeHtml(card.status || 'ready_to_contact')} lead-run-summary-block">
      <div class="today-contact-main">
        <div>
          <span class="chip success">下一通联系</span>
          <h3>${escapeHtml(card.title || '下一通先联系')}</h3>
          <p>${escapeHtml(card.summary || card.reason || '')}</p>
          <div class="keyword-list compact">
            <code>评分 ${escapeHtml(String(card.score_total ?? '-'))}</code>
            ${card.task_priority ? `<code>${escapeHtml(card.task_priority)}</code>` : ''}
            ${card.route_label ? `<code>${escapeHtml(card.route_label)}</code>` : ''}
            ${card.source_task_title ? `<code>${escapeHtml(card.source_task_title)}</code>` : ''}
          </div>
        </div>
        <div class="today-contact-actions">
          ${card.phone ? `<button class="button primary" data-lead-run-action="call-lead" data-lead-id="${escapeHtml(card.lead_id || '')}">呼叫 ${escapeHtml(card.phone)}</button>` : ''}
          <button class="button secondary" data-lead-run-action="today">打开今天处理</button>
        </div>
      </div>
      <div class="today-contact-grid">
        <article class="mini-card">
          <strong>为什么先联系 TA</strong>
          <p>${escapeHtml(proofCard?.lead_priority_reason || card.reason || card.next_action || '当前队列推荐优先处理。')}</p>
          ${signalChip ? `<p class="signal-reason">${signalChip} ${prioritySignal?.reason ? escapeHtml(prioritySignal.reason) : ''}</p>` : ''}
          ${card.due_at ? `<small>任务截止：${escapeHtml(formatDateTime(card.due_at) || formatDate(card.due_at))}</small>` : ''}
        </article>
        <article class="mini-card">
          <strong>照这个开口</strong>
          ${card.micro_script ? renderLeadMicroScriptBrief(card.micro_script) : `<p>${escapeHtml(card.script_snippet || '先确认对方当前需求和方便沟通时间。')}</p>`}
        </article>
        ${renderLeadScriptDefaultActivationCard(card.script_default_activation_card || card.script_basis_pack?.script_default_activation_card, {
          asArticle: true
        })}
        ${renderLeadExecutionProofCard(proofCard, { mode: 'today' })}
        ${renderLeadThreadBrief(card.lead_thread_brief, {
          title: '这条 lead 当前线程',
          compact: true
        })}
        ${renderLeadPromiseFulfillmentPack(card.promise_fulfillment_pack, {
          title: '这次答应发什么',
          compact: true
        })}
        ${renderLeadNextTouchAssetPack(card.next_touch_asset_pack, {
          title: '下一次直接发这个',
          compact: true
        })}
        ${renderLeadSilenceRecoveryPlay(card.silence_recovery_play, {
          title: '这条沉默怎么追回',
          compact: true
        })}
        ${renderLeadCallReadinessPack(card.call_readiness_pack, { mode: 'today' })}
        ${renderLeadLiveCallGuidancePack(card.live_call_guidance_pack, { mode: 'today' })}
        ${renderLeadAIOutboundExecutionBridge(card.ai_outbound_execution_bridge || approvedDraft?.execution_bridge, {
          title: 'AI 外呼执行桥'
        })}
        ${renderLeadScriptExperimentCard(scriptExperimentCard, { mode: 'today' })}
        <article class="mini-card">
          <strong>通话后点结果</strong>
          ${renderWritebackOptionButtons(options, {
            title: card.carryover_source === 'tomorrow_queue'
              ? '点任一结果后，会自动完成这条承接任务，并接上下一步。'
              : '',
            starterTemplate: card.writeback_starter_template || null,
            optionSurface
          })}
          <small>${escapeHtml(card.next_action || '回写后系统会接下一步。')}</small>
        </article>
        ${renderLeadObjectionAnswerPack(card.objection_answer_pack || card.script_basis_pack?.objection_answer_pack, {
          title: '遇到异议先这样回',
          maxItems: 2
        })}
        ${renderLeadAIOutboundApprovedDraft(approvedDraft)}
      </div>
    </section>
  `;
}

function renderLeadExecutionProofCard(card, { mode = 'today', asArticle = true } = {}) {
  if (!card) return '';
  const blockedClaims = asArray(card.blocked_claims).slice(0, 2);
  const watchouts = asArray(card.experiment_watchouts).slice(0, 2);
  const tagLabel = mode === 'writeback'
    ? '这条 lead 为什么继续这样跟'
    : mode === 'delivery'
      ? '这条 lead 为什么这样交付'
      : '这条 lead 为什么现在先联系';
  const content = `
    <span class="chip info">执行证明卡</span>
    <strong>${escapeHtml(tagLabel)}</strong>
    <p>${escapeHtml(card.summary || card.lead_priority_reason || '系统已把当前 lead 的推荐理由、证据边界和下一步原因收成证明卡。')}</p>
    ${card.playbook_fit_summary ? `<small>打法贴合：${escapeHtml(card.playbook_fit_summary)}</small>` : ''}
    ${card.evidence_fit_summary ? `<small>证据边界：${escapeHtml(card.evidence_fit_summary)}</small>` : ''}
    ${card.call_readiness_summary ? `<small>拨号前先：${escapeHtml(card.call_readiness_summary)}</small>` : ''}
    ${watchouts.length ? `<small>继续观察：${escapeHtml(watchouts.map((item) => item.summary || item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${blockedClaims.length ? `<small>先别默认说：${escapeHtml(blockedClaims.map((item) => item.claim_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${card.next_step_reason ? `<small>下一步：${escapeHtml(card.next_step_reason)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadCallReadinessPack(pack, { mode = 'today', compact = false, asArticle = true } = {}) {
  if (!pack) return '';
  const confirmPoints = asArray(pack.opener?.confirm_points).slice(0, compact ? 1 : 2);
  const blockedClaims = asArray(pack.blocked_claims).slice(0, compact ? 1 : 2);
  const title = mode === 'call'
    ? '这通电话拨前先这样准备'
    : '拨号前先这样准备';
  const content = `
    <span class="chip warning">Call Readiness</span>
    <strong>${escapeHtml(pack.title || title)}</strong>
    <p>${escapeHtml(pack.summary || '系统已把为什么现在打、先说什么、先防什么异议和这通电话先拿什么结果收成拨号准备包。')}</p>
    ${pack.why_now ? `<small>为什么现在打：${escapeHtml(pack.why_now)}</small>` : ''}
    ${pack.opener?.line ? `<small>开场先说：${escapeHtml(pack.opener.line)}</small>` : ''}
    ${pack.proof_point?.label ? `<small>先带证据：${escapeHtml(pack.proof_point.label)}</small>` : ''}
    ${pack.objection_watch?.objection_pattern
      ? `<small>先防异议：${escapeHtml(pack.objection_watch.objection_pattern)}${pack.objection_watch?.recommended_answer ? `；${escapeHtml(pack.objection_watch.recommended_answer)}` : ''}</small>`
      : ''}
    ${pack.desired_outcome?.label ? `<small>这通先拿到：${escapeHtml(pack.desired_outcome.label)}</small>` : ''}
    ${confirmPoints.length ? `<small>通话里先确认：${escapeHtml(confirmPoints.join('；'))}</small>` : ''}
    ${blockedClaims.length ? `<small>先别默认说：${escapeHtml(blockedClaims.map((item) => item.claim_label || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadLiveCallGuidancePack(pack, { mode = 'call', compact = false, asArticle = true } = {}) {
  if (!pack) return '';
  const proofPoints = asArray(pack.proof_points).slice(0, compact ? 1 : 2);
  const objectionAnswers = asArray(pack.objection_answers).slice(0, compact ? 1 : 2);
  const transferSignals = asArray(pack.transfer_guardrail?.trigger_signals).slice(0, compact ? 1 : 2);
  const confirmPoints = asArray(pack.script_basis?.confirm_points).slice(0, compact ? 1 : 2);
  const messageAngles = asArray(pack.script_basis?.message_angles).slice(0, compact ? 1 : 2);
  const title = mode === 'today'
    ? '拨通后这样推进'
    : '通话中这样推进';
  const content = `
    <span class="chip success">Live Guidance</span>
    <strong>${escapeHtml(pack.title || title)}</strong>
    <p>${escapeHtml(pack.summary || '系统已把这通电话的开口、证据、异议回答、升级边界和目标结果收成实时引导包。')}</p>
    ${pack.script_basis?.opener_line ? `<small>继续开口：${escapeHtml(pack.script_basis.opener_line)}</small>` : ''}
    ${confirmPoints.length ? `<small>先确认：${escapeHtml(confirmPoints.join('；'))}</small>` : ''}
    ${messageAngles.length ? `<small>优先角度：${escapeHtml(messageAngles.join('；'))}</small>` : ''}
    ${proofPoints.length ? `<small>优先证据：${escapeHtml(proofPoints.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${objectionAnswers.length ? `<small>异议先接：${escapeHtml(objectionAnswers.map((item) => `${item.objection_pattern || '常见顾虑'}${item.recommended_answer ? ` → ${item.recommended_answer}` : ''}`).join('；'))}</small>` : ''}
    ${pack.transfer_guardrail?.summary ? `<small>升级 guardrail：${escapeHtml(pack.transfer_guardrail.summary)}</small>` : ''}
    ${transferSignals.length ? `<small>触发信号：${escapeHtml(transferSignals.map((item) => `${item.label}${item.action ? ` → ${item.action}` : ''}`).join('；'))}</small>` : ''}
    ${pack.desired_outcome_cue?.label ? `<small>这通先拿到：${escapeHtml(pack.desired_outcome_cue.label)}</small>` : ''}
    ${pack.desired_outcome_cue?.next_step_cue ? `<small>拿到后继续：${escapeHtml(pack.desired_outcome_cue.next_step_cue)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadCallOutcomeProofPacket(packet, { title = '这通电话为什么会这样', compact = false, asArticle = true } = {}) {
  if (!packet) return '';
  const nextStep = packet.next_step_proof || null;
  const compactMode = compact === true;
  const content = `
    <span class="chip warning">Call Outcome Proof</span>
    <strong>${escapeHtml(packet.title || title)}</strong>
    <p>${escapeHtml(packet.summary || '系统已把这通电话里的核心异议、时机、预算、转人工、无效号码和下一步证明收成结构化结果包。')}</p>
    ${packet.core_objection?.label ? `<small>核心异议：${escapeHtml(packet.core_objection.label)}${packet.core_objection?.answer_hint && !compactMode ? ` → ${escapeHtml(packet.core_objection.answer_hint)}` : ''}</small>` : ''}
    ${packet.timing_signal?.label ? `<small>时机信号：${escapeHtml(packet.timing_signal.label)}${packet.timing_signal?.callback_window_label ? `｜${escapeHtml(packet.timing_signal.callback_window_label)}` : ''}</small>` : ''}
    ${packet.budget_signal?.label ? `<small>预算信号：${escapeHtml(packet.budget_signal.label)}</small>` : ''}
    ${packet.transfer_signal?.label ? `<small>转人工原因：${escapeHtml(packet.transfer_signal.label)}</small>` : ''}
    ${packet.invalid_number_proof?.label ? `<small>无效号码证明：${escapeHtml(packet.invalid_number_proof.label)}</small>` : ''}
    ${nextStep?.label ? `<small>下一步证明：${escapeHtml(nextStep.label)}${nextStep?.due_at ? `｜${escapeHtml(formatDateTime(nextStep.due_at) || formatDate(nextStep.due_at) || '')}` : ''}</small>` : ''}
    ${packet.learning_decision?.reason && !compactMode ? `<small>沉淀判断：${escapeHtml(packet.learning_decision.reason)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadCallProofContinuityPacket(packet, { title = '这通电话怎么不断线', compact = false, asArticle = true } = {}) {
  if (!packet) return '';
  const compactMode = compact === true;
  const content = `
    <span class="chip info">连续跟进桥</span>
    <strong>${escapeHtml(packet.title || title)}</strong>
    <p>${escapeHtml(packet.carryforward_summary || packet.summary || '系统已把这通电话里的承诺、要补的证明、沉默风险和下一次联系理由收成一条续桥。')}</p>
    ${packet.promise_made?.label ? `<small>已经答应：${escapeHtml(packet.promise_made.label)}${packet.promise_made?.due_at ? `｜${escapeHtml(formatDateTime(packet.promise_made.due_at) || formatDate(packet.promise_made.due_at) || '')}` : ''}</small>` : ''}
    ${packet.proof_to_send_next?.label ? `<small>下次先带：${escapeHtml(packet.proof_to_send_next.label)}</small>` : ''}
    ${packet.core_objection_now?.label ? `<small>当前别断在：${escapeHtml(packet.core_objection_now.label)}${packet.core_objection_now?.answer_hint && !compactMode ? ` → ${escapeHtml(packet.core_objection_now.answer_hint)}` : ''}</small>` : ''}
    ${packet.silence_risk?.label ? `<small>沉默风险：${escapeHtml(packet.silence_risk.label)}</small>` : ''}
    ${packet.next_touch_reason && !compactMode ? `<small>为什么下次还要继续：${escapeHtml(packet.next_touch_reason)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadThreadBrief(packet, { title = '这条 lead 当前线程', compact = false, asArticle = true } = {}) {
  if (!packet) return '';
  const compactMode = compact === true;
  const threadStateLabel = packet.thread_state?.label || packet.thread_state_label || '';
  const latestTouchLabel = packet.latest_touch?.label || packet.latest_touch_label || '';
  const latestTouchSummary = packet.latest_touch?.summary || '';
  const latestPromiseLabel = packet.latest_promise?.label || packet.latest_promise_label || '';
  const latestObjectionLabel = packet.latest_objection?.label || packet.latest_objection_label || '';
  const latestProofStatusLabel = packet.latest_proof_status?.label || packet.latest_proof_status_label || '';
  const silenceTimerStatus = packet.silence_timer?.status || packet.silence_timer_status || '';
  const silenceTimerLabel = packet.silence_timer?.label || packet.silence_timer_label || '';
  const nextBestTouchLabel = packet.next_best_touch?.label || packet.next_best_touch_label || '';
  const nextBestTouchReason = packet.next_best_touch?.reason || '';
  const nextBestTouchDueAt = packet.next_best_touch?.due_at || packet.silence_timer?.due_at || '';
  const nextBestTouchChannel = packet.next_best_touch?.channel || '';
  const whyStillMattersLabel = packet.why_this_lead_still_matters?.label || packet.why_this_lead_still_matters_label || '';
  const whyStillMattersReason = packet.why_this_lead_still_matters?.reason || '';
  const tone = silenceTimerStatus === 'overdue'
    ? 'warning'
    : threadStateLabel && /今天|明天|承诺/.test(threadStateLabel)
      ? 'success'
      : 'info';
  const content = `
    <span class="chip ${escapeHtml(tone)}">Lead Thread Brief</span>
    <strong>${escapeHtml(packet.title || title)}</strong>
    <p>${escapeHtml(packet.summary || '系统已把这条 lead 的最近动作、当前承诺和下一次触达压成短卡。')}</p>
    ${threadStateLabel ? `<small>线程状态：${escapeHtml(threadStateLabel)}</small>` : ''}
    ${latestTouchLabel ? `<small>最近动作：${escapeHtml(latestTouchLabel)}${latestTouchSummary && !compactMode ? `｜${escapeHtml(latestTouchSummary)}` : ''}</small>` : ''}
    ${latestPromiseLabel ? `<small>当前承诺：${escapeHtml(latestPromiseLabel)}</small>` : ''}
    ${latestObjectionLabel ? `<small>当前卡点：${escapeHtml(latestObjectionLabel)}</small>` : ''}
    ${latestProofStatusLabel ? `<small>补证状态：${escapeHtml(latestProofStatusLabel)}</small>` : ''}
    ${silenceTimerLabel ? `<small>沉默计时：${escapeHtml(silenceTimerLabel)}</small>` : ''}
    ${nextBestTouchLabel ? `<small>下一下：${escapeHtml(nextBestTouchLabel)}${nextBestTouchDueAt ? `｜${escapeHtml(formatDateTime(nextBestTouchDueAt) || formatDate(nextBestTouchDueAt) || '')}` : ''}${nextBestTouchChannel && !compactMode ? `｜${escapeHtml(nextBestTouchChannel)}` : ''}</small>` : ''}
    ${nextBestTouchReason && !compactMode ? `<small>为什么这样碰：${escapeHtml(nextBestTouchReason)}</small>` : ''}
    ${whyStillMattersLabel ? `<small>${escapeHtml(whyStillMattersLabel)}${whyStillMattersReason && !compactMode ? `｜${escapeHtml(whyStillMattersReason)}` : ''}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadPromiseFulfillmentPack(packet, { title = '承诺兑现包', compact = false, asArticle = true } = {}) {
  if (!packet) return '';
  const compactMode = compact === true;
  const assetLabel = packet.promised_asset_kind?.label || packet.promised_asset_kind_label || '';
  const sendByLabel = packet.send_by?.label || packet.send_by_label || '';
  const sendByDueAt = packet.send_by?.due_at || '';
  const channelLabel = packet.channel_to_send?.label || packet.channel_to_send_label || '';
  const completionLabel = packet.completion_proof?.label || packet.completion_label || '';
  const completionStatus = packet.completion_proof?.status || packet.completion_status || '';
  const riskLabel = packet.missed_promise_risk?.label || packet.missed_risk_label || '';
  const riskStatus = packet.missed_promise_risk?.status || packet.missed_risk_status || '';
  const proofPoints = asArray(packet.proof_points_to_include).slice(0, compactMode ? 1 : 2);
  const tone = completionStatus === 'delivered'
    ? 'success'
    : riskStatus === 'overdue'
      ? 'warning'
      : 'info';
  const content = `
    <span class="chip ${escapeHtml(tone)}">承诺兑现包</span>
    <strong>${escapeHtml(packet.title || title)}</strong>
    <p>${escapeHtml(packet.summary || '系统已把最近一次答应发送的内容、渠道、时间窗和留痕状态收成兑现包。')}</p>
    ${assetLabel ? `<small>答应发送：${escapeHtml(assetLabel)}</small>` : ''}
    ${sendByLabel || sendByDueAt ? `<small>何时发：${escapeHtml([sendByLabel, sendByDueAt ? (formatDateTime(sendByDueAt) || formatDate(sendByDueAt) || sendByDueAt) : ''].filter(Boolean).join('｜'))}</small>` : ''}
    ${channelLabel ? `<small>通过：${escapeHtml(channelLabel)}</small>` : ''}
    ${proofPoints.length ? `<small>先带：${escapeHtml(proofPoints.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${packet.message_stub && !compactMode ? `<small>直接发：${escapeHtml(truncateText(packet.message_stub, 120))}</small>` : ''}
    ${completionLabel ? `<small>留痕状态：${escapeHtml(completionLabel)}</small>` : ''}
    ${riskLabel ? `<small>失约风险：${escapeHtml(riskLabel)}</small>` : ''}
    ${packet.next_touch_asset_pack ? renderLeadNextTouchAssetPack(packet.next_touch_asset_pack, {
      title: '下一次就发这个',
      compact: true,
      asArticle: false
    }) : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadNextTouchAssetPack(packet, { title = '下一次直接发这个', compact = false, asArticle = true } = {}) {
  if (!packet) return '';
  const compactMode = compact === true;
  const assetKindLabel = packet.asset_kind?.label || packet.asset_kind_label || '';
  const assetGoalLabel = packet.asset_goal?.label || packet.asset_goal_label || '';
  const followupChannelLabel = packet.followup_channel?.label || packet.followup_channel_label || '';
  const expiryStatus = packet.asset_expiry_hint?.status || packet.asset_expiry_hint_status || '';
  const expiryLabel = packet.asset_expiry_hint?.label || packet.asset_expiry_hint_label || '';
  const ctaLabel = packet.cta_to_include?.label || packet.cta_to_include_label || '';
  const proofHighlights = asArray(packet.proof_highlights)
    .map((item) => item?.label || item?.claim_supported || '')
    .filter(Boolean)
    .slice(0, compactMode ? 1 : 3);
  const tone = ['needs_recheck', 'contact_missing', 'overdue'].includes(expiryStatus)
    ? 'warning'
    : expiryStatus === 'send_now'
      ? 'success'
      : 'info';
  const content = `
    <span class="chip ${escapeHtml(tone)}">下一触达资产</span>
    <strong>${escapeHtml(packet.title || title)}</strong>
    <p>${escapeHtml(packet.summary || '系统已把下一次触达要带什么、怎么发和为什么发压成一份轻资产。')}</p>
    ${assetKindLabel ? `<small>素材类型：${escapeHtml(assetKindLabel)}</small>` : ''}
    ${assetGoalLabel ? `<small>这次目标：${escapeHtml(assetGoalLabel)}</small>` : ''}
    ${followupChannelLabel ? `<small>建议先走：${escapeHtml(followupChannelLabel)}</small>` : ''}
    ${proofHighlights.length ? `<small>优先带：${escapeHtml(proofHighlights.join('；'))}</small>` : ''}
    ${packet.send_reason && !compactMode ? `<small>为什么发：${escapeHtml(packet.send_reason)}</small>` : ''}
    ${(packet.channel_copy || packet.channel_copy_preview) ? `<small>直接发：${escapeHtml(truncateText(packet.channel_copy || packet.channel_copy_preview, compactMode ? 80 : 140))}</small>` : ''}
    ${ctaLabel ? `<small>顺手带 CTA：${escapeHtml(ctaLabel)}</small>` : ''}
    ${expiryLabel ? `<small>时效提醒：${escapeHtml(expiryLabel)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadSilenceRecoveryPlay(packet, { title = '沉默恢复打法', compact = false, asArticle = true } = {}) {
  if (!packet) return '';
  const compactMode = compact === true;
  const silenceKindLabel = packet.silence_kind?.label || packet.silence_kind_label || '';
  const lastTouchLabel = packet.last_meaningful_touch?.label || packet.last_meaningful_touch_label || '';
  const lastTouchSummary = packet.last_meaningful_touch?.summary || '';
  const dropReasonLabel = packet.suspected_drop_reason?.label || packet.suspected_drop_reason_label || '';
  const recoveryAngleLabel = packet.recovery_angle?.label || packet.recovery_angle_label || '';
  const proofLabel = packet.proof_to_reintroduce?.label || packet.proof_to_reintroduce_label || '';
  const channelLabel = packet.recommended_channel?.label || packet.recommended_channel_label || '';
  const retryLabel = packet.retry_ceiling?.label || packet.retry_ceiling_label || '';
  const retryStatus = packet.retry_ceiling?.status || packet.retry_ceiling_status || '';
  const stopLabel = packet.stop_condition?.label || packet.stop_condition_label || '';
  const tone = retryStatus === 'ceiling_reached'
    ? 'warning'
    : retryStatus === 'last_try'
      ? 'warning'
      : 'info';
  const content = `
    <span class="chip ${escapeHtml(tone)}">沉默恢复</span>
    <strong>${escapeHtml(packet.title || title)}</strong>
    <p>${escapeHtml(packet.summary || '系统已把这条值得救的沉默线索收成可执行恢复打法。')}</p>
    ${silenceKindLabel ? `<small>沉默类型：${escapeHtml(silenceKindLabel)}</small>` : ''}
    ${lastTouchLabel ? `<small>最近有效互动：${escapeHtml(lastTouchLabel)}${lastTouchSummary && !compactMode ? `｜${escapeHtml(lastTouchSummary)}` : ''}</small>` : ''}
    ${dropReasonLabel ? `<small>疑似掉线原因：${escapeHtml(dropReasonLabel)}</small>` : ''}
    ${recoveryAngleLabel ? `<small>这次这样追回：${escapeHtml(recoveryAngleLabel)}</small>` : ''}
    ${proofLabel ? `<small>先重带：${escapeHtml(proofLabel)}</small>` : ''}
    ${channelLabel ? `<small>建议渠道：${escapeHtml(channelLabel)}</small>` : ''}
    ${packet.recovery_message_stub && !compactMode ? `<small>直接开口：${escapeHtml(truncateText(packet.recovery_message_stub, 120))}</small>` : ''}
    ${retryLabel ? `<small>追单边界：${escapeHtml(retryLabel)}</small>` : ''}
    ${stopLabel ? `<small>停手条件：${escapeHtml(stopLabel)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadResultProofHandoffPack(pack, { mode = 'result', asArticle = true } = {}) {
  if (!pack) return '';
  const workedNow = asArray(pack.what_worked_now).slice(0, 2);
  const notDefaultYet = asArray(pack.what_not_default_yet).slice(0, 2);
  const carryForward = asArray(pack.next_run_carry_forward).slice(0, 2);
  const founderDecisions = asArray(pack.founder_decisions_needed).slice(0, 2);
  const experimentsStillOpen = asArray(pack.experiments_still_open).slice(0, 2);
  const title = mode === 'writeback'
    ? '这轮结果怎么交给下一轮'
    : '这轮哪些证明可以继续带走';
  const content = `
    <span class="chip info">结果交接证明</span>
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(pack.handoff_summary || pack.summary || '系统已把这轮结果里能继续带去下一轮的证明、仍需观察的实验和老板边界收成一份交接包。')}</p>
    ${workedNow.length ? `<small>这轮先站住：${escapeHtml(workedNow.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${carryForward.length ? `<small>下一轮继续带：${escapeHtml(carryForward.map((item) => item.label || item.instruction || '').filter(Boolean).join('；'))}</small>` : ''}
    ${experimentsStillOpen.length ? `<small>继续观察：${escapeHtml(experimentsStillOpen.map((item) => item.label || item.current_read || '').filter(Boolean).join('；'))}</small>` : ''}
    ${notDefaultYet.length ? `<small>还不能默认：${escapeHtml(notDefaultYet.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${founderDecisions.length ? `<small>仍要老板拍板：${escapeHtml(founderDecisions.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${pack.founder_default_decision_summary ? `<small>老板决策摘要：${escapeHtml(pack.founder_default_decision_summary)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadFounderDefaultDecisionDigest(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const decisions = asArray(packet.decisions_to_make).slice(0, 3);
  const safeDefaults = asArray(packet.already_safe_defaults).slice(0, 2);
  const blockedByApproval = asArray(packet.blocked_by_approval).slice(0, 2);
  const proofMissing = asArray(packet.proof_missing).slice(0, 2);
  const content = `
    <span class="chip warning">老板决策摘要</span>
    <strong>${escapeHtml(packet.title || '这轮只要拍板哪几件事')}</strong>
    <p>${escapeHtml(packet.digest_summary || packet.summary || '系统已把当前仍卡在审批、证据不足和默认门未放行的关键决定收成老板一眼可判断的摘要。')}</p>
    ${safeDefaults.length ? `<small>已安全放开：${escapeHtml(safeDefaults.map((item) => item.default_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${decisions.length ? `<small>优先拍板：${escapeHtml(decisions.map((item) => item.decision_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${blockedByApproval.length ? `<small>还卡审批：${escapeHtml(blockedByApproval.map((item) => item.decision_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${proofMissing.length ? `<small>先补证明：${escapeHtml(proofMissing.map((item) => item.decision_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${packet.default_confidence_summary ? `<small>默认置信带：${escapeHtml(packet.default_confidence_summary)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadDefaultConfidenceBand(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const autoSafe = asArray(packet.auto_safe_defaults).slice(0, 2);
  const recommendOnly = asArray(packet.recommend_only_defaults).slice(0, 2);
  const approvalOnly = asArray(packet.approval_only_defaults).slice(0, 2);
  const content = `
    <span class="chip success">默认置信带</span>
    <strong>${escapeHtml(packet.title || '哪些默认动作已经稳到可以自动沿用')}</strong>
    <p>${escapeHtml(packet.band_summary || packet.summary || '系统已把哪些默认动作能自动沿用、哪些只能先推荐、哪些仍要老板拍板收成一条默认置信带。')}</p>
    ${autoSafe.length ? `<small>可自动沿用：${escapeHtml(autoSafe.map((item) => item.default_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${recommendOnly.length ? `<small>先推荐：${escapeHtml(recommendOnly.map((item) => item.default_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${approvalOnly.length ? `<small>仍要拍板：${escapeHtml(approvalOnly.map((item) => item.default_label || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadOpenIndustryAutostartPacket(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const tone = packet.status === 'needs_one_answer'
    ? 'warning'
    : packet.start_mode === 'known_industry_deep_run' || packet.start_mode === 'direct_run'
      ? 'success'
      : 'info';
  const assumptions = asArray(packet.assumption_stack).slice(0, 2);
  const sources = asArray(packet.starter_sources).slice(0, 2);
  const validationLoop = asArray(packet.validation_loop).slice(0, 3);
  const content = `
    <span class="chip ${escapeHtml(tone)}">开放行业自动起跑</span>
    <strong>${escapeHtml(packet.title || '一句话目标如何直接起跑')}</strong>
    <p>${escapeHtml(packet.start_summary || packet.summary || '系统会把一句话目标收成同一条获客主链，而不是把你打回行业模板中心。')}</p>
    ${packet.industry_guess?.value ? `<small>当前按：${escapeHtml(packet.industry_guess.value)}${packet.location_scope?.value ? ` · ${escapeHtml(packet.location_scope.value)}` : ''}${packet.target_profile_hypotheses?.[0] ? ` · ${escapeHtml(packet.target_profile_hypotheses[0])}` : ''}</small>` : ''}
    ${packet.one_critical_question ? `<small>现在只补一句：${escapeHtml(packet.one_critical_question)}</small>` : ''}
    ${sources.length ? `<small>先采：${escapeHtml(sources.map((item) => item.source_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${validationLoop.length ? `<small>收敛回路：${escapeHtml(validationLoop.map((item) => item.step_label || '').filter(Boolean).join(' → '))}</small>` : ''}
    ${packet.default_confidence_summary ? `<small>默认边界：${escapeHtml(packet.default_confidence_summary)}</small>` : ''}
    ${packet.known_industry_bootstrap_reason ? `<small>已验证行业继承：${escapeHtml(packet.known_industry_bootstrap_reason)}</small>` : ''}
    ${packet.call_readiness_summary ? `<small>下游承接：${escapeHtml(packet.call_readiness_summary)}</small>` : ''}
    ${assumptions[0]?.note ? `<small>${escapeHtml(assumptions[0].note)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadNextRunLearningPriorityPack(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const topUnknowns = asArray(packet.top_unknowns).slice(0, 2);
  const evidenceToCollect = asArray(packet.evidence_to_collect_first).slice(0, 2);
  const experimentsToRun = asArray(packet.experiments_to_run_first).slice(0, 2);
  const defaultsWaitingUnlock = asArray(packet.defaults_waiting_unlock).slice(0, 2);
  const ownerFocus = asArray(packet.owner_focus).slice(0, 2);
  const content = `
    <span class="chip warning">下一轮学习优先包</span>
    <strong>${escapeHtml(packet.title || '下一轮先学什么，才能继续放开默认动作')}</strong>
    <p>${escapeHtml(packet.priority_summary || packet.summary || '系统已把下一轮最值得先补的未知、证据、实验和待放开的默认项收成一份学习优先包。')}</p>
    ${topUnknowns.length ? `<small>先补未知：${escapeHtml(topUnknowns.map((item) => item.label || item.unknown_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${evidenceToCollect.length ? `<small>先补证据：${escapeHtml(evidenceToCollect.map((item) => item.label || item.claim_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${experimentsToRun.length ? `<small>先跑实验：${escapeHtml(experimentsToRun.map((item) => item.label || item.experiment_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${defaultsWaitingUnlock.length ? `<small>待放开默认：${escapeHtml(defaultsWaitingUnlock.map((item) => item.default_label || item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${ownerFocus.length ? `<small>老板先盯：${escapeHtml(ownerFocus.map((item) => item.label || item.focus_label || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadFounderWeeklyDecisionRollup(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const decisionsMade = asArray(packet.decisions_made_this_week).slice(0, 2);
  const defaultsUnlocked = asArray(packet.defaults_unlocked_this_week).slice(0, 2);
  const stillWaiting = asArray(packet.still_waiting_decisions).slice(0, 2);
  const evidenceMissing = asArray(packet.evidence_missing_this_week).slice(0, 2);
  const nextFocus = packet.next_week_decision_focus || null;
  const content = `
    <span class="chip warning">老板周度决策收口</span>
    <strong>${escapeHtml(packet.title || '这周老板已经决定了什么、下周还要盯什么')}</strong>
    <p>${escapeHtml(packet.rollup_summary || packet.summary || '系统已把这周老板已经拍板、默认项已放开、仍在等待和下周该先盯的决策收成一份周度收口。')}</p>
    ${decisionsMade.length ? `<small>这周已决定：${escapeHtml(decisionsMade.map((item) => item.decision_label || item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${defaultsUnlocked.length ? `<small>已放开默认：${escapeHtml(defaultsUnlocked.map((item) => item.default_label || item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${stillWaiting.length ? `<small>仍在等待：${escapeHtml(stillWaiting.map((item) => item.decision_label || item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${evidenceMissing.length ? `<small>还缺证明：${escapeHtml(evidenceMissing.map((item) => item.decision_label || item.label || item.claim_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${nextFocus?.focus_label ? `<small>下周先盯：${escapeHtml(nextFocus.focus_label)}${nextFocus.first_move ? ` - ${escapeHtml(nextFocus.first_move)}` : ''}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadFounderDecisionActionQueue(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const items = asArray(packet.decision_items).slice(0, 3);
  const primaryItem = items[0] || null;
  const trailingItems = items.slice(1);
  const content = `
    <span class="chip ${packet.approval_required ? 'warning' : 'info'}">老板决策动作队列</span>
    <strong>${escapeHtml(packet.title || '老板接下来先处理哪几件事')}</strong>
    <p>${escapeHtml(packet.queue_summary || packet.summary || '系统已把待拍板、待补证和待放开的默认动作收成一条可执行队列。')}</p>
    ${primaryItem?.item_label ? `<small>优先处理：${escapeHtml(primaryItem.item_label)}</small>` : ''}
    ${primaryItem?.first_move ? `<small>先做：${escapeHtml(primaryItem.first_move)}</small>` : ''}
    ${primaryItem?.unblock_target ? `<small>处理后会推进：${escapeHtml(primaryItem.unblock_target)}</small>` : ''}
    ${primaryItem?.business_impact ? `<small>这轮影响：${escapeHtml(primaryItem.business_impact)}</small>` : ''}
    ${primaryItem?.owner_hint || primaryItem?.due_hint ? `<small>${escapeHtml([primaryItem?.owner_hint || '', primaryItem?.due_hint || ''].filter(Boolean).join('｜'))}</small>` : ''}
    ${trailingItems.length ? `<small>后面还要跟：${escapeHtml(trailingItems.map((item) => item.item_label || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function leadFounderPulseItems(packet) {
  if (!packet || typeof packet !== 'object') return [];
  return [
    packet.today_must_do_one || null,
    ...asArray(packet.overdue_commitments),
    ...asArray(packet.due_now_actions),
    ...asArray(packet.proof_gap_alerts),
    ...asArray(packet.high_risk_silence)
  ].filter(Boolean);
}

function pickLeadFounderPulseItem(packet, panel = '') {
  const items = leadFounderPulseItems(packet);
  if (!items.length) return null;
  const targetPanel = panel === 'results' ? 'workflow' : panel || '';
  return items.find((item) => item?.jump_target?.panel === targetPanel)
    || packet?.today_must_do_one
    || items[0]
    || null;
}

function renderLeadFounderPulseActionButton(target, { tone = 'primary', label = '' } = {}) {
  if (!target?.action) return '';
  const attrs = [];
  if (target.lead_id) attrs.push(`data-lead-id="${escapeHtml(String(target.lead_id))}"`);
  if (target.task_id) attrs.push(`data-task-id="${escapeHtml(String(target.task_id))}"`);
  if (target.call_session_id) attrs.push(`data-call-session-id="${escapeHtml(String(target.call_session_id))}"`);
  if (target.panel) attrs.push(`data-mainline-panel="${escapeHtml(String(target.panel))}"`);
  if (target.scroll) attrs.push(`data-mainline-scroll="${escapeHtml(String(target.scroll))}"`);
  return `<button class="button ${escapeHtml(tone)}" data-lead-run-action="${escapeHtml(String(target.action || ''))}"${attrs.length ? ` ${attrs.join(' ')}` : ''}>${escapeHtml(label || target.label || '先处理这一件')}</button>`;
}

function renderLeadContextHandoffBridge(packet, { title = '回来先看这份交接', compact = false, asArticle = true } = {}) {
  if (!packet) return '';
  const happenedLabel = packet.what_just_happened?.label || packet.what_just_happened_label || '';
  const happenedSummary = packet.what_just_happened?.summary || '';
  const pendingLabel = packet.what_is_pending_now?.label || packet.what_is_pending_now_label || '';
  const pendingSummary = packet.what_is_pending_now?.summary || '';
  const openNextLabel = packet.what_to_open_next?.label || packet.what_to_open_next_label || '';
  const notRepeatLabel = packet.what_not_to_repeat?.label || packet.what_not_to_repeat_label || '';
  const notRepeatSummary = packet.what_not_to_repeat?.summary || '';
  const reasonLabel = packet.handoff_reason?.label || packet.handoff_reason_label || '';
  const reasonText = packet.handoff_reason?.reason || '';
  const expiry = packet.handoff_expiry || null;
  const actionTarget = packet.what_to_open_next?.action_target || null;
  const expiryLabel = expiry?.label || packet.handoff_expiry_label || '';
  const chipTone = expiry?.status === 'expired' ? 'warning' : expiry?.status === 'expiring' ? 'info' : 'success';
  const content = `
    <span class="chip ${chipTone}">上下文交接</span>
    <strong>${escapeHtml(packet.title || title)}</strong>
    <p>${escapeHtml(packet.summary || '系统已把刚发生了什么、现在还欠什么、回来先打开哪里，压成一份可继续的交接。')}</p>
    ${happenedLabel ? `<small>刚发生：${escapeHtml(happenedLabel)}${happenedSummary && !compact ? `｜${escapeHtml(happenedSummary)}` : ''}</small>` : ''}
    ${pendingLabel ? `<small>现在还欠：${escapeHtml(pendingLabel)}${pendingSummary && !compact ? `｜${escapeHtml(pendingSummary)}` : ''}</small>` : ''}
    ${openNextLabel ? `<small>回来先开：${escapeHtml(openNextLabel)}</small>` : ''}
    ${notRepeatLabel ? `<small>别重复：${escapeHtml(notRepeatLabel)}${notRepeatSummary && !compact ? `｜${escapeHtml(notRepeatSummary)}` : ''}</small>` : ''}
    ${reasonLabel ? `<small>为什么要交接：${escapeHtml(reasonLabel)}${reasonText && !compact ? `｜${escapeHtml(reasonText)}` : ''}</small>` : ''}
    ${expiryLabel ? `<small>有效期：${escapeHtml(expiryLabel)}${expiry?.expires_at ? `｜${escapeHtml(formatDateTime(expiry.expires_at) || formatDate(expiry.expires_at) || '')}` : ''}</small>` : ''}
    ${actionTarget?.action ? `<div class="lead-run-result-bridge-actions">${renderLeadFounderPulseActionButton(actionTarget, {
      tone: 'primary',
      label: actionTarget?.label || '先回到当前动作'
    })}</div>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="lead-run-result-bridge-card">${content}</article>`;
}

function renderLeadFounderPulsePacket(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const primary = packet.today_must_do_one || null;
  const dueNow = asArray(packet.due_now_actions).slice(0, 2);
  const overdue = asArray(packet.overdue_commitments).slice(0, 2);
  const proofGaps = asArray(packet.proof_gap_alerts).slice(0, 2);
  const silence = asArray(packet.high_risk_silence).slice(0, 2);
  const content = `
      <span class="chip ${primary?.urgency_bucket === 'overdue' ? 'warning' : 'info'}">老板主动提醒</span>
      <strong>${escapeHtml(packet.title || '现在最该先处理什么')}</strong>
      <p>${escapeHtml(packet.pulse_summary || packet.summary || '系统已把当前最该先做的一件事和主链里的紧急提醒收成一份老板提醒。')}</p>
      ${packet.promise_fulfillment_summary ? `<small>承诺兑现：${escapeHtml(packet.promise_fulfillment_summary)}</small>` : ''}
      ${packet.silence_recovery_summary ? `<small>沉默恢复：${escapeHtml(packet.silence_recovery_summary)}</small>` : ''}
      ${packet.context_handoff_summary ? `<small>回来先看：${escapeHtml(packet.context_handoff_summary)}</small>` : ''}
      ${primary?.title ? `<small>现在先做：${escapeHtml(primary.title)}</small>` : ''}
    ${primary?.why_now ? `<small>为什么现在：${escapeHtml(primary.why_now)}</small>` : ''}
    ${primary?.business_consequence ? `<small>不处理会怎样：${escapeHtml(primary.business_consequence)}</small>` : ''}
    ${overdue.length ? `<small>已超时：${escapeHtml(overdue.map((item) => item.title || item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${dueNow.length ? `<small>今天收口：${escapeHtml(dueNow.map((item) => item.title || item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${proofGaps.length ? `<small>先补证明：${escapeHtml(proofGaps.map((item) => item.title || item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${silence.length ? `<small>沉默高风险：${escapeHtml(silence.map((item) => item.title || item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${packet.context_handoff_bridge ? renderLeadContextHandoffBridge(packet.context_handoff_bridge, {
      title: '回来别丢这段上下文',
      compact: true,
      asArticle: false
    }) : ''}
    ${primary?.jump_target ? `<div class="lead-run-result-bridge-actions">${renderLeadFounderPulseActionButton(primary.jump_target, {
      tone: 'primary',
      label: primary.jump_target?.label || '先处理这一件'
    })}</div>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="lead-run-result-bridge-card">${content}</article>`;
}

function renderLeadFounderDecisionWritebackPacket(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const payload = packet.decision_writeback_payload || asArray(packet.items)[0] || null;
  const changedDefaults = asArray(packet.decision_changed_defaults || payload?.decision_changed_defaults).slice(0, 2);
  const changedFocus = asArray(packet.decision_changed_focus || payload?.decision_changed_focus).slice(0, 2);
  const metrics = packet.metrics || null;
  const statusLabel = payload?.decision_status === 'approved'
    ? '老板已批准'
    : payload?.decision_status === 'blocked'
      ? '老板先拦住'
      : payload?.decision_status === 'needs_proof'
        ? '老板先要求补证'
        : '老板已写回';
  const content = `
    <span class="chip ${payload?.decision_status === 'approved' ? 'success' : 'warning'}">老板决策写回</span>
    <strong>${escapeHtml(payload?.target_label || packet.title || '老板刚拍板了一条主链决策')}</strong>
    <p>${escapeHtml(packet.summary || payload?.summary || '系统已把老板刚写回的批准/拦住/补证决定接回当前主链。')}</p>
    ${payload?.decision_status ? `<small>写回结果：${escapeHtml(statusLabel)}</small>` : ''}
    ${payload?.decision_reason ? `<small>写回原因：${escapeHtml(payload.decision_reason)}</small>` : ''}
    ${changedDefaults.length ? `<small>影响默认：${escapeHtml(changedDefaults.map((item) => item.default_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${changedFocus[0]?.focus_summary ? `<small>主链变化：${escapeHtml(changedFocus[0].focus_summary)}</small>` : ''}
    ${metrics ? `<small>累计写回：批准 ${escapeHtml(String(metrics.approved_count || 0))} / 拦住 ${escapeHtml(String(metrics.blocked_count || 0))} / 补证 ${escapeHtml(String(metrics.needs_proof_count || 0))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadUnresolvedDecisionCarryforwardPacket(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const pendingChecks = asArray(packet.pending_decision_checks).slice(0, 2);
  const blockedUnlocks = asArray(packet.blocked_default_unlocks).slice(0, 2);
  const manualChecks = asArray(packet.first_manual_checks).slice(0, 2);
  const content = `
    <span class="chip warning">未完成决策续桥</span>
    <strong>${escapeHtml(packet.title || '上一轮没收完的老板边界，下一轮继续带上')}</strong>
    <p>${escapeHtml(packet.carryforward_summary || packet.summary || '系统已把上一轮还没拍完、没补完、没放开的老板边界继续桥到下一轮。')}</p>
    ${manualChecks[0]?.item_label ? `<small>回来先处理：${escapeHtml(manualChecks[0].item_label)}</small>` : ''}
    ${manualChecks[0]?.first_move ? `<small>先做：${escapeHtml(manualChecks[0].first_move)}</small>` : ''}
    ${pendingChecks.length ? `<small>未完成决策：${escapeHtml(pendingChecks.map((item) => item.decision_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${blockedUnlocks.length ? `<small>先别静默放开：${escapeHtml(blockedUnlocks.map((item) => item.default_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${packet.carryforward_reason ? `<small>续桥原因：${escapeHtml(packet.carryforward_reason)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadDefaultUnlockImpactBrief(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const changedBaseline = asArray(packet.changed_baseline).slice(0, 3);
  const proofRequirements = asArray(packet.proof_requirements).slice(0, 2);
  const rollbackTriggers = asArray(packet.rollback_triggers).slice(0, 2);
  const content = `
    <span class="chip warning">默认放开影响</span>
    <strong>${escapeHtml(packet.title || '默认一旦放开，今天会具体改什么')}</strong>
    <p>${escapeHtml(packet.impact_summary || packet.summary || '系统已把默认动作一旦放开后会改写的来源、话术和跟进 baseline 收成一份影响简报。')}</p>
    ${changedBaseline.length ? `<small>会改：${escapeHtml(changedBaseline.map((item) => item.baseline_label || item.unlocked_baseline_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${changedBaseline[0]?.direct_change ? `<small>先变化：${escapeHtml(changedBaseline[0].direct_change)}</small>` : ''}
    ${proofRequirements.length ? `<small>放开前先补：${escapeHtml(proofRequirements.map((item) => item.proof_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${rollbackTriggers.length ? `<small>回收信号：${escapeHtml(rollbackTriggers.map((item) => item.trigger_summary || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadEvidenceGapClosureBrief(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const proofTasks = asArray(packet.proof_tasks).slice(0, 2);
  const claims = asArray(packet.claim_to_verify).slice(0, 2);
  const collectFrom = asArray(packet.collect_from).slice(0, 2);
  const content = `
    <span class="chip warning">补证任务简报</span>
    <strong>${escapeHtml(packet.title || '还缺的证明，现在该怎么补')}</strong>
    <p>${escapeHtml(packet.closure_summary || packet.summary || '系统已把还缺的证明、该回哪补、补完会解开什么默认动作收成一份可执行补证简报。')}</p>
    ${proofTasks.length ? `<small>先做：${escapeHtml(proofTasks.map((item) => item.task_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${proofTasks[0]?.collect_instruction ? `<small>补法：${escapeHtml(proofTasks[0].collect_instruction)}</small>` : ''}
    ${proofTasks[0]?.expected_unlock ? `<small>补完后会推进：${escapeHtml(proofTasks[0].expected_unlock)}</small>` : ''}
    ${collectFrom.length ? `<small>先回：${escapeHtml(collectFrom.map((item) => item.source_label || item.source_url || '').filter(Boolean).join('；'))}</small>` : ''}
    ${claims.length ? `<small>待确认：${escapeHtml(claims.map((item) => item.claim_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${packet.stop_condition ? `<small>停手条件：${escapeHtml(packet.stop_condition)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadPlaybookFreshnessDecay(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const stableComponents = asArray(packet.stable_components).slice(0, 2);
  const decayedComponents = asArray(packet.decayed_components).slice(0, 2);
  const revalidationTriggers = asArray(packet.revalidation_triggers).slice(0, 2);
  const content = `
    <span class="chip warning">打法新鲜度</span>
    <strong>${escapeHtml(packet.title || '这条行业打法现在还新不新')}</strong>
    <p>${escapeHtml(packet.freshness_summary || packet.summary || '系统已把当前行业打法还能不能继续默认沿用收成一份新鲜度判断。')}</p>
    ${packet.freshness_band?.business_label ? `<small>当前状态：${escapeHtml(packet.freshness_band.business_label)}</small>` : ''}
    ${stableComponents.length ? `<small>仍然稳定：${escapeHtml(stableComponents.map((item) => item.component_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${decayedComponents.length ? `<small>开始变旧：${escapeHtml(decayedComponents.map((item) => item.component_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${revalidationTriggers.length ? `<small>先复核：${escapeHtml(revalidationTriggers.map((item) => item.trigger_label || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadEvidenceExpiryRecheck(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const reusableEvidence = asArray(packet.reusable_evidence_now).slice(0, 2);
  const expiringClaims = asArray(packet.expiring_claims).slice(0, 2);
  const blockedClaims = asArray(packet.blocked_reuse_claims).slice(0, 2);
  const recheckSources = asArray(packet.recheck_required_sources).slice(0, 2);
  const content = `
    <span class="chip warning">证据到期复核</span>
    <strong>${escapeHtml(packet.title || '哪些业务证据现在还敢继续带')}</strong>
    <p>${escapeHtml(packet.expiry_summary || packet.summary || '系统已把当前还能复用、已经变旧和下一步该去补证的业务证据收成一份复核包。')}</p>
    ${reusableEvidence.length ? `<small>还能继续用：${escapeHtml(reusableEvidence.map((item) => item.claim_supported || '').filter(Boolean).join('；'))}</small>` : ''}
    ${expiringClaims.length ? `<small>开始变旧：${escapeHtml(expiringClaims.map((item) => item.claim_supported || '').filter(Boolean).join('；'))}</small>` : ''}
    ${blockedClaims.length ? `<small>这轮先别带：${escapeHtml(blockedClaims.map((item) => item.claim_supported || '').filter(Boolean).join('；'))}</small>` : ''}
    ${recheckSources.length ? `<small>先去补证：${escapeHtml(recheckSources.map((item) => item.source_label || item.source_url || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadExperimentStoplossGuard(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const stopNow = asArray(packet.stop_now_experiments).slice(0, 2);
  const safeToContinue = asArray(packet.safe_to_continue).slice(0, 2);
  const replacementFocus = asArray(packet.replacement_learning_focus).slice(0, 2);
  const protectedBudget = asArray(packet.protected_budget).slice(0, 2);
  const content = `
    <span class="chip warning">实验止损守门</span>
    <strong>${escapeHtml(packet.title || '哪些实验现在先别继续烧')}</strong>
    <p>${escapeHtml(packet.stoploss_summary || packet.summary || '系统已把这轮该停、可继续观察和替代验证重点收成一份主链止损守门。')}</p>
    ${stopNow.length ? `<small>先停：${escapeHtml(stopNow.map((item) => item.experiment_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${safeToContinue.length ? `<small>继续观察：${escapeHtml(safeToContinue.map((item) => item.experiment_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${replacementFocus.length ? `<small>改放重点：${escapeHtml(replacementFocus.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${protectedBudget.length ? `<small>先保主链：${escapeHtml(protectedBudget.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadPlaybookEvidenceLearningHeartbeat(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const promotedDefaults = asArray(packet.promoted_defaults).slice(0, 2);
  const frozenDefaults = asArray(packet.frozen_defaults).slice(0, 2);
  const refreshedEvidence = asArray(packet.refreshed_evidence_refs).slice(0, 2);
  const staleEvidence = asArray(packet.stale_evidence_refs).slice(0, 2);
  const blockedPromotions = asArray(packet.blocked_promotions).slice(0, 2);
  const content = `
    <span class="chip warning">打法/证据学习</span>
    <strong>这轮哪些默认打法更稳了</strong>
    <p>${escapeHtml(packet.heartbeat_summary || packet.summary || '系统已把行业默认打法和证据复用边界继续收进学习心跳。')}</p>
    ${promotedDefaults.length ? `<small>升稳默认：${escapeHtml(promotedDefaults.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${refreshedEvidence.length ? `<small>继续复用：${escapeHtml(refreshedEvidence.map((item) => item.claim_supported || '').filter(Boolean).join('；'))}</small>` : ''}
    ${frozenDefaults.length ? `<small>先冻结：${escapeHtml(frozenDefaults.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${staleEvidence.length ? `<small>先刷新：${escapeHtml(staleEvidence.map((item) => item.claim_supported || '').filter(Boolean).join('；'))}</small>` : ''}
    ${blockedPromotions.length ? `<small>仍被拦下：${escapeHtml(blockedPromotions.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadRunReuseScopeGuard(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const safeReuseAssets = asArray(packet.safe_reuse_assets).slice(0, 2);
  const mustRefreshAssets = asArray(packet.must_refresh_assets).slice(0, 2);
  const industryDrift = asArray(packet.industry_drift_flags).slice(0, 1);
  const locationDrift = asArray(packet.location_drift_flags).slice(0, 1);
  const offerDrift = asArray(packet.offer_drift_flags).slice(0, 1);
  const content = `
    <span class="chip warning">复用范围守门</span>
    <strong>这轮还能沿用哪些旧结论</strong>
    <p>${escapeHtml(packet.reuse_scope_summary || packet.summary || '系统已把这轮还能继续沿用什么、必须先重开的部分收成复用范围守门。')}</p>
    ${safeReuseAssets.length ? `<small>还能继续沿用：${escapeHtml(safeReuseAssets.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${mustRefreshAssets.length ? `<small>这轮先重开：${escapeHtml(mustRefreshAssets.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${industryDrift.length ? `<small>行业变化：${escapeHtml(industryDrift.map((item) => item.current_value || item.reason || '').filter(Boolean).join('；'))}</small>` : ''}
    ${locationDrift.length ? `<small>区域变化：${escapeHtml(locationDrift.map((item) => item.current_value || item.reason || '').filter(Boolean).join('；'))}</small>` : ''}
    ${offerDrift.length ? `<small>承接变化：${escapeHtml(offerDrift.map((item) => item.current_value || item.reason || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadMainlineDefaultActivationBrief(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const sourceRoute = packet.activated_source_route || null;
  const messageAngle = packet.activated_message_angle || null;
  const evidenceBundle = packet.activated_evidence_bundle || null;
  const followupRhythm = packet.activated_followup_rhythm || null;
  const withheldDefaults = asArray(packet.withheld_defaults).slice(0, 2);
  const content = `
    <span class="chip success">默认激活简报</span>
    <strong>这轮默认先沿哪些动作起跑</strong>
    <p>${escapeHtml(packet.activation_reason_summary || packet.summary || '系统已把当前真正会起效的默认来源、开口、证据和跟进节奏收成一份默认激活简报。')}</p>
    ${sourceRoute?.source_label ? `<small>默认来源：${escapeHtml(sourceRoute.source_label)}</small>` : ''}
    ${messageAngle?.angle_label ? `<small>默认开口：${escapeHtml(messageAngle.angle_label)}</small>` : ''}
    ${evidenceBundle?.primary_claim ? `<small>默认证据：${escapeHtml(evidenceBundle.primary_claim)}</small>` : ''}
    ${followupRhythm?.callback_window || followupRhythm?.preferred_channel ? `<small>默认跟进：${escapeHtml(`${followupRhythm.callback_window || '当前建议窗口'} / ${followupRhythm.preferred_channel || '当前建议渠道'}`)}</small>` : ''}
    ${withheldDefaults.length ? `<small>先不激活：${escapeHtml(withheldDefaults.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadSourceDefaultActivationCard(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const defaultSources = asArray(packet.default_sources).slice(0, 2);
  const defaultClusters = asArray(packet.default_query_clusters).slice(0, 2);
  const includePatterns = asArray(packet.default_include_patterns).slice(0, 2);
  const qualityFloor = packet.default_quality_floor || null;
  const breakSignal = packet.break_default_signal || null;
  const content = `
    <span class="chip success">来源默认桥接</span>
    <strong>这轮默认先沿哪条来源路线补名单</strong>
    <p>${escapeHtml(packet.activation_reason || packet.summary || '系统已把当前默认来源路线桥到 discovery / import 主链。')}</p>
    ${packet.default_confidence_label ? `<small>当前置信带：${escapeHtml(packet.default_confidence_label)}</small>` : ''}
    ${defaultSources.length ? `<small>默认来源：${escapeHtml(defaultSources.map((item) => item.source_label || item.source_kind || '').filter(Boolean).join('；'))}</small>` : ''}
    ${defaultClusters.length ? `<small>默认问题簇：${escapeHtml(defaultClusters.map((item) => item.label || item.key || '').filter(Boolean).join('；'))}</small>` : ''}
    ${includePatterns.length ? `<small>先收：${escapeHtml(includePatterns.map((item) => item.pattern || '').filter(Boolean).join('；'))}</small>` : ''}
    ${qualityFloor?.quality_summary ? `<small>默认导入门：${escapeHtml(qualityFloor.quality_summary)}</small>` : ''}
    ${breakSignal?.break_summary ? `<small>停用信号：${escapeHtml(breakSignal.break_summary)}</small>` : ''}
    ${packet.default_confidence_summary ? `<small>置信说明：${escapeHtml(packet.default_confidence_summary)}</small>` : ''}
    ${packet.default_unlock_impact_summary ? `<small>放开后会改：${escapeHtml(packet.default_unlock_impact_summary)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadScriptDefaultActivationCard(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const defaultPersona = packet.default_target_persona || null;
  const defaultOpener = packet.default_opener || null;
  const defaultProof = asArray(packet.default_proof_sequence).slice(0, 2);
  const defaultObjection = packet.default_objection_branch || null;
  const blockedClaims = asArray(packet.claims_blocked_by_default).slice(0, 2);
  const content = `
    <span class="chip success">脚本默认桥接</span>
    <strong>这轮默认先这样说</strong>
    <p>${escapeHtml(packet.activation_reason || packet.summary || '系统已把当前更稳的默认开口、证据顺序和异议承接桥到 Today / 审批主链。')}</p>
    ${packet.default_confidence_label ? `<small>当前置信带：${escapeHtml(packet.default_confidence_label)}</small>` : ''}
    ${defaultPersona?.label ? `<small>默认对象：${escapeHtml(defaultPersona.label)}</small>` : ''}
    ${defaultOpener?.opener_label ? `<small>默认开口：${escapeHtml(defaultOpener.opener_label)}</small>` : ''}
    ${defaultProof.length ? `<small>默认证据：${escapeHtml(defaultProof.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${defaultObjection?.objection_pattern ? `<small>默认异议：${escapeHtml(defaultObjection.objection_pattern)}</small>` : ''}
    ${blockedClaims.length ? `<small>先别默认说：${escapeHtml(blockedClaims.map((item) => item.claim_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${packet.default_confidence_summary ? `<small>置信说明：${escapeHtml(packet.default_confidence_summary)}</small>` : ''}
    ${packet.default_unlock_impact_summary ? `<small>放开后会改：${escapeHtml(packet.default_unlock_impact_summary)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadFollowupDefaultActivationCard(packet, { asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const callbackWindow = packet.default_callback_window || null;
  const channels = asArray(packet.default_channels).slice(0, 2);
  const retryLimit = packet.default_retry_limit || null;
  const blockedMoves = asArray(packet.blocked_followup_moves).slice(0, 2);
  const content = `
    <span class="chip success">跟进默认桥接</span>
    <strong>这轮默认先这样跟</strong>
    <p>${escapeHtml(packet.activation_reason || packet.summary || '系统已把当前更稳的跟进时间窗、渠道和补跟上限桥回结果主链。')}</p>
    ${packet.default_confidence_label ? `<small>当前置信带：${escapeHtml(packet.default_confidence_label)}</small>` : ''}
    ${callbackWindow?.label ? `<small>默认时间窗：${escapeHtml(callbackWindow.label)}</small>` : ''}
    ${channels.length ? `<small>默认渠道：${escapeHtml(channels.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${retryLimit?.label ? `<small>默认补跟上限：${escapeHtml(retryLimit.label)}</small>` : ''}
    ${packet.default_message_stub ? `<small>默认跟进句：${escapeHtml(packet.default_message_stub)}</small>` : ''}
    ${blockedMoves.length ? `<small>先别默认做：${escapeHtml(blockedMoves.map((item) => item.move_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${packet.default_confidence_summary ? `<small>置信说明：${escapeHtml(packet.default_confidence_summary)}</small>` : ''}
    ${packet.default_unlock_impact_summary ? `<small>放开后会改：${escapeHtml(packet.default_unlock_impact_summary)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function leadAIOutboundExecutionTone(status) {
  return {
    ready_for_approval: 'info',
    waiting_approval: 'warning',
    approved_waiting_resume: 'warning',
    queued: 'warning',
    active: 'success',
    completed_pending_writeback: 'info',
    failed_pending_writeback: 'warning',
    completed: 'success',
    failed: 'danger',
    rejected: 'danger'
  }[status] || 'info';
}

function leadAIOutboundExecutionLabel(status) {
  return {
    ready_for_approval: '待提交',
    waiting_approval: '待审批',
    approved_waiting_resume: '待推进',
    queued: '已入队',
    active: '进行中',
    completed_pending_writeback: '待回写',
    failed_pending_writeback: '待补回写',
    completed: '已回写',
    failed: '已失败',
    rejected: '已驳回'
  }[status] || '执行中';
}

function leadExecutionFlowTone(status) {
  return {
    ready: 'info',
    blocked: 'warning',
    manual_confirm: 'warning',
    in_progress: 'success',
    auto_ready: 'success'
  }[status] || 'info';
}

function leadExecutionFlowLabel(status) {
  return {
    ready: '可推进',
    blocked: '先补齐',
    manual_confirm: '需人工确认',
    in_progress: '进行中',
    auto_ready: '低风险可自动接续'
  }[status] || '当前 flow';
}

function renderLeadExecutionFlowActionButton(action, { tone = 'secondary' } = {}) {
  if (!action || typeof action !== 'object') return '';
  const label = action.label || '继续当前主链';
  if (action.action_kind === 'call_action' && action.action && action.call_session_id) {
    return `<button class="button ${escapeHtml(tone)}" data-call-action="${escapeHtml(action.action)}" data-call-session-id="${escapeHtml(action.call_session_id)}">${escapeHtml(label)}</button>`;
  }
  if (action.action_kind === 'lead_run_action' && action.action) {
    const attrs = [
      action.task_id ? `data-task-id="${escapeHtml(action.task_id)}"` : '',
      action.lead_id ? `data-lead-id="${escapeHtml(action.lead_id)}"` : '',
      action.focus_title ? `data-focus-title="${escapeHtml(action.focus_title)}"` : '',
      action.focus_reason ? `data-focus-reason="${escapeHtml(action.focus_reason)}"` : ''
    ].filter(Boolean).join(' ');
    return `<button class="button ${escapeHtml(tone)}" data-lead-run-action="${escapeHtml(action.action)}"${attrs ? ` ${attrs}` : ''}>${escapeHtml(label)}</button>`;
  }
  return '';
}

function renderLeadExecutionFlowBridge(bridge, { mode = 'result', asArticle = true } = {}) {
  if (!bridge || typeof bridge !== 'object') return '';
  const missingEvidence = asArray(bridge.evidence_required).filter((item) => item?.status && item.status !== 'ready').slice(0, mode === 'commander' ? 1 : 2);
  const readyEvidence = asArray(bridge.evidence_required).filter((item) => item?.status === 'ready').slice(0, mode === 'commander' ? 1 : 2);
  const chips = [
    bridge.current_flow_stage_label || '',
    bridge.run_stage_label || '',
    bridge.manual_confirm_needed ? '需人工确认' : '',
    bridge.auto_advance_allowed ? '低风险自动接续' : '',
    missingEvidence.length ? `${missingEvidence.length} 项未齐` : ''
  ].filter(Boolean);
  const content = `
    <span class="chip ${escapeHtml(leadExecutionFlowTone(bridge.flow_status || 'ready'))}">${escapeHtml(leadExecutionFlowLabel(bridge.flow_status || 'ready'))}</span>
    <strong>${escapeHtml(bridge.title || '当前主链执行桥')}</strong>
    <p>${escapeHtml(bridge.summary || '系统已把当前 run 的下一步、卡点和恢复位收成同一份执行桥。')}</p>
    ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
    ${bridge.next_best_action?.label ? `<small>先做：${escapeHtml(bridge.next_best_action.label)}</small>` : ''}
    ${bridge.next_best_action_reason ? `<small>为什么先做：${escapeHtml(bridge.next_best_action_reason)}</small>` : ''}
    ${bridge.flow_block_reason?.label ? `<small>当前卡点：${escapeHtml(bridge.flow_block_reason.label)}${bridge.flow_block_reason?.reason ? ` · ${escapeHtml(bridge.flow_block_reason.reason)}` : ''}</small>` : ''}
    ${missingEvidence.length ? `<small>还缺：${escapeHtml(missingEvidence.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${readyEvidence.length ? `<small>已齐：${escapeHtml(readyEvidence.map((item) => item.label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${bridge.auto_advance_boundary ? `<small>自动推进边界：${escapeHtml(bridge.auto_advance_boundary)}</small>` : ''}
    ${bridge.flow_resume_hint?.summary ? `<small>回来时继续：${escapeHtml(bridge.flow_resume_hint.summary)}</small>` : ''}
    ${renderLeadExecutionFlowActionButton(bridge.next_best_action, { tone: mode === 'commander' ? 'secondary' : 'primary' })}
  `;
  if (mode === 'commander') {
    return `<div class="command-help">${content}</div>`;
  }
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="${escapeHtml(mode === 'today' ? 'today-mainline-card' : 'lead-run-result-bridge-card')}">${content}</article>`;
}

function leadOutcomeSopTone(status) {
  return {
    default_ready: 'success',
    candidate: 'info',
    needs_proof: 'warning',
    needs_founder_approval: 'warning',
    rollback_watch: 'danger'
  }[status] || 'info';
}

function leadOutcomeSopLabel(status) {
  return {
    default_ready: '默认可沿用',
    candidate: '继续观察',
    needs_proof: '先补证明',
    needs_founder_approval: '需老板确认',
    rollback_watch: '先收紧'
  }[status] || '结果 SOP';
}

function renderLeadOutcomeSopRollup(packet, { mode = 'result', asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const candidates = asArray(packet.sop_candidate_cards).slice(0, mode === 'commander' ? 1 : 3);
  const chips = [
    packet.ready_sop_count ? `${packet.ready_sop_count} 条默认可沿用` : '',
    packet.needs_proof_count ? `${packet.needs_proof_count} 条待补证` : '',
    packet.needs_founder_approval_count ? `${packet.needs_founder_approval_count} 条待老板确认` : '',
    packet.rollback_watch_count ? `${packet.rollback_watch_count} 条先收紧` : ''
  ].filter(Boolean);
  const content = `
    <span class="chip info">结果 SOP</span>
    <strong>${escapeHtml(packet.title || '这轮结果沉淀出的 SOP')}</strong>
    <p>${escapeHtml(packet.summary || '系统已把这轮结果里值得复用、还要补证和先收紧的打法收成一份轻量 SOP。')}</p>
    ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
    ${packet.default_ready_summary ? `<small>${escapeHtml(packet.default_ready_summary)}</small>` : ''}
    ${packet.proof_gap_summary ? `<small>还差：${escapeHtml(packet.proof_gap_summary)}</small>` : ''}
    ${packet.rollback_watch_summary ? `<small>收紧提醒：${escapeHtml(packet.rollback_watch_summary)}</small>` : ''}
    ${candidates.map((card) => `
      <div class="action-line">
        <p><span class="chip ${escapeHtml(leadOutcomeSopTone(card.status || 'candidate'))}">${escapeHtml(leadOutcomeSopLabel(card.status || 'candidate'))}</span> ${escapeHtml(card.sop_title || '结果 SOP')}</p>
        ${card.sop_summary ? `<small>${escapeHtml(card.sop_summary)}</small>` : ''}
        ${card.proof_gap?.label ? `<small>还差：${escapeHtml(card.proof_gap.label)}</small>` : ''}
        ${card.rollback_signal?.label ? `<small>收紧信号：${escapeHtml(card.rollback_signal.label)}</small>` : ''}
      </div>
    `).join('')}
  `;
  if (mode === 'commander') return `<div class="command-help">${content}</div>`;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="lead-run-result-bridge-card">${content}</article>`;
}

function renderLeadAIOutboundExecutionBridge(bridge, { title = 'AI 外呼执行桥', asArticle = true } = {}) {
  if (!bridge) return '';
  const approval = bridge.approval_request || null;
  const session = bridge.call_session || null;
  const status = bridge.status || '';
  const actionButton = bridge.resume_payload?.endpoint
    ? `<button class="button secondary" data-lead-run-action="resume-ai-outbound-execution" data-lead-id="${escapeHtml(bridge.lead_id || '')}">推进已审批外呼</button>`
    : session?.id
      ? `<button class="button ghost" data-call-action="select-call" data-call-session-id="${escapeHtml(session.id)}">${status === 'completed_pending_writeback' || status === 'failed_pending_writeback' ? '记录这通外呼结果' : '查看这通外呼'}</button>`
      : '';
  const content = `
    <span class="chip ${escapeHtml(leadAIOutboundExecutionTone(status))}">${escapeHtml(leadAIOutboundExecutionLabel(status))}</span>
    <strong>${escapeHtml(bridge.title || title)}</strong>
    <p>${escapeHtml(bridge.summary || '审批通过后，AI 外呼会在这里桥到执行、事件同步和结果回写。')}</p>
    ${bridge.delivery_id ? `<small>执行单号：${escapeHtml(bridge.delivery_id)}</small>` : ''}
    ${approval?.id ? `<small>审批单：${escapeHtml(approval.id)} · ${escapeHtml(approval.status || 'pending')}</small>` : ''}
    ${bridge.provider_execution_mode ? `<small>执行模式：${escapeHtml(bridge.provider_execution_mode)}</small>` : ''}
    ${bridge.writeback_summary ? `<small>回写提示：${escapeHtml(bridge.writeback_summary)}</small>` : ''}
    ${bridge.next_action ? `<small>${escapeHtml(bridge.next_action)}</small>` : ''}
    ${actionButton}
  `;
  if (!asArticle) return `<div class="mini-card">${content}</div>`;
  return `<article class="mini-card">${content}</article>`;
}

function renderLeadAIOutboundApprovedDraft(draft) {
  if (!draft) return '';
  const executionBridge = draft.execution_bridge || null;
  const executionFlowBridge = draft.execution_flow_bridge || null;
  const liveCallGuidancePack = draft.live_call_guidance_pack || draft.approval_payload?.body?.draft_context?.live_call_guidance_pack || null;
  const proofPoints = asArray(draft.evidence_pack?.proof_points).slice(0, 2);
  const messageAngles = asArray(draft.message_angles).slice(0, 2);
  const riskFlags = asArray(draft.risk_flags).slice(0, 2);
  const signalGuidance = draft.signal_guidance_snapshot || null;
  const preferredSources = asArray(signalGuidance?.preferred_sources).slice(0, 1);
  const queryClusters = asArray(signalGuidance?.query_clusters).slice(0, 1);
  const sourcePriorityReason = String(signalGuidance?.source_priority_reason || preferredSources[0]?.source_priority_reason || '').trim();
  const nextExperiments = asArray(draft.next_experiments).slice(0, 1);
  const scriptExperimentCard = draft.script_experiment_card || null;
  return `
    <article class="mini-card">
      <strong>AI 外呼先走审批</strong>
      <p>${escapeHtml(draft.summary || '先生成审批草案，再决定是否外呼。')}</p>
      <div class="keyword-list compact">
        ${draft.phone ? `<code>${escapeHtml(draft.phone)}</code>` : '<code>待补电话</code>'}
        ${messageAngles[0]?.angle ? `<code>${escapeHtml(messageAngles[0].angle)}</code>` : ''}
        ${proofPoints[0]?.proof_point ? '<code>带证据开口</code>' : ''}
      </div>
      ${proofPoints.map((item) => `<p>${escapeHtml(item.proof_point || item.label || '')}</p>`).join('')}
      ${leadPreferredSourceLine(preferredSources) ? `<small>${escapeHtml(leadPreferredSourceLine(preferredSources))}</small>` : ''}
      ${leadQueryClusterLine(queryClusters) ? `<small>${escapeHtml(leadQueryClusterLine(queryClusters))}</small>` : ''}
      ${leadSourcePriorityReasonLine(sourcePriorityReason) ? `<small>${escapeHtml(leadSourcePriorityReasonLine(sourcePriorityReason))}</small>` : ''}
      ${renderLeadScriptDefaultActivationCard(draft.script_default_activation_card || draft.script_basis_pack?.script_default_activation_card, {
        asArticle: false
      })}
      ${renderLeadScriptExperimentCard(scriptExperimentCard, { mode: 'approval' })}
      ${renderLeadObjectionAnswerPack(draft.objection_answer_pack || draft.script_basis_pack?.objection_answer_pack, {
        title: '审批前先看异议回答',
        maxItems: 1,
        asArticle: false
      })}
      ${renderLeadLiveCallGuidancePack(liveCallGuidancePack, {
        mode: 'call',
        compact: true,
        asArticle: false
      })}
      ${renderLeadExecutionFlowBridge(executionFlowBridge, {
        mode: 'approval',
        asArticle: false
      })}
      ${renderLeadAIOutboundExecutionBridge(executionBridge, {
        title: '审批后的执行状态',
        asArticle: false
      })}
      ${draft.win_loss_brief?.summary ? `<small>复盘提醒：${escapeHtml(draft.win_loss_brief.summary)}</small>` : ''}
      ${nextExperiments[0]?.instruction ? `<small>若要继续放大，先测：${escapeHtml(nextExperiments[0].instruction)}</small>` : ''}
      ${riskFlags[0]?.label
        ? `<small>风险：${escapeHtml(riskFlags.map((item) => `${item.label}${item.action ? ` → ${item.action}` : ''}`).join('；'))}</small>`
        : ''}
      ${draft.primary_action && !executionBridge?.resume_payload
        ? `<button class="button secondary" data-lead-run-action="${escapeHtml(draft.primary_action.action || '')}" data-lead-id="${escapeHtml(draft.lead_id || '')}" data-task-id="${escapeHtml(draft.task_id || '')}">${escapeHtml(draft.primary_action.label || '提交审批')}</button>`
        : `<small>${escapeHtml(draft.next_action || '先补信息，再生成审批请求。')}</small>`}
    </article>
  `;
}

function renderLeadObjectionAnswerPack(pack, options = {}) {
  const answers = asArray(pack?.answers).slice(0, Number(options.maxItems || 2));
  if (!answers.length) return '';
  const riskyAnswers = asArray(pack?.risky_answers).slice(0, 1);
  const title = options.title || '异议回答包';
  const content = `
    <strong>${escapeHtml(title)}</strong>
    ${pack?.summary ? `<p>${escapeHtml(pack.summary)}</p>` : ''}
    ${pack?.script_experiment_summary ? `<small>这轮先试：${escapeHtml(pack.script_experiment_summary)}</small>` : ''}
    ${pack?.founder_approval_needed ? `<small>${escapeHtml(pack?.approval_reason || '这轮异议实验仍有高风险边界，先人工确认。')}</small>` : ''}
    ${answers.map((item) => {
      const proofPoints = asArray(item.supporting_proof_points).slice(0, 2);
      const riskFlags = asArray(item.risk_flags).slice(0, 1);
      return `
        <div class="action-line">
          <p><strong>${escapeHtml(item.objection_pattern || '常见异议')}</strong></p>
          <small>${escapeHtml(item.recommended_answer || '')}</small>
          ${proofPoints.length
            ? `<small>优先证据：${escapeHtml(proofPoints.map((proof) => proof.proof_point || proof.label || '').filter(Boolean).join('；'))}</small>`
            : ''}
          ${item.answer_tone ? `<small>回答方式：${escapeHtml(leadObjectionToneLabel(item.answer_tone))}</small>` : ''}
          ${item.requires_manual_confirmation
            ? `<small>人工确认：${escapeHtml(item.manual_confirmation_reason || '这条回答先人工确认再说。')}</small>`
            : ''}
          ${riskFlags[0]?.label ? `<small>风险：${escapeHtml(riskFlags[0].label)}</small>` : ''}
          ${item.human_feedback_summary ? `<small>${escapeHtml(item.human_feedback_summary)}</small>` : ''}
          ${renderLeadHumanFeedbackButtons({
            targetKind: 'objection_answer',
            targetId: item.objection_pattern || '',
            targetLabel: item.objection_pattern || '当前异议'
          })}
        </div>
      `;
    }).join('')}
    ${riskyAnswers[0]?.objection_pattern ? `<small>需重点确认：${escapeHtml(riskyAnswers[0].objection_pattern)}</small>` : ''}
    ${pack?.next_action ? `<small>${escapeHtml(pack.next_action)}</small>` : ''}
  `;
  if (options.asArticle === false) return `<div class="lead-objection-answer-pack">${content}</div>`;
  return `<article class="mini-card lead-objection-answer-pack">${content}</article>`;
}

function leadObjectionToneLabel(tone) {
  return {
    cautious: '谨慎确认后再说',
    calm_value_first: '先稳住，再讲价值',
    proof_first: '先上证据，再谈判断',
    light_reengagement: '轻触达式复联',
    consultative: '顾问式确认'
  }[tone] || tone || '';
}

function leadNextActionTypeLabel(type) {
  return {
    callback_followup: '承诺回拨',
    retry_callback: '再试一次回拨',
    appointment_followup: '预约承接',
    switch_channel_followup: '换渠道跟进',
    decision_maker_followup: '补决策人继续',
    requalify_followup: '先确认再推进',
    quote_followup: '报价 / 方案跟进',
    continue_followup: '继续推进',
    repair_lead: '先修线索',
    repair_source_before_import: '先修来源再导入',
    repair_contact_before_import: '先补联系方式再导入',
    import_next_batch: '补下一批名单'
  }[type] || type || '下一步';
}

function leadFollowupChannelLabel(channel) {
  return {
    phone_callback: '电话回拨',
    sms: '短信',
    wecom_im: '企微 / 私信',
    email: '邮件'
  }[channel] || channel || '跟进渠道';
}

function renderLeadNextActionCommitmentPack(pack, { title = '承诺型下一步', asArticle = true } = {}) {
  if (!pack) return '';
  const callbackWindow = pack.callback_window || null;
  const executionCommitment = pack.execution_commitment || null;
  const content = `
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(leadNextActionTypeLabel(pack.next_action_type))}${callbackWindow?.label ? ` · ${escapeHtml(callbackWindow.label)}` : ''}</p>
    ${pack.execution_commitment_summary ? `<small>${escapeHtml(pack.execution_commitment_summary)}</small>` : ''}
    ${pack.why_this_next_step ? `<small>${escapeHtml(pack.why_this_next_step)}</small>` : ''}
    ${pack.suggested_channel ? `<small>建议渠道：${escapeHtml(pack.suggested_channel)}</small>` : ''}
    ${callbackWindow?.due_at ? `<small>承诺时间：${escapeHtml(formatDateTime(callbackWindow.due_at) || formatDate(callbackWindow.due_at) || callbackWindow.due_at)}</small>` : ''}
    ${pack.owner_hint ? `<small>谁来处理：${escapeHtml(pack.owner_hint)}</small>` : ''}
    ${executionCommitment?.status ? `<small>承诺状态：${escapeHtml(executionCommitment.status)}</small>` : ''}
    ${pack.followup_message_stub ? `<small>可直接照着说：${escapeHtml(pack.followup_message_stub)}</small>` : ''}
    ${pack.call_proof_continuity_summary ? `<small>续桥提醒：${escapeHtml(pack.call_proof_continuity_summary)}</small>` : ''}
    ${pack.queue_sync?.status === 'queued' ? '<small>已同步进明天继续跟进队列。</small>' : ''}
    ${pack.queue_sync?.status === 'suggested' ? '<small>适合同步进明天继续跟进队列。</small>' : ''}
    ${renderLeadFollowupExperimentCard(pack.followup_experiment_card, {
      mode: 'commitment',
      asArticle: false
    })}
  `;
  if (!asArticle) return `<div class="lead-next-action-commitment-pack">${content}</div>`;
  return `<article class="mini-card lead-next-action-commitment-pack">${content}</article>`;
}

function renderLeadMultiChannelFollowupPack(pack, { title = '多渠道跟进包', asArticle = true, maxItems = 4 } = {}) {
  if (!pack) return '';
  const channels = asArray(pack.channels).slice(0, maxItems);
  const chips = channels.map((item) => `${leadFollowupChannelLabel(item.channel)}${item.ready ? '' : '待补'}`);
  const content = `
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(pack.summary || '已按当前结果整理出可执行的多渠道跟进包。')}</p>
    ${pack.why_this_pack ? `<small>${escapeHtml(pack.why_this_pack)}</small>` : ''}
    ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
    <div class="action-stack compact-stack">
      ${channels.map((item) => `
        <article class="mini-card">
          <strong>${escapeHtml(leadFollowupChannelLabel(item.channel))}${item.is_primary ? ' · 优先' : ''}</strong>
          <p>${escapeHtml(item.send_window?.label || '现在先发')}${item.ready ? '' : ' · 先补联系方式'}</p>
          ${item.why_this_channel ? `<small>${escapeHtml(item.why_this_channel)}</small>` : ''}
          ${item.message_stub ? `<small>可直接发：${escapeHtml(item.message_stub)}</small>` : ''}
          ${asArray(item.risk_flags)[0]?.label ? `<small>风险：${escapeHtml(asArray(item.risk_flags).map((flag) => `${flag.label}${flag.action ? ` → ${flag.action}` : flag.reason ? ` → ${flag.reason}` : ''}`).join('；'))}</small>` : ''}
        </article>
      `).join('')}
    </div>
    ${renderLeadFollowupExperimentCard(pack.followup_experiment_card, {
      mode: 'followup_pack',
      asArticle: false
    })}
    ${pack.next_touch_asset_pack ? renderLeadNextTouchAssetPack(pack.next_touch_asset_pack, {
      title: '下一次优先发这份',
      compact: true,
      asArticle: false
    }) : ''}
  `;
  if (!asArticle) return `<div class="lead-multi-channel-followup-pack">${content}</div>`;
  return `<article class="mini-card lead-multi-channel-followup-pack">${content}</article>`;
}

function leadPatternSummaryLine(items, label) {
  const patterns = asArray(items).map((item) => String(item?.pattern || '').trim()).filter(Boolean).slice(0, 2);
  return patterns.length ? `${label}：${patterns.join('、')}` : '';
}

function renderLeadSourceQualityBenchmark(benchmark, { title = '高质量来源标准', asArticle = true } = {}) {
  if (!benchmark) return '';
  const mustHaveEvidence = asArray(benchmark.must_have_evidence).slice(0, 3);
  const preferredContactSignals = asArray(benchmark.preferred_contact_signals).slice(0, 2);
  const rejectPatterns = asArray(benchmark.reject_patterns).slice(0, 2);
  const content = `
    <strong>${escapeHtml(title)}</strong>
    ${benchmark.benchmark_scope ? `<small>${escapeHtml(benchmark.benchmark_scope)}</small>` : ''}
    ${benchmark.quality_reason_summary ? `<p>${escapeHtml(benchmark.quality_reason_summary)}</p>` : ''}
    ${mustHaveEvidence.map((item) => `<small>必须有：${escapeHtml(`${item.label || item.key || '关键证据'}${item.detail ? ` · ${item.detail}` : ''}`)}</small>`).join('')}
    ${preferredContactSignals.map((item) => `<small>优先联系方式：${escapeHtml(`${item.label || item.key || '联系方式'}${item.detail ? ` · ${item.detail}` : ''}`)}</small>`).join('')}
    ${rejectPatterns.map((item) => `<small>先排除：${escapeHtml(`${item.pattern || item.label || item.key || '低质量名单'}${item.reason ? ` · ${item.reason}` : ''}`)}</small>`).join('')}
    ${benchmark.next_action ? `<small>${escapeHtml(benchmark.next_action)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="lead-source-quality-benchmark">${content}</div>`;
  return `<article class="mini-card lead-source-quality-benchmark">${content}</article>`;
}

function captureBudgetRiskTone(riskTier) {
  return {
    low: 'success',
    medium: 'warning',
    high: 'danger'
  }[riskTier] || 'info';
}

function captureBudgetRiskLabel(riskTier) {
  return {
    low: '低风险',
    medium: '中风险',
    high: '高风险'
  }[riskTier] || (riskTier || '风险');
}

function renderLeadCaptureBudgetRiskGuard(packet, { title = '读取预算与风险守门', asArticle = true } = {}) {
  if (!packet) return '';
  const retrySummary = packet.retry_budget?.summary || '';
  const timeoutSummary = packet.page_timeout_budget?.summary || '';
  const scrollSummary = packet.scroll_budget?.summary || '';
  const providerSummary = packet.provider_cost_budget?.summary || '';
  const content = `
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(packet.summary || '当前页面读取已进入预算与风险守门。')}</p>
    <div class="keyword-list compact">
      <code>${escapeHtml(captureBudgetRiskLabel(packet.risk_tier))}</code>
      ${packet.manual_confirmation_required ? '<code>先人工确认</code>' : '<code>可继续自动跑</code>'}
      ${packet.capture_mode ? `<code>${escapeHtml(packet.capture_mode)}</code>` : ''}
    </div>
    ${packet.source_title ? `<small>${escapeHtml(`来源页：${packet.source_title}`)}</small>` : ''}
    ${packet.source_url ? `<small>${escapeHtml(packet.source_url)}</small>` : ''}
    ${packet.manual_confirmation_reason ? `<small>${escapeHtml(packet.manual_confirmation_reason)}</small>` : ''}
    ${retrySummary ? `<small>${escapeHtml(retrySummary)}</small>` : ''}
    ${timeoutSummary ? `<small>${escapeHtml(timeoutSummary)}</small>` : ''}
    ${scrollSummary ? `<small>${escapeHtml(scrollSummary)}</small>` : ''}
    ${providerSummary ? `<small>${escapeHtml(providerSummary)}</small>` : ''}
    ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="lead-capture-budget-risk-guard">${content}</div>`;
  return `<article class="mini-card lead-capture-budget-risk-guard">${content}</article>`;
}

function renderLeadSourceCaptureBenchmark(packet, { title = '页面读取基准', asArticle = true } = {}) {
  if (!packet) return '';
  const comparison = asArray(packet.provider_comparison).slice(0, 4);
  const content = `
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(packet.quality_reason_summary || '当前页面读取栈已补齐 coverage / signal / cost 对比口径。')}</p>
    <div class="quality-metrics">
      ${[
        ['覆盖率', `${packet.coverage_rate ?? 0}%`],
        ['有用信号率', `${packet.useful_signal_rate ?? 0}%`],
        ['候选产出率', `${packet.candidate_yield_rate ?? 0}%`],
        ['重试率', `${packet.retry_rate ?? 0}%`],
        ['时延', packet.avg_capture_latency?.label || ''],
        ['成本', packet.estimated_cost?.label || '']
      ].filter(([, value]) => value).map(([label, value]) => `
        <article>
          <strong>${escapeHtml(String(value))}</strong>
          <span>${escapeHtml(label)}</span>
        </article>
      `).join('')}
    </div>
    ${packet.recommended_provider?.provider_label ? `<small>${escapeHtml(`后续同类页优先：${packet.recommended_provider.provider_label}${packet.recommended_provider.reason ? ` · ${packet.recommended_provider.reason}` : ''}`)}</small>` : ''}
    ${packet.source_choice_hint ? `<small>${escapeHtml(packet.source_choice_hint)}</small>` : ''}
    ${comparison.length ? `
      <div class="action-stack compact-stack">
        ${comparison.map((item) => `
          <article class="mini-card">
            <strong>${escapeHtml(item.provider_label || item.provider_key || 'provider')}${item.used ? ' · 本次已用' : item.recommended ? ' · 推荐' : ''}</strong>
            <small>${escapeHtml(`覆盖 ${item.coverage_rate || 0}% · 信号 ${item.useful_signal_rate || 0}% · 产出 ${item.candidate_yield_rate || 0}% · 重试 ${item.retry_rate || 0}%`)}</small>
            ${item.avg_capture_latency?.label ? `<small>${escapeHtml(`时延：${item.avg_capture_latency.label}`)}</small>` : ''}
            ${item.estimated_cost?.label ? `<small>${escapeHtml(`成本：${item.estimated_cost.label}`)}</small>` : ''}
            ${item.rationale ? `<small>${escapeHtml(item.rationale)}</small>` : ''}
          </article>
        `).join('')}
      </div>
    ` : ''}
    ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="lead-source-capture-benchmark">${content}</div>`;
  return `<article class="mini-card lead-source-capture-benchmark">${content}</article>`;
}

function renderLeadNextBatchCollectionBrief(brief, { title = '下一批采集 brief', asArticle = true } = {}) {
  if (!brief) return '';
  const queryClusters = asArray(brief.query_clusters).slice(0, 2);
  const preferredSources = asArray(brief.preferred_sources).slice(0, 2);
  const keywords = asArray(brief.collection_keywords).slice(0, 6);
  const includePatterns = asArray(brief.include_patterns).slice(0, 2);
  const excludePatterns = asArray(brief.exclude_patterns).slice(0, 2);
  const nextExperiments = asArray(brief.next_experiments).slice(0, 2);
  const content = `
    <strong>${escapeHtml(title)}</strong>
    ${brief.summary ? `<p>${escapeHtml(brief.summary)}</p>` : ''}
    ${renderLeadSourceQualityBenchmark(brief.source_quality_benchmark, {
      title: '下一批高质量名单标准',
      asArticle: false
    })}
    ${renderLeadSourceCaptureBenchmark(brief.source_capture_benchmark, {
      title: '同类页面读取基准',
      asArticle: false
    })}
    ${leadPreferredSourceLine(preferredSources) ? `<small>${escapeHtml(leadPreferredSourceLine(preferredSources))}</small>` : ''}
    ${leadQueryClusterLine(queryClusters) ? `<small>${escapeHtml(leadQueryClusterLine(queryClusters))}</small>` : ''}
    ${brief.source_priority_reason ? `<small>${escapeHtml(leadSourcePriorityReasonLine(brief.source_priority_reason))}</small>` : ''}
    ${leadPatternSummaryLine(includePatterns, '优先补') ? `<small>${escapeHtml(leadPatternSummaryLine(includePatterns, '优先补'))}</small>` : ''}
    ${leadPatternSummaryLine(excludePatterns, '先排除') ? `<small>${escapeHtml(leadPatternSummaryLine(excludePatterns, '先排除'))}</small>` : ''}
    ${nextExperiments[0]?.instruction ? `<small>先测：${escapeHtml(nextExperiments.map((item) => item.instruction || '').filter(Boolean).join('；'))}</small>` : ''}
    ${brief.evidence_gap_closure_summary ? `<small>补证任务：${escapeHtml(brief.evidence_gap_closure_summary)}</small>` : ''}
    ${asArray(brief.proof_tasks).length ? `<small>优先补：${escapeHtml(asArray(brief.proof_tasks).slice(0, 2).map((item) => item.task_label || '').filter(Boolean).join('；'))}</small>` : ''}
    ${keywords.length ? `<div class="keyword-list compact">${keywords.map((keyword) => `<code>${escapeHtml(keyword)}</code>`).join('')}</div>` : ''}
  `;
  if (!asArticle) return `<div class="lead-next-batch-collection-brief">${content}</div>`;
  return `<article class="mini-card lead-next-batch-collection-brief">${content}</article>`;
}

function leadHumanFeedbackImpactTargets(targetKind) {
  return {
    source: '来源排序 / 周简报 / 下一批采集',
    script: '异议回答 / 周简报 / 下一批实验',
    objection_answer: '异议回答 / 周简报 / 下一批建议',
    weekly_founder_brief: '周简报 / 下一批建议'
  }[targetKind] || '后续推荐';
}

function renderLeadHumanFeedbackButtons({ targetKind = '', targetId = '', targetLabel = '', impact = '', compact = true } = {}) {
  if (!targetKind || !targetId) return '';
  const targetText = targetLabel || targetId;
  const impactText = impact || `这条反馈会影响：${leadHumanFeedbackImpactTargets(targetKind)}`;
  return `
    <div class="lead-feedback-inline${compact ? ' compact' : ''}">
      <div class="inline-actions">
        <button
          class="button ghost"
          data-lead-run-action="human-feedback"
          data-feedback-target-kind="${escapeHtml(targetKind)}"
          data-feedback-target-id="${escapeHtml(targetId)}"
          data-feedback-target-label="${escapeHtml(targetText)}"
          data-feedback-type="useful"
          data-feedback-impact="${escapeHtml(impactText)}"
        >有用</button>
        <button
          class="button ghost"
          data-lead-run-action="human-feedback"
          data-feedback-target-kind="${escapeHtml(targetKind)}"
          data-feedback-target-id="${escapeHtml(targetId)}"
          data-feedback-target-label="${escapeHtml(targetText)}"
          data-feedback-type="not_useful"
          data-feedback-impact="${escapeHtml(impactText)}"
        >没用</button>
      </div>
      <small>${escapeHtml(impactText)}</small>
    </div>
  `;
}

function renderLeadSourceAuthorityRecalibrationPacket(packet, { title = '来源可信度动态校准', asArticle = true } = {}) {
  if (!packet) return '';
  const items = asArray(packet.items).slice(0, 2);
  const content = `
    <strong>${escapeHtml(title)}</strong>
    ${packet.summary ? `<p>${escapeHtml(packet.summary)}</p>` : ''}
    ${renderLeadSourceQualityBenchmark(packet.source_quality_benchmark, {
      title: '这轮按什么算高质量',
      asArticle: false
    })}
    ${items.map((item) => {
      const direction = Number(item.delta || 0) > 0 ? '上调' : Number(item.delta || 0) < 0 ? '下调' : '持平';
      return `
        <div class="action-line">
          <small>${escapeHtml(`${item.source_label || item.source_kind || '公开来源'}：${direction}${item.delta ? ` ${Math.abs(Number(item.delta || 0))} 分` : ''}${item.authority_delta_reason ? ` · ${item.authority_delta_reason}` : ''}`)}</small>
          ${renderLeadHumanFeedbackButtons({
            targetKind: 'source',
            targetId: `${item.source_kind || ''}::${item.source_label || item.source_kind || '公开来源'}`,
            targetLabel: item.source_label || item.source_kind || '公开来源'
          })}
        </div>
      `;
    }).join('')}
    ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="lead-source-authority-recalibration-pack">${content}</div>`;
  return `<article class="mini-card lead-source-authority-recalibration-pack">${content}</article>`;
}

function renderLeadOutcomeReasonPacket(packet, { title = '结果原因包', maxItems = 2, asArticle = true } = {}) {
  if (!packet) return '';
  const lines = [
    ...asArray(packet.win_causes).slice(0, maxItems).map((item) => `赢因：${item.label}${item.count > 1 ? ` ×${item.count}` : ''}`),
    ...asArray(packet.loss_causes).slice(0, maxItems).map((item) => `输因：${item.label}${item.count > 1 ? ` ×${item.count}` : ''}`),
    ...asArray(packet.no_response_causes).slice(0, maxItems).map((item) => `未接通：${item.label}${item.count > 1 ? ` ×${item.count}` : ''}`),
    ...asArray(packet.invalid_lead_causes).slice(0, maxItems).map((item) => `无效线索：${item.label}${item.count > 1 ? ` ×${item.count}` : ''}`)
  ].slice(0, 4);
  if (!lines.length && !packet.summary && !packet.source_mismatch_flag) return '';
  const content = `
    <strong>${escapeHtml(title)}</strong>
    ${packet.summary ? `<p>${escapeHtml(packet.summary)}</p>` : ''}
    ${lines.map((line) => `<small>${escapeHtml(line)}</small>`).join('')}
    ${packet.source_mismatch_flag ? '<small>来源提醒：已出现来源判断错位。</small>' : ''}
    ${packet.next_action_hint ? `<small>${escapeHtml(packet.next_action_hint)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="lead-outcome-reason-pack">${content}</div>`;
  return `<article class="mini-card lead-outcome-reason-pack">${content}</article>`;
}

function renderLeadMicroScriptBrief(script) {
  if (!script) return '';
  const points = asArray(script.confirm_points).slice(0, 3);
  return `
    <div class="lead-micro-script">
      <p>${escapeHtml(script.opening || '先确认对方当前需求和方便沟通时间。')}</p>
      ${points.length ? `<ul>${points.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>` : ''}
      ${script.close ? `<small>${escapeHtml(script.close)}</small>` : ''}
    </div>
  `;
}

function leadSignalTone(status) {
  return {
    validated_feedback_ready: 'success',
    signals_collected: 'info',
    empty: 'warning'
  }[status] || 'info';
}

function leadSignalStatusLabel(status) {
  return {
    validated_feedback_ready: '已沉淀验证反馈',
    signals_collected: '已收集真实 signal',
    empty: '还没有 signal'
  }[status] || 'Signal packet';
}

function renderLeadSignalNeedLines(signals) {
  return asArray(signals).map((signal) => {
    const detail = [
      signal.evidence || asArray(signal.examples).join('、') || signal.angle || '已从真实来源提炼。',
      asArray(signal.gate_reasons)[0] || ''
    ].filter(Boolean).join(' · ');
    return `
      <div class="lead-signal-line">
        <p>${escapeHtml(signal.label || signal.key || '需求 signal')}${signal.matched_count ? ` · 匹配 ${escapeHtml(String(signal.matched_count))} 条` : ''}${signal.priority_rank ? ` · P${escapeHtml(String(signal.priority_rank))}` : ''}</p>
        <small>${escapeHtml(truncateText(detail, 96))}</small>
      </div>
    `;
  }).join('');
}

function renderLeadSignalAngleLines(angles) {
  return asArray(angles).map((angle) => {
    const detail = [
      angle.angle,
      asArray(angle.recommended_variants).length ? `适配：${asArray(angle.recommended_variants).join(' / ')}` : '',
      angle.supporting_evidence
    ].filter(Boolean).join(' · ');
    return `
      <div class="lead-signal-line">
        <p>${escapeHtml(angle.label || angle.key || '推荐开口')}${angle.priority_rank ? ` · 优先 ${escapeHtml(String(angle.priority_rank))}` : ''}</p>
        <small>${escapeHtml(truncateText(detail || '先按当前 signal 开口，再确认真实需求。', 110))}</small>
      </div>
    `;
  }).join('');
}

function renderLeadSignalFeedbackLines(feedback) {
  return asArray(feedback).map((item) => {
    const tone = item.status === 'validated' ? 'success' : item.status === 'blocked' ? 'warning' : 'info';
    const label = item.status === 'validated' ? '已验证' : item.status === 'blocked' ? '先避开' : '待观察';
    const detail = item.evidence || item.repeat_rule || item.name || '已由真实结果补充。';
    return `
      <div class="lead-signal-line">
        <div class="lead-signal-line-head">
          <span class="chip ${tone}">${escapeHtml(label)}</span>
        </div>
        <p>${escapeHtml(item.signal || item.name || '结果反馈')}</p>
        <small>${escapeHtml(truncateText(detail, 110))}</small>
      </div>
    `;
  }).join('');
}

function renderLeadSignalEvidenceLines(sourceEvidence, painEvidence) {
  if (asArray(sourceEvidence).length) {
    return asArray(sourceEvidence).map((item) => `
      <div class="lead-signal-line">
        <p>${escapeHtml(item.source_label || item.source_kind || '公开来源')}</p>
        <small>${escapeHtml(truncateText(item.evidence || item.source_url || '有来源证据可回看。', 110))}</small>
      </div>
    `).join('');
  }
  return asArray(painEvidence).map((item) => `
    <div class="lead-signal-line">
      <p>${escapeHtml(item.company_name || item.contact_name || item.source_label || '原话证据')}</p>
      <small>${escapeHtml(truncateText(item.text || item.source_evidence || '已记录真实需求原话。', 110))}</small>
    </div>
  `).join('');
}

function renderLeadSignalIntentLines(intents) {
  return asArray(intents).map((item) => `
    <div class="lead-signal-line">
      <p>${escapeHtml(item.label || item.key || 'SERP 意图')}</p>
      <small>${escapeHtml(truncateText([item.landing_expectation, asArray(item.handoff_terms).join(' / '), item.evidence].filter(Boolean).join(' · '), 110))}</small>
    </div>
  `).join('');
}

function renderLeadSignalMarketLines(offers, objections, competitors) {
  const lines = [
    ...asArray(offers).slice(0, 2).map((item) => ({
      title: item.label || item.key || '承接卖点',
      detail: [item.promise, item.cta, item.evidence].filter(Boolean).join(' · ')
    })),
    ...asArray(objections).slice(0, 2).map((item) => ({
      title: item.label || item.key || '异议模式',
      detail: [item.response_angle, item.evidence].filter(Boolean).join(' · ')
    })),
    ...asArray(competitors).slice(0, 1).map((item) => ({
      title: item.source_label || '公开页承接',
      detail: [item.positioning, item.cta, item.faq_hint].filter(Boolean).join(' · ')
    }))
  ].slice(0, 4);
  return lines.map((item) => `
    <div class="lead-signal-line">
      <p>${escapeHtml(item.title || '市场承接')}</p>
      <small>${escapeHtml(truncateText(item.detail || '已沉淀公开页承接线索。', 116))}</small>
    </div>
  `).join('');
}

function renderLeadSignalPacket(packet, { mode = 'workflow', extraClass = '' } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const needSignals = asArray(packet.need_signals).slice(0, mode === 'today' ? 2 : 3);
  const messageAngles = asArray(packet.message_angles).slice(0, mode === 'today' ? 2 : 3);
  const feedback = asArray(packet.validated_signal_feedback).slice(0, mode === 'today' ? 2 : 3);
  const sourceEvidence = asArray(packet.source_evidence).slice(0, mode === 'today' ? 2 : 3);
  const painEvidence = asArray(packet.pain_evidence).slice(0, mode === 'today' ? 2 : 3);
  const serpIntents = asArray(packet.serp_intents).slice(0, mode === 'today' ? 1 : 2);
  const offerPatterns = asArray(packet.offer_patterns).slice(0, 2);
  const objectionPatterns = asArray(packet.objection_patterns).slice(0, 2);
  const competitorSnapshots = asArray(packet.competitor_positioning_snapshot).slice(0, 2);
  const sourceKinds = asArray(packet.source_kinds).slice(0, 4);
  const signalQualityGate = packet.signal_quality_gate || null;
  const hasContent = needSignals.length || messageAngles.length || feedback.length || sourceEvidence.length || painEvidence.length || serpIntents.length || offerPatterns.length || objectionPatterns.length || competitorSnapshots.length || packet.summary || packet.next_action;
  if (!hasContent) return '';
  const counts = packet.counts || {};
  const className = ['lead-signal-card', mode === 'workflow' ? '' : mode, extraClass].filter(Boolean).join(' ');
  const title = mode === 'result'
    ? '这轮结果沉淀了哪些 signal'
    : mode === 'today'
      ? '今天先按这些 signal 推进'
      : '为什么这轮线索值得现在联系';
  const metaTags = [
    Number(counts.import_ready || 0) ? `${counts.import_ready} 条可直接联系` : '',
    Number(counts.need_signals || 0) ? `${counts.need_signals} 个需求 signal` : '',
    Number(counts.rejected_need_signals || 0) ? `${counts.rejected_need_signals} 个待补证据` : '',
    Number(counts.serp_intents || 0) ? `${counts.serp_intents} 个搜索承接` : '',
    Number(counts.validated_feedback || 0) ? `${counts.validated_feedback} 条验证反馈` : '',
    ...sourceKinds
  ].filter(Boolean).slice(0, 5);
  const evidenceTitle = feedback.length ? '哪些已经被验证 / 该避开' : '公开来源与原话证据';
  return `
    <section class="${className}">
      <div class="lead-signal-head">
        <div>
          <span class="chip ${leadSignalTone(packet.status)}">${escapeHtml(leadSignalStatusLabel(packet.status))}</span>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(packet.summary || '系统会把公开来源、需求原话和结果回写沉淀成可复用 signal。')}</p>
        </div>
        ${metaTags.length ? `<div class="keyword-list compact">${metaTags.map((item) => `<code>${escapeHtml(item)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="lead-signal-grid">
        <article class="mini-card">
          <strong>${mode === 'result' ? '有效需求 signal' : '现在先抓的信号'}</strong>
          ${needSignals.length
            ? renderLeadSignalNeedLines(needSignals)
            : '<p>还没有足够 signal，先继续采集并导入真实结果。</p>'}
        </article>
        <article class="mini-card">
          <strong>${mode === 'today' ? '建议怎么开口' : '建议开口角度'}</strong>
          ${messageAngles.length
            ? renderLeadSignalAngleLines(messageAngles)
            : '<p>还没有可复用开口角度，先积累公开来源和回写结果。</p>'}
        </article>
        <article class="mini-card">
          <strong>${evidenceTitle}</strong>
          ${(feedback.length || sourceEvidence.length || painEvidence.length)
            ? (feedback.length ? renderLeadSignalFeedbackLines(feedback) : renderLeadSignalEvidenceLines(sourceEvidence, painEvidence))
            : '<p>还没有形成稳定证据链，先把来源和结果写回当前 run。</p>'}
        </article>
      </div>
      ${(serpIntents.length || offerPatterns.length || objectionPatterns.length || competitorSnapshots.length) ? `
        <div class="action-stack compact-stack">
          ${serpIntents.length ? `
            <article class="mini-card">
              <strong>搜索词在承接什么</strong>
              ${renderLeadSignalIntentLines(serpIntents)}
            </article>
          ` : ''}
          ${(offerPatterns.length || objectionPatterns.length || competitorSnapshots.length) ? `
            <article class="mini-card">
              <strong>公开页怎么承接与化解顾虑</strong>
              ${renderLeadSignalMarketLines(offerPatterns, objectionPatterns, competitorSnapshots)}
            </article>
          ` : ''}
        </div>
      ` : ''}
      ${signalQualityGate?.summary ? `<small class="lead-signal-next">门槛：${escapeHtml(signalQualityGate.summary)}</small>` : ''}
      ${packet.next_action ? `<small class="lead-signal-next">下一步：${escapeHtml(packet.next_action)}</small>` : ''}
    </section>
  `;
}

function leadCaptureProofGateTone(status) {
  return {
    pass: 'success',
    hold: 'warning',
    retry: 'warning',
    reject: 'danger'
  }[status] || 'info';
}

function leadCaptureProofGateLabel(status) {
  return {
    pass: '可继续导入',
    hold: '先保留待判断',
    retry: '先重试读取',
    reject: '当前先拦下'
  }[status] || '页面读取证明';
}

function renderLeadCaptureProofSurface(packet, { mode = 'result', extraClass = '' } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const evidence = asArray(packet.evidence_highlights).slice(0, mode === 'commander' ? 2 : 3);
  const signals = asArray(packet.signal_highlights).slice(0, mode === 'commander' ? 2 : 3);
  const trust = asArray(packet.trust_highlights).slice(0, mode === 'commander' ? 2 : 3);
  const chips = [
    packet.access_label || '',
    packet.source_label || '',
    packet.quality_gate_status ? leadCaptureProofGateLabel(packet.quality_gate_status) : '',
    packet.capture_mode === 'authenticated_page_capture' ? '已授权读取' : '',
    packet.capture_mode === 'logged_community_capture' ? '登录社区只读' : ''
  ].filter(Boolean).slice(0, 4);
  if (mode === 'commander') {
    return `
      <div class="command-help">
        <strong>最近一次页面读取证明</strong>
        <p>${escapeHtml(packet.summary || '这里会说明系统最近读了哪个页面、读回了什么、为什么可信。')}</p>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
        ${packet.source_title ? `<small>读了：${escapeHtml(packet.source_title)}</small>` : ''}
        ${packet.access_summary ? `<small>读取口径：${escapeHtml(packet.access_summary)}</small>` : ''}
        ${evidence.length ? `<small>读回证据：${evidence.map((item) => escapeHtml(item)).join('；')}</small>` : ''}
        ${signals.length ? `<small>抽回信号：${signals.map((item) => escapeHtml(item)).join('；')}</small>` : ''}
        ${trust.length ? `<small>为什么可信：${trust.map((item) => escapeHtml(item)).join('；')}</small>` : ''}
      </div>
    `;
  }
  const className = ['lead-run-result-bridge-card', extraClass].filter(Boolean).join(' ');
  return `
    <article class="${className}">
      <span class="chip ${leadCaptureProofGateTone(packet.quality_gate_status)}">${escapeHtml(mode === 'today' ? '页面证明' : '页面读取证明')}</span>
      <strong>${escapeHtml(packet.source_title || '最近一次读取页面')}</strong>
      <p>${escapeHtml(packet.summary || '这轮页面读取已经收成主链可回看的页面证明。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">
        ${packet.source_url ? `<small>· 来源页：${escapeHtml(packet.source_url)}</small>` : ''}
        ${packet.access_summary ? `<small>· 读取口径：${escapeHtml(packet.access_summary)}</small>` : ''}
        ${evidence.length ? `<small>· 读回证据：${evidence.map((item) => escapeHtml(item)).join('；')}</small>` : ''}
        ${signals.length ? `<small>· 抽回信号：${signals.map((item) => escapeHtml(item)).join('；')}</small>` : ''}
        ${trust.length ? `<small>· 为什么可信：${trust.map((item) => escapeHtml(item)).join('；')}</small>` : ''}
      </div>
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </article>
  `;
}

function leadMainlineMemoryCardLabel(kind) {
  return {
    source_memory_card: '来源记忆',
    script_memory_card: '开口记忆',
    objection_memory_card: '异议记忆',
    commitment_memory_card: '承诺记忆',
    outcome_memory_card: '结果记忆',
    founder_decision_memory_card: '老板决策记忆'
  }[kind] || '主链记忆';
}

function renderLeadMainlineMemoryFabric(packet, { mode = 'result', extraClass = '' } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const recalled = asArray(packet.recalled_cards).slice(0, mode === 'commander' ? 2 : 3);
  const dropped = asArray(packet.dropped_cards).slice(0, mode === 'commander' ? 1 : 2);
  const chips = [
    recalled.length ? `带入 ${recalled.length} 条` : '',
    asArray(packet.memory_cards).length ? `${asArray(packet.memory_cards).length} 条候选` : '',
    dropped.length ? `压下 ${dropped.length} 条` : '',
    packet.recall_limit ? `上限 ${packet.recall_limit}` : ''
  ].filter(Boolean);
  const recalledLines = recalled.map((item) => {
    const summary = item?.memory_summary || '';
    const freshness = item?.freshness?.label ? ` · ${item.freshness.label}` : '';
    const confidence = item?.confidence?.label ? ` · ${item.confidence.label}` : '';
    return `${leadMainlineMemoryCardLabel(item?.card_kind)}：${summary}${freshness}${confidence}`;
  }).filter(Boolean);
  const droppedLines = dropped.map((item) => {
    const summary = item?.memory_summary || leadMainlineMemoryCardLabel(item?.card_kind);
    const reason = item?.not_recalled_reason || item?.do_not_apply_when || '这轮先不带。';
    return `${leadMainlineMemoryCardLabel(item?.card_kind)}：${summary}；不带原因：${reason}`;
  }).filter(Boolean);
  if (mode === 'commander') {
    return `
      <div class="command-help">
        <strong>${escapeHtml(packet.title || '主链记忆织网')}</strong>
        <p>${escapeHtml(packet.recall_explanation || packet.summary || '这里会说明这轮记住了什么、为什么继续带，以及为什么没带另一批记忆。')}</p>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
        ${recalledLines[0] ? `<small>继续带：${escapeHtml(recalledLines[0])}</small>` : ''}
        ${droppedLines[0] ? `<small>先不带：${escapeHtml(droppedLines[0])}</small>` : ''}
      </div>
    `;
  }
  if (mode === 'today') {
    return `
      <article class="${['today-mainline-card', extraClass].filter(Boolean).join(' ')}">
        <div class="today-mainline-head">
          <div>
            <span class="chip info">主链记忆</span>
            <strong>${escapeHtml(packet.title || '这轮继续带哪几条记忆')}</strong>
            <p>${escapeHtml(packet.summary || '系统已把这轮真正值得继续沿用的主链记忆压缩出来。')}</p>
          </div>
          ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
        </div>
        <div class="today-evidence-grid">
          <div class="today-mainline-section">
            <span class="today-mainline-section-title">这轮继续带着的记忆</span>
            ${recalledLines.length ? recalledLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('') : '<p>当前没有足够强的历史记忆，先按最新结果推进。</p>'}
          </div>
          <div class="today-mainline-section">
            <span class="today-mainline-section-title">为什么没带另一批</span>
            ${droppedLines.length ? droppedLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('') : '<p>当前候选记忆不多，这轮先不用额外裁剪。</p>'}
            ${packet.recall_explanation ? `<small>${escapeHtml(packet.recall_explanation)}</small>` : ''}
          </div>
        </div>
      </article>
    `;
  }
  return `
    <article class="${['lead-run-result-bridge-card', extraClass].filter(Boolean).join(' ')}">
      <span class="chip info">主链记忆</span>
      <strong>${escapeHtml(packet.title || '这轮继续带哪几条记忆')}</strong>
      <p>${escapeHtml(packet.summary || '系统已把这轮真正值得继续沿用的主链记忆压缩出来。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">
        ${recalledLines.map((line) => `<small>· ${escapeHtml(line)}</small>`).join('')}
        ${droppedLines.map((line) => `<small>· ${escapeHtml(line)}</small>`).join('')}
      </div>
      ${packet.recall_explanation ? `<small>${escapeHtml(packet.recall_explanation)}</small>` : ''}
    </article>
  `;
}

function renderLeadSkillProofSurface(packet, { mode = 'result', extraClass = '' } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const retirementPacket = packet.mainline_skill_retirement_packet || null;
  const activeMemory = asArray(packet.active_memory_summary).slice(0, mode === 'commander' ? 2 : 3);
  const activeSkills = asArray(packet.active_skill_summary).slice(0, mode === 'commander' ? 2 : 3);
  const outcomes = asArray(packet.supporting_outcomes).slice(0, mode === 'commander' ? 2 : 3);
  const blockedActions = asArray(packet.blocked_actions).slice(0, mode === 'commander' ? 1 : 2);
  const retiredSkills = asArray(retirementPacket?.retired_skill_refs).slice(0, mode === 'commander' ? 1 : 2);
  const nextExperiment = packet.next_experiment || null;
  const totalOutcomeCount = outcomes.reduce((sum, item) => sum + Math.max(0, Number(item?.outcome_count || 0) || 0), 0);
  const chips = [
    activeMemory.length ? `带入 ${activeMemory.length} 条记忆` : '',
    activeSkills.length ? `沿用 ${activeSkills.length} 条技能` : '',
    totalOutcomeCount ? `${totalOutcomeCount} 次真实结果` : outcomes.length ? `${outcomes.length} 组结果依据` : '',
    blockedActions.length ? `${blockedActions.length} 处仍需判断` : '',
    retiredSkills.length ? `${retiredSkills.length} 条技能已停用` : ''
  ].filter(Boolean).slice(0, 4);
  const memoryLines = activeMemory.map((item) => {
    const takeaway = item?.business_takeaway || item?.why_it_matters || item?.content || '';
    return `${item?.memory_label || '当前记忆'}：${takeaway}`;
  }).filter(Boolean);
  const skillLines = activeSkills.map((item) => {
    const reason = item?.expected_use_case || item?.why_used || '';
    return `${item?.skill_kind_label || '当前技能'} · ${item?.skill_label || '当前做法'}${reason ? `：${reason}` : ''}`;
  }).filter(Boolean);
  const outcomeLines = outcomes.map((item) => {
    const label = item?.label || '真实结果';
    const evidence = item?.evidence || '';
    const count = Number(item?.outcome_count || 0) > 0 ? `（${item.outcome_count} 次）` : '';
    return `${label}${count}：${evidence}`;
  }).filter(Boolean);
  const blockedLines = blockedActions.map((item) =>
    `${item?.action_label || '当前动作'}：${item?.why_manual_decision || item?.reason || '这一步仍需老板判断。'}`
  ).filter(Boolean);
  const retirementLines = retiredSkills.map((item) => {
    const replacement = asArray(item?.replacement_candidates)[0] || null;
    return `${item?.skill_label || '当前技能'}：${item?.rollback_reason || item?.founder_notice || '这条技能已先停用。'}${replacement?.candidate_label ? ` 先改用${replacement.candidate_label}。` : ''}`;
  }).filter(Boolean);
  if (mode === 'commander') {
    return `
      <div class="command-help">
        <strong>${escapeHtml(packet.title || '这轮为什么这样建议')}</strong>
        <p>${escapeHtml(packet.recommendation_reason || packet.summary || '这里会解释这轮建议背后用了哪条记忆、哪条技能、哪批真实结果。')}</p>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
        ${memoryLines[0] ? `<small>当前记忆：${escapeHtml(memoryLines[0])}</small>` : ''}
        ${skillLines[0] ? `<small>当前技能：${escapeHtml(skillLines[0])}</small>` : ''}
        ${outcomeLines[0] ? `<small>真实结果：${escapeHtml(outcomeLines[0])}</small>` : ''}
        ${blockedLines[0] ? `<small>仍要老板判断：${escapeHtml(blockedLines[0])}</small>` : ''}
        ${retirementLines[0] ? `<small>已先停用：${escapeHtml(retirementLines[0])}</small>` : ''}
      </div>
    `;
  }
  if (mode === 'today') {
    const className = ['today-mainline-card', extraClass].filter(Boolean).join(' ');
    return `
      <article class="${className}">
        <div class="today-mainline-head">
          <div>
            <span class="chip info">为什么这样建议</span>
            <strong>${escapeHtml(packet.title || '当前建议依据')}</strong>
            <p>${escapeHtml(packet.recommendation_reason || packet.summary || '系统已把这轮建议背后的记忆、技能和真实结果收口成一张业务证明卡。')}</p>
          </div>
          ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
        </div>
        <div class="today-evidence-grid">
          <div class="today-mainline-section">
            <span class="today-mainline-section-title">当前实际沿用的记忆 / 技能</span>
            ${memoryLines.length ? memoryLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('') : '<p>当前还没有足够强的历史记忆，先按最新结果推进。</p>'}
            ${skillLines.length ? skillLines.map((line) => `<small>${escapeHtml(line)}</small>`).join('') : '<small>当前还没有进入默认沿用的技能，先继续观察真实回写。</small>'}
          </div>
          <div class="today-mainline-section">
            <span class="today-mainline-section-title">这些结论为什么站得住</span>
            ${outcomeLines.length ? outcomeLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('') : '<p>完成更多真实结果回写后，这里会继续显示具体支撑样本。</p>'}
            ${blockedLines.length ? blockedLines.map((line) => `<small>${escapeHtml(`仍需老板判断：${line}`)}</small>`).join('') : '<small>当前没有必须额外拦下的高风险动作。</small>'}
            ${retirementLines.length ? retirementLines.map((line) => `<small>${escapeHtml(`已先停用：${line}`)}</small>`).join('') : ''}
          </div>
        </div>
        ${nextExperiment?.instruction || nextExperiment?.title ? `<small>${escapeHtml(`下一轮先试：${nextExperiment.instruction || nextExperiment.title}`)}</small>` : ''}
      </article>
    `;
  }
  const className = ['lead-run-result-bridge-card', extraClass].filter(Boolean).join(' ');
  const detailLines = [
    ...memoryLines.map((line) => `当前记忆：${line}`),
    ...skillLines.map((line) => `当前技能：${line}`),
    ...outcomeLines.map((line) => `真实结果：${line}`),
    ...blockedLines.map((line) => `仍要老板判断：${line}`),
    ...retirementLines.map((line) => `已先停用：${line}`),
    nextExperiment?.instruction || nextExperiment?.title ? `下一轮先试：${nextExperiment.instruction || nextExperiment.title}` : ''
  ].filter(Boolean).slice(0, 5);
  return `
    <article class="${className}">
      <span class="chip info">${escapeHtml(mode === 'result' ? '技能证明面' : '建议依据')}</span>
      <strong>${escapeHtml(packet.title || '这轮为什么这样建议')}</strong>
      <p>${escapeHtml(packet.summary || packet.recommendation_reason || '系统已把这轮建议背后的记忆、技能和结果依据收口成主链证明面。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">
        ${detailLines.length
          ? detailLines.map((line) => `<small>· ${escapeHtml(line)}</small>`).join('')
          : '<small>· 完成更多真实回写后，这里会继续解释为什么下一轮仍建议沿用当前打法。</small>'}
      </div>
      ${packet.recommendation_reason ? `<small>${escapeHtml(packet.recommendation_reason)}</small>` : ''}
    </article>
  `;
}

function leadExperimentQueueKindLabel(kind) {
  return {
    source_experiment: '来源实验',
    script_experiment: '开口实验',
    followup_experiment: '跟进实验'
  }[kind] || '主链实验';
}

function renderLeadMainlineExperimentQueue(packet, { mode = 'result', extraClass = '' } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const allExperiments = asArray(packet.experiments);
  const experiments = (
    mode === 'today'
      ? allExperiments.filter((item) => item?.experiment_kind !== 'source_experiment')
      : allExperiments
  ).slice(0, mode === 'commander' ? 2 : 3);
  if (!experiments.length) return '';
  const chips = [
    allExperiments.length ? `${allExperiments.length} 个主链实验` : '',
    asArray(packet.source_experiments).length ? `${asArray(packet.source_experiments).length} 个来源` : '',
    asArray(packet.script_experiments).length ? `${asArray(packet.script_experiments).length} 个开口` : '',
    asArray(packet.followup_experiments).length ? `${asArray(packet.followup_experiments).length} 个跟进` : '',
    asArray(packet.stop_now_experiments).length ? `${asArray(packet.stop_now_experiments).length} 个先停` : '',
    asArray(packet.safe_to_continue).length ? `${asArray(packet.safe_to_continue).length} 个继续看` : ''
  ].filter(Boolean).slice(0, 4);
  const detailLines = experiments.map((item) => {
    const decisionLabel = item?.stoploss_decision_label;
    const prefix = decisionLabel === 'stop_now'
      ? `先停 · ${leadExperimentQueueKindLabel(item?.experiment_kind)}`
      : decisionLabel === 'safe_to_continue'
        ? `继续看 · ${leadExperimentQueueKindLabel(item?.experiment_kind)}`
        : `${item?.queue_priority_label || '先试'} · ${leadExperimentQueueKindLabel(item?.experiment_kind)}`;
    const reason = (
      item?.stoploss_decision_summary
      || item?.experiment_reason_summary
    )
      ? `；${decisionLabel === 'stop_now' ? '为什么先停' : decisionLabel === 'safe_to_continue' ? '继续观察理由' : '为什么先试'}：${item?.stoploss_decision_summary || item?.experiment_reason_summary}`
      : '';
    return `${prefix}：${item?.planned_change || item?.hypothesis || '继续沿当前主链推进。'}${reason}`;
  }).filter(Boolean);
  const signalLines = experiments.map((item) => {
    if (item?.stoploss_decision_label === 'stop_now') {
      return [
        item?.stop_signal ? `停手信号：${item.stop_signal}` : '',
        item?.replacement_focus ? `改放重点：${item.replacement_focus}` : ''
      ].filter(Boolean).join('；');
    }
    if (item?.stoploss_decision_label === 'safe_to_continue') {
      return [
        item?.success_signal ? `继续看信号：${item.success_signal}` : '',
        item?.continue_guardrail ? `继续守住：${item.continue_guardrail}` : ''
      ].filter(Boolean).join('；');
    }
    const success = item?.success_signal ? `成功信号：${item.success_signal}` : '';
    const stop = item?.stop_signal ? `停手信号：${item.stop_signal}` : '';
    return [success, stop].filter(Boolean).join('；');
  }).filter(Boolean);
  if (mode === 'commander') {
    return `
      <div class="command-help">
        <strong>${escapeHtml(packet.title || '下一轮先试这几件事')}</strong>
        <p>${escapeHtml(packet.summary || '这里会收口说明下一轮最该先试的来源、开口和跟进动作。')}</p>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
        ${detailLines[0] ? `<small>${escapeHtml(detailLines[0])}</small>` : ''}
        ${signalLines[0] ? `<small>${escapeHtml(signalLines[0])}</small>` : ''}
        ${packet.experiment_stoploss_summary ? `<small>${escapeHtml(packet.experiment_stoploss_summary)}</small>` : ''}
        ${experiments[0]?.owner_hint ? `<small>${escapeHtml(experiments[0].owner_hint)}</small>` : ''}
      </div>
    `;
  }
  if (mode === 'today') {
    return `
      <article class="${['today-mainline-card', extraClass].filter(Boolean).join(' ')}">
        <div class="today-mainline-head">
          <div>
            <span class="chip warning">今天先试什么</span>
            <strong>${escapeHtml(packet.title || '主链实验队列')}</strong>
            <p>${escapeHtml(packet.summary || '系统已把今天最该先试的开口和跟进动作收成一张实验卡。')}</p>
          </div>
          ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
        </div>
        <div class="today-evidence-grid">
          <div class="today-mainline-section">
            <span class="today-mainline-section-title">这轮优先试的动作</span>
            ${detailLines.length ? detailLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('') : '<p>完成更多结果回写后，这里会继续收紧成更具体的实验动作。</p>'}
          </div>
          <div class="today-mainline-section">
            <span class="today-mainline-section-title">怎么判断要继续还是停手</span>
            ${signalLines.length ? signalLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('') : '<p>系统会继续根据回写结果决定这条实验该继续放大还是先停下。</p>'}
            ${packet.experiment_stoploss_summary ? `<small>${escapeHtml(packet.experiment_stoploss_summary)}</small>` : ''}
            ${experiments[0]?.owner_hint ? `<small>${escapeHtml(experiments[0].owner_hint)}</small>` : ''}
          </div>
        </div>
      </article>
    `;
  }
  return `
    <article class="${['lead-run-result-bridge-card', extraClass].filter(Boolean).join(' ')}">
      <span class="chip warning">主链实验队列</span>
      <strong>${escapeHtml(packet.title || '下一轮先试这几件事')}</strong>
      <p>${escapeHtml(packet.summary || '系统已把下一轮最该先试的几件事收成主链实验队列。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">
        ${detailLines.map((line) => `<small>· ${escapeHtml(line)}</small>`).join('')}
        ${signalLines[0] ? `<small>· ${escapeHtml(signalLines[0])}</small>` : ''}
        ${packet.experiment_stoploss_summary ? `<small>· ${escapeHtml(packet.experiment_stoploss_summary)}</small>` : ''}
        ${experiments[0]?.owner_hint ? `<small>· ${escapeHtml(experiments[0].owner_hint)}</small>` : ''}
      </div>
      ${packet.experiment_reason_summary ? `<small>${escapeHtml(packet.experiment_reason_summary)}</small>` : ''}
    </article>
  `;
}

function renderLeadSourceExperimentCard(packet, { mode = 'discovery', extraClass = '' } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const targetSources = asArray(packet.target_sources).slice(0, 3);
  const targetClusters = asArray(packet.target_query_clusters).slice(0, 3);
  const includePatterns = asArray(packet.include_patterns).slice(0, 2);
  const excludePatterns = asArray(packet.exclude_patterns).slice(0, 2);
  const tone = mode === 'import' ? 'warning' : 'info';
  return `
    <div class="${['next-batch-memory-guidance', extraClass].filter(Boolean).join(' ')}">
      <span class="chip ${tone}">${escapeHtml(mode === 'import' ? '导入前来源实验' : '来源实验桥')}</span>
      <strong>${escapeHtml(packet.title || '这轮先验证的来源假设')}</strong>
      <p>${escapeHtml(packet.summary || '系统已把这轮最值得先测的来源假设收成主链卡片。')}</p>
      ${packet.evidence_reason ? `<small>${escapeHtml(packet.evidence_reason)}</small>` : ''}
      ${targetSources.length ? `<small>优先来源：${targetSources.map((item) => escapeHtml(`${item.source_label || item.source_kind || '来源'}${item.source_priority_reason ? `（${item.source_priority_reason}）` : ''}`)).join('；')}</small>` : ''}
      ${targetClusters.length ? `<small>问题簇：${targetClusters.map((item) => escapeHtml(item.label || item.key || '问题簇')).join('、')}</small>` : ''}
      ${packet.expected_candidate_profile ? `<small>预期名单：${escapeHtml(packet.expected_candidate_profile)}</small>` : ''}
      ${(includePatterns.length || excludePatterns.length) ? `
        <div class="keyword-list compact">
          ${includePatterns.map((item) => `<code>${escapeHtml(`补 ${item.pattern || '这类线索'}`)}</code>`).join('')}
          ${excludePatterns.map((item) => `<code>${escapeHtml(`排 ${item.pattern || '这类来源'}`)}</code>`).join('')}
        </div>
      ` : ''}
      ${packet.success_signal ? `<small>成功信号：${escapeHtml(packet.success_signal)}</small>` : ''}
      ${packet.abort_signal ? `<small>停手信号：${escapeHtml(packet.abort_signal)}</small>` : ''}
    </div>
  `;
}

function renderLeadScriptExperimentCard(packet, { mode = 'today', extraClass = '' } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const proofSequence = asArray(packet.proof_sequence).slice(0, 3);
  const riskyClaims = asArray(packet.risky_claims_to_avoid).slice(0, 2);
  const title = packet.title || '这轮先试的脚本变化';
  const chipLabel = mode === 'approval'
    ? '审批前脚本实验'
    : mode === 'result'
      ? '脚本实验回看'
      : '今天先试的脚本实验';
  return `
    <article class="${['mini-card', extraClass].filter(Boolean).join(' ')}">
      <span class="chip ${packet.founder_approval_needed ? 'warning' : 'info'}">${escapeHtml(chipLabel)}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(packet.summary || '系统已把这轮脚本实验收成可直接执行的一张卡。')}</p>
      ${packet.target_persona ? `<small>适用对象：${escapeHtml(packet.target_persona)}</small>` : ''}
      ${packet.opener_variant?.opener ? `<small>先试开口：${escapeHtml(`${packet.opener_variant.opener_label || '当前开口'} · ${packet.opener_variant.opener}`)}</small>` : ''}
      ${proofSequence.length ? `<small>证据顺序：${proofSequence.map((item) => escapeHtml(item.label || item.instruction || '当前证据')).join(' → ')}</small>` : ''}
      ${packet.objection_branch?.objection_pattern ? `<small>重点异议：${escapeHtml(`${packet.objection_branch.objection_pattern} → ${packet.objection_branch.recommended_answer || '先按当前回答承接'}`)}</small>` : ''}
      ${packet.experiment_reason ? `<small>${escapeHtml(packet.experiment_reason)}</small>` : ''}
      ${packet.success_signal ? `<small>成功信号：${escapeHtml(packet.success_signal)}</small>` : ''}
      ${packet.founder_approval_needed ? `<small>需老板确认：${escapeHtml(packet.approval_reason || '这轮脚本实验仍有高风险边界，先人工确认。')}</small>` : ''}
      ${riskyClaims.length ? `<small>先别说：${riskyClaims.map((item) => escapeHtml(item.phrase || '')).filter(Boolean).join('；')}</small>` : ''}
    </article>
  `;
}

function renderLeadFollowupExperimentCard(packet, { mode = 'writeback', extraClass = '', asArticle = true } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const channelMix = asArray(packet.channel_mix).slice(0, 3);
  const chipLabel = mode === 'weekly'
    ? '周简报跟进实验'
    : mode === 'tomorrow'
      ? '明日跟进实验'
      : mode === 'commitment'
        ? '下一步跟进实验'
        : mode === 'followup_pack'
          ? '渠道组合实验'
          : '回写后跟进实验';
  const content = `
    <span class="chip ${packet.founder_approval_needed ? 'warning' : 'info'}">${escapeHtml(chipLabel)}</span>
    <strong>${escapeHtml(packet.title || '这轮先试的跟进节奏')}</strong>
    <p>${escapeHtml(packet.summary || '系统已把这轮时间窗和渠道组合收成可执行的跟进实验。')}</p>
    ${packet.callback_window_variant?.label ? `<small>时间窗：${escapeHtml(packet.callback_window_variant.label)}</small>` : ''}
    ${channelMix.length ? `<small>渠道组合：${channelMix.map((item) => escapeHtml(item.label || leadFollowupChannelLabel(item.channel))).join(' → ')}</small>` : ''}
    ${packet.retry_ceiling?.label ? `<small>${escapeHtml(packet.retry_ceiling.label)}</small>` : ''}
    ${packet.message_stub ? `<small>建议话术：${escapeHtml(packet.message_stub)}</small>` : ''}
    ${packet.experiment_reason ? `<small>${escapeHtml(packet.experiment_reason)}</small>` : ''}
    ${packet.success_signal ? `<small>成功信号：${escapeHtml(packet.success_signal)}</small>` : ''}
    ${packet.stop_signal ? `<small>停手信号：${escapeHtml(packet.stop_signal)}</small>` : ''}
    ${packet.founder_boundary ? `<small>老板边界：${escapeHtml(packet.founder_boundary)}</small>` : ''}
  `;
  if (!asArticle) return `<div class="${['lead-followup-experiment-card', extraClass].filter(Boolean).join(' ')}">${content}</div>`;
  return `<article class="${['mini-card', 'lead-followup-experiment-card', extraClass].filter(Boolean).join(' ')}">${content}</article>`;
}

function renderLeadMainlineLearningHeartbeat(packet, { extraClass = '' } = {}) {
  if (!packet || typeof packet !== 'object') return '';
  const playbookEvidenceLearning = packet.playbook_evidence_learning_heartbeat || null;
  const playbookEvidenceLearningSummary = String(
    packet.playbook_evidence_learning_summary
    || playbookEvidenceLearning?.summary
    || ''
  ).trim();
  const triggerSources = asArray(packet.trigger_sources).slice(0, 4);
  const refreshedMemories = asArray(packet.refreshed_memories).slice(0, 3);
  const promotedSkills = asArray(packet.promoted_skills).slice(0, 3);
  const blockedPromotions = asArray(packet.blocked_promotions).slice(0, 3);
  const newSkillCandidates = asArray(packet.new_skill_candidates).slice(0, 3);
  const chips = [
    asArray(packet.processed_writebacks).length ? `${asArray(packet.processed_writebacks).length} 次回写已入学习` : '',
    refreshedMemories.length ? `${refreshedMemories.length} 条记忆已刷新` : '',
    promotedSkills.length ? `${promotedSkills.length} 条技能已升版` : '',
    blockedPromotions.length ? `${blockedPromotions.length} 条仍未放开` : '',
    playbookEvidenceLearning?.promoted_default_count ? `${playbookEvidenceLearning.promoted_default_count} 条打法默认更稳` : '',
    playbookEvidenceLearning?.stale_evidence_count ? `${playbookEvidenceLearning.stale_evidence_count} 条证据待刷新` : ''
  ].filter(Boolean).slice(0, 4);
  const detailLines = [
    playbookEvidenceLearningSummary ? `打法/证据刷新：${playbookEvidenceLearningSummary}` : '',
    ...triggerSources.map((item) => `${item?.label || '学习来源'}：${item?.summary || ''}`),
    ...refreshedMemories.map((item) => `${item?.memory_label || '主链记忆'}：${item?.summary || item?.why_reused || ''}`),
    ...promotedSkills.map((item) => `已升版技能：${item?.skill_label || '当前技能'}${item?.use_case ? ` · ${item.use_case}` : ''}`),
    ...blockedPromotions.map((item) => `暂不放开：${item?.skill_label || '当前技能'} · ${item?.block_reason || '这条技能还没过样本或审批门。'}`),
    ...newSkillCandidates.map((item) => `新技能候选：${item?.skill_label || '当前候选'} · ${item?.confidence_reason || item?.candidate_status || ''}`)
  ].filter(Boolean).slice(0, 6);
  return `
    <article class="${['lead-run-result-bridge-card', extraClass].filter(Boolean).join(' ')}">
      <span class="chip warning">学习心跳</span>
      <strong>这轮系统学到了什么</strong>
      <p>${escapeHtml(packet.learning_summary || '系统已把回写、记忆刷新和技能判断继续收进同一条主链学习心跳。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">
        ${detailLines.length
          ? detailLines.map((line) => `<small>· ${escapeHtml(line)}</small>`).join('')
          : '<small>· 完成更多真实回写后，这里会继续解释系统这轮学到了什么、为什么还没默认放开某些技能。</small>'}
      </div>
    </article>
  `;
}

function resolveLeadIndustrySellableContext(run) {
  const starterPack = run?.discovery_plan?.starter_pack || run?.public_source_adapter?.source_pack?.starter_pack || null;
  const scriptBasisPack = run?.today_contact_card?.script_basis_pack || null;
  const evidencePack = scriptBasisPack?.evidence_pack || starterPack?.evidence_pack || null;
  const objectionAnswerPack = run?.today_contact_card?.objection_answer_pack || scriptBasisPack?.objection_answer_pack || null;
  return {
    starterPack,
    topSource: asArray(starterPack?.preferred_sources)[0] || null,
    topProofPoint: asArray(evidencePack?.proof_points)[0] || null,
    topObjectionAnswer: asArray(objectionAnswerPack?.answers)[0]
      || asArray(starterPack?.objection_patterns)[0]
      || asArray(evidencePack?.objection_answers)[0]
      || null,
    resultPack: run?.delivery_result_pack || null
  };
}

function renderLeadIndustrySellableBrief(run, { compact = false } = {}) {
  const context = resolveLeadIndustrySellableContext(run);
  if (!context.starterPack) return '';
  const lines = [
    context.topSource?.source_label
      ? `先去哪找：${context.topSource.source_label}${context.topSource.source_priority_reason ? ` · ${context.topSource.source_priority_reason}` : ''}`
      : '',
    context.topProofPoint?.proof_point ? `先带哪句证据：${context.topProofPoint.proof_point}` : '',
    context.topObjectionAnswer
      ? `高频异议：${context.topObjectionAnswer.objection_pattern || context.topObjectionAnswer.label || ''}${context.topObjectionAnswer.recommended_answer || context.topObjectionAnswer.response_angle ? ` → ${context.topObjectionAnswer.recommended_answer || context.topObjectionAnswer.response_angle}` : ''}`
      : '',
    context.resultPack?.suggested_use ? `结果怎么交付：${context.resultPack.suggested_use}` : ''
  ].filter(Boolean).slice(0, compact ? 3 : 4);
  if (!lines.length) return '';
  return `
    <article class="lead-run-result-bridge-card${compact ? ' lead-run-summary-block' : ''}">
      <span class="chip success">行业可卖主链</span>
      <strong>${escapeHtml(context.starterPack.label || '当前行业包')}</strong>
      <p>${escapeHtml(context.starterPack.primary_goal || '当前行业已经收成可直接执行的获客主链。')}</p>
      <div class="lead-run-result-bridge-list">
        ${lines.map((line) => `<small>· ${escapeHtml(line)}</small>`).join('')}
      </div>
    </article>
  `;
}

function buildTodayMainlineSourceEvidence(run, lead, card) {
  const metadata = lead?.run_metadata || {};
  const adapter = metadata.public_source_adapter || {};
  const sourceLabel = card?.source_task_title
    || adapter.source_task_title
    || adapter.source_label
    || adapter.source_kind
    || asArray(run?.signal_packet?.source_kinds)[0]
    || '';
  const sourceUrl = String(metadata.source_url || adapter.source_url || '').trim();
  const pageHint = String(metadata.source_page_hint || adapter.page_position || '').trim();
  const evidence = [metadata.source_evidence, metadata.import_message, pageHint]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(' · ');
  if (!sourceLabel && !sourceUrl && !evidence) return [];
  return [{
    source_label: sourceLabel || '当前来源',
    source_kind: adapter.source_kind || '',
    source_url: sourceUrl,
    evidence: evidence || sourceUrl || '已沉淀来源证据。'
  }];
}

function resolveLeadMainlineSignalGuidance(run, card = run?.today_contact_card || null) {
  if (card?.signal_guidance_snapshot) return card.signal_guidance_snapshot;
  const sourcePack = run?.public_source_adapter?.source_pack || null;
  return sourcePack?.signal_guidance || run?.next_batch_plan?.signal_guidance || null;
}

function resolveLeadMainlineStarterPack(run) {
  return run?.public_source_adapter?.source_pack?.starter_pack || null;
}

function resolveLeadMainlineEvidencePack(run, card = run?.today_contact_card || null) {
  return card?.script_basis_pack?.evidence_pack
    || run?.script_variants?.review_feedback?.evidence_pack
    || run?.outcome_review?.evidence_pack
    || run?.next_batch_plan?.evidence_pack
    || resolveLeadMainlineStarterPack(run)?.evidence_pack
    || null;
}

function resolveLeadMainlineObjectionPatterns(run, card = run?.today_contact_card || null) {
  const cardPatterns = asArray(card?.script_basis_pack?.objection_patterns).slice(0, 2);
  if (cardPatterns.length) return cardPatterns;
  const packetPatterns = asArray(run?.signal_packet?.objection_patterns).slice(0, 2);
  if (packetPatterns.length) return packetPatterns;
  return asArray(resolveLeadMainlineStarterPack(run)?.objection_patterns).slice(0, 2);
}

function leadQueryClusterLine(queryClusters) {
  const clusters = asArray(queryClusters).slice(0, 2);
  if (!clusters.length) return '';
  return `问题簇：${clusters.map((item) => `${item.label || item.key || '问题'}${asArray(item.collection_keywords).length ? `（${asArray(item.collection_keywords).slice(0, 2).join(' / ')}）` : ''}`).join('；')}`;
}

function leadPreferredSourceLine(preferredSources) {
  const sources = asArray(preferredSources).slice(0, 2);
  if (!sources.length) return '';
  return `优先来源：${sources.map((item) => `${item.source_label || item.source_kind || '公开来源'}${item.source_authority_score ? ` ${item.source_authority_score}/100` : ''}`).join('、')}`;
}

function leadSourcePriorityReasonLine(reason) {
  const text = String(reason || '').trim();
  return text ? `为什么先采：${text}` : '';
}

function buildTodayMainlineModel(run) {
  const card = run?.today_contact_card || null;
  const workbench = run?.today_workbench || null;
  const leadId = card?.lead_id || workbench?.next_lead?.lead_id || workbench?.today_carryover?.lead_id || '';
  const lead = findLeadById(leadId);
  const packet = run?.signal_packet || null;
  const signalGuidance = resolveLeadMainlineSignalGuidance(run, card);
  const sourcePack = run?.public_source_adapter?.source_pack || null;
  const starterPack = resolveLeadMainlineStarterPack(run);
  const scriptBasisPack = card?.script_basis_pack || null;
  const sourceEvidence = asArray(packet?.source_evidence).slice(0, 2);
  const fallbackSourceEvidence = buildTodayMainlineSourceEvidence(run, lead, card);
  const queryClusters = asArray(signalGuidance?.query_clusters).length
    ? asArray(signalGuidance.query_clusters).slice(0, 2)
    : asArray(sourcePack?.query_clusters).length
      ? asArray(sourcePack.query_clusters).slice(0, 2)
      : asArray(starterPack?.query_clusters).slice(0, 2);
  const preferredSources = asArray(signalGuidance?.preferred_sources).length
    ? asArray(signalGuidance.preferred_sources).slice(0, 2)
    : asArray(sourcePack?.preferred_sources).length
      ? asArray(sourcePack.preferred_sources).slice(0, 2)
      : asArray(starterPack?.preferred_sources).slice(0, 2);
  return {
    card,
    workbench,
    proofCard: card?.lead_execution_proof_card || run?.lead_execution_proof_card || null,
    leadName: card?.lead_name || (lead ? leadDisplayName(lead) : ''),
    goal: String(run?.goal || '').trim(),
    sourceLabel: card?.source_task_title || fallbackSourceEvidence[0]?.source_label || fallbackSourceEvidence[0]?.source_kind || asArray(packet?.source_kinds)[0] || '',
    dueLabel: card?.due_at ? formatDate(card.due_at) : '',
    sourceEvidence: sourceEvidence.length ? sourceEvidence : fallbackSourceEvidence,
    painEvidence: asArray(packet?.pain_evidence).slice(0, 2),
    needSignals: asArray(packet?.need_signals).slice(0, 2),
    messageAngles: asArray(scriptBasisPack?.message_angles).length
      ? asArray(scriptBasisPack.message_angles).slice(0, 2)
      : asArray(packet?.message_angles).slice(0, 2),
    queryClusters,
    preferredSources,
    sourcePriorityReason: String(signalGuidance?.source_priority_reason || sourcePack?.source_priority_reason || starterPack?.source_priority_reason || preferredSources[0]?.source_priority_reason || '').trim(),
    evidencePack: resolveLeadMainlineEvidencePack(run, card),
    objectionPatterns: resolveLeadMainlineObjectionPatterns(run, card)
  };
}

function renderTodayContextHeaderCard(run, model = buildTodayMainlineModel(run)) {
  const { card, leadName, goal, sourceLabel, dueLabel } = model;
  if (!card) return '';
  const summary = card.summary || card.reason || '系统已把今天最该推进的对象固定到顶部。';
  const chips = [
    Number(card.score_total || 0) ? `评分 ${card.score_total}` : '',
    card.task_priority || '',
    card.route_label || '',
    card.completed_call_count ? `已联系 ${card.completed_call_count} 次` : ''
  ].filter(Boolean).slice(0, 4);
  return `
    <article class="today-mainline-card today-context-header-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${card.carryover_source === 'tomorrow_queue' ? 'warning' : 'success'}">${escapeHtml(card.carryover_source === 'tomorrow_queue' ? '今天先接明天队列' : '当前 lead')}</span>
          <strong>${escapeHtml(leadName || card.title || '今天先处理这条线索')}</strong>
          <p>${escapeHtml(summary)}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((item) => `<code>${escapeHtml(item)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-meta-grid">
        <div class="today-mainline-meta-item">
          <span>当前阶段</span>
          <strong>${escapeHtml(leadRunStageLabel(run?.current_stage))}</strong>
        </div>
        <div class="today-mainline-meta-item">
          <span>今日目标</span>
          <strong>${escapeHtml(truncateText(goal || '把这条线索推进到下一步', 42))}</strong>
        </div>
        <div class="today-mainline-meta-item">
          <span>来源</span>
          <strong>${escapeHtml(truncateText(sourceLabel || '当前获客执行', 32))}</strong>
        </div>
      </div>
      <small>${escapeHtml(dueLabel ? `任务时间：${dueLabel}` : (card.next_action || '处理完这条线索后，系统会继续接下一步。'))}</small>
    </article>
  `;
}

function renderTodayEvidenceReasonCard(run, model = buildTodayMainlineModel(run)) {
  const { card, workbench, proofCard, sourceEvidence, painEvidence, needSignals, messageAngles, queryClusters, preferredSources, sourcePriorityReason } = model;
  if (!card) return '';
  const reason = proofCard?.lead_priority_reason || card.reason || card.summary || workbench?.summary || '系统判断这条线索最值得今天先推进。';
  const prioritySignal = card.priority_signal || null;
  const priorityTone = prioritySignal?.status === 'boost'
    ? 'success'
    : prioritySignal?.status === 'review'
      ? 'warning'
      : 'info';
  return `
    <article class="today-mainline-card today-evidence-reason-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip info">为什么现在先联系</span>
          <strong>推荐理由与来源证据</strong>
          <p>${escapeHtml(reason)}</p>
        </div>
        ${prioritySignal ? `<span class="chip ${priorityTone}">${escapeHtml(prioritySignal.label || '当前优先信号')}</span>` : ''}
      </div>
      <div class="today-evidence-grid">
        <div class="today-mainline-section">
          <span class="today-mainline-section-title">来源证据</span>
          ${(sourceEvidence.length || painEvidence.length)
            ? renderLeadSignalEvidenceLines(sourceEvidence, painEvidence)
            : '<p>还没有足够来源证据，先继续补公开来源与推荐理由。</p>'}
        </div>
        <div class="today-mainline-section">
          <span class="today-mainline-section-title">需求信号</span>
          ${needSignals.length
            ? renderLeadSignalNeedLines(needSignals)
            : messageAngles.length
              ? renderLeadSignalAngleLines(messageAngles)
              : '<p>还没有稳定需求信号，先继续沉淀公开来源与结果回写。</p>'}
        </div>
        ${(queryClusters.length || preferredSources.length || sourcePriorityReason) ? `
          <div class="today-mainline-section">
            <span class="today-mainline-section-title">为什么这类来源现在排前面</span>
            ${leadQueryClusterLine(queryClusters) ? `<p>${escapeHtml(leadQueryClusterLine(queryClusters))}</p>` : ''}
            ${leadPreferredSourceLine(preferredSources) ? `<p>${escapeHtml(leadPreferredSourceLine(preferredSources))}</p>` : ''}
            ${leadSourcePriorityReasonLine(sourcePriorityReason) ? `<small>${escapeHtml(leadSourcePriorityReasonLine(sourcePriorityReason))}</small>` : ''}
          </div>
        ` : ''}
        ${(proofCard?.playbook_fit_summary || proofCard?.evidence_fit_summary || asArray(proofCard?.blocked_claims).length) ? `
          <div class="today-mainline-section">
            <span class="today-mainline-section-title">这句话为什么能说 / 还不能默认说什么</span>
            ${proofCard?.playbook_fit_summary ? `<p>${escapeHtml(proofCard.playbook_fit_summary)}</p>` : ''}
            ${proofCard?.evidence_fit_summary ? `<p>${escapeHtml(proofCard.evidence_fit_summary)}</p>` : ''}
            ${asArray(proofCard?.blocked_claims).length ? `<small>${escapeHtml(`先别默认说：${asArray(proofCard.blocked_claims).slice(0, 2).map((item) => item.claim_label || '').filter(Boolean).join('；')}`)}</small>` : ''}
          </div>
        ` : ''}
      </div>
      ${prioritySignal?.reason ? `<small>${escapeHtml(prioritySignal.reason)}</small>` : ''}
    </article>
  `;
}

function renderTodayScriptActionStrip(run, model = buildTodayMainlineModel(run)) {
  const { card, workbench, evidencePack, objectionPatterns } = model;
  if (!card) return '';
  const primaryPack = run?.primary_prospect_outreach_pack
    || run?.lead_acquisition_workbench_view?.primary_prospect_outreach_pack
    || null;
  const packChannel = primaryPack?.contact_plan?.recommended_channel;
  const packScript = primaryPack?.outreach_script?.opening || '';
  const writebackPreview = findLeadRunWritebackPreviewForTask(run, card.task_id)
    || deriveLeadWritebackPreview(null, card.writeback_starter_template || null);
  const proofPoints = asArray(evidencePack?.proof_points).slice(0, 2);
  const objectionAnswers = asArray(evidencePack?.objection_answers).slice(0, 2);
  const buttons = [];
  if (card.status === 'needs_queue') {
    buttons.push('<button class="button primary" data-lead-run-action="advance-today">推进到今日联系</button>');
    buttons.push('<button class="button secondary" data-home-tab="workflow">查看当前执行</button>');
  } else if (packChannel && packChannel !== 'phone') {
    buttons.push(`<button class="button primary" data-lead-run-action="outreach-contact" data-lead-id="${escapeHtml(card.lead_id || primaryPack?.lead_id || '')}" data-outreach-opening="${escapeHtml(packScript || card.script || card.opening_line || '')}" data-outreach-channel="${escapeHtml(primaryPack?.contact_plan?.recommended_channel_label || '推荐渠道')}">${escapeHtml(primaryPack?.primary_cta?.label || '去联系')}</button>`);
    if (card.task_id) {
      buttons.push(`<button class="button secondary" data-action="complete-task" data-task-id="${escapeHtml(card.task_id)}">记录结果</button>`);
    } else {
      buttons.push('<button class="button secondary" data-home-tab="workflow">查看当前执行</button>');
    }
    if (card.phone) {
      buttons.push(`<button class="button ghost" data-lead-run-action="call-lead" data-lead-id="${escapeHtml(card.lead_id || '')}">备用：呼叫 ${escapeHtml(card.phone)}</button>`);
    }
  } else if (card.phone) {
    buttons.push(`<button class="button primary" data-lead-run-action="call-lead" data-lead-id="${escapeHtml(card.lead_id || '')}">呼叫 ${escapeHtml(card.phone)}</button>`);
    if (card.task_id) {
      buttons.push(`<button class="button secondary" data-action="complete-task" data-task-id="${escapeHtml(card.task_id)}">记录结果</button>`);
    } else {
      buttons.push('<button class="button secondary" data-home-tab="workflow">查看当前执行</button>');
    }
    buttons.push('<button class="button ghost" data-home-tab="workflow">查看完整执行</button>');
  } else {
    buttons.push('<button class="button primary" data-home-tab="workflow">去补联系方式</button>');
    buttons.push('<button class="button secondary" data-home-tab="workflow">查看当前执行</button>');
  }
  const scriptBrief = card.micro_script
    ? renderLeadMicroScriptBrief(card.micro_script)
    : `<p>${escapeHtml(card.script_snippet || workbench?.script_preview || '先确认对方当前需求和方便沟通时间。')}</p>`;
  return `
    <article class="today-mainline-card today-script-action-strip">
      <div>
        <span class="chip warning">${escapeHtml(card.status === 'needs_queue' ? '先把队列推进到今天' : (packChannel && packChannel !== 'phone' ? '按推荐渠道直接触达' : '照这条链直接执行'))}</span>
        <strong>${escapeHtml(packChannel && packChannel !== 'phone' ? '话术、触达和回写放在一条链上' : '话术、呼叫和回写放在一条链上')}</strong>
        <p>${escapeHtml(card.status === 'needs_queue' ? (card.summary || '先把今天要联系的人推进到顶部，再开始联系。') : (card.next_action || (packChannel && packChannel !== 'phone' ? '复制开口话术后到推荐渠道发送，发送后立刻按结果回写。' : '看完开口就能直接打，打完立刻按结果回写。')))}</p>
      </div>
      <div class="today-script-strip">
          <div class="today-script-brief">
            <div class="today-mainline-section">
              <span class="today-mainline-section-title">建议开口</span>
              ${scriptBrief}
              ${card.script_snippet && card.micro_script ? `<small>${escapeHtml(card.script_snippet)}</small>` : ''}
            </div>
            ${(proofPoints.length || objectionAnswers.length || objectionPatterns.length) ? `
              <div class="today-mainline-section">
                <span class="today-mainline-section-title">这次优先带的证据 / 异议</span>
                ${proofPoints.length ? `<p>${escapeHtml(`优先证据：${proofPoints.map((item) => item.proof_point || item.label || '').filter(Boolean).join('；')}`)}</p>` : ''}
                ${objectionAnswers.length ? `<p>${escapeHtml(`优先回应：${objectionAnswers.map((item) => `${item.label || '异议'} → ${item.answer || ''}`).join('；')}`)}</p>` : ''}
                ${!objectionAnswers.length && objectionPatterns.length ? `<small>${escapeHtml(`常见顾虑：${objectionPatterns.map((item) => item.pattern || item.label || item.objection || '').filter(Boolean).join('；')}`)}</small>` : ''}
              </div>
            ` : ''}
          </div>
          <div class="today-script-actions">
            <div class="button-stack">${buttons.join('')}</div>
            ${writebackPreview
            ? renderLeadWritebackPreviewBrief(writebackPreview, {
                compact: true,
                starterTemplate: card.writeback_starter_template || null
              })
            : `
              <div class="task-outcome-context">
                <span class="chip info">下一步会接上</span>
                <strong>${escapeHtml(card.route_label || '今日联系')}</strong>
                <p>${escapeHtml(card.next_action || '推进到今日联系后，这里会直接给出回写方式。')}</p>
              </div>
            `}
          <small>${escapeHtml(card.status === 'needs_queue' ? '先把线索推进到今天队列，再开始呼叫。' : (card.next_action || '通话结束后立刻点结果标签，系统会自动安排下一步。'))}</small>
        </div>
      </div>
    </article>
  `;
}

function renderTodayMainlineStrip(run) {
  const model = buildTodayMainlineModel(run);
  if (!model.card) {
    return `
      <article class="today-mainline-card full-span">
        <span class="chip info">Today 主链</span>
        <strong>还没有今天要联系的线索</strong>
        <p>创建获客执行后，这里会固定展示当前 lead、推荐原因、建议开口和回写动作。</p>
        <div class="button-stack">
          <button class="button secondary" data-home-tab="workflow">先创建当前执行</button>
        </div>
      </article>
    `;
  }
  return [
    renderLeadMainlineControlRail(run, { mode: 'today' }),
    renderTodayContextHeaderCard(run, model),
    renderTodayEvidenceReasonCard(run, model),
    renderLeadExecutionProofCard(run?.today_contact_card?.lead_execution_proof_card || run?.lead_execution_proof_card, { mode: 'today', asArticle: true }),
    renderLeadExecutionFlowBridge(run?.execution_flow_bridge, { mode: 'today' }),
    renderLeadMainlineMemoryFabric(run?.mainline_memory_fabric, { mode: 'today' }),
    renderLeadSkillProofSurface(run?.today_contact_card?.skill_proof_surface || run?.skill_proof_surface, { mode: 'today' }),
    renderLeadMainlineExperimentQueue(run?.mainline_experiment_queue, { mode: 'today' }),
    renderTodayScriptActionStrip(run, model)
  ].filter(Boolean).join('');
}

function renderLeadMainlineControlRail(run, { mode = 'today' } = {}) {
  const workOrder = run?.agent_work_order || null;
  const autonomyPolicy = run?.run_autonomy_policy || null;
  const progress = run?.agent_run_progress_packet || null;
  const autopilot = run?.source_mission_autopilot_packet || null;
  const crossSourcePlan = run?.cross_source_capture_plan || null;
  const sourceCaptureAttempt = run?.source_capture_attempt_packet || null;
  const candidateVerify = run?.candidate_verification_packet || null;
  const leadEvidenceBundle = run?.lead_evidence_bundle || null;
  const nonPhone = run?.non_phone_execution_pack || null;
  const channelReceipt = run?.channel_receipt_packet || null;
  const importDecision = run?.autonomous_import_decision_packet || null;
  const firstTouch = run?.first_touch_action_pack || null;
  const channelRisk = run?.channel_action_risk_packet || null;
  const agentDelivery = run?.agent_delivery_result_pack || null;
  const cmdGoalSummary = run?.commander_goal_summary || null;
  const cmdProgressStrip = run?.commander_progress_strip || null;
  const cmdPendingConfirm = run?.commander_pending_confirmations || null;
  const cmdTodayAction = run?.commander_today_primary_action || null;
  const todayLeadCtx = run?.today_lead_context || null;
  const todayChannelDec = run?.today_channel_decision || null;
  const todayActionBar = run?.today_action_bar || null;
  const resultDelivery = run?.result_delivery_summary || null;
  const resultHandoff = run?.result_handoff_pack || null;
  const runAutoLoop = run?.run_autonomous_loop_packet || null;
  const autoStopReason = run?.autonomous_stop_reason_card || null;
  const founderIntervention = run?.founder_intervention_resume_pack || null;
  const deliveryGate = run?.service_delivery_readiness_gate || null;
  const stepTriggerBridge = run?.autonomous_step_trigger_bridge || null;
  const replyIntent = run?.reply_intent_packet || null;
  const nonPhoneOutcomeProof = run?.non_phone_outcome_proof_packet || null;
  if (!workOrder && !autonomyPolicy && !progress && !autopilot && !crossSourcePlan && !sourceCaptureAttempt && !candidateVerify && !leadEvidenceBundle && !nonPhone && !channelReceipt && !importDecision && !firstTouch && !channelRisk && !agentDelivery && !runAutoLoop && !autoStopReason && !founderIntervention && !deliveryGate && !stepTriggerBridge && !replyIntent && !nonPhoneOutcomeProof) return '';
  const cardClass = mode === 'result' ? 'lead-run-result-summary-card' : 'today-mainline-card';
  return `
    <section class="lead-mainline-control-rail">
      ${renderLeadWorkOrderCard(workOrder, { mode, cardClass })}
      ${renderLeadAutonomyPolicyCard(autonomyPolicy, { mode, cardClass })}
      ${renderLeadRunProgressCard(progress, { mode, cardClass })}
      ${renderSourceMissionAutopilotCard(autopilot, { mode, cardClass })}
      ${renderCrossSourceCapturePlanCard(crossSourcePlan, { mode, cardClass })}
      ${renderSourceCaptureAttemptPacketCard(sourceCaptureAttempt, { mode, cardClass })}
      ${renderCandidateVerificationCard(candidateVerify, { mode, cardClass })}
      ${renderLeadEvidenceBundleCard(leadEvidenceBundle, { mode, cardClass })}
      ${renderNonPhoneExecutionCard(nonPhone, { mode, cardClass })}
      ${renderChannelReceiptCard(channelReceipt, { mode, cardClass })}
      ${renderAutonomousImportDecisionCard(importDecision, { mode, cardClass })}
      ${renderFirstTouchActionCard(firstTouch, { mode, cardClass })}
      ${renderChannelActionRiskCard(channelRisk, { mode, cardClass })}
      ${renderAgentDeliveryResultCard(agentDelivery, { mode, cardClass })}
      ${renderCommanderGoalSummary(cmdGoalSummary, { mode, cardClass })}
      ${renderCommanderProgressStrip(cmdProgressStrip, { mode, cardClass })}
      ${renderCommanderPendingConfirmations(cmdPendingConfirm, { mode, cardClass })}
      ${renderCommanderTodayPrimaryAction(cmdTodayAction, { mode, cardClass })}
      ${renderTodayLeadContext(todayLeadCtx, { mode, cardClass })}
      ${renderTodayChannelDecision(todayChannelDec, { mode, cardClass })}
      ${renderTodayActionBar(todayActionBar, { mode, cardClass })}
      ${renderResultDeliverySummary(resultDelivery, { mode, cardClass })}
      ${renderResultHandoffPack(resultHandoff, { mode, cardClass })}
      ${renderRunAutonomousLoopCard(runAutoLoop, { mode, cardClass })}
      ${renderAutonomousStopReasonCard(autoStopReason, { mode, cardClass })}
      ${renderFounderInterventionResumeCard(founderIntervention, { mode, cardClass })}
      ${renderServiceDeliveryReadinessGate(deliveryGate, { mode, cardClass })}
      ${renderAutonomousStepTriggerBridge(stepTriggerBridge, { mode, cardClass })}
      ${renderReplyIntentCard(replyIntent, { mode, cardClass })}
      ${renderNonPhoneOutcomeProofCard(nonPhoneOutcomeProof, { mode, cardClass })}
    </section>
  `;
}

function renderLeadWorkOrderCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const allowedActions = asArray(packet.allowed_actions).slice(0, 3);
  const approvalActions = asArray(packet.approval_required_actions).slice(0, 3);
  const successCriteria = asArray(packet.success_criteria).slice(0, 3);
  const chips = [
    packet.service_scope ? packet.service_scope : '',
    packet.work_order_id ? `工单 ${truncateText(packet.work_order_id, 18)}` : '',
    packet.target_outcome ? truncateText(packet.target_outcome, 24) : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-work-order-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip info">${mode === 'result' ? '已落地工作单' : '工作单'}</span>
          <strong>${escapeHtml(packet.normalized_goal || packet.user_goal_raw || '当前 run 工作单')}</strong>
          <p>${escapeHtml(packet.delivery_expectation || packet.target_outcome || '当前获客执行会沿这张工作单推进。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">这张工单要做什么</span>
        ${allowedActions.length ? `<p>${escapeHtml(`允许自动做：${allowedActions.join(' / ')}`)}</p>` : ''}
        ${approvalActions.length ? `<small>${escapeHtml(`需要人工确认：${approvalActions.join(' / ')}`)}</small>` : ''}
        ${successCriteria.length ? `<small>${escapeHtml(`完成标准：${successCriteria.join('；')}`)}</small>` : ''}
        ${packet.blocked_reason ? `<small>${escapeHtml(`阻断原因：${packet.blocked_reason}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderLeadAutonomyPolicyCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const autoAllowedSteps = asArray(packet.auto_allowed_steps).slice(0, 3);
  const approvalRequiredSteps = asArray(packet.approval_required_steps).slice(0, 3);
  const stopConditions = asArray(packet.stop_conditions).slice(0, 3);
  const escalationConditions = asArray(packet.escalation_conditions).slice(0, 3);
  const chips = [
    packet.autonomy_level ? packet.autonomy_level : '',
    autoAllowedSteps.length ? `${autoAllowedSteps.length} 个自动步` : '',
    approvalRequiredSteps.length ? `${approvalRequiredSteps.length} 个审批点` : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-autonomy-policy-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${packet.autonomy_level === 'manual_only' ? 'warning' : 'info'}">${mode === 'result' ? '已收口自治策略' : '自治策略'}</span>
          <strong>${escapeHtml(packet.frontstage_explanation?.confirmation || packet.audit_summary || '当前 run 自治策略')}</strong>
          <p>${escapeHtml(packet.audit_summary || '这里只说明哪些步骤可自动推进、哪些必须先审批。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">自动 / 审批边界</span>
        ${autoAllowedSteps.length ? `<p>${escapeHtml(`可自动：${autoAllowedSteps.join(' / ')}`)}</p>` : ''}
        ${approvalRequiredSteps.length ? `<small>${escapeHtml(`需审批：${approvalRequiredSteps.join(' / ')}`)}</small>` : ''}
        ${stopConditions.length ? `<small>${escapeHtml(`停止条件：${stopConditions.join(' / ')}`)}</small>` : ''}
        ${escalationConditions.length ? `<small>${escapeHtml(`升级条件：${escalationConditions.join(' / ')}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderLeadRunProgressCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const nextStep = asArray(packet.next_step).slice(0, 3);
  const checklist = asArray(packet.deliverable_checklist).slice(0, 3);
  const chips = [
    packet.current_stage_label || packet.current_stage || '',
    packet.autonomy_level ? packet.autonomy_level : '',
    packet.approval_state || ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-progress-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip success">${mode === 'result' ? '进度回写' : '进度包'}</span>
          <strong>${escapeHtml(packet.progress_summary || packet.next_recommended_action || '当前 run 进度')}</strong>
          <p>${escapeHtml(packet.next_run_hint || '这里会持续说明当前 stage、下一步和是否需要审批。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">下一步怎么走</span>
        ${nextStep.length ? nextStep.map((step) => `<p>${escapeHtml(step)}</p>`).join('') : '<p>当前还没有可展示的下一步。</p>'}
        ${checklist.length ? `<small>${escapeHtml(`交付清单：${checklist.join('；')}`)}</small>` : ''}
        ${packet.blocked_reason ? `<small>${escapeHtml(`阻断原因：${packet.blocked_reason}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderSourceMissionAutopilotCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const blockedSources = asArray(packet.sources_blocked).slice(0, 3);
  const chips = [
    packet.autopilot_stage ? packet.autopilot_stage : '',
    packet.sources_attempted != null ? `${packet.sources_attempted} 个来源` : '',
    packet.human_review_required ? '需要人工确认' : '自动推进'
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-source-autopilot-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${packet.human_review_required ? 'warning' : 'info'}">${mode === 'result' ? '来源任务回执' : '来源自动驾驶'}</span>
          <strong>${escapeHtml(packet.mission_summary || '来源自动抓取与验证')}</strong>
          <p>${escapeHtml(packet.next_autopilot_action || '系统将自动推进来源抓取。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">来源进度</span>
        <p>${escapeHtml(`已尝试 ${packet.sources_attempted || 0} 个，已验证 ${packet.sources_verified || 0} 个`)}</p>
        ${packet.blocking_reason ? `<small>${escapeHtml(`阻断原因：${packet.blocking_reason}`)}</small>` : ''}
        ${blockedSources.length ? `<small>${escapeHtml(`被阻断来源：${blockedSources.join(' / ')}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderCrossSourceCapturePlanCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const sourceCandidates = asArray(packet.source_candidates).slice(0, 4);
  const selectedSources = asArray(packet.selected_sources).slice(0, 4);
  const chips = [
    selectedSources.length ? `${selectedSources.length} 个已选来源` : '',
    sourceCandidates.length ? `${sourceCandidates.length} 个候选来源` : '',
    packet.quality_gate ? '有质量门' : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-cross-source-capture-plan-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip info">${mode === 'result' ? '来源计划已归档' : '跨来源采集计划'}</span>
          <strong>${escapeHtml(packet.mission_goal || '本轮来源采集计划')}</strong>
          <p>${escapeHtml(packet.capture_plan || packet.next_action || '系统会按计划采集公开来源。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">优先来源</span>
        ${selectedSources.length ? `<p>${escapeHtml(selectedSources.join(' / '))}</p>` : '<p>等待系统选出优先来源。</p>'}
        ${packet.quality_gate ? `<small>${escapeHtml(`质量门：${packet.quality_gate}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderSourceCaptureAttemptPacketCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const attempts = asArray(packet.capture_attempts).slice(0, 4);
  const chipClass = packet.quality_gate_status === 'passed' ? 'success' : packet.quality_gate_status === 'needs_review' ? 'warning' : 'info';
  const chips = [
    packet.attempted_count != null ? `${packet.attempted_count} 次尝试` : '',
    packet.successful_count != null ? `${packet.successful_count} 次成功` : '',
    packet.failed_count ? `${packet.failed_count} 次失败` : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-source-capture-attempt-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${chipClass}">${mode === 'result' ? '采集尝试回执' : '来源采集尝试'}</span>
          <strong>${escapeHtml(packet.next_action || '来源采集状态')}</strong>
          <p>${escapeHtml(`质量门状态：${packet.quality_gate_status || 'pending'}`)}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">最近采集</span>
        ${attempts.length ? `<ul class="compact-list">${attempts.map((attempt) => `<li>${escapeHtml(attempt.source_name || '来源')}：${escapeHtml(attempt.status || 'pending')}</li>`).join('')}</ul>` : '<p>等待来源采集结果。</p>'}
      </div>
    </article>
  `;
}

function renderCandidateVerificationCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const evidenceSources = asArray(packet.evidence_sources).slice(0, 3);
  const confidenceChipClass = packet.verification_confidence === 'high' ? 'success' : packet.verification_confidence === 'medium' ? 'info' : 'warning';
  const chips = [
    packet.verification_confidence ? `置信度：${packet.verification_confidence}` : '',
    packet.total_candidates != null ? `${packet.total_candidates} 个候选` : '',
    packet.requires_manual_check ? '需人工核查' : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-candidate-verify-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${confidenceChipClass}">${mode === 'result' ? '候选验证结果' : '候选验证'}</span>
          <strong>${escapeHtml(packet.verification_summary || '候选来源验证状态')}</strong>
          <p>${escapeHtml(packet.quality_benchmark || '这里显示候选来源的验证进度和置信度。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">验证详情</span>
        <p>${escapeHtml(`已验证 ${packet.verified_count || 0} / ${packet.total_candidates || 0}，未验证 ${packet.unverified_count || 0}`)}</p>
        ${evidenceSources.length ? `<small>${escapeHtml(`有证据的来源：${evidenceSources.join(' / ')}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderLeadEvidenceBundleCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const evidenceItems = asArray(packet.evidence_items).slice(0, 4);
  const chipClass = packet.ready_for_today ? 'success' : packet.verified_count > 0 ? 'info' : 'warning';
  const chips = [
    packet.total_candidates != null ? `${packet.total_candidates} 个候选` : '',
    packet.verified_count != null ? `${packet.verified_count} 条验证` : '',
    packet.verification_confidence ? `置信度：${packet.verification_confidence}` : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-lead-evidence-bundle-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${chipClass}">${mode === 'result' ? '线索证据已归档' : '线索证据包'}</span>
          <strong>${escapeHtml(packet.evidence_summary || '线索证据整理')}</strong>
          <p>${escapeHtml(packet.import_decision_summary || '系统会把来源证据带入导入和今日跟进。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">证据明细</span>
        ${evidenceItems.length ? `<ul class="compact-list">${evidenceItems.map((item) => `<li>${escapeHtml(item.label || item.type || '证据')}：${escapeHtml(item.value || '')}</li>`).join('')}</ul>` : '<p>当前还没有可展示的线索证据。</p>'}
      </div>
    </article>
  `;
}

function renderNonPhoneExecutionCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const availableChannels = asArray(packet.available_channels).slice(0, 4);
  const chips = [
    packet.recommended_channel ? `推荐渠道：${packet.recommended_channel}` : '',
    packet.execution_status ? packet.execution_status : '',
    packet.approval_required ? '需要审批' : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-non-phone-exec-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip info">${mode === 'result' ? '非电话执行回执' : '非电话执行包'}</span>
          <strong>${escapeHtml(packet.next_action || '准备非电话触达草稿')}</strong>
          <p>${escapeHtml(packet.outbound_draft ? truncateText(packet.outbound_draft, 60) : '系统将在审批后通过指定渠道发送。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">可用渠道</span>
        ${availableChannels.length ? `<p>${escapeHtml(availableChannels.join(' / '))}</p>` : '<p>暂无可用渠道。</p>'}
        <small>${escapeHtml('外发必须经过人工审批')}</small>
      </div>
    </article>
  `;
}

function renderChannelReceiptCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const chips = [
    packet.total_actions != null ? `${packet.total_actions} 个动作` : '',
    packet.successful_actions != null ? `${packet.successful_actions} 个成功` : '',
    packet.pending_actions != null && packet.pending_actions > 0 ? `${packet.pending_actions} 个待定` : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-channel-receipt-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip success">${mode === 'result' ? '渠道回执已归档' : '渠道回执'}</span>
          <strong>${escapeHtml(packet.last_action_summary || '本次 run 的触达回执')}</strong>
          <p>${escapeHtml(packet.next_commitment || '等待系统生成下一步承诺动作。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">动作汇总</span>
        <p>${escapeHtml(`共 ${packet.total_actions || 0} 个触达动作，${packet.successful_actions || 0} 个成功`)}</p>
        ${packet.next_commitment ? `<small>${escapeHtml(`下一步承诺：${packet.next_commitment}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderAutonomousImportDecisionCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const chips = [
    packet.import_policy_level ? `策略：${packet.import_policy_level}` : '',
    packet.auto_import_count != null ? `${packet.auto_import_count} 条可导入` : '',
    packet.requires_approval ? '需要审批' : '无需审批'
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-import-decision-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${packet.requires_approval ? 'warning' : 'success'}">${mode === 'result' ? '导入决策已落地' : '自动导入决策'}</span>
          <strong>${escapeHtml(packet.decision_summary || '候选来源导入决策')}</strong>
          <p>${escapeHtml(packet.blocking_reason || `共评估 ${packet.total_evaluated || 0} 条候选`)}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">导入分布</span>
        <p>${escapeHtml(`安全导入 ${packet.auto_import_count || 0} 条，待确认 ${packet.held_count || 0} 条，拒绝 ${packet.rejected_count || 0} 条`)}</p>
        ${packet.blocking_reason ? `<small>${escapeHtml(`阻断原因：${packet.blocking_reason}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderFirstTouchActionCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const riskFlags = asArray(packet.risk_flags).slice(0, 3);
  const chips = [
    packet.recommended_channel ? `渠道：${packet.recommended_channel}` : '',
    packet.action_type ? packet.action_type : '',
    packet.approval_required ? '需审批' : '无需审批'
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-first-touch-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${packet.ready_to_execute ? 'success' : packet.approval_required ? 'warning' : 'info'}">${mode === 'result' ? '首触已执行' : '首次触达包'}</span>
          <strong>${escapeHtml(packet.execution_hint || '准备首次触达动作')}</strong>
          <p>${escapeHtml(packet.message_draft ? truncateText(packet.message_draft, 60) : packet.channel_reason || '系统将准备首次触达草稿。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">触达详情</span>
        <p>${escapeHtml(`发送窗口：${packet.send_window || '待定'}`)}</p>
        ${packet.proof_to_attach ? `<small>${escapeHtml(`佐证信号：${truncateText(packet.proof_to_attach, 50)}`)}</small>` : ''}
        ${riskFlags.length ? `<small>${escapeHtml(`风险标记：${riskFlags.join(' / ')}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderChannelActionRiskCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const regulatoryFlags = asArray(packet.regulatory_flags).slice(0, 3);
  const riskChipClass = packet.overall_risk_level === 'high' ? 'danger' : packet.overall_risk_level === 'medium' ? 'warning' : 'success';
  const chips = [
    packet.overall_risk_level ? `风险：${packet.overall_risk_level}` : '',
    packet.contact_risk ? `联系人：${packet.contact_risk}` : '',
    packet.clearance_required ? '需要放行' : '低风险通过'
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-channel-risk-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${riskChipClass}">${mode === 'result' ? '渠道风险已评估' : '渠道动作风险'}</span>
          <strong>${escapeHtml(packet.risk_summary || '渠道动作风险评估')}</strong>
          <p>${escapeHtml(`联系人风险：${packet.contact_risk || ''}，消息风险：${packet.message_risk || ''}，渠道风险：${packet.channel_risk || ''}`)}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">风险详情</span>
        ${packet.stop_condition_met ? `<p>${escapeHtml('⚠ 停止条件已触发，需人工介入')}</p>` : ''}
        ${regulatoryFlags.length ? `<small>${escapeHtml(`合规标记：${regulatoryFlags.join(' / ')}`)}</small>` : ''}
        ${!packet.stop_condition_met && !regulatoryFlags.length ? `<p>${escapeHtml('无重大合规风险')}</p>` : ''}
      </div>
    </article>
  `;
}

function renderAgentDeliveryResultCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const statusChipClass = packet.completion_status === 'complete' ? 'success' : packet.completion_status === 'blocked' ? 'danger' : packet.completion_status === 'partial' ? 'warning' : 'info';
  const chips = [
    packet.completion_status ? packet.completion_status : '',
    packet.revenue_ready ? '可变现' : '',
    packet.human_review_required ? '需人工确认' : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-agent-delivery-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${statusChipClass}">${mode === 'result' ? '执行结果已交付' : '智能交付结果包'}</span>
          <strong>${escapeHtml(packet.service_title || '获客执行结果')}</strong>
          <p>${escapeHtml(packet.next_run_hint || packet.outcome_summary || '完整的获客执行结果包')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">执行摘要</span>
        <p>${escapeHtml(`发现 ${packet.leads_sourced || 0} 条，验证 ${packet.leads_verified || 0} 条，导入 ${packet.leads_imported || 0} 条`)}</p>
        <p>${escapeHtml(`已准备 ${packet.actions_prepared || 0} 个触达动作，已执行 ${packet.actions_executed || 0} 个`)}</p>
        ${packet.import_decision_summary ? `<small>${escapeHtml(packet.import_decision_summary)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderCommanderGoalSummary(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const blockedChipClass = packet.blocked ? 'danger' : packet.agent_can_auto_advance ? 'success' : 'info';
  const chips = [
    packet.current_stage_label || '',
    packet.blocked ? '已阻断' : '',
    packet.primary_cta || ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-commander-goal-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${blockedChipClass}">${mode === 'result' ? '目标已完成' : '指挥官目标'}</span>
          <strong>${escapeHtml(packet.goal_headline || '获客执行目标')}</strong>
          <p>${escapeHtml(packet.delivery_expectation || packet.current_stage_label || '')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">下一步操作</span>
        <p>${escapeHtml(packet.primary_cta || '继续推进')}</p>
        ${packet.blocked_reason ? `<small>${escapeHtml(`阻断原因：${packet.blocked_reason}`)}</small>` : ''}
        <small>${escapeHtml(packet.agent_can_auto_advance ? '智能体可自动推进' : '需要手动推进')}</small>
      </div>
    </article>
  `;
}

function renderCommanderProgressStrip(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const steps = asArray(packet.steps).slice(0, 7);
  const statusIcon = { done: '✓', active: '●', pending: '○', blocked: '✗' };
  const chips = [
    packet.overall_progress_pct != null ? `${packet.overall_progress_pct}%` : '',
    packet.active_step || ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-commander-progress-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip info">${mode === 'result' ? '进度已归档' : '执行进度'}</span>
          <strong>${escapeHtml(`整体进度：${packet.overall_progress_pct || 0}%`)}</strong>
          <p>${escapeHtml(packet.next_auto_step || '等待下一步自动推进')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">步骤状态</span>
        ${steps.map((s) => `<p>${escapeHtml(`${statusIcon[s.status] || '○'} ${s.label}${s.count != null ? ` (${s.count})` : ''}`)}</p>`).join('')}
      </div>
    </article>
  `;
}

function renderCommanderPendingConfirmations(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const items = asArray(packet.items).slice(0, 5);
  const chipClass = packet.has_blockers ? 'danger' : packet.total_pending > 0 ? 'warning' : 'success';
  const chips = [
    packet.total_pending != null ? `${packet.total_pending} 项待确认` : '',
    packet.has_blockers ? '有阻断项' : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-commander-pending-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${chipClass}">${mode === 'result' ? '确认已完成' : '待确认事项'}</span>
          <strong>${escapeHtml(packet.total_pending > 0 ? `${packet.total_pending} 项待确认` : '无待确认事项')}</strong>
          <p>${escapeHtml(packet.has_blockers ? '存在阻断项，请优先处理' : '请按优先级逐项确认')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">待确认详情</span>
        ${items.length ? items.map((item) => `<p>${escapeHtml(`[${item.urgency}] ${item.label}`)}</p><small>${escapeHtml(item.action_hint)}</small>`).join('') : '<p>当前没有需要确认的事项。</p>'}
      </div>
    </article>
  `;
}

function renderCommanderTodayPrimaryAction(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const urgencyChipClass = packet.urgency === 'high' ? 'danger' : packet.urgency === 'medium' ? 'warning' : 'info';
  const chips = [
    packet.urgency ? `紧迫度：${packet.urgency}` : '',
    packet.channel ? `渠道：${packet.channel}` : '',
    packet.action_ready ? '可执行' : '未就绪'
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-commander-today-action-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${urgencyChipClass}">${mode === 'result' ? '今日动作已执行' : '今日主要动作'}</span>
          <strong>${escapeHtml(packet.recommended_action || '今日获客动作')}</strong>
          <p>${escapeHtml(packet.why_today || packet.lead_company || '')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">联系对象</span>
        ${packet.lead_name ? `<p>${escapeHtml(`联系人：${packet.lead_name}`)}</p>` : ''}
        ${packet.lead_company ? `<p>${escapeHtml(`公司：${packet.lead_company}`)}</p>` : ''}
        <small>${escapeHtml(packet.why_today || '今日最优先跟进目标')}</small>
      </div>
    </article>
  `;
}

function renderTodayLeadContext(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const confChipClass = packet.confidence_label === 'high' ? 'success' : packet.confidence_label === 'medium' ? 'info' : 'warning';
  const chips = [
    packet.confidence_label ? `置信度：${packet.confidence_label}` : '',
    packet.source_name ? truncateText(packet.source_name, 16) : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-today-lead-context-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${confChipClass}">${mode === 'result' ? '线索上下文' : '今日线索上下文'}</span>
          <strong>${escapeHtml(packet.company_name || packet.contact_name || '今日线索')}</strong>
          <p>${escapeHtml(packet.recommended_reason || packet.top_signal || '')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">线索信息</span>
        ${packet.contact_name ? `<p>${escapeHtml(`联系人：${packet.contact_name}`)}</p>` : ''}
        ${packet.phone ? `<p>${escapeHtml(`电话：${packet.phone}`)}</p>` : ''}
        ${packet.top_signal ? `<small>${escapeHtml(`核心信号：${truncateText(packet.top_signal, 50)}`)}</small>` : ''}
        ${packet.evidence_snippet ? `<small>${escapeHtml(truncateText(packet.evidence_snippet, 50))}</small>` : ''}
      </div>
    </article>
  `;
}

function renderTodayChannelDecision(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const riskChipClass = packet.risk_level === 'high' ? 'danger' : packet.risk_level === 'medium' ? 'warning' : 'success';
  const chips = [
    packet.channel_label ? `渠道：${packet.channel_label}` : '',
    packet.risk_level ? `风险：${packet.risk_level}` : '',
    packet.approval_required ? '需审批' : '无需审批'
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-today-channel-decision-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${riskChipClass}">${mode === 'result' ? '渠道决策已执行' : '渠道决策'}</span>
          <strong>${escapeHtml(packet.channel_label ? `通过${packet.channel_label}触达` : '渠道触达决策')}</strong>
          <p>${escapeHtml(packet.selection_reason || packet.send_window || '')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">触达详情</span>
        ${packet.message_draft ? `<p>${escapeHtml(truncateText(packet.message_draft, 60))}</p>` : ''}
        <small>${escapeHtml(`发送窗口：${packet.send_window || '待定'}`)}</small>
        ${packet.approval_hint ? `<small>${escapeHtml(packet.approval_hint)}</small>` : ''}
        ${packet.alternative_channel ? `<small>${escapeHtml(`备用渠道：${packet.alternative_channel}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderTodayActionBar(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const primaryEnabled = packet.primary_action?.enabled;
  const primaryChipClass = primaryEnabled ? 'success' : 'warning';
  const chips = [
    packet.primary_action?.action_key || '',
    primaryEnabled ? '可执行' : '已阻断'
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-today-action-bar-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${primaryChipClass}">${mode === 'result' ? '操作栏已归档' : '今日操作栏'}</span>
          <strong>${escapeHtml(packet.primary_action?.label || '执行动作')}</strong>
          <p>${escapeHtml(packet.primary_action?.blocked_reason || packet.writeback_hint || '')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">操作选项</span>
        ${asArray(packet.secondary_actions).map((a) => `<small>${escapeHtml(a.label)}</small>`).join('')}
        <small>${escapeHtml(packet.writeback_hint || '')}</small>
      </div>
    </article>
  `;
}

function renderResultDeliverySummary(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const statusChipClass = packet.completion_status === 'complete' ? 'success' : packet.completion_status === 'blocked' ? 'danger' : packet.completion_status === 'partial' ? 'warning' : 'info';
  const chips = [
    packet.completion_status || '',
    packet.delivery_ready ? '可导出' : '',
    packet.leads_found != null ? `${packet.leads_found} 条线索` : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-result-delivery-summary-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${statusChipClass}">${mode === 'result' ? '结果已交付' : '交付摘要'}</span>
          <strong>${escapeHtml(packet.service_title || '获客执行结果摘要')}</strong>
          <p>${escapeHtml(packet.export_hint || packet.top_outcome || '')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">交付数据</span>
        <p>${escapeHtml(`发现 ${packet.leads_found || 0} 条，导入 ${packet.leads_imported || 0} 条，执行 ${packet.actions_executed || 0} 个动作`)}</p>
        ${packet.top_outcome ? `<small>${escapeHtml(truncateText(packet.top_outcome, 60))}</small>` : ''}
        ${packet.delivery_blocked_reason ? `<small>${escapeHtml(`阻断：${packet.delivery_blocked_reason}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderResultHandoffPack(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const pivotChipClass = packet.continue_or_pivot === 'continue' ? 'success' : 'warning';
  const lessons = asArray(packet.lessons_learned).slice(0, 3);
  const chips = [
    packet.continue_or_pivot ? (packet.continue_or_pivot === 'continue' ? '继续推进' : '建议切换') : '',
    lessons.length ? `${lessons.length} 条经验` : ''
  ].filter(Boolean);
  return `
    <article class="${cardClass} lead-mainline-result-handoff-pack-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${pivotChipClass}">${mode === 'result' ? '结果已交接' : '结果交接包'}</span>
          <strong>${escapeHtml(packet.handoff_summary || '获客结果交接')}</strong>
          <p>${escapeHtml(packet.next_run_recommendation || packet.next_batch_hint || '')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">下一步建议</span>
        <p>${escapeHtml(packet.next_batch_hint || packet.next_run_recommendation || '继续推进')}</p>
        ${lessons.length ? `<small>${escapeHtml(`经验：${lessons.join('；')}`)}</small>` : ''}
        ${packet.pivot_reason ? `<small>${escapeHtml(`切换原因：${packet.pivot_reason}`)}</small>` : ''}
      </div>
    </article>
  `;
}

function renderRunAutonomousLoopCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const statusBadgeClass = packet.loop_status === 'running' ? 'success'
    : packet.loop_status === 'completed' ? 'info'
    : packet.loop_status === 'blocked' ? 'error'
    : 'warning';
  const statusLabel = { running: '自动推进中', paused_for_approval: '等待审批', paused_needs_input: '等待输入',
    paused_budget: '预算上限', completed: '已完成', blocked: '已阻断' }[packet.loop_status] || packet.loop_status;
  return `
    <article class="${cardClass} lead-mainline-run-autonomous-loop-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${statusBadgeClass}">${escapeHtml(statusLabel)}</span>
          <strong>${escapeHtml(packet.loop_summary || '自治循环状态')}</strong>
          <p>${escapeHtml(packet.next_auto_action || '')}</p>
        </div>
        <div class="keyword-list compact">
          <code>${escapeHtml(`已完成 ${packet.steps_completed_auto ?? 0} 步`)}</code>
          ${packet.steps_requiring_human > 0 ? `<code>${escapeHtml(`${packet.steps_requiring_human} 步需确认`)}</code>` : ''}
          ${packet.can_advance_auto ? '<code>可自动推进</code>' : ''}
        </div>
      </div>
    </article>
  `;
}

function renderAutonomousStopReasonCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  if (!packet.is_stopped) return '';
  const severityClass = packet.severity === 'blocking' ? 'error' : packet.severity === 'warning' ? 'warning' : 'info';
  const items = (Array.isArray(packet.items_blocking) ? packet.items_blocking : []).slice(0, 3);
  return `
    <article class="${cardClass} lead-mainline-autonomous-stop-reason-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${severityClass}">${escapeHtml(packet.stop_headline || '已暂停')}</span>
          <strong>${escapeHtml(packet.stop_detail || '')}</strong>
          ${packet.user_action_required ? `<p>${escapeHtml(packet.user_action_required)}</p>` : ''}
        </div>
        ${items.length ? `<div class="keyword-list compact">${items.map((i) => `<code>${escapeHtml(i)}</code>`).join('')}</div>` : ''}
      </div>
      ${packet.resume_hint ? `<div class="today-mainline-section"><small>${escapeHtml(packet.resume_hint)}</small></div>` : ''}
    </article>
  `;
}

function renderFounderInterventionResumeCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  if (packet.intervention_type === 'none') return '';
  const urgencyClass = packet.intervention_urgency === 'immediate' ? 'error' : packet.intervention_urgency === 'today' ? 'warning' : 'info';
  const items = (Array.isArray(packet.intervention_items) ? packet.intervention_items : []).slice(0, 3);
  return `
    <article class="${cardClass} lead-mainline-founder-intervention-resume-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${urgencyClass}">${escapeHtml({ immediate: '立即处理', today: '今日处理', whenever: '随时处理' }[packet.intervention_urgency] || '待处理')}</span>
          <strong>${escapeHtml(packet.intervention_prompt || '需要您介入')}</strong>
          ${packet.after_intervention ? `<p>${escapeHtml(packet.after_intervention)}</p>` : ''}
        </div>
      </div>
      ${items.length ? `<div class="today-mainline-section"><ul class="compact-list">${items.map((i) => `<li>${escapeHtml(i.label)}${i.required ? ' <span class="chip error">必须</span>' : ''}</li>`).join('')}</ul></div>` : ''}
      ${packet.skip_allowed && packet.skip_consequence ? `<div class="today-mainline-section"><small>${escapeHtml(`跳过影响：${packet.skip_consequence}`)}</small></div>` : ''}
    </article>
  `;
}

function renderServiceDeliveryReadinessGate(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const levelClass = packet.readiness_level === 'ready' ? 'success' : packet.readiness_level === 'partial' ? 'warning' : 'info';
  const levelLabel = { ready: '完全就绪', partial: '部分就绪', draft: '草稿阶段', not_started: '未开始' }[packet.readiness_level] || packet.readiness_level;
  const deliverable = (Array.isArray(packet.deliverable_items) ? packet.deliverable_items : []).slice(0, 4);
  const missing = (Array.isArray(packet.missing_items) ? packet.missing_items : []).slice(0, 3);
  return `
    <article class="${cardClass} lead-mainline-service-delivery-readiness-gate-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${levelClass}">${escapeHtml(levelLabel)}</span>
          <strong>${escapeHtml(packet.gate_summary || '交付就绪检查')}</strong>
        </div>
        <div class="keyword-list compact">
          ${packet.export_ready ? '<code>可导出</code>' : ''}
          ${deliverable.map((d) => `<code>${escapeHtml(d)}</code>`).join('')}
        </div>
      </div>
      ${missing.length ? `<div class="today-mainline-section"><span class="today-mainline-section-title">待补充</span><div class="keyword-list compact">${missing.map((m) => `<code>${escapeHtml(m)}</code>`).join('')}</div></div>` : ''}
      ${packet.export_blocked_reason ? `<div class="today-mainline-section"><small>${escapeHtml(packet.export_blocked_reason)}</small></div>` : ''}
    </article>
  `;
}

function renderAutonomousStepTriggerBridge(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const steps = (Array.isArray(packet.triggerable_steps) ? packet.triggerable_steps : []).slice(0, 5);
  if (steps.length === 0 && !packet.next_trigger_step) return '';
  return `
    <article class="${cardClass} lead-mainline-autonomous-step-trigger-bridge-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${packet.all_steps_auto ? 'success' : 'warning'}">${packet.all_steps_auto ? '全自动' : `${packet.manual_steps_remaining ?? 0} 步需人工`}</span>
          <strong>${escapeHtml(`下一触发步骤：${packet.next_trigger_step || ''}`)}</strong>
          ${packet.next_trigger_condition ? `<p>${escapeHtml(packet.next_trigger_condition)}</p>` : ''}
        </div>
      </div>
      ${steps.length ? `<div class="today-mainline-section"><span class="today-mainline-section-title">待触发步骤</span><ul class="compact-list">${steps.map((s) => `<li>${escapeHtml(s.step_label || s.step_key)}${s.auto_executable ? ' <code>自动</code>' : ' <code>待审批</code>'}</li>`).join('')}</ul></div>` : ''}
    </article>
  `;
}

function renderReplyIntentCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const chips = [
    packet.intent_label || '',
    packet.source_channel ? `渠道：${packet.source_channel}` : '',
    packet.confidence ? `置信度：${packet.confidence}` : '',
    packet.stop_followup ? '停止跟进' : ''
  ].filter(Boolean);
  const chipClass = packet.stop_followup ? 'error' : packet.requires_human_takeover ? 'warning' : 'info';
  return `
    <article class="${cardClass} lead-mainline-reply-intent-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${chipClass}">${mode === 'result' ? '回复意图已归档' : '回复意图'}</span>
          <strong>${escapeHtml(packet.summary || packet.intent_label || '非电话回复意图')}</strong>
          <p>${escapeHtml(packet.next_action || '系统将根据回复意图生成下一步。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">意图判断</span>
        <p>${escapeHtml(packet.evidence_snippet || '当前没有可展示的回复证据。')}</p>
        ${packet.requires_human_takeover ? '<small>这类回复建议由老板或人工接手推进。</small>' : ''}
      </div>
    </article>
  `;
}

function renderNonPhoneOutcomeProofCard(packet, { mode = 'today', cardClass = 'today-mainline-card' } = {}) {
  if (!packet) return '';
  const proofItems = (Array.isArray(packet.proof_items) ? packet.proof_items : []).slice(0, 4);
  const chips = [
    packet.channel ? `渠道：${packet.channel}` : '',
    packet.outcome_status ? `状态：${packet.outcome_status}` : '',
    packet.writeback_ready ? '可回写' : ''
  ].filter(Boolean);
  const chipClass = packet.outcome_status === 'replied' ? 'success' : packet.outcome_status === 'failed' ? 'error' : 'info';
  return `
    <article class="${cardClass} lead-mainline-non-phone-outcome-proof-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip ${chipClass}">${mode === 'result' ? '非电话结果证明' : '非电话证明包'}</span>
          <strong>${escapeHtml(packet.proof_summary || '非电话执行证明')}</strong>
          <p>${escapeHtml(packet.next_action_commitment || '系统将把这份结果写回下一步。')}</p>
        </div>
        ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </div>
      <div class="today-mainline-section">
        <span class="today-mainline-section-title">证明明细</span>
        ${proofItems.length ? `<ul class="compact-list">${proofItems.map((item) => `<li>${escapeHtml(item.label || item.type || '证明')}：${escapeHtml(item.value || '')}</li>`).join('')}</ul>` : '<p>当前还没有可展示的非电话证明。</p>'}
      </div>
    </article>
  `;
}

function buildTodayTaskOutcomeContext(run, card = run?.today_contact_card || null) {
  if (!card?.task_id) return null;
  const writebackPreview = findLeadRunWritebackPreviewForTask(run, card.task_id)
    || deriveLeadWritebackPreview(null, card.writeback_starter_template || null);
  return {
    leadName: card.lead_name || card.title || '这条线索',
    title: card.task_title || card.title || '今日跟进任务',
    reason: card.reason || card.summary || '记录本次联系结果，并让系统自动接下一步。',
    nextAction: card.next_action || '记录本次跟进结果，并让系统自动安排下一步。',
    microScript: card.micro_script || null,
    writebackPreview,
    writebackOptionSurface: card.writeback_option_surface || writebackPreview?.option_surface || null
  };
}

function renderTodayInlineWritebackPanel(run) {
  const card = run?.today_contact_card || null;
  const latestReview = state.ui.latestCallWritebackReview && String(state.ui.latestCallWritebackReview.runId || '') === String(run?.id || '')
    ? state.ui.latestCallWritebackReview
    : null;
  const confirmation = run?.writeback_confirmation_card || null;
  if (!card && !confirmation && !latestReview) return '';
  if (confirmation) {
    const primary = confirmation.primary_action || null;
    const outcomeLabel = confirmation.outcome_tag || callDispositionText(confirmation.disposition || '') || '已记录';
    return `
      <article class="today-mainline-card today-inline-writeback-card">
        <div class="today-mainline-head">
          <div>
            <span class="chip success">结果回写已接回主链</span>
            <strong>${escapeHtml(confirmation.title || '本次结果已记录')}</strong>
            <p>${escapeHtml(confirmation.summary || '这次通话/跟进结果已经写回当前获客执行。')}</p>
          </div>
          <div class="keyword-list compact">
            ${confirmation.lead_name ? `<code>${escapeHtml(confirmation.lead_name)}</code>` : ''}
            <code>${escapeHtml(outcomeLabel)}</code>
            ${confirmation.route_label ? `<code>${escapeHtml(confirmation.route_label)}</code>` : ''}
          </div>
        </div>
        <div class="today-writeback-grid">
          <article class="today-writeback-section">
            <span class="today-mainline-section-title">刚写回了什么</span>
            <p>${escapeHtml(latestReview?.nextAction || confirmation.summary || '系统已记录本次结果，并刷新当前执行。')}</p>
            ${confirmation.completed_task ? `<small>${escapeHtml(confirmation.completed_task.title || '当前任务')} · ${escapeHtml(confirmation.completed_task.completion_result || '已完成')}</small>` : ''}
            ${latestReview ? `<small>${escapeHtml(`最新结果：${callDispositionText(latestReview.disposition || '') || '已回写'}`)}</small>` : ''}
          </article>
          <article class="today-writeback-section">
            <span class="today-mainline-section-title">下一步已经接上</span>
            <p>${escapeHtml(confirmation.next_action || '继续处理系统已生成的下一步。')}</p>
            ${confirmation.next_task?.micro_script ? renderLeadMicroScriptBrief(confirmation.next_task.micro_script) : confirmation.micro_script ? renderLeadMicroScriptBrief(confirmation.micro_script) : ''}
            <div class="button-stack">
              ${primary?.action ? `
                <button class="button primary" data-lead-run-action="${escapeHtml(primary.action)}"
                  data-task-id="${escapeHtml(primary.task_id || '')}"
                  data-lead-id="${escapeHtml(primary.lead_id || '')}"
                  data-focus-title="${escapeHtml(primary.title || '')}"
                  data-focus-lead="${escapeHtml(confirmation.lead_name || '')}"
                  data-focus-reason="${escapeHtml(primary.reason || confirmation.next_action || '')}">${escapeHtml(primary.label || '继续下一步')}</button>
              ` : '<button class="button secondary" data-home-tab="results">查看结果与下一步</button>'}
              <button class="button ghost" data-home-tab="results">打开结果页</button>
            </div>
          </article>
        </div>
      </article>
    `;
  }
  if (!card) return '';
  if (card.status === 'needs_queue') {
    return `
      <article class="today-mainline-card today-inline-writeback-card">
        <span class="chip info">结果回写会出现在这里</span>
        <strong>先把今天要联系的对象推进到顶部</strong>
        <p>${escapeHtml(card.summary || '形成今日联系队列后，这里会直接给你结果回写入口和下一步承接。')}</p>
        <div class="button-stack">
          <button class="button primary" data-lead-run-action="advance-today">推进到今日联系</button>
        </div>
      </article>
    `;
  }
  const outcomeContext = buildTodayTaskOutcomeContext(run, card);
  return `
    <article class="today-mainline-card today-inline-writeback-card">
      <div class="today-mainline-head">
        <div>
          <span class="chip warning">打完就在这里记结果</span>
          <strong>内嵌结果回写面板</strong>
          <p>${escapeHtml(card.task_id ? '不用去结果区翻卡片；当前这条线索的结果标签和补时间提示已经收在这里。' : '当前没有可回写的跟进任务，先继续创建今日任务。')}</p>
        </div>
        <div class="keyword-list compact">
          ${card.lead_name ? `<code>${escapeHtml(card.lead_name)}</code>` : ''}
          ${card.task_priority ? `<code>${escapeHtml(card.task_priority)}</code>` : ''}
          ${card.route_label ? `<code>${escapeHtml(card.route_label)}</code>` : ''}
        </div>
      </div>
      <div class="today-writeback-grid">
        <article class="today-writeback-section">
          <span class="today-mainline-section-title">回写前先看一眼</span>
          <p>${escapeHtml(card.next_action || '记录结果后，系统会自动接下一步。')}</p>
          ${outcomeContext?.writebackPreview ? renderLeadWritebackPreviewBrief(outcomeContext.writebackPreview, {
            compact: true,
            starterTemplate: card.writeback_starter_template || null
          }) : `<small>${escapeHtml(card.reason || card.summary || '当前结果会直接回写到这条获客执行。')}</small>`}
        </article>
        <article class="today-writeback-section">
          <span class="today-mainline-section-title">直接点结果</span>
          ${card.task_id
            ? renderTaskOutcomeQuickButtons(card.task_id, outcomeContext, { title: '常用结果标签' })
            : '<p>当前没有可回写任务。</p>'}
          <div class="button-stack">
            ${card.task_id ? `<button class="button secondary" data-action="complete-task" data-task-id="${escapeHtml(card.task_id)}">打开完整结果表单</button>` : ''}
            <button class="button ghost" data-home-tab="results">结果与下一步</button>
          </div>
        </article>
      </div>
    </article>
  `;
}

function renderTodayNextStepTimerCard(run) {
  const confirmation = run?.writeback_confirmation_card || null;
  const multiChannelFollowupPack = confirmation?.multi_channel_followup_pack || run?.multi_channel_followup_pack || null;
  const handoff = run?.today_workbench?.writeback_handoff || null;
  const routeCard = run?.outcome_route_card || null;
  const currentCard = run?.today_contact_card || null;
  const nextTask = confirmation?.next_task || handoff?.next_task || routeCard?.followup_task || null;
  const dueAt = nextTask?.due_at || confirmation?.next_step_due_at || routeCard?.next_step_due_at || currentCard?.due_at || '';
  const dueLabel = dueAt ? formatDate(dueAt) : '';
  const title = nextTask?.title
    || confirmation?.next_action
    || routeCard?.recommended_action
    || currentCard?.task_title
    || '回写后这里会显示下一步';
  const owner = nextTask?.lead_name || confirmation?.lead_name || routeCard?.lead_name || currentCard?.lead_name || '';
  const actionLabel = confirmation?.primary_action?.label || handoff?.primary_action?.label || '';
  const primaryAction = confirmation?.primary_action || handoff?.primary_action || null;
  return `
    <article class="today-mainline-card today-next-step-card">
      <div>
        <span class="chip ${nextTask || confirmation ? 'success' : 'info'}">${escapeHtml(nextTask || confirmation ? '下一步时间已排好' : '下一步时间')}</span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(dueLabel ? `时间：${dueLabel}` : '完成一次真实回写后，这里会立即显示下一步动作、时间和对象。')}</p>
      </div>
      <div class="today-next-step-meta">
        ${owner ? `<small>${escapeHtml(owner)}</small>` : ''}
        ${confirmation?.route_label ? `<small>${escapeHtml(confirmation.route_label)}</small>` : currentCard?.route_label ? `<small>${escapeHtml(currentCard.route_label)}</small>` : ''}
        ${routeCard?.outcome_tag ? `<small>${escapeHtml(routeCard.outcome_tag)}</small>` : ''}
      </div>
      <div class="button-stack">
        ${primaryAction?.action ? `
          <button class="button primary" data-lead-run-action="${escapeHtml(primaryAction.action)}"
            data-task-id="${escapeHtml(primaryAction.task_id || '')}"
            data-lead-id="${escapeHtml(primaryAction.lead_id || '')}"
            data-focus-title="${escapeHtml(primaryAction.title || '')}"
            data-focus-lead="${escapeHtml(owner || '')}"
            data-focus-reason="${escapeHtml(primaryAction.reason || confirmation?.next_action || '')}">${escapeHtml(actionLabel || '继续下一步')}</button>
        ` : '<button class="button secondary" data-home-tab="results">查看结果与下一步</button>'}
      </div>
      ${multiChannelFollowupPack ? renderLeadMultiChannelFollowupPack(multiChannelFollowupPack, {
        title: '今天可直接跟进的渠道',
        asArticle: false,
        maxItems: 2
      }) : ''}
    </article>
  `;
}

function renderLeadResultSummaryStrip(run) {
  if (!run) {
    return renderEmpty('完成通话或任务回写后，这里会先收口展示本次结果、下一步和为什么继续这样做。');
  }
  const confirmation = run.writeback_confirmation_card || null;
  const routeCard = run.outcome_route_card || null;
  const review = run.outcome_review || null;
  const nextBatchPlan = run.next_batch_plan || null;
  const feedbackPacket = run.result_feedback_packet || confirmation?.review_feedback_packet || null;
  const scriptExperimentCard = run.script_experiment_card || feedbackPacket?.script_experiment_card || null;
  const tomorrowQueue = run.tomorrow_queue || null;
  const promptLearning = confirmation?.prompt_learning || review?.prompt_learning || nextBatchPlan?.prompt_learning || null;
  const outcomeLabel = confirmation?.outcome_tag
    || callDispositionText(confirmation?.disposition || routeCard?.disposition || '')
    || '等待结果';
  const outcomeCopy = confirmation?.summary || routeCard?.summary || '完成真实触达后，这里会先收口展示结果。';
  const nextDueAt = confirmation?.next_task?.due_at || routeCard?.next_step_due_at || routeCard?.followup_task?.due_at || '';
  const nextTitle = confirmation?.next_task?.title || routeCard?.recommended_action || run.next_recommended_action || '继续推进当前执行';
  const whyCopy = feedbackPacket?.summary
    || promptLearning?.summary
    || feedbackPacket?.script_feedback_conditions?.summary
    || feedbackPacket?.win_loss_brief?.summary
    || review?.script_feedback_conditions?.summary
    || review?.win_loss_brief?.summary
    || review?.summary
    || run.signal_packet?.summary
    || '结果回写后，这里会说明为什么下一轮仍建议沿当前方向推进。';
  const whyChips = [
    promptLearning?.prompt_learning_phase ? `Prompt ${leadPromptPhaseLabel(promptLearning.prompt_learning_phase)}` : '',
    leadSampleConfidenceChip(promptLearning?.sample_count),
    promptLearning?.prompt_version_hash ? `版本 ${truncateText(promptLearning.prompt_version_hash, 12)}` : '',
    asArray(feedbackPacket?.next_experiments).length ? `${asArray(feedbackPacket?.next_experiments).length} 个实验` : asArray(review?.next_experiments).length ? `${asArray(review?.next_experiments).length} 个实验` : ''
  ].filter(Boolean);
  return `
    <div class="lead-run-result-summary-grid">
      <article class="lead-run-result-summary-card">
        <span class="chip success">本次结果</span>
        <strong>${escapeHtml(outcomeLabel)}</strong>
        <p>${escapeHtml(outcomeCopy)}</p>
      </article>
      <article class="lead-run-result-summary-card">
        <span class="chip warning">下一步</span>
        <strong>${escapeHtml(nextTitle)}</strong>
        <p>${escapeHtml(nextDueAt ? `继续时间：${formatDate(nextDueAt)}` : (confirmation?.next_action || routeCard?.next_action || run.computed_next_recommended_action || '继续按当前主链推进。'))}</p>
      </article>
      <article class="lead-run-result-summary-card">
        <span class="chip info">为什么继续这样</span>
        <strong>${escapeHtml(promptLearning?.next_action || '当前结果依据')}</strong>
        <p>${escapeHtml(whyCopy)}</p>
        ${whyChips.length ? `<div class="keyword-list compact">${whyChips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      </article>
    </div>
    ${renderLeadMainlineControlRail(run, { mode: 'result' })}
    <div class="lead-run-result-bridge-grid">
      ${renderProspectOutreachResultSummary(run)}
      ${renderLeadExecutionFlowBridge(run.execution_flow_bridge, {
        mode: 'result'
      })}
      ${renderLeadOutcomeSopRollup(run.outcome_sop_rollup, {
        mode: 'result'
      })}
      ${renderLeadAIOutboundExecutionBridge(run.ai_outbound_execution_bridge || feedbackPacket?.ai_outbound_execution_bridge, {
        title: 'AI 外呼执行桥'
      })}
      ${renderLeadOpenIndustryAutostartPacket(run.open_industry_autostart_packet)}
      ${renderLeadIndustrySellableBrief(run)}
      ${renderLeadWeeklyFounderBriefBridge(run.weekly_founder_brief)}
      ${renderLeadFounderPulsePacket(run.founder_pulse_packet)}
      ${renderLeadContextHandoffBridge(run.context_handoff_bridge)}
      ${renderLeadNextTouchAssetPack(run.next_touch_asset_pack)}
      ${renderLeadResultProofHandoffPack(run.result_proof_handoff_pack)}
      ${renderLeadThreadBrief(run.lead_thread_brief)}
      ${renderLeadCallProofContinuityPacket(run.call_proof_continuity_packet)}
      ${renderLeadPromiseFulfillmentPack(run.promise_fulfillment_pack)}
      ${renderLeadSilenceRecoveryPlay(run.silence_recovery_play)}
      ${renderLeadFounderDefaultDecisionDigest(run.founder_default_decision_digest)}
      ${renderLeadDefaultConfidenceBand(run.default_confidence_band)}
      ${renderLeadNextRunLearningPriorityPack(run.next_run_learning_priority_pack)}
      ${renderLeadPlaybookFreshnessDecay(run.playbook_freshness_decay_packet)}
      ${renderLeadEvidenceExpiryRecheck(run.evidence_expiry_recheck_packet)}
      ${renderLeadExperimentStoplossGuard(run.experiment_stoploss_guard)}
      ${renderLeadRunReuseScopeGuard(run.run_reuse_scope_guard)}
      ${renderLeadMainlineDefaultActivationBrief(run.mainline_default_activation_brief)}
      ${renderLeadDefaultUnlockImpactBrief(run.default_unlock_impact_brief)}
      ${renderLeadEvidenceGapClosureBrief(run.evidence_gap_closure_brief)}
      ${renderLeadSourceDefaultActivationCard(run.source_default_activation_card)}
      ${renderLeadScriptDefaultActivationCard(run.script_default_activation_card)}
      ${renderLeadFollowupDefaultActivationCard(run.followup_default_activation_card)}
      ${renderLeadFounderWeeklyDecisionRollup(run.founder_weekly_decision_rollup)}
      ${renderLeadFounderDecisionActionQueue(run.founder_decision_action_queue)}
      ${renderLeadFounderDecisionWritebackPacket(run.founder_decision_writeback_packet)}
      ${renderLeadUnresolvedDecisionCarryforwardPacket(run.unresolved_decision_carryforward_packet)}
      ${renderLeadNextRunBootstrapBridge(run.next_run_bootstrap_packet)}
      ${renderLeadCaptureProofSurface(run.capture_proof_surface, { mode: 'result' })}
      ${renderLeadMainlineMemoryFabric(run.mainline_memory_fabric, { mode: 'result' })}
      ${renderLeadSkillProofSurface(run.skill_proof_surface, { mode: 'result' })}
      ${renderLeadMainlineExperimentQueue(run.mainline_experiment_queue, { mode: 'result' })}
      ${renderLeadScriptExperimentCard(scriptExperimentCard, { mode: 'result' })}
      ${renderLeadPlaybookEvidenceLearningHeartbeat(run.playbook_evidence_learning_heartbeat)}
      ${renderLeadMainlineLearningHeartbeat(run.mainline_learning_heartbeat)}
      ${renderLeadResultTomorrowQueueBridge(tomorrowQueue, {
        summary: confirmation?.next_action || routeCard?.next_action || run.computed_next_recommended_action || ''
      })}
      ${renderLeadResultNextBatchBridge(nextBatchPlan, review, feedbackPacket)}
      ${renderLeadResultLearningPack(run, review, nextBatchPlan)}
      ${renderLeadDeliveryResultPackExport(run.delivery_result_pack)}
    </div>
  `;
}

function renderLeadNextRunBootstrapBridge(packet) {
  if (!packet) return '';
  const scriptFocus = packet.script_focus || null;
  const topSource = asArray(packet.preferred_sources)[0] || null;
  const topCluster = asArray(packet.query_clusters)[0] || null;
  const topExperiment = asArray(packet.next_week_experiments)[0] || null;
  const chips = [
    topSource?.source_label ? `来源 ${topSource.source_label}` : '',
    topCluster?.label ? `问题簇 ${topCluster.label}` : '',
    asArray(packet.next_week_experiments).length ? `${asArray(packet.next_week_experiments).length} 个延续实验` : ''
  ].filter(Boolean);
  const detailLines = [
    packet.why_this_bootstrap || '',
    packet.result_proof_handoff_summary || '',
    packet.call_proof_continuity_summary || '',
    packet.founder_default_decision_summary || '',
    packet.founder_weekly_decision_summary || '',
    packet.carryforward_summary || '',
    packet.founder_pulse_summary || '',
    packet.default_unlock_impact_summary || '',
    packet.learning_priority_summary || '',
    packet.playbook_freshness_summary || '',
    packet.reuse_scope_summary || '',
    packet.default_activation_summary || '',
    packet.playbook_evidence_learning_summary || '',
    packet.learning_summary || '',
    packet.experiment_summary || '',
    packet.retirement_summary || '',
    packet.mainline_memory_summary ? `继续记住：${packet.mainline_memory_summary}` : packet.mainline_memory_fabric?.summary ? `继续记住：${packet.mainline_memory_fabric.summary}` : '',
    packet.source_priority_reason ? `继续理由：${packet.source_priority_reason}` : '',
    scriptFocus?.proof_point ? `开口先带：${scriptFocus.proof_point}` : '',
    scriptFocus?.objection_answer ? `异议先回：${scriptFocus.objection_answer}` : '',
    topExperiment?.instruction ? `先测：${topExperiment.instruction}` : ''
  ].filter(Boolean).slice(0, 4);
  return `
    <article class="lead-run-result-bridge-card">
      <span class="chip success">下一轮起跑包</span>
      <strong>${escapeHtml(packet.title || '按本轮结论启动下一轮')}</strong>
      <p>${escapeHtml(packet.summary || '把本轮更稳的来源、问题簇和话术重点直接带回下一轮 run。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">
        ${detailLines.length
          ? detailLines.map((line) => `<small>· ${escapeHtml(line)}</small>`).join('')
          : '<small>· 结果回写后，这里会收口成一份可直接起下一轮的轻量起跑包。</small>'}
      </div>
      <div class="lead-run-result-bridge-actions">
        <button class="button primary" data-lead-run-action="next-run-bootstrap">按本轮结论启动下一轮</button>
      </div>
    </article>
  `;
}

function renderLeadWeeklyFounderBriefBridge(brief) {
  if (!brief) return '';
  const chips = [
    brief.status === 'ready' ? '本周可直接决策' : brief.status === 'partial' ? '还差几次真实回写' : '先跑第一批结果',
    asArray(brief.best_sources).length ? `${asArray(brief.best_sources).length} 个更稳来源` : '',
    asArray(brief.top_objections).length ? `${asArray(brief.top_objections).length} 个高频异议` : '',
    asArray(brief.next_week_experiments).length ? `${asArray(brief.next_week_experiments).length} 个下周实验` : '',
    brief.retirement_summary ? '已有技能退场提醒' : ''
  ].filter(Boolean);
  const detailLines = [
    ...asArray(brief.weekly_wins).slice(0, 2),
    ...asArray(brief.weekly_losses).slice(0, 1),
    brief.result_proof_handoff_summary ? `结果交接：${brief.result_proof_handoff_summary}` : '',
    brief.execution_commitment_summary ? `下一步承诺：${brief.execution_commitment_summary}` : '',
    brief.founder_default_decision_summary ? `老板决策：${brief.founder_default_decision_summary}` : '',
    brief.founder_weekly_decision_summary ? `本周决策收口：${brief.founder_weekly_decision_summary}` : '',
    brief.founder_pulse_summary ? `当前提醒：${brief.founder_pulse_summary}` : '',
    brief.silence_recovery_summary ? `沉默恢复：${brief.silence_recovery_summary}` : '',
    brief.learning_priority_summary ? `下一轮学习重点：${brief.learning_priority_summary}` : '',
    brief.founder_notice ? `老板提醒：${brief.founder_notice}` : '',
    ...asArray(brief.next_week_experiments).slice(0, 1).map((item) => `下周先试：${item.instruction || item.title || '继续当前实验'}`)
  ].filter(Boolean).slice(0, 4);
  return `
    <article class="lead-run-result-bridge-card">
      <span class="chip info">老板周简报</span>
      <strong>${escapeHtml(brief.headline || brief.title || '本周轻量简报')}</strong>
      <p>${escapeHtml(brief.summary || '系统会把本周来源赢输、异议和下周实验收成一屏能看懂的简报。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">
        ${detailLines.length
          ? detailLines.map((line) => `<small>· ${escapeHtml(line)}</small>`).join('')
          : '<small>· 先完成本周第一批真实触达，再看系统收口的周简报。</small>'}
      </div>
      ${renderLeadFollowupExperimentCard(brief.followup_experiment_card, {
        mode: 'weekly',
        asArticle: false
      })}
      ${renderLeadFollowupDefaultActivationCard(brief.followup_default_activation_card, {
        asArticle: false
      })}
      ${renderLeadSilenceRecoveryPlay(brief.silence_recovery_play, {
        title: '这周最值得救回的沉默',
        compact: true,
        asArticle: false
      })}
      ${brief.retirement_summary ? `<small>${escapeHtml(`技能退场：${brief.retirement_summary}`)}</small>` : ''}
      ${brief.human_feedback_summary ? `<small>${escapeHtml(`人工反馈：${brief.human_feedback_summary}`)}</small>` : ''}
      ${renderLeadHumanFeedbackButtons({
        targetKind: 'weekly_founder_brief',
        targetId: 'weekly_founder_brief',
        targetLabel: brief.title || '老板周简报'
      })}
      <div class="lead-run-result-bridge-actions">
        <button class="button primary" data-lead-run-action="weekly-review">刷新周简报</button>
        <button class="button ghost" data-home-tab="results">留在结果页</button>
      </div>
    </article>
  `;
}

function renderProspectOutreachResultSummary(run) {
  const summary = run?.prospect_outreach_result_summary || null;
  const packs = summary
    ? asArray(summary.top_packs)
    : asArray(run?.prospect_outreach_packs || run?.lead_acquisition_workbench_view?.prospect_outreach_packs)
      .slice(0, 5)
      .map((pack, index) => ({
        rank: index + 1,
        display_name: pack.display_name,
        primary_need: pack.need_summary?.primary_need,
        recommended_channel_label: pack.contact_plan?.recommended_channel_label,
        purchase_intent_level: pack.purchase_intent?.level,
        source_url: pack.trigger_evidence?.source_url,
        has_profile_analysis: Boolean(pack.profile_analysis && Object.keys(pack.profile_analysis).length)
      }));
  if (!summary && packs.length < 1) return '';

  const chips = [
    summary?.meets_mvp_evidence_gate ? 'MVP 证据门已满足' : summary?.meets_mvp_pack_count ? '触达包已生成' : '',
    summary?.total_packs ? `${summary.total_packs} 张触达包` : packs.length ? `${packs.length} 张触达包` : '',
    summary?.packs_with_profile_analysis ? `${summary.packs_with_profile_analysis} 张含主页追读` : '',
    summary?.mvp_checklist?.passed_count != null
      ? `§8 自动检 ${summary.mvp_checklist.passed_count}/${summary.mvp_checklist.total_count}`
      : ''
  ].filter(Boolean);

  return `
    <article class="lead-run-result-bridge-card prospect-outreach-result-summary-card">
      <span class="chip success">触达包交付汇总</span>
      <strong>${escapeHtml(summary?.summary?.slice(0, 72) || '今日优先触达机会已收口到 Result')}</strong>
      <p>${escapeHtml(summary?.summary || 'Result 页展示触达包数量、渠道、意愿与来源链接，与 Workbench 读同一份 prospect_outreach_packs。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list prospect-outreach-result-pack-list">
        ${packs.slice(0, 5).map((pack) => `
          <div class="prospect-outreach-result-pack-row">
            <strong>${escapeHtml(pack.display_name || `触达机会 ${pack.rank || ''}`)}</strong>
            <small>
              ${escapeHtml([
                pack.recommended_channel_label || '平台私信',
                pack.purchase_intent_level ? `意愿 ${pack.purchase_intent_level}` : '',
                pack.primary_need ? truncateText(pack.primary_need, 48) : '',
                pack.has_profile_analysis ? '含主页追读' : ''
              ].filter(Boolean).join(' · '))}
            </small>
            ${pack.source_url ? `<a class="button ghost" href="${escapeHtml(pack.source_url)}" target="_blank" rel="noopener noreferrer">来源</a>` : ''}
          </div>
        `).join('')}
      </div>
      <div class="lead-run-result-bridge-actions">
        <button class="button primary" data-home-tab="today">回 Today 去联系</button>
        <button class="button ghost" data-lead-run-action="outreach-contact">打开主触达卡</button>
      </div>
      ${renderProspectOutreachAcceptanceDock(run, { compact: true })}
    </article>
  `;
}

function renderProspectOutreachAcceptanceDock(run, options = {}) {
  if (!run) return '';
  const compact = options.compact === true;
  const mvpAcceptance = run.prospect_outreach_mvp_demo_acceptance || null;
  const mvpChecklist = run.prospect_outreach_mvp_demo_checklist || null;
  const liveAcceptance = run.prospect_outreach_live_demo_acceptance || null;
  const registry = run.prospect_outreach_channel_provider_registry || null;
  const signals = run.prospect_outreach_live_demo_run_signals || null;
  const attestationItems = asArray(run.prospect_outreach_live_demo_attestation_items).length
    ? run.prospect_outreach_live_demo_attestation_items
    : PROSPECT_OUTREACH_LIVE_DEMO_ATTESTATION_ITEMS_FALLBACK;
  const envGuide = run.prospect_outreach_provider_env_guide || null;
  if (!mvpAcceptance && !mvpChecklist && !liveAcceptance && !registry) return '';

  const aStatus = mvpAcceptance?.status === 'accepted'
    ? `A 层自动化 ${mvpAcceptance.passed_count || 0}/${mvpAcceptance.total_count || 9} 已通过`
    : mvpChecklist?.passed_count != null
      ? `A 层检 ${mvpChecklist.passed_count}/${mvpChecklist.total_count}`
      : 'A 层待检';
  const bStatus = liveAcceptance?.status === 'accepted'
    ? `B 层真机已记账 · ${liveAcceptance.accepted_by || '验收人'}`
    : 'B 层真机未记账';
  const wechatReady = registry?.channels?.wechat?.endpoint_configured ? '企微 endpoint 已配' : '企微 endpoint 未配';
  const emailReady = registry?.channels?.email?.endpoint_configured ? '邮件 endpoint 已配' : '邮件 endpoint 未配';
  const signalHints = [
    signals?.packs_ge_3 ? '触达包≥3' : '触达包不足 3',
    signals?.mvp_automation_passed ? 'A 层全绿' : 'A 层未全绿',
    signals?.browser_session_bound ? '浏览器会话已绑定' : '浏览器会话未绑定'
  ].filter(Boolean);

  return `
    <section class="prospect-outreach-acceptance-dock${compact ? ' is-compact' : ''}">
      <header class="workbench-entity-hero">
        <p class="workbench-zone-kicker">Acceptance</p>
        <h3>${compact ? '验收与生产渠道' : '验收分层与生产渠道'}</h3>
        <p>A 层为 mock 主链自动化；B 层为真机 Chrome 记账，二者不混用。生产代发需配置环境变量或 strategy bindings。</p>
      </header>
      <div class="workbench-entity-grid">
        <article class="workbench-entity-card">
          <span>A 层 §8</span>
          <strong>${escapeHtml(aStatus)}</strong>
          <small>${escapeHtml(mvpAcceptance?.note || '由 prospect_outreach_mvp_demo_acceptance 读模型判定')}</small>
        </article>
        <article class="workbench-entity-card">
          <span>B 层 live</span>
          <strong>${escapeHtml(bStatus)}</strong>
          <small>${escapeHtml(signalHints.join(' · ') || '完成真机 Demo 后可记账')}</small>
        </article>
        <article class="workbench-entity-card">
          <span>生产 provider</span>
          <strong>${escapeHtml(wechatReady)}</strong>
          <small>${escapeHtml(emailReady)}</small>
        </article>
      </div>
      ${liveAcceptance?.status === 'accepted' ? '' : compact ? `
        <p class="prospect-outreach-acceptance-hint">完整 B 层 attestation 表单请在 Workbench 填写。</p>
      ` : `
        <form class="prospect-outreach-live-attestation-form">
          <fieldset>
            <legend>B 层真机六项 attestation（须全部勾选，不使用 force_accept）</legend>
            ${attestationItems.map((item) => `
              <label class="prospect-outreach-attestation-row">
                <input type="checkbox" name="attestation_${escapeHtml(item.key)}" />
                <span>${escapeHtml(item.label || item.key)}</span>
              </label>
            `).join('')}
          </fieldset>
          <label class="prospect-outreach-attestation-row">
            <span>验收人</span>
            <input type="text" name="operator_name" placeholder="姓名或角色" autocomplete="name" />
          </label>
          <label class="prospect-outreach-attestation-row">
            <input type="checkbox" name="browser_session_confirmed" />
            <span>已确认真机 Chrome 会话（或 run 已绑定 browser_session）</span>
          </label>
          <div class="prospect-outreach-actions">
            <button class="button secondary" type="button" data-lead-run-action="outreach-live-demo-acceptance">
              提交 B 层真机验收记账
            </button>
          </div>
        </form>
      `}
      ${envGuide?.env_vars?.length ? `
        <details class="prospect-outreach-env-guide">
          <summary>生产 provider 环境变量（${escapeHtml(envGuide.example_file || '.env.example')}）</summary>
          <ul>
            ${envGuide.env_vars.map((row) => `
              <li><code>${escapeHtml(row.key)}</code> — ${escapeHtml(row.purpose || '')}</li>
            `).join('')}
          </ul>
          <p><small>Gateway 契约：<code>${escapeHtml(run.prospect_outreach_provider_gateway_contract?.packet_id || envGuide.gateway_contract_id || 'prospect-outreach-provider-gateway-v1')}</code> · 见 <code>docs/prospect-outreach-provider-gateway.md</code></small></p>
        </details>
      ` : ''}
    </section>
  `;
}

const PROSPECT_OUTREACH_LIVE_DEMO_ATTESTATION_ITEMS_FALLBACK = [
  { key: 'chrome_logged_in_xhs', label: 'Chrome 已登录小红书账号' },
  { key: 'completed_public_source_discover', label: '完成 public-source discover（真机读帖）' },
  { key: 'outreach_cards_reviewed_ge_3', label: '查看 ≥3 张触达卡' },
  { key: 'copied_opening_and_contacted', label: '复制开口并完成平台联系' },
  { key: 'writeback_interested_recorded', label: '回写 interested' },
  { key: 'stayed_outside_agent_config', label: '全程未进入 Agent/工具配置页' }
];

function renderLeadDeliveryResultPackExport(pack) {
  if (!pack) return '';
  const clientCover = pack.client_cover_summary || null;
  const clientNextSteps = pack.client_next_steps || null;
  const handoffNotes = pack.handoff_notes || null;
  const clientRiskNotes = pack.client_risk_notes || null;
  const chips = [
    pack.status === 'ready' ? '可直接交付' : pack.status === 'partial' ? '中间交付' : '待补结果',
    pack?.lead_pack_export?.total_leads ? `${pack.lead_pack_export.total_leads} 条线索` : '',
    pack?.priority_queue_export?.total_actions ? `${pack.priority_queue_export.total_actions} 条顺位` : '',
    pack?.followup_packet_export?.total_followups ? `${pack.followup_packet_export.total_followups} 个跟进动作` : ''
  ].filter(Boolean);
  const review = pack.review_pack_export || null;
  const lines = [
    clientCover?.summary || pack?.lead_pack_export?.summary || '',
    asArray(clientNextSteps?.steps)[0]?.title
      ? `交付后先做：${asArray(clientNextSteps.steps)[0].title}`
      : pack?.suggested_use ? `交付方式：${pack.suggested_use}` : '',
    asArray(handoffNotes?.notes)[0]?.note
      ? `交接备注：${asArray(handoffNotes.notes)[0].note}`
      : review?.summary || '',
    pack?.result_proof_handoff_summary ? `结果交接：${pack.result_proof_handoff_summary}` : '',
    pack?.lead_execution_proof_summary ? `执行证明：${pack.lead_execution_proof_summary}` : '',
    asArray(clientRiskNotes?.notes)[0]?.label
      ? `风险提示：${asArray(clientRiskNotes.notes)[0].label}`
      : review?.next_batch_recommendation?.source_priority_reason
        ? `下一批优先理由：${review.next_batch_recommendation.source_priority_reason}`
      : ''
  ].filter(Boolean).slice(0, 4);
  return `
    <article class="lead-run-result-bridge-card">
      <span class="chip success">交付结果包</span>
      <strong>${escapeHtml(pack.title || '当前结果包')}</strong>
      <p>${escapeHtml(pack.delivery_summary || '系统会把名单、顺位、脚本、跟进包和复盘收成可导出的结果包。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">
        ${lines.map((line) => `<small>· ${escapeHtml(line)}</small>`).join('')}
      </div>
      <small>${escapeHtml(clientCover?.delivery_positioning || '更适合直接交付客户 / 老板的业务语言版本。')}</small>
      ${renderLeadNextTouchAssetPack(pack.next_touch_asset_pack, {
        title: '交付后下一次先发这份',
        compact: true,
        asArticle: false
      })}
      <div class="lead-run-result-bridge-actions">
        <button class="button primary" data-lead-run-action="export-result-pack">导出结果包</button>
      </div>
    </article>
  `;
}

function renderLeadResultTomorrowQueueBridge(queue, fallback = {}) {
  const ladderItems = asArray(queue?.priority_ladder_packet?.items).slice(0, 3);
  const candidates = asArray(queue?.candidates).slice(0, 3);
  const routeSummary = asArray(queue?.route_summary).slice(0, 3);
  const createdCount = asArray(queue?.created_tasks).length;
  const existingCount = asArray(queue?.existing_tasks).length;
  const chips = [
    candidates.length ? `${candidates.length} 条待继续` : '',
    createdCount ? `新增 ${createdCount} 个任务` : '',
    existingCount ? `沿用 ${existingCount} 个未完成` : ''
  ].filter(Boolean);
  const detailLines = ladderItems.length
    ? ladderItems.map((item) => `<small>· ${escapeHtml(item.lead_name || item.lead_id || '线索')} · ${escapeHtml(item.urgency_bucket || '明天继续跟进')} · 最晚 ${escapeHtml(formatDateTime(item.latest_recommended_time) || '明天')} · ${escapeHtml(item.why_not_now || item.why_now || '已排入明天顺位')}</small>`).join('')
    : candidates.length
    ? candidates.map((item) => `<small>· ${escapeHtml(item.name || item.lead_id || '线索')} · ${escapeHtml(item.reason || item.route_label || '明天继续跟进')}</small>`).join('')
    : routeSummary.length
      ? routeSummary.map((item) => `<small>· ${escapeHtml(item.label || '继续跟进')}：${escapeHtml(String(item.count || 0))} 条</small>`).join('')
      : '<small>· 先把预约、回拨、未接通这些线索整理进明天队列，第二天不用重新翻结果。</small>';
  const summary = queue?.priority_ladder_packet?.summary || queue?.summary || fallback.summary || '把今天需要继续回拨、预约或补证据的线索先排进明天队列。';
  const title = ladderItems.length
    ? `明天先跟这 ${ladderItems.length} 条`
    : candidates.length
      ? `明天先跟这 ${candidates.length} 条`
    : createdCount
      ? '先把明日队列排出来'
      : '整理明日继续跟进队列';
  return `
    <article class="lead-run-result-bridge-card">
      <span class="chip warning">明天继续跟谁</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(summary)}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">${detailLines}</div>
      ${queue?.founder_pulse_summary ? `<small>当前提醒：${escapeHtml(queue.founder_pulse_summary)}</small>` : ''}
      ${renderLeadCallProofContinuityPacket(queue?.call_proof_continuity_packet, {
        title: '明天别让这条承诺断线',
        compact: true,
        asArticle: false
      })}
      ${renderLeadPromiseFulfillmentPack(queue?.promise_fulfillment_pack, {
        title: '明天先兑现这条承诺',
        compact: true,
        asArticle: false
      })}
      ${renderLeadSilenceRecoveryPlay(queue?.silence_recovery_play, {
        title: '明天先追回这条沉默',
        compact: true,
        asArticle: false
      })}
      ${renderLeadFollowupDefaultActivationCard(queue?.followup_default_activation_card, {
        asArticle: false
      })}
      ${renderLeadFollowupExperimentCard(queue?.followup_experiment_card, {
        mode: 'tomorrow',
        asArticle: false
      })}
      <div class="lead-run-result-bridge-actions">
        <button class="button primary" data-lead-run-action="tomorrow-queue">${escapeHtml(queue ? '刷新明日队列' : '整理明日队列')}</button>
        <button class="button ghost" data-home-tab="today">看今天处理</button>
      </div>
    </article>
  `;
}

function renderLeadResultNextBatchBridge(plan, review, feedbackPacket = null) {
  const recommendation = review?.next_batch_recommendation || null;
  const keywords = asArray(plan?.keywords).slice(0, 3);
  const steps = asArray(plan?.collection_steps).slice(0, 2);
  const gates = asArray(plan?.quality_gate).slice(0, 1);
  const sampleHints = asArray(plan?.sample_rows_hint).slice(0, 1);
  const reviewFeedbackPacket = plan?.review_feedback_packet || feedbackPacket || null;
  const experiment = asArray(plan?.next_experiments || reviewFeedbackPacket?.next_experiments).slice(0, 1);
  const riskFlags = asArray(plan?.risk_flags || reviewFeedbackPacket?.risk_flags).slice(0, 1);
  const signalGuidance = plan?.signal_guidance_snapshot || reviewFeedbackPacket?.signal_guidance_snapshot || plan?.signal_guidance || null;
  const recalibrationPacket = plan?.source_authority_recalibration_packet || reviewFeedbackPacket?.source_authority_recalibration_packet || signalGuidance?.source_authority_recalibration_packet || null;
  const collectionBrief = plan?.next_batch_collection_brief || null;
  const queryClusters = asArray(signalGuidance?.query_clusters).slice(0, 2);
  const preferredSources = asArray(signalGuidance?.preferred_sources).slice(0, 2);
  const sourcePriorityReason = String(signalGuidance?.source_priority_reason || preferredSources[0]?.source_priority_reason || '').trim();
  const detailLines = plan
    ? [
      leadPreferredSourceLine(preferredSources) || (plan.source ? `优先来源：${plan.source}` : ''),
      leadQueryClusterLine(queryClusters),
      leadSourcePriorityReasonLine(sourcePriorityReason),
      reviewFeedbackPacket?.win_loss_brief?.summary || plan.win_loss_brief?.summary
        ? `来源赢/输：${reviewFeedbackPacket?.win_loss_brief?.summary || plan.win_loss_brief?.summary}`
        : '',
      recalibrationPacket?.summary ? `动态校准：${recalibrationPacket.summary}` : '',
      leadPatternSummaryLine(collectionBrief?.include_patterns, '优先补'),
      leadPatternSummaryLine(collectionBrief?.exclude_patterns, '先排除'),
      experiment[0]?.instruction ? `先测：${experiment[0].instruction}` : '',
      riskFlags[0]?.label ? `风险：${riskFlags.map((item) => `${item.label}${item.action ? ` → ${item.action}` : ''}`).join('；')}` : '',
      ...steps,
      ...gates,
      ...sampleHints
    ].filter(Boolean).slice(0, 5)
    : [
      recommendation?.source || '',
      recommendation?.action || review?.next_action || '',
      '先把采集清单生成出来，再补真实名单并导入。'
    ].filter(Boolean).slice(0, 3);
  const chips = plan
    ? [
      plan.batch_size ? `${plan.batch_size} 条` : '',
      riskFlags.length ? `${riskFlags.length} 个风险` : '',
      ...asArray(collectionBrief?.collection_keywords || keywords).slice(0, 3)
    ].filter(Boolean)
    : [];
  return `
    <article class="lead-run-result-bridge-card">
      <span class="chip success">下一批导入</span>
      <strong>${escapeHtml(plan ? `补 ${plan.batch_size || ''} 条下一批真实线索` : '先生成下一批采集清单')}</strong>
      <p>${escapeHtml(plan?.summary || recommendation?.action || '结果回写后，这里会直接告诉你下一批该补什么名单。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${renderLeadNextBatchCollectionBrief(collectionBrief, { asArticle: false })}
      <div class="lead-run-result-bridge-list">
        ${detailLines.map((item) => `<small>· ${escapeHtml(item)}</small>`).join('')}
      </div>
      <div class="lead-run-result-bridge-actions">
        ${plan ? `
          <button class="button primary" data-lead-run-action="import-next-batch"
            data-next-batch-source="${escapeHtml(plan.source || '')}"
            data-next-batch-target="${escapeHtml(plan.target_profile || '')}"
            data-next-batch-batch-size="${escapeHtml(String(plan.batch_size || ''))}">补下一批线索</button>
          <button class="button ghost" data-lead-run-action="next-batch">刷新采集清单</button>
        ` : `
          <button class="button primary" data-lead-run-action="next-batch">生成采集清单</button>
        `}
      </div>
    </article>
  `;
}

function renderLeadResultLearningPack(run, review, nextBatchPlan) {
  const routeLearning = review?.route_learning || null;
  const promptLearning = review?.prompt_learning || nextBatchPlan?.prompt_learning || null;
  const signalGuidance = nextBatchPlan?.signal_guidance || null;
  const scriptFeedback = review?.script_feedback_conditions || nextBatchPlan?.script_feedback_conditions || null;
  const winLossBrief = review?.win_loss_brief || nextBatchPlan?.win_loss_brief || null;
  const experiment = asArray(review?.next_experiments || nextBatchPlan?.next_experiments).slice(0, 1);
  const memoryLabels = asArray(promptLearning?.top_memories).slice(0, 3).map((item) => item.label || '记忆');
  const preferredSource = asArray(signalGuidance?.preferred_sources)[0] || null;
  const title = routeLearning?.best_route?.route_label
    ? `继续放大「${routeLearning.best_route.route_label}」`
    : promptLearning?.focus_variant?.label
      ? `继续沿用「${promptLearning.focus_variant.label}」`
      : preferredSource?.source_label
        ? `继续从「${preferredSource.source_label}」找`
        : '把结果沉成下一轮打法';
  const summary = routeLearning?.summary || promptLearning?.summary || signalGuidance?.summary || '结果回写后，这里会把 route learning、prompt learning 和 signal guidance 收成一块。';
  const chips = [
    routeLearning?.best_route?.route_label ? `保留 ${routeLearning.best_route.route_label}` : '',
    routeLearning?.weak_route?.route_label ? `复盘 ${routeLearning.weak_route.route_label}` : '',
    promptLearning?.prompt_learning_phase ? `Prompt ${leadPromptPhaseLabel(promptLearning.prompt_learning_phase)}` : '',
    promptLearning?.prompt_version_hash ? `版本 ${truncateText(promptLearning.prompt_version_hash, 12)}` : '',
    preferredSource?.source_label ? `来源 ${preferredSource.source_label}` : '',
    winLossBrief?.winning_sources?.[0]?.source_label ? `赢 ${winLossBrief.winning_sources[0].source_label}` : ''
  ].filter(Boolean).slice(0, 4);
  const detailLines = [
    routeLearning?.next_generation_hint ? `路由：${routeLearning.next_generation_hint}` : routeLearning?.correction_focus ? `路由：${routeLearning.correction_focus}` : '',
    promptLearning?.next_action ? `Prompt：${promptLearning.next_action}` : '',
    scriptFeedback?.summary ? `话术回流：${scriptFeedback.summary}` : '',
    memoryLabels.length ? `记忆：下一轮只继续带 ${memoryLabels.join('、')} 这 ${memoryLabels.length} 条高相关记忆。` : '',
    leadPromptMeta(promptLearning),
    signalGuidance?.quality_gate?.[0] ? `Signal：${signalGuidance.quality_gate[0]}` : '',
    leadQueryClusterLine(signalGuidance?.query_clusters),
    leadSourcePriorityReasonLine(signalGuidance?.source_priority_reason),
    winLossBrief?.summary ? `来源赢/输：${winLossBrief.summary}` : '',
    experiment[0]?.instruction ? `实验：${experiment[0].instruction}` : ''
  ].filter(Boolean).slice(0, 4);
  const followAction = run?.weekly_review ? 'next-loop' : review ? 'weekly-review' : 'outcome';
  const followLabel = run?.weekly_review ? '生成下一轮行动' : review ? '轻量周复盘' : '先复盘结果';
  return `
    <article class="lead-run-result-bridge-card">
      <span class="chip info">学习收口</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(summary)}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      <div class="lead-run-result-bridge-list">
        ${detailLines.length
          ? detailLines.map((item) => `<small>· ${escapeHtml(item)}</small>`).join('')
          : '<small>· 完成更多真实回写后，这里会继续明确哪类路由、哪版 prompt、哪类来源该继续放大。</small>'}
      </div>
      <div class="lead-run-result-bridge-actions">
        <button class="button primary" data-lead-run-action="${escapeHtml(followAction)}">${escapeHtml(followLabel)}</button>
        <button class="button ghost" data-home-tab="results">留在结果页</button>
      </div>
    </article>
  `;
}

function deriveLeadWritebackPreview(preview = null, starterTemplate = null) {
  if (preview) return preview;
  if (!starterTemplate) return null;
  const conditional = asArray(starterTemplate.conditional_fields);
  return {
    route_label: starterTemplate.context?.route_label || '继续跟进',
    route_hint: starterTemplate.route_hint || '',
    next_action: starterTemplate.next_action || '',
    outcome_tags: asArray(starterTemplate.option_surface?.options || starterTemplate.outcome_options).map((item) => item.tag).filter(Boolean).slice(0, 5),
    expected_results: asArray(starterTemplate.expected_results).slice(0, 4),
    due_required_tags: conditional.flatMap((item) => asArray(item?.when_tags)).filter(Boolean).slice(0, 5),
    option_surface: starterTemplate.option_surface || null
  };
}

function renderLeadWritebackPreviewBrief(preview, { compact = false, starterTemplate = null } = {}) {
  if (!preview) return '';
  const backendOptionSurface = preview.option_surface || starterTemplate?.option_surface || null;
  const optionSurface = starterTemplate || backendOptionSurface
    ? collectWritebackOptionSurface(starterTemplate?.option_surface?.options || starterTemplate?.outcome_options || backendOptionSurface?.options || [], starterTemplate, { compact, providedSurface: backendOptionSurface })
    : { labels: [] };
  const outcomeTags = optionSurface.labels.length
    ? optionSurface.labels
    : asArray(preview.outcome_tags).slice(0, compact ? 3 : 5);
  const dueRequiredTags = asArray(preview.due_required_tags).slice(0, compact ? 2 : 4);
  const expectedResults = asArray(preview.expected_results).slice(0, compact ? 2 : 3);
  const dueNote = renderWritebackOptionDueNote(starterTemplate?.option_surface?.options || starterTemplate?.outcome_options || backendOptionSurface?.options || [], starterTemplate, {
    compact,
    providedSurface: backendOptionSurface,
    fallbackText: dueRequiredTags.length
      ? `这些结果要补下一次时间：${dueRequiredTags.join('、')}`
      : expectedResults.length
        ? `预期结果：${expectedResults.join('、')}`
        : '可直接一键回写最接近的结果标签。'
  });
  return `
    <div class="task-outcome-context">
      <span class="chip warning">打完后这样回写</span>
      <strong>${escapeHtml(preview.route_label || '继续跟进')}</strong>
      <p>${escapeHtml(preview.route_hint || preview.next_action || '通话结束后点最接近的结果标签。')}</p>
      ${outcomeTags.length ? `<div class="keyword-list compact">${outcomeTags.map((tag) => `<code>${escapeHtml(tag)}</code>`).join('')}</div>` : ''}
      <small>${escapeHtml(dueNote)}</small>
    </div>
  `;
}

function findLeadRunWritebackPreviewForTask(run, taskId) {
  if (!run?.id || !taskId) return null;
  const handoff = run.today_workbench?.writeback_handoff || null;
  if (String(handoff?.next_task_id || '') === String(taskId)) {
    return deriveLeadWritebackPreview(handoff.writeback_preview, handoff.writeback_starter_template);
  }
  const confirmation = run.writeback_confirmation_card || null;
  if (String(confirmation?.next_task?.id || '') === String(taskId)) {
    return deriveLeadWritebackPreview(confirmation.next_writeback_preview, confirmation.next_writeback_starter_template);
  }
  if (String(run.today_contact_card?.task_id || '') === String(taskId)) {
    return deriveLeadWritebackPreview(null, run.today_contact_card?.writeback_starter_template || null);
  }
  return null;
}

function renderWorkbenchWritebackHandoff(handoff, { deferred = false } = {}) {
  if (!handoff) return '';
  const nextTask = handoff.next_task || null;
  const preview = deriveLeadWritebackPreview(handoff.writeback_preview, handoff.writeback_starter_template);
  const dueLabel = formatDateTime(nextTask?.due_at) || formatDate(nextTask?.due_at) || '待安排';
  return `
    <div class="tomorrow-queue-mini">
      <div>
        <span class="chip ${deferred ? 'warning' : 'success'}">${deferred ? '下一通已排队' : '下一通已准备好'}</span>
        <p><strong>${escapeHtml(handoff.headline || '继续下一通')}</strong></p>
        <p>${escapeHtml(deferred ? `先处理当前到期任务；随后 ${handoff.summary || '继续下一通。'}` : (handoff.summary || '现在继续处理下一通。'))}</p>
        <small>${escapeHtml(nextTask?.title || '下一步任务')} · ${escapeHtml(dueLabel)}${preview?.route_label ? ` · ${escapeHtml(preview.route_label)}` : ''}</small>
      </div>
      <div class="action-stack compact-stack">
        <article class="mini-card">
          <span class="chip info">照这个开口</span>
          <strong>${escapeHtml(nextTask?.lead_name || handoff.lead_name || '下一条线索')}</strong>
          ${nextTask?.micro_script ? renderLeadMicroScriptBrief(nextTask.micro_script) : `<p>${escapeHtml(handoff.summary || '继续处理下一条线索。')}</p>`}
          <small>${escapeHtml(deferred ? '到期任务完成后，这一通会继续接上。' : '顶部主按钮已对准这一通，点“继续下一步”即可开始。')}</small>
        </article>
        <article class="mini-card">
          ${renderLeadWritebackPreviewBrief(preview, {
            compact: true,
            starterTemplate: handoff.writeback_starter_template || null
          })}
        </article>
      </div>
    </div>
  `;
}

function renderLeadScriptVariants(scriptVariants) {
  const variants = asArray(scriptVariants?.variants);
  if (!variants.length) return '';
  const selectedKey = String(scriptVariants?.selected_variant || scriptVariants?.best_variant_key || '');
  const selectedVariant = selectedKey
    ? variants.find((variant) => String(variant?.key || '') === selectedKey) || null
    : null;
  const bestVariant = scriptVariants?.efficacy?.best_variant || null;
  const provenance = scriptVariants?.provenance || null;
  const diversitySurface = scriptVariants?.diversity_surface || null;
  const weakRouteRefresh = scriptVariants?.weak_route_refresh || null;
  const reviewFeedback = scriptVariants?.review_feedback || (scriptVariants?.script_feedback_conditions || scriptVariants?.win_loss_brief || scriptVariants?.evidence_pack ? {
    summary: scriptVariants?.script_feedback_conditions?.summary || scriptVariants?.win_loss_brief?.summary || scriptVariants?.evidence_pack?.summary || '',
    evidence_pack: scriptVariants?.evidence_pack || null,
    script_feedback_conditions: scriptVariants?.script_feedback_conditions || null,
    win_loss_brief: scriptVariants?.win_loss_brief || null,
    next_experiments: scriptVariants?.next_experiments || [],
    risk_flags: scriptVariants?.risk_flags || []
  } : null);
  const summaryTitle = selectedVariant?.title || selectedVariant?.key || (bestVariant?.variant_key ? `已验证：${bestVariant.variant_key}` : '默认模板');
  const summaryReason = scriptVariants?.selection_reason || '';
  return `
    <div class="mini-card">
        <strong>当前优先话术</strong>
        <p>${escapeHtml(summaryTitle)}</p>
        <div class="keyword-list compact">
          ${selectedKey ? '<code>当前优先</code>' : '<code>默认模板</code>'}
          ${bestVariant ? `<code>${escapeHtml(`${bestVariant.conversion_rate_pct || 0}% 转化`)}</code><code>${escapeHtml(leadSampleConfidenceChip(bestVariant.total_uses) || '暂无验证样本')}</code>` : '<code>暂无验证样本</code>'}
        </div>
      ${renderLeadScriptProvenance(provenance)}
      ${renderLeadScriptReviewFeedback(reviewFeedback)}
      ${renderLeadVariantDiversitySurface(diversitySurface)}
      ${renderLeadWeakRouteRefreshSummary(weakRouteRefresh)}
      ${renderLeadHumanFeedbackButtons({
        targetKind: 'script',
        targetId: selectedKey || summaryTitle,
        targetLabel: summaryTitle || '当前优先话术'
      })}
      ${summaryReason ? `<small>${escapeHtml(summaryReason)}</small>` : ''}
    </div>
    <div class="script-variant-grid">
      ${variants.map((variant) => `
        <article class="script-variant-card">
          <div class="mini-card-heading">
            <span class="chip info">${escapeHtml(variant.label || variant.key || '话术')}</span>
            ${variant.selected ? '<span class="chip success">当前优先</span>' : ''}
            ${!variant.selected && variant.best_performing ? '<span class="chip warning">已验证更稳</span>' : ''}
            ${variant.weak_route_fix ? '<span class="chip warning">弱路由修正</span>' : ''}
          </div>
          <strong>${escapeHtml(variant.title || '')}</strong>
          <p>${escapeHtml(variant.content || variant.text || '')}</p>
          <div class="keyword-list compact">
            ${variant.efficacy
              ? `<code>${escapeHtml(`${variant.efficacy.conversion_rate_pct || 0}% 转化`)}</code><code>${escapeHtml(leadSampleConfidenceChip(variant.efficacy.total_uses) || '暂无验证样本')}</code>`
              : '<code>暂无验证样本</code>'}
          </div>
          ${variant.supporting_proof_point?.proof_point ? `<small>${escapeHtml(`优先证据：${variant.supporting_proof_point.proof_point}`)}</small>` : ''}
          ${variant.objection_answer?.label ? `<small>${escapeHtml(`先处理异议：${variant.objection_answer.label} → ${variant.objection_answer.answer}`)}</small>` : ''}
          ${variant.when_to_use ? `<small>${escapeHtml(variant.when_to_use)}</small>` : ''}
        </article>
      `).join('')}
    </div>
  `;
}

function renderLeadGenerationWarning(warning) {
  if (!warning) return '';
  const chips = [
    warning.badge || '',
    warning.status === 'using_template' ? '先继续打当前话术' : '',
    warning.status === 'waiting_ai' ? '不用停下来等' : '',
    warning.status === 'budget_warning' ? '优先复用已验证开口' : '',
    warning.status === 'retry_ready' ? '稍后可再试一次' : ''
  ].filter(Boolean);
  const details = asArray(warning.details).slice(0, 3);
  return `
    <div class="script-provenance weak-route-refresh">
      <div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>
      ${warning.title ? `<small>${escapeHtml(warning.title)}</small>` : ''}
      ${warning.summary ? `<small>${escapeHtml(warning.summary)}</small>` : ''}
      ${details.length ? `<small>${escapeHtml(details.join('；'))}</small>` : ''}
      ${warning.next_action ? `<small>${escapeHtml(warning.next_action)}</small>` : ''}
    </div>
  `;
}

function renderLeadWeakRouteRefreshSummary(refresh) {
  if (!refresh) return '';
  const guidance = refresh.prompt_guidance || null;
  const notes = asArray(guidance?.adjustment_notes || refresh.improvements).slice(0, 3);
  const rules = asArray(guidance?.carryover_rules).slice(0, 3);
  const memories = asArray(guidance?.top_memories).slice(0, 3);
  const chips = [
    `修正 ${refresh.route_type || 'weak-route'}`,
    guidance?.prompt_learning_phase ? `沿用 ${leadPromptPhaseLabel(guidance.prompt_learning_phase)} prompt` : '',
    guidance?.prompt_version_hash ? `版本 ${truncateText(guidance.prompt_version_hash, 16)}` : '',
    leadSampleConfidenceChip(guidance?.sample_count),
    guidance?.focus_variant?.label ? `复用 ${guidance.focus_variant.label}` : ''
  ].filter(Boolean);
  return `
    <div class="script-provenance weak-route-refresh">
      <div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>
      ${refresh.reason ? `<small>${escapeHtml(refresh.reason)}</small>` : ''}
      ${notes.length ? `<small>${escapeHtml(`这次生成优先纠正：${notes.join('；')}`)}</small>` : ''}
      ${guidance?.carryover_summary ? `<small>${escapeHtml(guidance.carryover_summary)}</small>` : ''}
      ${rules.length ? `<small>${escapeHtml(`继续保留：${rules.join('；')}`)}</small>` : ''}
      ${memories.length ? `<small>${escapeHtml(`继续带入的记忆：${memories.map((item) => `${item.label || '记忆'}：${truncateText(item.content || '', 24)}`).join('；')}`)}</small>` : ''}
    </div>
  `;
}

function renderLeadScriptProvenance(provenance) {
  if (!provenance) return '';
  const learningContext = provenance.learning_context || null;
  const promptPromotion = provenance.prompt_promotion || learningContext?.prompt_promotion || null;
  const chips = [
    provenance.source === 'ai_generated' ? 'AI 生成' : '模板',
    provenance.prompt_learning_phase ? `Prompt ${leadPromptPhaseLabel(provenance.prompt_learning_phase)}` : '',
    provenance.prompt_version_hash ? `版本 ${String(provenance.prompt_version_hash).slice(0, 8)}` : '',
    leadSampleConfidenceChip(provenance?.efficacy_summary?.samples, { verifiedPrefix: '已验证', provisionalPrefix: '观察中' }),
    Number(provenance?.prompt_total_calls || 0) > 0 ? `${provenance.prompt_total_calls} 次 prompt 回写` : '',
    promptPromotion?.status === 'ready_to_promote' ? '可升版' : '',
    promptPromotion?.status === 'promoted' ? '已升版' : '',
    ...asArray(learningContext?.rules || []).slice(0, 3)
  ].filter(Boolean);
  const notes = [];
  if (learningContext?.summary) {
    notes.push(learningContext.summary);
  }
  if (Number(provenance?.efficacy_summary?.samples || 0) >= 5) {
    notes.push(`生成时参考了 ${provenance.efficacy_summary.samples} 次已验证样本`);
  } else if (Number(provenance?.efficacy_summary?.samples || 0) > 0) {
    notes.push(`生成时参考了 ${provenance.efficacy_summary.samples} 次观察样本，暂不当成稳定依据`);
  }
  if (Number.isFinite(Number(provenance?.efficacy_summary?.template_rate_pct))) {
    notes.push(`模板转化 ${formatLeadPercent(provenance.efficacy_summary.template_rate_pct)}`);
  }
  if (Number.isFinite(Number(provenance?.efficacy_summary?.ai_rate_pct)) && Number(provenance.efficacy_summary.ai_rate_pct) > 0) {
    notes.push(`上一版 AI 转化 ${formatLeadPercent(provenance.efficacy_summary.ai_rate_pct)}`);
  }
  if (Number(provenance?.prompt_total_calls || 0) > 0) {
    const promptRate = Number.isFinite(Number(provenance?.prompt_conversion_rate_pct))
      ? `，其中转化 ${formatLeadPercent(provenance.prompt_conversion_rate_pct)}`
      : '';
    notes.push(`当前 prompt 已累计 ${provenance.prompt_total_calls} 次结果回写${promptRate}`);
  } else if (provenance.prompt_learning_phase) {
    notes.push(`当前 prompt 处于 ${leadPromptPhaseLabel(provenance.prompt_learning_phase)} 阶段`);
  }
  if (promptPromotion?.summary) {
    notes.push(promptPromotion.summary);
  }
  const meta = [
    provenance.prompt_industry ? `行业：${provenance.prompt_industry}` : '',
    provenance.prompt_created_at ? `生成于 ${formatDateTime(provenance.prompt_created_at) || formatDate(provenance.prompt_created_at)}` : ''
  ].filter(Boolean).join(' · ');
  const memoryNotes = asArray(learningContext?.top_memories || []).slice(0, 3);
  return `
    <div class="script-provenance">
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${notes.length ? `<small>${escapeHtml(notes.join('；'))}</small>` : ''}
      ${memoryNotes.length ? `<small>${escapeHtml(`本次带入的相关记忆：${memoryNotes.map((memory) => `${memory.label || '记忆'}：${truncateText(memory.content || '', 46)}`).join('；')}`)}</small>` : ''}
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
    </div>
  `;
}

function renderLeadScriptReviewFeedback(feedback) {
  if (!feedback) return '';
  const evidencePack = feedback.evidence_pack || null;
  const conditions = feedback.script_feedback_conditions || null;
  const winLossBrief = feedback.win_loss_brief || null;
  const proofPoints = asArray(evidencePack?.proof_points).slice(0, 2);
  const nextExperiments = asArray(feedback.next_experiments).slice(0, 2);
  const riskFlags = asArray(feedback.risk_flags).slice(0, 2);
  const chips = [
    proofPoints.length ? `${proofPoints.length} 条证据` : '',
    asArray(evidencePack?.objection_answers).length ? `${asArray(evidencePack?.objection_answers).length} 条异议` : '',
    nextExperiments.length ? `${nextExperiments.length} 个实验` : '',
    riskFlags.length ? `${riskFlags.length} 个风险` : ''
  ].filter(Boolean);
  const notes = [
    feedback.summary || '',
    conditions?.summary ? `回流条件：${conditions.summary}` : '',
    proofPoints[0]?.proof_point ? `继续带入：${proofPoints.map((item) => item.proof_point).join('；')}` : '',
    winLossBrief?.summary ? `来源赢/输：${winLossBrief.summary}` : '',
    nextExperiments[0]?.instruction ? `下一轮先测：${nextExperiments[0].instruction}` : '',
    riskFlags[0]?.action ? `风险提醒：${riskFlags.map((item) => `${item.label} → ${item.action || item.reason}`).join('；')}` : ''
  ].filter(Boolean).slice(0, 4);
  return `
    <div class="script-provenance weak-route-refresh">
      <div class="keyword-list compact">
        <code>复盘回流</code>
        ${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}
      </div>
      ${notes.map((note) => `<small>${escapeHtml(note)}</small>`).join('')}
    </div>
  `;
}

function renderLeadVariantDiversitySurface(surface) {
  if (!surface) return '';
  const chips = [
    surface?.prompt_learning_phase ? `Prompt ${leadPromptPhaseLabel(surface.prompt_learning_phase)}` : '',
    surface?.prompt_version_hash ? `版本 ${truncateText(surface.prompt_version_hash, 16)}` : '',
    Number(surface?.distinct_opening_count || 0) > 0 ? `${surface.distinct_opening_count} 种开口` : '',
    surface?.focus_variant?.label ? `当前优先 ${surface.focus_variant.label}` : ''
  ].filter(Boolean);
  const examples = asArray(surface?.opening_examples).slice(0, 2);
  const recommendations = asArray(surface?.recommendations).slice(0, 3);
  return `
    <div class="script-provenance weak-route-refresh">
      <div class="keyword-list compact">
        <code>${escapeHtml(surface.status === 'needs_diversifying' ? '开口需拉开' : '开口差异充足')}</code>
        ${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}
      </div>
      ${surface.summary ? `<small>${escapeHtml(surface.summary)}</small>` : ''}
      ${examples.length ? `<small>${escapeHtml(`当前保留的不同开口：${examples.map((item) => truncateText(item.preview || '', 26)).join('；')}`)}</small>` : ''}
      ${recommendations.length ? `<small>${escapeHtml(recommendations.join('；'))}</small>` : ''}
    </div>
  `;
}

function leadPromptPhaseLabel(phase) {
  return {
    baseline: '基线',
    optimized: '优化',
    refined: '精修'
  }[phase] || '基线';
}

function leadSampleConfidenceChip(count, { verifiedPrefix = '已验证', provisionalPrefix = '观察中' } = {}) {
  const num = Number(count || 0);
  if (!Number.isFinite(num) || num <= 0) return '';
  return num >= 5 ? `${verifiedPrefix} ${num} 次样本` : `${provisionalPrefix} ${num} 次样本`;
}

function formatLeadPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return `${num % 1 === 0 ? num.toFixed(0) : num.toFixed(1)}%`;
}

function renderLeadPriorityLadderPacket(packet) {
  if (!packet) return '';
  const primary = packet.primary_focus || null;
  const todayQueue = packet.today_queue || null;
  const tomorrowQueue = packet.tomorrow_queue || null;
  return `
    <section class="lead-run-summary-block">
      <div class="lead-run-result-summary-grid">
        <article class="lead-run-result-summary-card">
          <span class="chip success">现在先打谁</span>
          <strong>${escapeHtml(primary?.lead_name || '当前优先对象')}</strong>
          <p>${escapeHtml(primary?.why_now || packet.summary || '系统会把当前最值得先联系的对象排在这里。')}</p>
          <div class="keyword-list compact">
            ${primary?.urgency_bucket ? `<code>${escapeHtml(primary.urgency_bucket)}</code>` : ''}
            ${primary?.suggested_channel ? `<code>${escapeHtml(primary.suggested_channel)}</code>` : ''}
            ${primary?.latest_recommended_time ? `<code>最晚 ${escapeHtml(formatDateTime(primary.latest_recommended_time) || formatDate(primary.latest_recommended_time))}</code>` : ''}
          </div>
          ${primary?.evidence_to_use ? `<small>优先带：${escapeHtml(primary.evidence_to_use)}</small>` : ''}
          ${primary?.silence_recovery_summary ? `<small>沉默恢复：${escapeHtml(primary.silence_recovery_summary)}</small>` : ''}
        </article>
        ${renderLeadPriorityLadderLane(todayQueue, {
          chip: 'Today 顺序',
          emptyCopy: '今天还没有已排好的顺位。'
        })}
        ${renderLeadPriorityLadderLane(tomorrowQueue, {
          chip: 'Tomorrow 顺序',
          emptyCopy: '明天队列生成后，这里会按同一套业务语言排好顺序。'
        })}
      </div>
      <p class="muted">${escapeHtml(packet.next_action || '先完成第一顺位，再按后续顺位继续推进。')}</p>
    </section>
  `;
}

function renderLeadPriorityLadderLane(queue, { chip = '顺位', emptyCopy = '' } = {}) {
  const items = asArray(queue?.items).slice(0, 4);
  return `
    <article class="lead-run-result-summary-card">
      <span class="chip info">${escapeHtml(chip)}</span>
      <strong>${escapeHtml(queue?.summary || emptyCopy || '系统会在这里解释优先顺位。')}</strong>
      ${items.length ? `
        <div class="action-stack compact-stack">
          ${items.map((item) => `
            <div class="mini-card">
              <div class="mini-card-heading">
                <strong>${escapeHtml(`${item.rank}. ${item.lead_name || item.lead_id || '线索'}`)}</strong>
                ${item.urgency_bucket ? `<span class="chip ${escapeHtml(item.is_primary_now ? 'success' : item.queue_key === 'tomorrow' ? 'warning' : 'info')}">${escapeHtml(item.urgency_bucket)}</span>` : ''}
              </div>
              <p>${escapeHtml(item.why_now || '已按当前主链优先级排位。')}</p>
              <small>${escapeHtml(`建议渠道：${item.suggested_channel || '继续跟进'}${item.latest_recommended_time ? ` · 最晚 ${formatDateTime(item.latest_recommended_time) || formatDate(item.latest_recommended_time)}` : ''}`)}</small>
              ${item.evidence_to_use ? `<small>优先带：${escapeHtml(item.evidence_to_use)}</small>` : ''}
              ${item.silence_recovery_summary ? `<small>沉默恢复：${escapeHtml(item.silence_recovery_summary)}</small>` : ''}
              ${item.why_not_now ? `<small>后置原因：${escapeHtml(item.why_not_now)}</small>` : ''}
            </div>
          `).join('')}
        </div>
      ` : `<p>${escapeHtml(emptyCopy || '系统会在这里解释优先顺位。')}</p>`}
    </article>
  `;
}

function renderTomorrowQueueMini(queue) {
  const ladderItems = asArray(queue?.priority_ladder_packet?.items).slice(0, 4);
  const candidates = asArray(queue.candidates).slice(0, 4);
  return `
    <div class="tomorrow-queue-mini">
      <div>
        <span class="chip info">明天继续跟谁</span>
        <p>${escapeHtml(queue?.priority_ladder_packet?.summary || queue.summary || '已整理明天继续跟进队列。')}</p>
        ${queue?.lead_thread_brief ? renderLeadThreadBrief(queue.lead_thread_brief, { title: '当前最要紧的线程', compact: true, asArticle: false }) : ''}
        ${queue?.promise_fulfillment_pack ? renderLeadPromiseFulfillmentPack(queue.promise_fulfillment_pack, { title: '当前最要紧的承诺', compact: true, asArticle: false }) : ''}
        ${queue?.silence_recovery_play ? renderLeadSilenceRecoveryPlay(queue.silence_recovery_play, { title: '当前最要紧的沉默恢复', compact: true, asArticle: false }) : ''}
      </div>
      <div class="action-stack compact-stack">
        ${(ladderItems.length ? ladderItems : candidates).map((item) => {
          const matchedCandidate = candidates.find((candidate) => String(candidate.lead_id || '') === String(item.lead_id || item.lead_id || '')) || null;
          const commitmentPack = item.next_action_commitment_pack || matchedCandidate?.next_action_commitment_pack || null;
          const continuityPack = item.call_proof_continuity_packet || matchedCandidate?.call_proof_continuity_packet || null;
          const threadBrief = item.lead_thread_brief || matchedCandidate?.lead_thread_brief || null;
          const silenceRecoveryPlay = item.silence_recovery_play || matchedCandidate?.silence_recovery_play || null;
          return `
          <article class="mini-card">
            <div class="mini-card-heading">
              <strong>${escapeHtml(item.lead_name || item.name || item.lead_id || '线索')}</strong>
              ${(item.urgency_bucket || item.route_label) ? `<span class="chip soft">${escapeHtml(item.urgency_bucket || item.route_label)}</span>` : ''}
              ${(item.priority_signal?.label || item.quality_signal?.label) ? `<span class="chip ${escapeHtml((item.priority_signal?.status || item.quality_signal?.status) === 'boost' ? 'success' : (item.priority_signal?.status || item.quality_signal?.status) === 'review' ? 'warning' : 'info')}">${escapeHtml(item.priority_signal?.label || item.quality_signal?.label)}</span>` : ''}
            </div>
            <p>${escapeHtml(item.why_not_now || item.why_now || item.reason || '明天继续跟进')}</p>
            <small>${escapeHtml(formatDateTime(item.latest_recommended_time || item.due_at) || '明天')} · ${escapeHtml(item.source_hint || (item.source === 'call_result' ? '来自通话结果' : item.source === 'memory_guidance' ? '来自长期记忆' : '来自跟进任务'))}</small>
            ${commitmentPack ? `<small>${escapeHtml(leadNextActionTypeLabel(commitmentPack.next_action_type))} · ${escapeHtml(commitmentPack.suggested_channel || '继续跟进')}</small>` : ''}
            ${threadBrief?.summary ? `<small>${escapeHtml(threadBrief.summary)}</small>` : ''}
            ${continuityPack?.carryforward_summary || continuityPack?.summary ? `<small>${escapeHtml(continuityPack.carryforward_summary || continuityPack.summary)}</small>` : ''}
            ${silenceRecoveryPlay?.summary ? `<small>${escapeHtml(silenceRecoveryPlay.summary)}</small>` : ''}
            ${item.execution_commitment_summary ? `<small>${escapeHtml(item.execution_commitment_summary)}</small>` : ''}
          </article>
        `;
        }).join('')}
      </div>
    </div>
  `;
}

function todayCheckStatusLabel(status) {
  return {
    done: '完成',
    doing: '现在',
    todo: '待做'
  }[status] || '待做';
}

function missionAutoplayRiskLabel(riskTier) {
  return {
    low: '低风险',
    medium: '中风险',
    high: '高风险'
  }[riskTier] || '待评估';
}

function missionAutoplayRiskTone(riskTier) {
  return riskTier === 'low' ? 'success' : riskTier === 'medium' ? 'info' : 'warning';
}

function renderLeadDiscoveryPlan(plan, publicSourceAdapter = null, discoveryMissionPacket = null) {
  if (!plan) {
    return renderEmpty('点击“生成找线索清单”，系统会把行业、区域、搜索词、证据字段和导入格式写回当前获客执行。');
  }
  const starterPack = plan.starter_pack || plan.industry_template?.starter_pack || null;
  const sources = asArray(plan.sources).slice(0, 3);
  const sourceActions = asArray(plan.source_actions).slice(0, 3);
  const sourceExperiments = asArray(plan.source_experiments).slice(0, 2);
  const keywords = asArray(plan.keywords).slice(0, 6);
  const missionPacket = discoveryMissionPacket || publicSourceAdapter?.discovery_mission_packet || null;
  const sourceExperimentCard = plan.source_experiment_card || missionPacket?.source_experiment_card || null;
  return `
    <div class="lead-run-discovery-grid">
      ${plan.industry_template ? `
        <div class="industry-template-card">
          <span class="chip success">行业模板 v1</span>
          <strong>${escapeHtml(plan.industry_template.industry || plan.industry || '当前行业')}</strong>
          <p>${escapeHtml(plan.industry_template.target_profile || plan.target_customer_profile || '')}</p>
          <small>结果标签：${asArray(plan.result_tags).slice(0, 6).map(escapeHtml).join(' / ')}</small>
          ${starterPack ? `<small>Starter pack：${escapeHtml(starterPack.label || starterPack.pack_key || '当前行业包')}</small>` : ''}
        </div>
      ` : ''}
      ${starterPack ? `
        <div class="industry-template-card">
          <span class="chip warning">Starter pack</span>
          <strong>${escapeHtml(starterPack.label || '行业 starter pack')}</strong>
          <p>${escapeHtml(starterPack.primary_goal || '当前行业已有默认主链包。')}</p>
          ${asArray(starterPack.target_personas).length ? `<small>优先对象：${asArray(starterPack.target_personas).slice(0, 3).map(escapeHtml).join(' / ')}</small>` : ''}
          ${asArray(starterPack.source_focus).length ? `<small>优先来源：${asArray(starterPack.source_focus).slice(0, 3).map(escapeHtml).join(' / ')}</small>` : ''}
          ${asArray(starterPack.query_clusters).length ? `<small>问题簇：${asArray(starterPack.query_clusters).slice(0, 2).map((item) => escapeHtml(`${item.label || item.key || '问题'}${asArray(item.collection_keywords).length ? `（${asArray(item.collection_keywords).slice(0, 2).join(' / ')}）` : ''}`)).join('；')}</small>` : ''}
          ${asArray(starterPack.preferred_sources).length ? `<small>来源优先级：${asArray(starterPack.preferred_sources).slice(0, 2).map((item) => escapeHtml(`${item.source_label || item.source_kind || '来源'}：${item.source_priority_reason || '优先补这类来源'}`)).join('；')}</small>` : ''}
          ${asArray(starterPack.evidence_pack?.proof_points).length ? `<small>优先证据：${asArray(starterPack.evidence_pack.proof_points).slice(0, 2).map((item) => escapeHtml(item.proof_point || '')).filter(Boolean).join('；')}</small>` : ''}
          ${starterPack.evidence_pack?.preferred_offer?.cta ? `<small>优先承接：${escapeHtml(`${starterPack.evidence_pack.preferred_offer.label || '下一步承接'} · ${starterPack.evidence_pack.preferred_offer.cta}`)}</small>` : ''}
          ${asArray(starterPack.objection_patterns).length ? `<small>高频异议：${escapeHtml(`${starterPack.objection_patterns[0].label || '当前异议'} → ${starterPack.objection_patterns[0].response_angle || '先按当前证据回应'}`)}</small>` : ''}
        </div>
      ` : ''}
      <div>
        <span class="chip info">找线索入口</span>
        <div class="action-stack compact-stack">
          ${sources.map((source) => `
            <article class="mini-card">
              <strong>${escapeHtml(source.name || '线索入口')}</strong>
              <p>${escapeHtml(source.how_to_use || '')}</p>
              <small>${escapeHtml(source.why_it_matters || '')}</small>
            </article>
          `).join('')}
        </div>
      </div>
      ${sourceActions.length ? `
        <div>
          <span class="chip warning">可执行采集动作</span>
          <div class="action-stack compact-stack">
            ${sourceActions.map((action) => `
              <article class="mini-card source-action-card">
                <strong>${escapeHtml(action.title || '采集动作')}</strong>
                <p>${escapeHtml(action.search_prompt || '')}</p>
                <small>验收：${escapeHtml(action.qualify_rule || '有明确需求且可联系')}</small>
                <div class="keyword-list compact">
                  ${asArray(action.collect_fields).slice(0, 4).map((field) => `<code>${escapeHtml(field)}</code>`).join('')}
                </div>
                ${action.import_example ? `<button class="button ghost" data-fill-import-example="${escapeHtml(action.import_example)}">用这个格式填导入框</button>` : ''}
              </article>
            `).join('')}
          </div>
        </div>
      ` : ''}
      ${renderLeadSourceExperimentCard(sourceExperimentCard, { mode: 'discovery' })}
      ${sourceExperiments.length ? `
        <div>
          <span class="chip warning">这轮先试的来源实验</span>
          <div class="action-stack compact-stack">
            ${sourceExperiments.map((item) => `
              <article class="mini-card source-action-card">
                <strong>${escapeHtml(item.title || '来源实验')}</strong>
                <p>${escapeHtml(item.planned_change || item.hypothesis || '继续沿当前来源实验推进。')}</p>
                <small>${escapeHtml(item.experiment_reason_summary || plan.experiment_reason_summary || '系统已把这轮最值得先试的来源变化收进 discovery 主链。')}</small>
                ${item.success_signal ? `<small>成功信号：${escapeHtml(item.success_signal)}</small>` : ''}
              </article>
            `).join('')}
          </div>
        </div>
      ` : ''}
      ${renderLeadEvidenceGapClosureBrief(plan.evidence_gap_closure_brief || publicSourceAdapter?.evidence_gap_closure_brief, {
        asArticle: true
      })}
      ${renderDiscoveryMissionPacket(missionPacket)}
      ${renderPublicSourceAdapter(publicSourceAdapter)}
      <div>
        <span class="chip success">搜索词</span>
        <div class="keyword-list">
          ${keywords.map((keyword) => `<code>${escapeHtml(keyword)}</code>`).join('')}
        </div>
        ${asArray(plan.scoring_signals).length ? `<p class="muted">优先信号：${asArray(plan.scoring_signals).slice(0, 4).map(escapeHtml).join('；')}</p>` : ''}
        <p class="muted">导入格式：${escapeHtml(plan.import_format || '公司名，联系人，电话，需求描述')}</p>
        <p class="muted">最低可用线索：${escapeHtml(String(plan.minimum_usable_leads || 3))} 条 · ${escapeHtml(plan.next_action || '收集真实客户后导入。')}</p>
      </div>
    </div>
  `;
}

function renderDiscoveryMissionPacket(packet) {
  if (!packet) return '';
  const summary = packet.mission_execution_summary || null;
  const autoplayGuard = packet.mission_autoplay_guard || null;
  const missions = asArray(packet.source_task_queue).slice(0, 4);
  const records = asArray(packet.candidate_source_records).slice(0, 4);
  const missingRequirements = asArray(summary?.missing_requirements).slice(0, 4);
  return `
    <div class="public-source-pack">
      <div class="card-heading compact-heading">
        <span class="icon-badge">RUN</span>
        <div>
          <strong>Discovery mission packet</strong>
          <p>${escapeHtml(packet.summary || '当前 run 已生成可执行来源 mission。')}</p>
        </div>
      </div>
      ${summary ? `
        <div class="quality-metrics">
          ${[
            ['mission 总数', summary.total_missions ?? 0],
            ['已执行', summary.executed_count ?? summary.completed_count ?? 0],
            ['待执行', summary.pending_count ?? 0],
            ['可自动跑', summary.autoplay_allowed_count ?? 0],
            ['页面 mission', summary.capture_mission_count ?? 0],
            ['待确认导入', summary.ready_to_import_count ?? 0],
            ['候选来源', summary.candidate_count ?? 0],
            ['可导入候选', summary.import_ready_candidate_count ?? 0]
          ].map(([label, value]) => `
            <article>
              <strong>${escapeHtml(String(value))}</strong>
              <span>${escapeHtml(label)}</span>
            </article>
          `).join('')}
        </div>
      ` : ''}
      ${autoplayGuard ? `
        <div class="next-batch-memory-guidance">
          <span class="chip ${Number(autoplayGuard.auto_runnable_count || 0) > 0 ? 'success' : 'warning'}">自动执行守门</span>
          <p>${escapeHtml(autoplayGuard.summary || '系统会按风险判断哪些 mission 可自动跑。')}</p>
          <small>${escapeHtml(autoplayGuard.next_action || '低风险 mission 可自动刷新，高风险 mission 仍先人工确认。')}</small>
        </div>
      ` : ''}
      ${renderLeadSourceExperimentCard(packet.source_experiment_card, { mode: 'mission' })}
      <div>
        <span class="chip info">已跑了哪些 mission</span>
        <div class="action-stack compact-stack">
          ${missions.length ? missions.map((mission) => `
            <article class="mini-card source-pack-task ${escapeHtml(mission.status || 'pending')}">
              <span class="chip warning">${escapeHtml(mission.source_label || mission.source_kind || '来源')}</span>
              <span class="chip ${sourceTaskStatusTone(mission.status)}">${escapeHtml(sourceTaskStatusLabel(mission.status))}</span>
              ${mission.mission_type ? `<span class="chip info">${escapeHtml(discoveryMissionTypeLabel(mission.mission_type))}</span>` : ''}
              ${mission.mission_autoplay_guard ? `<span class="chip ${missionAutoplayRiskTone(mission.mission_autoplay_guard.risk_tier)}">${escapeHtml(missionAutoplayRiskLabel(mission.mission_autoplay_guard.risk_tier))}</span>` : ''}
              ${mission.mission_autoplay_guard ? `<span class="chip ${mission.mission_autoplay_guard.auto_allowed ? 'success' : 'warning'}">${escapeHtml(mission.mission_autoplay_guard.auto_allowed ? '可自动跑' : '先人工确认')}</span>` : ''}
              <strong>${escapeHtml(mission.title || '来源 mission')}</strong>
              <p>${escapeHtml(mission.search_prompt || mission.next_action || '')}</p>
              ${mission.capture_mode ? `<small>读取方式：${escapeHtml(discoveryMissionCaptureModeLabel(mission.capture_mode))}</small>` : ''}
              ${mission.captured_source_url ? `<small>本次读取页面：${escapeHtml(mission.captured_source_url)}</small>` : ''}
              ${asArray(mission.collection_keywords).length ? `<small>搜索种子：${asArray(mission.collection_keywords).slice(0, 3).map(escapeHtml).join('、')}</small>` : ''}
              ${asArray(mission.query_clusters).length ? `<small>问题簇：${asArray(mission.query_clusters).map((item) => escapeHtml(item.label || item.key || '问题簇')).join('、')}</small>` : ''}
              ${mission.source_experiment_alignment_reason ? `<small>${escapeHtml(mission.source_experiment_alignment_reason)}</small>` : ''}
              ${mission.authority_hints?.source_priority_reason ? `<small>${escapeHtml(mission.authority_hints.source_priority_reason)}</small>` : ''}
              ${asArray(mission.trust_hints).length ? `<small>${asArray(mission.trust_hints).map(escapeHtml).join('；')}</small>` : ''}
              ${asArray(mission.expected_evidence).length ? `<small>预期证据：${asArray(mission.expected_evidence).slice(0, 3).map(escapeHtml).join('、')}</small>` : ''}
              ${mission.required_session ? `<small>${escapeHtml(mission.required_session.required ? `会话要求：${mission.required_session.reason || '需要老板已登录浏览器'}` : `会话要求：${mission.required_session.reason || '可直接按公开页读取'}`)}</small>` : ''}
              ${mission.capture_budget_risk_guard?.retry_budget?.summary ? `<small>${escapeHtml(mission.capture_budget_risk_guard.retry_budget.summary)}</small>` : ''}
              ${mission.capture_budget_risk_guard?.page_timeout_budget?.label ? `<small>${escapeHtml(`读取超时预算：${mission.capture_budget_risk_guard.page_timeout_budget.label}`)}</small>` : ''}
              ${mission.capture_budget_risk_guard?.scroll_budget?.summary ? `<small>${escapeHtml(mission.capture_budget_risk_guard.scroll_budget.summary)}</small>` : ''}
              ${mission.capture_budget_risk_guard?.provider_cost_budget?.summary ? `<small>${escapeHtml(mission.capture_budget_risk_guard.provider_cost_budget.summary)}</small>` : ''}
              ${mission.fallback_strategy?.summary ? `<small>${escapeHtml(`Fallback：${mission.fallback_strategy.summary}`)}</small>` : ''}
              ${mission.source_capture_benchmark?.quality_reason_summary ? `<small>${escapeHtml(`读取基准：${mission.source_capture_benchmark.quality_reason_summary}`)}</small>` : ''}
              ${asArray(mission.extracted_artifacts).length ? `<small>已提取：${asArray(mission.extracted_artifacts).map(escapeHtml).join('；')}</small>` : ''}
              ${mission.mission_result_summary ? `<small>${escapeHtml(mission.mission_result_summary)}</small>` : ''}
              ${mission.worth_continuing_reason ? `<small>${escapeHtml(mission.worth_continuing_reason)}</small>` : ''}
              ${asArray(mission.writeback_targets).length ? `<small>回写：${asArray(mission.writeback_targets).map(escapeHtml).join(' / ')}</small>` : ''}
              ${mission.mission_autoplay_guard?.auto_allowed && mission.mission_autoplay_guard?.auto_run_reason ? `<small>${escapeHtml(mission.mission_autoplay_guard.auto_run_reason)}</small>` : ''}
              ${!mission.mission_autoplay_guard?.auto_allowed && mission.mission_autoplay_guard?.auto_block_reason ? `<small>${escapeHtml(mission.mission_autoplay_guard.auto_block_reason)}</small>` : ''}
              ${mission.mission_autoplay_guard?.cooldown_hint ? `<small>${escapeHtml(mission.mission_autoplay_guard.cooldown_hint)}</small>` : ''}
              ${mission.mission_autoplay_guard?.budget_hint ? `<small>${escapeHtml(mission.mission_autoplay_guard.budget_hint)}</small>` : ''}
              ${mission.last_result?.execution_mode === 'auto' ? `<small>本次执行：系统已自动跑过这条低风险 mission。</small>` : ''}
            </article>
          `).join('') : renderEmpty('生成 discovery plan 后，这里会列出可执行来源 mission。')}
        </div>
      </div>
      <div>
        <span class="chip success">回来了哪些候选来源</span>
        <div class="action-stack compact-stack">
          ${records.length ? records.map((record) => `
            <article class="mini-card">
              <strong>${escapeHtml(record.source_title || '候选来源')}</strong>
              <p>${escapeHtml(asArray(record.extracted_need_signals).slice(0, 3).join('、') || record.source_label || '')}</p>
              <small>${escapeHtml(record.import_ready ? '可导入当前 run' : asArray(record.missing).join('、') || '待补证据')} · ${escapeHtml(record.source_label || '')} · 可信度 ${escapeHtml(String(record.authority_score || 0))}</small>
              ${record.source_experiment_alignment_reason ? `<small>${escapeHtml(record.source_experiment_alignment_reason)}</small>` : ''}
              ${asArray(record.trust_flags).length ? `<small>${asArray(record.trust_flags).slice(0, 2).map(escapeHtml).join('；')}</small>` : ''}
              ${asArray(record.message_angles).length ? `<small>建议开口：${asArray(record.message_angles).slice(0, 2).map((item) => escapeHtml(item.label || item.angle || '话术角度')).join('、')}</small>` : ''}
            </article>
          `).join('') : renderEmpty('执行 mission 并粘贴真实公开结果后，这里会出现候选来源记录。')}
        </div>
      </div>
      ${missingRequirements.length ? `<p class="muted">还需要补：${missingRequirements.map(escapeHtml).join('、')}</p>` : ''}
      ${summary?.latest_capture_summary ? `<p class="muted">最近一次页面 mission：${escapeHtml(summary.latest_capture_summary)}</p>` : ''}
      <p class="muted">${escapeHtml(packet.next_action || summary?.next_action || '继续执行优先 mission，再把候选来源回写到主链。')}</p>
    </div>
  `;
}

function discoveryMissionTypeLabel(type) {
  return {
    public_page_capture: '公开页读取',
    logged_page_capture: '登录页读取',
    competitor_page_capture: '竞品页读取',
    community_signal_capture: '社区信号读取'
  }[type] || type || '页面读取';
}

function discoveryMissionCaptureModeLabel(mode) {
  return {
    public_page_capture: '公开页渲染读取',
    authenticated_page_capture: '登录态渲染读取',
    logged_community_capture: '登录社区只读提取'
  }[mode] || mode || '页面读取';
}

function renderPublicSourceAdapter(adapter) {
  if (!adapter) {
    return `
      <div class="public-source-adapter-card">
        <span class="chip info">半自动公开来源采集</span>
        <strong>先生成“今天去哪里找客户”的采集包</strong>
        <p>系统会给出地图、公开名录、社媒问答等搜索任务、证据规则和粘贴模板；你只复制真实公开结果，再结构化导入，不编造客户。</p>
        <button class="button secondary" data-lead-run-action="public-source">生成半自动采集包</button>
      </div>
    `;
  }
  const candidates = asArray(adapter.candidates).slice(0, 4);
  const signalPipeline = adapter.signal_pipeline || null;
  const liveAdapter = adapter.live_adapter || null;
  return `
    <div class="public-source-adapter-card">
      <span class="chip info">公开来源 adapter</span>
      <strong>${escapeHtml(adapter.adapter_name || '公开来源结果结构化')}</strong>
      <p>${escapeHtml(adapter.summary || '')}</p>
      <small>可导入 ${escapeHtml(String(adapter.import_ready_count || 0))} 条 · 已导入 ${escapeHtml(String(adapter.imported_count || 0))} 条</small>
      ${liveAdapter ? `
        <div class="next-batch-memory-guidance">
          <span class="chip info">${escapeHtml(String(liveAdapter.input_kind || 'live').toUpperCase())} live adapter</span>
          <p>${escapeHtml(`${liveAdapter.worker_language || 'go'} 已结构化 ${liveAdapter.normalized_count || 0} 条 B2B 来源结果。`)}</p>
          <small>${escapeHtml(`${liveAdapter.dataset_label || 'B2B CSV'} · 原始 ${liveAdapter.raw_row_count || 0} 条`)}</small>
        </div>
      ` : ''}
      ${signalPipeline ? `
        <div class="next-batch-memory-guidance">
          <span class="chip success">AI signal radar</span>
          <p>${escapeHtml(signalPipeline.signal_guidance?.summary || '公开来源结果已完成 staged signal 分析。')}</p>
          <small>${escapeHtml(String(signalPipeline.counts?.raw || 0))} 条公开结果 → ${escapeHtml(String(signalPipeline.counts?.filtered || 0))} 条高信号候选 · ${escapeHtml(signalPipeline.worker_language || 'local')}</small>
        </div>
      ` : ''}
      ${renderLeadEvidenceGapClosureBrief(adapter.evidence_gap_closure_brief, {
        asArticle: false
      })}
      ${renderPublicSourcePack(adapter.source_pack)}
      ${Number(adapter.imported_count || 0) > 0 ? `
        <div class="import-to-today-card">
          <span class="chip success">可推进</span>
          <strong>把刚导入的真实线索推进到今日联系</strong>
          <p>一键完成质量检查、生成话术和创建今日跟进队列，下一步就能直接呼叫/私信。</p>
          <button class="button primary" data-lead-run-action="advance-today">推进到今日联系</button>
        </div>
      ` : ''}
      <div class="action-stack compact-stack">
          ${candidates.length ? candidates.map((candidate) => `
            <article class="mini-card">
              <strong>${escapeHtml(candidate.company_name || candidate.contact_name || candidate.candidate_id || '候选线索')}</strong>
              <p>${escapeHtml(candidate.message || candidate.source_evidence || '')}</p>
              <small>${escapeHtml(candidate.import_ready ? '可导入' : asArray(candidate.missing).join('、') || '待补证据')} · ${escapeHtml(candidate.source_label || '')}</small>
              ${candidate.source_record_id ? `<small>记录 ID：${escapeHtml(candidate.source_record_id)}</small>` : ''}
              ${candidate.source_priority_reason ? `<small>${escapeHtml(candidate.source_priority_reason)}</small>` : ''}
              ${asArray(candidate.query_clusters).length ? `<small>问题簇：${asArray(candidate.query_clusters).map((item) => escapeHtml(item.label || item.key || '问题')).join('、')}</small>` : ''}
            </article>
          `).join('') : renderEmpty('粘贴公开来源结果后，这里会显示结构化候选。')}
        </div>
      <button class="button secondary" data-lead-run-action="public-source">继续识别导入框里的公开结果</button>
    </div>
  `;
}

function renderPublicSourcePack(pack) {
  if (!pack) return '';
  const signalGuidance = pack.signal_guidance || null;
  const memoryGuidance = pack.memory_guidance || null;
  const promptLearning = pack.prompt_learning || null;
  const starterPack = pack.starter_pack || null;
  const sourceCapturePolicyPacket = pack.source_capture_policy_packet || null;
  const browserSessionBridge = pack.browser_session_bridge || null;
  const captureBudgetRiskGuard = pack.capture_budget_risk_guard || null;
  const captureProviderRoutingPacket = pack.capture_provider_routing_packet || null;
  const crawlMarkdownPacket = pack.crawl_markdown_packet || null;
  const renderedPageReadPacket = pack.rendered_page_read_packet || null;
  const visualPageFallbackPacket = pack.visual_page_fallback_packet || null;
  const pageEvidencePacket = pack.page_evidence_packet || null;
  const loggedCommunityCapturePacket = pack.logged_community_capture_packet || null;
  const pageSignalExtractionPacket = pack.page_signal_extraction_packet || null;
  const pageCandidateBridgePacket = pack.page_candidate_bridge_packet || null;
  const sourceCaptureBenchmark = pack.source_capture_benchmark || pack.next_batch_collection_brief?.source_capture_benchmark || null;
  const sourceCaptureQualityGate = pack.source_capture_quality_gate || null;
  const publicSourceLiveAdapter = pack.public_source_live_adapter || null;
  const b2bSlot = pack.b2b_source_adapter_slot || null;
  const recalibrationPacket = pack.source_authority_recalibration_packet || signalGuidance?.source_authority_recalibration_packet || null;
  const sourceQualityBenchmark = pack.source_quality_benchmark || pack.next_batch_collection_brief?.source_quality_benchmark || recalibrationPacket?.source_quality_benchmark || null;
  const preferredSources = asArray(signalGuidance?.preferred_sources).slice(0, 2);
  const queryClusters = asArray(pack.query_clusters || signalGuidance?.query_clusters).slice(0, 2);
  const priorityLineage = pack.source_priority_lineage || signalGuidance?.source_priority_lineage || null;
  const validatedSignals = asArray(signalGuidance?.validated_signals).slice(0, 3);
  const validatedPriority = asArray(pack.validated_signal_priority || signalGuidance?.validated_signal_priority).slice(0, 2);
  const serpIntents = asArray(signalGuidance?.serp_intents).slice(0, 2);
  const offerPatterns = asArray(signalGuidance?.offer_patterns).slice(0, 2);
  const memoryItems = asArray(memoryGuidance?.memories).slice(0, 3);
  const tasks = asArray(pack.collection_tasks)
    .slice(0, 4)
    .sort((a, b) => {
      const score = (task) => task?.source_kind === 'b2b_database'
        ? 9
        : task?.priority_state === 'preferred'
          ? 0
          : task?.priority_state === 'secondary'
            ? 1
            : 2;
      return score(a) - score(b);
    });
  return `
    <div class="public-source-pack">
      <div class="card-heading compact-heading">
        <span class="icon-badge">SRC</span>
        <div>
          <strong>半自动采集包</strong>
          <p>${escapeHtml(pack.summary || '')}</p>
        </div>
      </div>
      ${signalGuidance ? `
        <div class="next-batch-memory-guidance">
          <span class="chip success">已验证 signal 指路采集包</span>
          <p>${escapeHtml(signalGuidance.summary || '下一轮已按 signal guidance 调整采集优先级。')}</p>
          ${starterPack?.label ? `<small>Starter pack：${escapeHtml(starterPack.label)}</small>` : ''}
          ${preferredSources.length ? `<small>优先来源：${preferredSources.map((item) => escapeHtml(item.source_label || item.source_kind || '公开来源')).join('、')}</small>` : ''}
          ${priorityLineage?.summary ? `<small>来源排序说明：${escapeHtml(priorityLineage.summary)}</small>` : ''}
          ${queryClusters.length ? `<small>问题簇：${queryClusters.map((item) => escapeHtml(`${item.label || item.key || '问题'}${asArray(item.collection_keywords).length ? `（${asArray(item.collection_keywords).slice(0, 2).join(' / ')}）` : ''}`)).join('；')}</small>` : ''}
          ${validatedSignals.length ? `<small>优先信号：${validatedSignals.map((item) => escapeHtml(item.signal || '')).filter(Boolean).join('、')}</small>` : ''}
          ${validatedPriority.length ? `<small>写回优先级：${validatedPriority.map((item) => escapeHtml(`${item.priority_rank || 0}. ${item.signal || ''}`)).join('；')}</small>` : ''}
          ${serpIntents.length ? `<small>SERP 承接：${serpIntents.map((item) => escapeHtml(`${item.label || item.key || '承接'} → ${item.landing_expectation || '公开页'}`)).join('；')}</small>` : ''}
          ${offerPatterns.length ? `<small>公开页承接词：${offerPatterns.map((item) => escapeHtml(item.cta || item.label || '公开页承接')).join('、')}</small>` : ''}
        </div>
      ` : ''}
      ${renderLeadSourceAuthorityRecalibrationPacket(recalibrationPacket, {
        title: '来源可信度动态校准'
      })}
      ${renderLeadSourceQualityBenchmark(sourceQualityBenchmark, {
        title: '这轮高质量来源标准'
      })}
      ${renderLeadSourceCapturePolicyPacket(sourceCapturePolicyPacket)}
      ${renderLeadBrowserSessionBridge(browserSessionBridge)}
      ${renderLeadCaptureBudgetRiskGuard(captureBudgetRiskGuard)}
      ${renderLeadCaptureProviderRoutingPacket(captureProviderRoutingPacket)}
      ${renderLeadSourceCaptureBenchmark(sourceCaptureBenchmark)}
      ${renderLeadCrawlMarkdownPacket(crawlMarkdownPacket)}
      ${renderLeadRenderedPageReadPacket(renderedPageReadPacket)}
      ${renderLeadVisualPageFallbackPacket(visualPageFallbackPacket)}
      ${renderLeadPageEvidencePacket(pageEvidencePacket)}
      ${renderLeadLoggedCommunityCapturePacket(loggedCommunityCapturePacket)}
      ${renderLeadPageSignalExtractionPacket(pageSignalExtractionPacket)}
      ${renderLeadPageCandidateBridgePacket(pageCandidateBridgePacket)}
      ${renderLeadSourceCaptureQualityGate(sourceCaptureQualityGate)}
      ${memoryItems.length ? `
        <div class="next-batch-memory-guidance">
          <span class="chip info">长期记忆继续指路</span>
          <p>${escapeHtml(memoryGuidance.summary || '采集包已继续沿用最相关的历史记忆。')}</p>
          ${memoryItems.map((memory) => `
            <small>${escapeHtml(memoryTypeLabel(memory.memory_type))}：${escapeHtml(truncateText(memory.content || '', 88))}</small>
          `).join('')}
        </div>
      ` : ''}
      ${renderLeadPromptLearningCard(promptLearning, {
        title: '采集时继续沿哪版 Prompt',
        badge: 'Prompt 学习',
        emptyCopy: '后续采集会在这里说明该继续沿哪版 prompt 和记忆方向。'
      })}
      ${renderPublicSourceLiveAdapter(publicSourceLiveAdapter)}
      ${renderB2BSourceAdapterSlot(b2bSlot)}
      <div class="keyword-list compact">
        ${asArray(pack.keywords).slice(0, 6).map((keyword) => `<code>${escapeHtml(keyword)}</code>`).join('')}
      </div>
      <div class="action-stack compact-stack">
        ${tasks.map((task) => `
          <article class="mini-card source-pack-task ${escapeHtml(task.status || 'pending')}">
            <span class="chip warning">${escapeHtml(task.source_label || task.source_kind || '公开来源')}</span>
            ${task.priority_state === 'preferred'
              ? '<span class="chip success">优先来源</span>'
              : task.priority_state === 'secondary'
                ? '<span class="chip info">补充来源</span>'
                : ''}
            <span class="chip ${sourceTaskStatusTone(task.status)}">${escapeHtml(sourceTaskStatusLabel(task.status))}</span>
            <strong>${escapeHtml(task.title || '采集任务')}</strong>
            <p>${escapeHtml(task.search_prompt || task.search_query || '')}</p>
            <small>验收：${escapeHtml(task.acceptance || '可联系、有来源、有需求信号')}</small>
            ${task.priority_reason ? `<small>${escapeHtml(task.priority_reason)}</small>` : ''}
            ${task.source_authority_score ? `<small>来源可信度：${escapeHtml(String(task.source_authority_score))} / 100${asArray(task.query_cluster_labels).length ? `；问题簇：${escapeHtml(asArray(task.query_cluster_labels).join('、'))}` : ''}</small>` : ''}
            ${task.authority_delta_reason ? `<small>${escapeHtml(task.authority_delta_reason)}</small>` : ''}
            ${asArray(task.trust_flags).length ? `<small>${asArray(task.trust_flags).map((flag) => escapeHtml(flag)).join('；')}</small>` : ''}
            ${task.signal_hint ? `<small>${escapeHtml(task.signal_hint)}</small>` : ''}
            ${task.last_result ? `<small>本次结果：解析 ${escapeHtml(String(task.last_result.parsed_count || 0))} 条，可导入 ${escapeHtml(String(task.last_result.import_ready_count || 0))} 条，已导入 ${escapeHtml(String(task.last_result.imported_count || 0))} 条</small>` : ''}
            <div class="keyword-list compact">
              ${asArray(task.collect_fields).slice(0, 5).map((field) => `<code>${escapeHtml(field)}</code>`).join('')}
            </div>
            ${task.paste_template ? `<button class="button ghost" data-source-task-id="${escapeHtml(task.id || '')}" data-fill-import-example="${escapeHtml(task.paste_template)}">选这个任务并填模板</button>` : ''}
          </article>
        `).join('')}
      </div>
      <p class="muted">粘贴格式：${escapeHtml(pack.paste_format || '名称，联系人，联系方式，需求信号，来源')}</p>
      <p class="muted">${escapeHtml(pack.next_action || '完成任务后粘贴结果并识别导入。')}</p>
    </div>
  `;
}

function sourceCaptureActionLabel(action) {
  return {
    read_public_page: '读取公开页',
    read_authenticated_page_with_user_session: '读取用户授权登录页',
    capture_visible_text: '提取可见文字',
    capture_source_link: '保留来源链接',
    extract_need_signals: '提取需求信号',
    write_mainline_source_records: '回写主链来源记录'
  }[action] || action || '只读动作';
}

function sourceCaptureDisallowedActionLabel(action) {
  return {
    post_content: '发帖',
    comment: '评论',
    send_message: '私信/发消息',
    submit_form: '提交表单',
    create_account: '代注册账号'
  }[action] || action || '高风险动作';
}

function renderLeadSourceCapturePolicyPacket(packet) {
  if (!packet) return '';
  const provenanceFields = asArray(packet.provenance_required_fields).slice(0, 5);
  const readOnlyActions = asArray(packet.read_only_actions).slice(0, 4);
  const requiresUserSession = asArray(packet.requires_user_session).slice(0, 2);
  const disallowedActions = asArray(packet.disallowed_actions).slice(0, 4);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">来源读取边界</span>
      <p>${escapeHtml(packet.frontend_explanation || packet.summary || '当前只允许在主链内做只读来源读取。')}</p>
      ${packet.public_read_allowed ? '<small>公开页：可直接读取并继续写回当前 run。</small>' : ''}
      ${packet.authenticated_read_allowed ? `<small>登录页：${escapeHtml(requiresUserSession[0]?.reason || '必须来自你自己已登录浏览器的授权会话。')}</small>` : ''}
      ${provenanceFields.length ? `<small>来源证明：${provenanceFields.map((field) => escapeHtml(field)).join(' / ')}</small>` : ''}
      ${readOnlyActions.length ? `<small>只做：${readOnlyActions.map((action) => escapeHtml(sourceCaptureActionLabel(action))).join(' / ')}</small>` : ''}
      ${disallowedActions.length ? `<small>不会做：${disallowedActions.map((action) => escapeHtml(sourceCaptureDisallowedActionLabel(action))).join(' / ')}</small>` : ''}
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function renderLeadBrowserSessionBridge(bridge) {
  if (!bridge) return '';
  const authorizedDomains = asArray(bridge.authorized_domains).slice(0, 4);
  const chips = [
    bridge.session_status === 'session_bound' ? '已绑定登录态会话' : '',
    bridge.session_status === 'needs_user_browser_session' ? '待绑定老板浏览器' : '',
    bridge.session_status === 'not_required' ? '当前任务可先读公开页' : '',
    bridge.worker_language ? `Worker ${bridge.worker_language}` : '',
    bridge.control_language ? `控制面 ${bridge.control_language}` : '',
    bridge.browser_kind ? bridge.browser_kind : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">已登录浏览器桥</span>
      <p>${escapeHtml(bridge.summary || '当前来源读取可复用你自己的已登录浏览器。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${bridge.profile_label ? `<small>${escapeHtml(`当前资料：${bridge.profile_label}`)}</small>` : ''}
      ${authorizedDomains.length ? `<small>${escapeHtml(`授权域名：${authorizedDomains.join(' / ')}`)}</small>` : ''}
      ${bridge.browser_session_id ? `<small>${escapeHtml(`会话 ID：${bridge.browser_session_id}`)}</small>` : ''}
      ${bridge.last_seen_at ? `<small>${escapeHtml(`最近发现：${bridge.last_seen_at}`)}</small>` : ''}
      ${bridge.session_status === 'session_bound'
        ? '<small>当前读取来自你自己的已登录浏览器；系统不会保存站点账号密码。</small>'
        : bridge.requires_user_session
          ? '<small>需要你自己的已登录浏览器后，系统才会继续读取登录态页面。</small>'
          : '<small>当前仍按公开页只读执行；后续碰到登录页时再要求绑定。</small>'}
      ${bridge.next_action ? `<small>${escapeHtml(bridge.next_action)}</small>` : ''}
    </div>
  `;
}

function providerRoutingTriggerReasonLabel(reason) {
  return {
    local_stack_ready: '主读取栈已经足够',
    authenticated_page_requires_user_session: '登录态页面必须继续走你的浏览器',
    rendered_text_empty: '渲染后正文为空',
    rendered_text_missing: '渲染后正文明显缺失',
    markdown_extraction_failed: 'clean markdown 暂未抽出来',
    key_module_extraction_failed: '关键页面模块没抽全',
    dom_low_confidence: 'DOM 低可信 / 强前端渲染',
    fallback_provider_unconfigured: '备用 provider 尚未配置',
    fallback_provider_failed: '备用 provider 这次补位失败'
  }[reason] || reason || '主读取栈异常';
}

function providerRoutingDecisionLabel(decision) {
  return {
    stay_with_primary_stack: '继续主读取栈',
    skip_authenticated_session_page: '登录态页不走远程补位',
    skip_fallback_not_configured: '未启用远程补位',
    fallback_to_firecrawl: '已切到 Firecrawl 补位',
    firecrawl_fallback_failed: 'Firecrawl 补位失败'
  }[decision] || decision || '继续主读取栈';
}

function renderLeadCaptureProviderRoutingPacket(packet) {
  if (!packet) return '';
  const runtime = packet.runtime || {};
  const chips = [
    packet.primary_provider ? `主栈 ${packet.primary_provider}` : '',
    packet.fallback_provider ? `补位 ${packet.fallback_provider}` : '',
    packet.routing_decision ? providerRoutingDecisionLabel(packet.routing_decision) : '',
    runtime.runtime_configured ? '远程补位已配置' : '',
    packet.worker_language ? `Worker ${packet.worker_language}` : '',
    packet.control_language ? `控制面 ${packet.control_language}` : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">Provider fallback 路由</span>
      <p>${escapeHtml(packet.summary || '主读取栈失败时，系统会按规则决定是否临时切到备用 provider。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${packet.source_url ? `<small>${escapeHtml(`来源页：${packet.source_url}`)}</small>` : ''}
      ${packet.trigger_reason ? `<small>${escapeHtml(`触发原因：${providerRoutingTriggerReasonLabel(packet.trigger_reason)}`)}</small>` : ''}
      ${packet.local_failure_reason && packet.local_failure_reason !== packet.trigger_reason ? `<small>${escapeHtml(`主栈失败点：${providerRoutingTriggerReasonLabel(packet.local_failure_reason)}`)}</small>` : ''}
      ${packet.provider_cost_hint ? `<small>${escapeHtml(packet.provider_cost_hint)}</small>` : ''}
      ${packet.benchmark_summary ? `<small>${escapeHtml(`读取基准：${packet.benchmark_summary}`)}</small>` : ''}
      ${packet.worker_error ? `<small>${escapeHtml(`补位结果：${packet.worker_error}`)}</small>` : ''}
      <small>这层只解释为什么继续本地主栈、为什么临时切 Firecrawl，不会长成 provider 控制台。</small>
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function renderLeadRenderedPageReadPacket(packet) {
  if (!packet) return '';
  const chunks = asArray(packet.chunks).slice(0, 2);
  const scrollSession = packet.capture_scroll_session || null;
  const chips = [
    packet.capture_mode === 'authenticated_page_capture' ? '登录态渲染页' : '',
    packet.capture_mode === 'public_page_capture' ? '公开渲染页' : '',
    packet.worker_language ? `Worker ${packet.worker_language}` : '',
    packet.control_language ? `控制面 ${packet.control_language}` : '',
    packet.status === 'ready' ? '正文已读取' : '',
    packet.status === 'needs_user_browser_session' ? '需老板浏览器' : '',
    packet.status === 'needs_render_worker' ? '待接 Go 读页 Worker' : '',
    scrollSession?.has_more ? '还可继续续读' : '',
    scrollSession && !scrollSession.has_more ? '已到当前页尾' : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">渲染页读取</span>
      <p>${escapeHtml(packet.summary || '当前已把渲染后页面读取结果收进主链。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${packet.page_title ? `<small>${escapeHtml(`页面：${packet.page_title}`)}</small>` : ''}
      ${packet.final_url ? `<small>${escapeHtml(`来源页：${packet.final_url}`)}</small>` : ''}
      ${packet.page_meta?.meta_description ? `<small>${escapeHtml(`页面摘要：${truncateText(packet.page_meta.meta_description, 96)}`)}</small>` : ''}
      ${packet.page_meta?.h1 ? `<small>${escapeHtml(`首屏标题：${packet.page_meta.h1}`)}</small>` : ''}
      ${scrollSession?.session_id ? `<small>${escapeHtml(`续读会话：${scrollSession.session_id}`)}</small>` : ''}
      ${scrollSession ? `<small>${escapeHtml(`当前位置：${scrollSession.current_scroll_offset || 0}；本次新增段数：${scrollSession.unread_chunk_count || 0}`)}</small>` : ''}
      ${scrollSession?.stop_reason ? `<small>${escapeHtml(`停止原因：${renderedPageScrollStopReasonLabel(scrollSession.stop_reason)}`)}</small>` : ''}
      ${chunks.length ? chunks.map((chunk) => `<small>${escapeHtml(truncateText(chunk.text || '', 120))}</small>`).join('') : ''}
      ${packet.screenshot_ref?.capture_status ? `<small>${escapeHtml(`截图状态：${packet.screenshot_ref.capture_status === 'captured' ? '已生成截图引用' : packet.screenshot_ref.capture_status === 'contract_ready' ? '已预留截图引用' : packet.screenshot_ref.capture_status}`)}</small>` : ''}
      ${packet.capture_mode === 'authenticated_page_capture'
        ? '<small>登录态页面只会复用你自己的已登录浏览器，会继续保留授权来源证明。</small>'
        : '<small>公开页可先直接读渲染后正文，再把页面证据、信号和候选桥回当前 run。</small>'}
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function visualFallbackReasonLabel(reason) {
  return {
    rendered_text_empty: '渲染后正文为空',
    rendered_text_missing: '渲染后正文明显缺失',
    markdown_extraction_failed: 'clean markdown 暂未抽出来',
    key_module_extraction_failed: '关键页面模块没抽全',
    dom_low_confidence: 'DOM 低可信 / 强前端渲染'
  }[reason] || reason || 'DOM 低可信';
}

function renderLeadVisualPageFallbackPacket(packet) {
  if (!packet) return '';
  const visualChunks = asArray(packet.visual_chunks).slice(0, 2);
  const layoutRegions = asArray(packet.layout_regions).slice(0, 3);
  const confidenceSummary = packet.confidence_summary || {};
  const chips = [
    packet.status === 'ready' ? '可见页 fallback 已就绪' : '',
    packet.status === 'needs_visual_worker' ? '待接 Python 视觉 Worker' : '',
    packet.status === 'fallback_unavailable' ? '这次 fallback 暂未成功' : '',
    packet.worker_language ? `Worker ${packet.worker_language}` : '',
    packet.control_language ? `控制面 ${packet.control_language}` : '',
    confidenceSummary.engine ? confidenceSummary.engine : '',
    confidenceSummary.region_count ? `区域 ${confidenceSummary.region_count}` : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">视觉 / OCR fallback</span>
      <p>${escapeHtml(packet.summary || '当 DOM / markdown 抽取不稳时，系统会补一层可见页面 fallback。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${packet.page_title ? `<small>${escapeHtml(`页面：${packet.page_title}`)}</small>` : ''}
      ${packet.source_url ? `<small>${escapeHtml(`来源页：${packet.source_url}`)}</small>` : ''}
      ${packet.fallback_reason ? `<small>${escapeHtml(`触发原因：${visualFallbackReasonLabel(packet.fallback_reason)}`)}</small>` : ''}
      ${packet.recognized_text ? `<small>${escapeHtml(truncateText(packet.recognized_text, 140))}</small>` : ''}
      ${visualChunks.length ? visualChunks.map((chunk) => `<small>${escapeHtml(`${chunk.region_kind || '区域'}：${truncateText(chunk.text || '', 96)}`)}</small>`).join('') : ''}
      ${layoutRegions.length ? `<small>${escapeHtml(`识别区域：${layoutRegions.map((region) => `${region.region_kind || '区域'}(${truncateText(region.text || '', 24)})`).join('；')}`)}</small>` : ''}
      ${packet.screenshot_ref?.capture_status ? `<small>${escapeHtml(`截图状态：${packet.screenshot_ref.capture_status === 'captured' ? '已生成截图引用' : packet.screenshot_ref.capture_status === 'contract_ready' ? '已预留截图引用' : packet.screenshot_ref.capture_status}`)}</small>` : ''}
      ${confidenceSummary.explanation ? `<small>${escapeHtml(confidenceSummary.explanation)}</small>` : ''}
      <small>这层 fallback 只在页面正文抽不全时补主链证据，不会长成独立视觉识别后台。</small>
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function renderLeadCrawlMarkdownPacket(packet) {
  if (!packet) return '';
  const links = asArray(packet.extracted_links).slice(0, 2);
  const images = asArray(packet.extracted_images).slice(0, 2);
  const metadata = packet.metadata || {};
  const chips = [
    packet.extraction_mode === 'crawl4ai_markdown' ? 'Crawl4AI clean markdown' : '',
    packet.extraction_mode === 'firecrawl_remote_fallback' ? 'Firecrawl 远程补位' : '',
    packet.extraction_mode === 'html_clean_fallback' ? 'HTML clean fallback' : '',
    packet.status === 'ready' ? 'clean text 已抽取' : '',
    packet.status === 'fallback_to_rendered_page' ? '已回退 rendered read' : '',
    packet.worker_language ? `Worker ${packet.worker_language}` : '',
    packet.control_language ? `控制面 ${packet.control_language}` : '',
    metadata.link_count ? `链接 ${metadata.link_count}` : '',
    metadata.image_count ? `图片 ${metadata.image_count}` : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">公开页 clean extraction</span>
      <p>${escapeHtml(packet.summary || '当前公开页已优先抽成 clean markdown / clean text。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${metadata.page_title ? `<small>${escapeHtml(`页面：${metadata.page_title}`)}</small>` : ''}
      ${packet.source_url ? `<small>${escapeHtml(`来源页：${packet.source_url}`)}</small>` : ''}
      ${metadata.meta_description ? `<small>${escapeHtml(`页面摘要：${truncateText(metadata.meta_description, 96)}`)}</small>` : ''}
      ${packet.clean_text ? `<small>${escapeHtml(truncateText(packet.clean_text, 140))}</small>` : ''}
      ${packet.markdown ? `<small>${escapeHtml(truncateText(packet.markdown, 140))}</small>` : ''}
      ${links.length ? `<small>${escapeHtml(`抽到链接：${links.map((item) => item.text || item.url).join('；')}`)}</small>` : ''}
      ${images.length ? `<small>${escapeHtml(`抽到图片：${images.map((item) => item.alt || item.src).join('；')}`)}</small>` : ''}
      ${packet.status === 'fallback_to_rendered_page'
        ? '<small>当前 clean extraction 没有成功，系统已继续用 rendered page read 保底，不会让主链断掉。</small>'
        : '<small>这份 clean markdown 会继续服务页面证据和页面信号抽取，不会长出独立 crawler center。</small>'}
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function renderLeadPageEvidencePacket(packet) {
  if (!packet) return '';
  const ctaBlocks = asArray(packet.cta_blocks).slice(0, 2);
  const faqBlocks = asArray(packet.faq_blocks).slice(0, 2);
  const proofPoints = asArray(packet.proof_points).slice(0, 2);
  const contactBlocks = asArray(packet.contact_blocks).slice(0, 2);
  const chips = [
    packet.status === 'ready' ? '页面证据已收口' : '',
    packet.worker_language ? `Worker ${packet.worker_language}` : '',
    packet.control_language ? `控制面 ${packet.control_language}` : '',
    ctaBlocks.length ? `CTA ${ctaBlocks.length}` : '',
    faqBlocks.length ? `FAQ ${faqBlocks.length}` : '',
    proofPoints.length ? `证明 ${proofPoints.length}` : '',
    contactBlocks.length ? `联系 ${contactBlocks.length}` : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">页面证据包</span>
      <p>${escapeHtml(packet.summary || '当前页面已收成可直接影响承接判断的话术级证据包。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${packet.page_title ? `<small>${escapeHtml(`页面：${packet.page_title}`)}</small>` : ''}
      ${packet.source_url ? `<small>${escapeHtml(`来源页：${packet.source_url}`)}</small>` : ''}
      ${packet.page_headline ? `<small>${escapeHtml(`主标题：${packet.page_headline}`)}</small>` : ''}
      ${packet.offer_summary ? `<small>${escapeHtml(packet.offer_summary)}</small>` : ''}
      ${ctaBlocks.length ? `<small>${escapeHtml(`CTA：${ctaBlocks.map((item) => item.label || '下一步').join('；')}`)}</small>` : ''}
      ${faqBlocks.length ? `<small>${escapeHtml(`常见顾虑：${faqBlocks.map((item) => item.question || 'FAQ').join('；')}`)}</small>` : ''}
      ${proofPoints.length ? `<small>${escapeHtml(`证明点：${proofPoints.map((item) => item.detail || item.label || '证明').join('；')}`)}</small>` : ''}
      ${contactBlocks.length ? `<small>${escapeHtml(`联系方式：${contactBlocks.map((item) => `${item.channel || '联系'} ${item.value || ''}`).join('；')}`)}</small>` : ''}
      ${packet.evidence_summary ? `<small>${escapeHtml(packet.evidence_summary)}</small>` : ''}
      <small>这份页面证据会继续影响承接卖点、异议和开口角度，不会长成独立页面分析平台。</small>
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function loggedCommunityPageKindLabel(kind) {
  return {
    thread_post_page: '帖子 / 详情页',
    comment_stream: '评论流',
    search_result_page: '搜索结果页',
    author_profile_page: '作者 / 主页'
  }[kind] || kind || '社区页面';
}

function renderLeadLoggedCommunityCapturePacket(packet) {
  if (!packet) return '';
  const needSignals = asArray(packet.extracted_need_signals).slice(0, 3);
  const objections = asArray(packet.extracted_objections).slice(0, 3);
  const messageAngles = asArray(packet.message_angles).slice(0, 2);
  const surfaces = asArray(packet.read_surfaces).slice(0, 3);
  const chips = [
    packet.community_label ? packet.community_label : '',
    packet.status === 'ready' ? '社区信号已收口' : '',
    packet.status === 'needs_user_browser_session' ? '待绑定老板浏览器' : '',
    packet.page_kind ? loggedCommunityPageKindLabel(packet.page_kind) : '',
    needSignals.length ? `需求 ${needSignals.length}` : '',
    objections.length ? `顾虑 ${objections.length}` : '',
    messageAngles.length ? `开口 ${messageAngles.length}` : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">登录社区信号包</span>
      <p>${escapeHtml(packet.summary || '当前登录社区页面已收成只读信号包。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${packet.source_url ? `<small>${escapeHtml(`来源页：${packet.source_url}`)}</small>` : ''}
      ${packet.captured_at ? `<small>${escapeHtml(`读取时间：${packet.captured_at}`)}</small>` : ''}
      ${packet.community_summary ? `<small>${escapeHtml(packet.community_summary)}</small>` : ''}
      ${surfaces.length ? `<small>${escapeHtml(`本次只读范围：${surfaces.map((item) => loggedCommunityPageKindLabel(item)).join(' / ')}`)}</small>` : ''}
      ${packet.session_origin ? `<small>${escapeHtml(`会话来源：${packet.session_origin}`)}</small>` : ''}
      ${needSignals.length ? `<small>${escapeHtml(`需求信号：${needSignals.map((item) => item.label || item.key || '信号').join('；')}`)}</small>` : ''}
      ${objections.length ? `<small>${escapeHtml(`主要顾虑：${objections.map((item) => item.label || item.key || '顾虑').join('；')}`)}</small>` : ''}
      ${messageAngles.length ? `<small>${escapeHtml(`建议开口：${messageAngles.map((item) => item.label || item.angle || '开口').join('；')}`)}</small>` : ''}
      <small>这层只解释这轮从哪个登录社区读回了什么信号，只做只读读取，不会代你发帖、评论或私信。</small>
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function renderLeadPageSignalExtractionPacket(packet) {
  if (!packet) return '';
  const needSignals = asArray(packet.need_signals).slice(0, 3);
  const offerPatterns = asArray(packet.offer_patterns).slice(0, 2);
  const objectionPatterns = asArray(packet.objection_patterns).slice(0, 2);
  const messageAngles = asArray(packet.message_angles).slice(0, 2);
  const chips = [
    packet.status === 'ready' ? '页面信号已收口' : '',
    packet.source_label ? packet.source_label : '',
    needSignals.length ? `需求 ${needSignals.length}` : '',
    offerPatterns.length ? `承接 ${offerPatterns.length}` : '',
    objectionPatterns.length ? `顾虑 ${objectionPatterns.length}` : '',
    messageAngles.length ? `开口 ${messageAngles.length}` : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">页面业务信号包</span>
      <p>${escapeHtml(packet.summary || '当前页面读取结果已收成可直接服务找人、开口和下一批的业务信号包。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${packet.page_title ? `<small>${escapeHtml(`页面：${packet.page_title}`)}</small>` : ''}
      ${packet.source_url ? `<small>${escapeHtml(`来源页：${packet.source_url}`)}</small>` : ''}
      ${packet.page_headline ? `<small>${escapeHtml(`页面主标题：${packet.page_headline}`)}</small>` : ''}
      ${needSignals.length ? `<small>${escapeHtml(`更像哪类客户：${needSignals.map((item) => item.label || item.key || '需求').join('；')}`)}</small>` : ''}
      ${offerPatterns.length ? `<small>${escapeHtml(`页面承接动作：${offerPatterns.map((item) => item.cta || item.label || '承接').join('；')}`)}</small>` : ''}
      ${objectionPatterns.length ? `<small>${escapeHtml(`开口前先处理：${objectionPatterns.map((item) => item.label || item.key || '顾虑').join('；')}`)}</small>` : ''}
      ${messageAngles.length ? `<small>${escapeHtml(`建议开口：${messageAngles.map((item) => item.label || item.angle || '开口').join('；')}`)}</small>` : ''}
      <small>这层只把页面读取结果收成业务语言 signal objects，继续回写 signal、脚本依据和下一批 brief，不会长成独立情报平台。</small>
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function renderLeadPageCandidateBridgePacket(packet) {
  if (!packet) return '';
  const queryClusters = asArray(packet.query_clusters).slice(0, 2);
  const preferredSources = asArray(packet.preferred_sources).slice(0, 2);
  const messageAngles = asArray(packet.message_angles).slice(0, 2);
  const trustFlags = asArray(packet.trust_flags).slice(0, 3);
  const candidateSnapshot = packet.candidate_snapshot || null;
  const chips = [
    packet.status === 'ready_to_review' ? '可直接过导入前质量门' : '',
    packet.status === 'held_for_contact_repair' ? '先保留待补联系人' : '',
    packet.status === 'needs_more_page_context' ? '还需补页面依据' : '',
    packet.worker_language ? `Worker ${packet.worker_language}` : '',
    packet.control_language ? `控制面 ${packet.control_language}` : '',
    packet.source_kind ? packet.source_kind : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">页面候选桥接</span>
      <p>${escapeHtml(packet.summary || '当前页面读取结果已被桥接成候选来源。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${packet.source_title ? `<small>${escapeHtml(`候选来源：${packet.source_title}`)}</small>` : ''}
      ${packet.source_url ? `<small>${escapeHtml(`来源页：${packet.source_url}`)}</small>` : ''}
      ${candidateSnapshot?.contact_phone || candidateSnapshot?.contact_email || candidateSnapshot?.platform_account
        ? `<small>${escapeHtml(`已识别联系方式：${[candidateSnapshot.contact_phone, candidateSnapshot.contact_email, candidateSnapshot.platform_account].filter(Boolean).join(' / ')}`)}</small>`
        : packet.hold_reason
          ? `<small>${escapeHtml(packet.hold_reason)}</small>`
          : ''}
      ${queryClusters.length ? `<small>问题簇：${queryClusters.map((item) => escapeHtml(item.label || item.key || '问题')).join(' / ')}</small>` : ''}
      ${preferredSources.length ? `<small>优先来源：${preferredSources.map((item) => escapeHtml(item.source_label || item.source_kind || '公开来源')).join(' / ')}</small>` : ''}
      ${messageAngles.length ? `<small>建议开口：${messageAngles.map((item) => escapeHtml(item.label || item.angle || '开口角度')).join(' / ')}</small>` : ''}
      ${packet.source_priority_reason ? `<small>${escapeHtml(packet.source_priority_reason)}</small>` : ''}
      ${trustFlags.length ? `<small>${trustFlags.map((flag) => escapeHtml(flag)).join('；')}</small>` : ''}
      <small>这层只把页面读到的业务证据桥成候选来源，不会长成独立候选后台。</small>
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function renderLeadSourceCaptureQualityGate(packet) {
  if (!packet) return '';
  const chipTone = {
    pass: 'success',
    hold: 'warning',
    retry: 'warning',
    reject: 'danger'
  }[packet.gate_status] || 'info';
  const chipLabel = {
    pass: '可继续导入',
    hold: '先保留待判断',
    retry: '先重试读取',
    reject: '当前先拦下'
  }[packet.gate_status] || (packet.gate_status || '质量门');
  const details = [
    packet.evidence_completeness?.reason ? `页面证据：${packet.evidence_completeness.reason}` : '',
    packet.contact_completeness?.reason ? `联系方式：${packet.contact_completeness.reason}` : '',
    packet.duplicate_risk?.reason ? `重复风险：${packet.duplicate_risk.reason}` : '',
    packet.page_credibility?.reason ? `页面可信度：${packet.page_credibility.reason}` : '',
    packet.extraction_confidence?.reason ? `抽取稳定度：${packet.extraction_confidence.reason}` : ''
  ].filter(Boolean).slice(0, 3);
  const reason = packet.hold_reason || packet.retry_reason || packet.reject_reason || packet.quality_reason_summary || '';
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip ${chipTone}">页面质量门</span>
      <p>${escapeHtml(packet.quality_reason_summary || '当前页面读取结果已进入页面质量门。')}</p>
      <div class="keyword-list compact">
        <code>${escapeHtml(chipLabel)}</code>
        ${packet.worker_language ? `<code>${escapeHtml(`Worker ${packet.worker_language}`)}</code>` : ''}
      </div>
      ${packet.source_title ? `<small>${escapeHtml(`来源页：${packet.source_title}`)}</small>` : ''}
      ${packet.source_url ? `<small>${escapeHtml(packet.source_url)}</small>` : ''}
      ${reason ? `<small>${escapeHtml(reason)}</small>` : ''}
      ${packet.capture_budget_risk_guard?.manual_confirmation_reason ? `<small>${escapeHtml(`风险守门：${packet.capture_budget_risk_guard.manual_confirmation_reason}`)}</small>` : ''}
      ${packet.source_capture_benchmark?.quality_reason_summary ? `<small>${escapeHtml(`读取基准：${packet.source_capture_benchmark.quality_reason_summary}`)}</small>` : ''}
      ${details.map((item) => `<small>${escapeHtml(item)}</small>`).join('')}
      <small>这层只判断当前页面是否值得继续导入、补修或重读，不会长成独立抓取质量平台。</small>
      ${packet.next_action ? `<small>${escapeHtml(packet.next_action)}</small>` : ''}
    </div>
  `;
}

function renderedPageScrollStopReasonLabel(reason) {
  return {
    await_infinite_scroll_resume: '这次先停在当前滚动窗口，继续下滚会只补新增内容',
    await_lazy_load_resume: '这次先停在当前懒加载窗口，继续续读会补后面的新内容',
    await_resume_for_more: '这次先停在当前位置，继续续读会补后面的新内容',
    reached_page_end: '已经读到当前页尾',
    no_new_content: '当前没有新的未读内容'
  }[reason] || reason || '已停止';
}

function renderB2BSourceAdapterSlot(slot) {
  if (!slot) return '';
  const datasets = asArray(slot.preferred_dataset_kinds).slice(0, 3);
  const trustFlags = asArray(slot.trust_flags).slice(0, 3);
  const queryClusters = asArray(slot.query_clusters).slice(0, 2);
  const writebackFields = asArray(slot.writeback_fields).slice(0, 6);
  const chips = [
    slot.status === 'contract_ready' ? 'B2B slot 已预留' : '',
    slot.status === 'live_ready' ? 'CSV live 已接入' : '',
    slot.expected_worker_language ? `Worker ${slot.expected_worker_language}` : '',
    slot.control_language ? `控制面 ${slot.control_language}` : '',
    slot.target_min_source_authority_score ? `可信度门槛 ${slot.target_min_source_authority_score}` : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">B2B 数据源补位</span>
      <p>${escapeHtml(slot.summary || 'B2B 数据源只作为当前 run 的补位来源。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${datasets.length ? `<small>${escapeHtml(`优先数据集：${datasets.map((item) => `${item.label}（${item.reason}）`).join('；')}`)}</small>` : ''}
      ${queryClusters.length ? `<small>${escapeHtml(`适配问题簇：${queryClusters.map((item) => item.label || item.key || '问题').join('、')}`)}</small>` : ''}
      ${writebackFields.length ? `<small>${escapeHtml(`接入后必须回写：${writebackFields.join('、')}`)}</small>` : ''}
      ${asArray(slot.live_input_types).length ? `<small>${escapeHtml(`当前可接入：${asArray(slot.live_input_types).join('、')}`)}</small>` : ''}
      ${trustFlags.length ? `<small>${escapeHtml(trustFlags.join('；'))}</small>` : ''}
      ${slot.next_action ? `<small>${escapeHtml(slot.next_action)}</small>` : ''}
    </div>
  `;
}

function renderPublicSourceLiveAdapter(adapter) {
  if (!adapter) return '';
  const trustFlags = asArray(adapter.trust_flags).slice(0, 3);
  const supportedInputs = asArray(adapter.supported_input_types).slice(0, 2);
  const chips = [
    adapter.status === 'live_ready' ? 'Feed live 已就绪' : '',
    adapter.status === 'fetched_live' ? '本轮已 live 拉取' : '',
    adapter.status === 'live_empty' ? '本轮无条目' : '',
    adapter.control_language ? `控制面 ${adapter.control_language}` : '',
    supportedInputs.length ? `输入 ${supportedInputs.join(' / ')}` : ''
  ].filter(Boolean);
  return `
    <div class="next-batch-memory-guidance">
      <span class="chip info">公开来源 live adapter</span>
      <p>${escapeHtml(adapter.summary || '当前 run 已可直接拉取一个真实公开来源。')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${adapter.feed_title ? `<small>${escapeHtml(`本轮来源：${adapter.feed_title}`)}</small>` : ''}
      ${adapter.feed_url ? `<small>${escapeHtml(`Feed URL：${adapter.feed_url}`)}</small>` : ''}
      ${adapter.live_item_count ? `<small>${escapeHtml(`本轮带回 ${adapter.live_item_count} 条候选来源`)}</small>` : ''}
      ${adapter.latest_published_at ? `<small>${escapeHtml(`最近发布时间：${adapter.latest_published_at}`)}</small>` : ''}
      ${trustFlags.length ? `<small>${escapeHtml(trustFlags.join('；'))}</small>` : ''}
      ${adapter.next_action ? `<small>${escapeHtml(adapter.next_action)}</small>` : ''}
    </div>
  `;
}

function sourceTaskStatusLabel(status) {
  return {
    done: '已产出',
    ready_to_import: '待确认导入',
    needs_repair: '需补证据',
    pending: '待执行'
  }[status] || '待执行';
}

function sourceTaskStatusTone(status) {
  return {
    done: 'success',
    ready_to_import: 'warning',
    needs_repair: 'danger',
    pending: 'info'
  }[status] || 'info';
}

function importReviewStatusLabel(status) {
  return {
    duplicate: '重复线索',
    likely_duplicate: '疑似重复',
    missing_contact: '缺联系方式',
    weak_source_evidence: '证据偏弱',
    ready_to_import: '可导入',
    imported: '已导入',
    merged: '已合并导入',
    held_for_repair: '待修复',
    rejected: '已拒绝'
  }[status] || '待判断';
}

function importReviewStatusTone(status) {
  return {
    duplicate: 'danger',
    likely_duplicate: 'warning',
    missing_contact: 'danger',
    weak_source_evidence: 'warning',
    ready_to_import: 'success',
    imported: 'success',
    merged: 'success',
    held_for_repair: 'warning',
    rejected: 'info'
  }[status] || 'info';
}

function leadImportRepairFieldLabel(fieldName) {
  return {
    contact_name: '联系人',
    contact_phone: '联系电话',
    contact_email: '联系邮箱',
    platform_account: '平台账号'
  }[fieldName] || fieldName || '待修复字段';
}

function renderLeadImportReviewPacket(packet) {
  if (!packet) return '';
  const metrics = packet.metrics || {};
  const reviews = asArray(packet.reviews).slice(0, 6);
  const repairHints = asArray(packet.repair_hints).slice(0, 3);
  const contactRepairPacket = packet.contact_repair_packet || null;
  return `
    <div class="lead-run-gate-panel">
      <div>
        <span class="chip warning">导入前置质量门</span>
        <p class="muted">${escapeHtml(packet.summary || '候选线索会先在这里完成通过、合并、修复或拒绝判断。')}</p>
      </div>
      ${renderLeadSourceQualityBenchmark(packet.source_quality_benchmark, {
        title: '当前高质量名单标准'
      })}
      ${renderLeadSourceExperimentCard(packet.source_experiment_card, { mode: 'import' })}
      <div class="quality-metrics">
        ${[
          ['候选总数', metrics.total_candidates ?? 0],
          ['可直接导入', metrics.ready_to_import ?? 0],
          ['可修复后导入', metrics.repairable_candidates ?? 0],
          ['建议合并', (metrics.duplicate ?? 0) + (metrics.likely_duplicate ?? 0)],
          ['待修复', (metrics.missing_contact ?? 0) + (metrics.weak_source_evidence ?? 0) + (metrics.held_for_repair ?? 0)],
          ['已导入/合并', (metrics.imported ?? 0) + (metrics.merged ?? 0)],
          ['已拒绝', metrics.rejected ?? 0]
        ].map(([label, value]) => `
          <article>
            <strong>${escapeHtml(String(value))}</strong>
            <span>${escapeHtml(label)}</span>
          </article>
        `).join('')}
      </div>
      <div class="action-stack compact-stack">
        ${reviews.length ? reviews.map((item) => `
          <article class="mini-card gate-card">
            <div class="card-heading compact-heading">
              <div>
                <strong>${escapeHtml(item.source_title || item.candidate_id || '候选线索')}</strong>
                <p>${escapeHtml(item.explanation || '')}</p>
              </div>
              <span class="chip ${importReviewStatusTone(item.review_status)}">${escapeHtml(importReviewStatusLabel(item.review_status))}</span>
            </div>
             <small>${escapeHtml(item.source_label || '')}${item.authority_score ? ` · 可信度 ${escapeHtml(String(item.authority_score))}` : ''}</small>
              ${item.source_experiment_alignment_reason ? `<small>${escapeHtml(item.source_experiment_alignment_reason)}</small>` : ''}
              ${asArray(item.merge_recommendations).length ? `<small>${escapeHtml(asArray(item.merge_recommendations).map((merge) => merge.summary || '').filter(Boolean).join('；'))}</small>` : ''}
             ${asArray(item.repair_hints).length ? asArray(item.repair_hints).slice(0, 2).map((hint) => `
               <small>${escapeHtml(`${hint.issue || '需补修复'}：${hint.hint || hint.action || ''}`)}</small>
             `).join('') : ''}
             ${asArray(item.contact_repair_packet?.items).length ? asArray(item.contact_repair_packet.items).slice(0, 3).map((repair) => `
               <small>${escapeHtml(`最小修复：${leadImportRepairFieldLabel(repair.field_name)} → ${repair.suggested_value || '-'}（${repair.repair_reason || '按来源原文补齐'}）`)}</small>
             `).join('') : ''}
             ${item.contact_repair_packet?.next_action ? `<small>${escapeHtml(item.contact_repair_packet.next_action)}</small>` : ''}
             ${item.decision?.explanation ? `<small>已处理：${escapeHtml(item.decision.explanation)}</small>` : ''}
             ${asArray(item.decision_options).length ? `
               <div class="button-stack">
                ${asArray(item.decision_options).map((option, index) => `
                  <button
                    class="button ${index === 0 ? 'primary' : 'secondary'}"
                    data-lead-run-action="import-review"
                    data-candidate-id="${escapeHtml(item.candidate_id || '')}"
                    data-import-review-action="${escapeHtml(option.action || '')}"
                    title="${escapeHtml(option.reason || '')}"
                  >
                    ${escapeHtml(option.label || '继续处理')}
                  </button>
                `).join('')}
              </div>
            ` : ''}
          </article>
        `).join('') : renderEmpty('公开来源解析出候选后，这里会先给出导入前判断。')}
      </div>
      ${repairHints.length ? `<p class="muted">优先补：${repairHints.map((item) => escapeHtml(`${item.source_title || '候选'}${item.issue ? `（${item.issue}）` : ''}`)).join('、')}</p>` : ''}
      ${contactRepairPacket?.repairable_candidates ? `<p class="muted">可直接修复后导入：${asArray(contactRepairPacket.repairs).slice(0, 2).map((item) => {
        const repairSummary = asArray(item.items).slice(0, 2).map((repair) => `${leadImportRepairFieldLabel(repair.field_name)}→${repair.suggested_value || '-'}`).join('、');
        return escapeHtml(`${item.source_title || '候选'}（${repairSummary}）`);
      }).join('、')}</p>` : ''}
      <p class="muted">${escapeHtml(packet.next_action || '先完成导入前判断，再把通过项推进到当前 run。')}</p>
    </div>
  `;
}

function renderLeadQualityReview(review) {
  if (!review) {
    return renderEmpty('导入线索后点击“检查线索质量”，系统会标出可直接联系、缺联系方式和缺需求证据的线索。');
  }
  const metrics = review.metrics || {};
  const topLeads = asArray(review.top_leads).slice(0, 3);
  const fixQueue = asArray(review.fix_queue).slice(0, 4);
  const blockers = asArray(review.blockers).slice(0, 3);
  return `
    <div class="lead-run-quality-grid">
      <div>
        <span class="chip success">质量检查</span>
        <div class="quality-metrics">
          ${[
            ['可直接联系', metrics.ready_to_call ?? 0],
            ['今日优先', metrics.high_priority ?? 0],
            ['电话可直呼', metrics.phone_ready ?? 0],
            ['仅邮箱/账号', metrics.digital_only ?? 0],
            ['缺联系方式', metrics.needs_contact ?? 0],
            ['缺需求证据', metrics.needs_need_signal ?? 0],
            ['来源已标准化', metrics.traceable_sources ?? 0],
            ['下一批需补证据', metrics.next_batch_needs_evidence ?? 0]
          ].map(([label, value]) => `
            <article>
              <strong>${escapeHtml(String(value))}</strong>
              <span>${escapeHtml(label)}</span>
            </article>
          `).join('')}
        </div>
        <p class="muted">${escapeHtml(review.summary || '已完成线索质量检查。')}</p>
      </div>
      <div>
        <span class="chip info">今天先联系</span>
        <div class="action-stack compact-stack">
          ${topLeads.length
            ? topLeads.map((lead) => `
              <article class="mini-card">
                <strong>${escapeHtml(lead.name || lead.lead_id || '线索')}</strong>
                <p>评分 ${escapeHtml(String(lead.score_total ?? '-'))} · ${escapeHtml(lead.suggested_action || '优先跟进')}</p>
                <small>${escapeHtml(lead.reason || '')}</small>
              </article>
            `).join('')
            : renderEmpty('还没有达到可直接联系标准的线索。')}
        </div>
      </div>
      <div>
        <span class="chip warning">需要补齐</span>
        <div class="action-stack compact-stack">
          ${fixQueue.length
            ? fixQueue.map((item) => `
              <article class="mini-card">
                <strong>${escapeHtml(item.name || item.lead_id || '线索')}</strong>
                <p>${escapeHtml(item.issue || '需要补充')}</p>
                <small>${escapeHtml(item.action || '')}</small>
                ${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ''}
                ${item.example ? `<small>${escapeHtml(item.example)}</small>` : ''}
              </article>
            `).join('')
            : renderEmpty(blockers.length ? blockers.join('；') : '当前没有明显阻断。')}
        </div>
      </div>
    </div>
  `;
}

function renderLeadQueueGate(run) {
  const repairReviewPanel = renderLeadRepairRequeueReview(run.repair_requeue_review, run);
  const queueState = state.data.leadRunQueueSkips;
  const persistedGate = run.queue_gate_review || null;
  const usingRecentQueueAttempt = queueState?.run_id === run.id;
  const skipped = usingRecentQueueAttempt
    ? asArray(queueState.skipped_leads)
    : asArray(persistedGate?.skipped_leads);
  const nextBatchFixes = asArray(run.quality_review?.fix_queue)
    .filter((item) => String(item.issue || '').includes('下一批') || String(item.issue || '').includes('联系方式'))
    .slice(0, 6);
  const leadsById = new Map(asArray(run.leads).map((lead) => [lead.id, lead]));
  if (!skipped.length && !nextBatchFixes.length) return repairReviewPanel;
  const visibleItems = skipped.length ? skipped : nextBatchFixes;
  const persistedSummary = String(persistedGate?.summary || '').trim();
  const createdTaskCount = Number(persistedGate?.created_task_count || queueState?.created_count || 0);
  const summaryText = skipped.length
    ? usingRecentQueueAttempt || persistedGate?.source === 'followup_queue_build'
      ? `${persistedSummary || `最近一次创建队列拦截了 ${skipped.length} 条线索。`}${createdTaskCount ? ` 已入队 ${createdTaskCount} 条。` : ''} 这些线索仍保留在当前获客执行里，补齐后可重新创建队列。`
      : persistedSummary || `当前仍有 ${skipped.length} 条线索未满足进入队列条件，补齐后可重新创建今日跟进队列。`
    : '当前仍有线索未满足进入队列条件，补齐后再生成跟进队列。';
  return `
    ${repairReviewPanel}
    <div class="lead-run-gate-panel">
      <div>
        <span class="chip warning">未进入跟进队列</span>
        <p class="muted">${escapeHtml(summaryText)}</p>
      </div>
      <div class="action-stack compact-stack">
        ${visibleItems.map((item) => {
          const lead = leadsById.get(item.lead_id);
          const repairReason = String(item.reason || item.issue || '');
          const repairableEvidence = repairReason === 'missing_next_batch_evidence'
            || repairReason.includes('下一批');
          const repairableContact = repairReason === 'missing_contact'
            || repairReason.includes('联系方式');
          const evidenceValue = escapeHtml(String(lead?.run_metadata?.source_evidence || lead?.run_metadata?.import_message || ''));
          const contactValue = escapeHtml(String(lead?.contact_phone || lead?.contact_email || lead?.platform_account || ''));
          return `
          <article class="mini-card gate-card">
            <strong>${escapeHtml(item.name || item.lead_id || '线索')}</strong>
            <p>${escapeHtml(leadQueueSkipReasonLabel(item.reason || item.issue))}</p>
            <small>${escapeHtml(item.action || '补充最近需求信号、来源位置或为什么值得今天联系。')}</small>
            ${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ''}
            ${item.example ? `<small>${escapeHtml(item.example)}</small>` : ''}
            ${repairableContact ? `
              <div class="lead-run-repair-form">
                <input data-lead-run-contact-input type="text" value="${contactValue}" placeholder="${escapeHtml(item.placeholder || '补一个电话、微信或邮箱')}" />
                <button class="button secondary" data-lead-run-repair-queue="${escapeHtml(item.lead_id || '')}" data-repair-reason="missing_contact" data-repair-hint="${escapeHtml(item.hint || '')}">修好并重新入队</button>
              </div>
            ` : ''}
            ${repairableEvidence ? `
              <div class="lead-run-repair-form">
                <textarea data-lead-run-evidence-input rows="3" placeholder="${escapeHtml(item.placeholder || '例如：刚注册公司，正在咨询代理记账报价；来源：企查查新注册名单。')}">${evidenceValue}</textarea>
                <button class="button secondary" data-lead-run-repair-queue="${escapeHtml(item.lead_id || '')}" data-repair-reason="missing_next_batch_evidence" data-repair-hint="${escapeHtml(item.hint || '')}">修好并重新入队</button>
              </div>
            ` : ''}
          </article>
        `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderLeadRepairRequeueReview(review, run) {
  if (!review) return '';
  const status = String(review.status || '');
  const task = review.task || null;
  const lead = asArray(run?.leads).find((item) => item.id === review.lead_id);
  const canCall = Boolean(lead?.contact_phone);
  const continuePrefill = {
    object_type: 'lead',
    object_id: review.lead_id || '',
    title: task?.title || `继续跟进 ${review.lead_name || review.lead_id || '线索'}`,
    priority: task?.priority || 'P1'
  };
  const chipLabel = status === 'queued' ? '修复后已入队' : '修复后仍被拦截';
  const toneClass = status === 'queued' ? 'success' : 'warning';
  const focusAttrs = task ? [
    `data-task-id="${escapeHtml(task.id || '')}"`,
    `data-focus-title="${escapeHtml(task.title || '今日跟进任务')}"`,
    `data-focus-lead="${escapeHtml(review.lead_name || review.lead_id || '线索')}"`,
    `data-focus-reason="${escapeHtml(review.admission_reason || review.summary || '补齐信息后已进入今日队列')}"`,
    `data-focus-next="${escapeHtml(review.next_action || '可以直接继续今天的跟进。')}"`
  ].join(' ') : '';
  return `
    <div class="lead-run-repair-review ${toneClass}">
      <div>
        <span class="chip ${toneClass}">${escapeHtml(chipLabel)}</span>
        <p class="muted">${escapeHtml(review.summary || '')}</p>
      </div>
      <div class="action-stack compact-stack">
        <article class="mini-card">
          <strong>${escapeHtml(review.lead_name || review.lead_id || '线索')}</strong>
          <p>${escapeHtml(review.admission_reason || review.blocker_action || '')}</p>
          <small>${escapeHtml(
            status === 'queued'
              ? review.next_action || '可以直接继续今天的跟进。'
              : leadQueueSkipReasonLabel(review.blocker_reason || '')
          )}</small>
        </article>
        ${task ? `
          <article class="mini-card">
            <strong>${escapeHtml(task.title || '今日跟进任务')}</strong>
            <p>优先级 ${escapeHtml(task.priority || 'P1')} · 截止 ${escapeHtml(formatDateTime(task.due_at) || '-')}</p>
            <small>这条线索已经转成可执行的今日跟进任务。</small>
            <div class="button-stack compact-stack">
              <button class="button secondary" data-action="complete-task" data-task-id="${escapeHtml(task.id || '')}">记录结果</button>
              <button class="button ghost" data-next-command="${escapeHtml(`帮我继续处理这个跟进任务：${task.title || task.id || review.lead_name || review.lead_id}`)}" data-commander-template="crm_followup" data-prefill-json="${escapeHtml(JSON.stringify(continuePrefill))}">继续处理</button>
              <button class="button ghost" data-repair-review-action="today" ${focusAttrs}>看今天处理</button>
            </div>
          </article>
        ` : ''}
        ${status === 'queued' && canCall ? `
          <article class="mini-card">
            <strong>马上联系这条线索</strong>
            <p>${escapeHtml(leadDisplayName(lead))} · ${escapeHtml(lead.contact_phone || '')}</p>
            <small>把这条已修复线索直接放入顶部呼叫栏，马上开始今天的跟进。</small>
            <div class="button-stack compact-stack">
              <button class="button secondary" data-repair-review-action="call-lead" data-lead-id="${escapeHtml(review.lead_id || '')}">放入顶部呼叫栏</button>
              <button class="button ghost" data-repair-review-action="today" ${focusAttrs}>看今天处理</button>
            </div>
          </article>
        ` : ''}
      </div>
    </div>
  `;
}

function leadQueueSkipReasonLabel(reason) {
  return {
    missing_contact: '缺少联系方式',
    missing_next_batch_evidence: '下一批质量门槛未通过：缺少需求/来源证据'
  }[reason] || reason || '需要补齐后再排队';
}

function renderLeadRunCallWriteback(review, run) {
  if (!review || !run?.id || String(review.runId || '') !== String(run.id)) return '';
  const disposition = callDispositionText(review.disposition || '');
  const preview = deriveLeadWritebackPreview(review.writebackPreview, null);
  return `
    <div class="lead-run-call-writeback">
      <div>
        <span class="chip success">通话已回写</span>
        <strong>${escapeHtml(review.leadName || '修复线索')}</strong>
        <p>${escapeHtml(disposition ? `刚记录通话结果：${disposition}` : '刚记录了一次通话结果。')}</p>
        ${preview ? renderLeadWritebackPreviewBrief(preview, { compact: true }) : ''}
      </div>
      <div>
        <small>${escapeHtml(review.nextAction || '已刷新获客执行复盘和下一步建议。')}</small>
        ${review.followupTaskTitle ? `<p class="muted">已接下一步：${escapeHtml(review.followupTaskTitle)}</p>` : ''}
      </div>
    </div>
  `;
}

function renderLeadOutcomeRouteCard(card) {
  if (!card || card.status === 'waiting_for_result') return '';
  return `
    <div class="lead-outcome-route-card ${escapeHtml(card.status || 'followup')}">
      <div>
        <span class="chip success">结果分流</span>
        <strong>${escapeHtml(card.title || '已生成下一步')}</strong>
        <p>${escapeHtml(card.summary || '')}</p>
        <div class="keyword-list compact">
          ${card.lead_name ? `<code>${escapeHtml(card.lead_name)}</code>` : ''}
          ${card.outcome_tag ? `<code>${escapeHtml(card.outcome_tag)}</code>` : ''}
          ${card.next_step_due_at ? `<code>${escapeHtml(formatDate(card.next_step_due_at))}</code>` : ''}
        </div>
      </div>
      <div class="action-stack compact-stack">
        <article class="mini-card">
          <strong>${escapeHtml(card.recommended_action || '继续下一步')}</strong>
          <p>${escapeHtml(card.next_action || '')}</p>
          ${card.followup_task ? `<small>任务：${escapeHtml(card.followup_task.title || card.followup_task.id)} · ${escapeHtml(formatDate(card.followup_task.due_at))}</small>` : '<small>没有创建新任务，结果已用于复盘。</small>'}
        </article>
        <div>
          ${card.primary_action ? `<button class="button secondary" data-lead-run-action="${escapeHtml(card.primary_action)}">去执行下一步</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

function renderLeadMicroScriptQualityCard(card) {
  if (!card || card.status === 'waiting_for_writeback') return '';
  const latest = card.latest || {};
  const routes = asArray(card.route_summary).slice(0, 3);
  return `
    <div class="lead-micro-script-quality-card ${escapeHtml(card.status || 'mixed')}">
      <div>
        <span class="chip info">微话术质量</span>
        <strong>${escapeHtml(card.title || '微话术结果已复盘')}</strong>
        <p>${escapeHtml(card.summary || '')}</p>
        <div class="keyword-list compact">
          <code>匹配 ${escapeHtml(String(card.metrics?.aligned_results || 0))}/${escapeHtml(String(card.metrics?.reviewed_tasks || 0))}</code>
          <code>正向 ${escapeHtml(String(card.metrics?.positive_results || 0))}</code>
          ${latest.route_label ? `<code>${escapeHtml(latest.route_label)}</code>` : ''}
        </div>
      </div>
      <div class="action-stack compact-stack">
        ${latest.task_id ? `
          <article class="mini-card">
            <strong>${escapeHtml(latest.task_title || latest.route_label || '最近一次微话术')}</strong>
            <p>实际结果：${escapeHtml(latest.actual_result || '已回写')}</p>
            <small>预期：${asArray(latest.expected_results).map(escapeHtml).join(' / ')}</small>
          </article>
        ` : ''}
        ${routes.length ? `
          <article class="mini-card">
            <strong>哪些微话术有效</strong>
            ${routes.map((route) => `
              <p>${escapeHtml(route.route_label || route.route_type)}：匹配 ${escapeHtml(String(route.aligned || 0))}/${escapeHtml(String(route.touched || 0))}</p>
            `).join('')}
            <small>${escapeHtml(card.next_action || '')}</small>
          </article>
        ` : ''}
      </div>
    </div>
  `;
}

function renderLeadRunMemoryFeedback(run) {
  const updates = run?.memory_updates || null;
  const recall = run?.memory_recall || null;
  const promoted = asArray(updates?.memories).slice(0, 3);
  const recalled = asArray(recall?.memories).slice(0, 3);
  if (!promoted.length && !recalled.length) return '';
  return `
    <div class="lead-run-memory-feedback">
      <div>
        <span class="chip info">长期记忆已接入</span>
        <strong>${escapeHtml(memoryFeedbackTitle(updates, recall))}</strong>
        <p>${escapeHtml(memoryFeedbackCopy(promoted, recalled))}</p>
      </div>
      <div class="action-stack compact-stack">
        ${promoted.length ? `
          <article class="mini-card">
            <strong>刚沉淀的记忆</strong>
            ${promoted.map((memory) => `
              <p>${escapeHtml(memoryTypeLabel(memory.memory_type))}：${escapeHtml(truncateText(memory.content || '', 92))}</p>
              <small>${escapeHtml(memorySourceLabel(memory.source_refs))}</small>
            `).join('')}
          </article>
        ` : ''}
        ${recalled.length ? `
          <article class="mini-card">
            <strong>本次已召回用于话术/队列</strong>
            ${recalled.map((memory) => `
              <p>${escapeHtml(memoryTypeLabel(memory.memory_type))}：${escapeHtml(truncateText(memory.content || '', 92))}</p>
              <small>${escapeHtml(memoryRecallReason(memory))}</small>
            `).join('')}
          </article>
        ` : ''}
      </div>
    </div>
  `;
}

function memoryFeedbackTitle(updates, recall) {
  const promotedCount = Number(updates?.promoted_count || asArray(updates?.memories).length || 0);
  const recalledCount = asArray(recall?.memories).length;
  if (promotedCount && recalledCount) return `已沉淀 ${promotedCount} 条，并召回 ${recalledCount} 条影响下一步`;
  if (promotedCount) return `已从本轮结果沉淀 ${promotedCount} 条长期记忆`;
  return `已召回 ${recalledCount} 条长期记忆影响当前动作`;
}

function memoryFeedbackCopy(promoted, recalled) {
  if (promoted.length && recalled.length) return '系统已经把真实回写结果变成可追溯记忆，并用于下一次话术、排序和跟进提醒。';
  if (promoted.length) return '这些记忆来自通话/任务结果，后续生成话术和今日队列会自动参考。';
  return '当前话术或队列已经参考历史跟进结果、待回拨伏笔或长期条件。';
}

function memoryTypeLabel(type) {
  return {
    fact: '事实',
    open_loop: '待办伏笔',
    condition: '长期条件',
    preference: '偏好',
    profile: '画像',
    learning: '经验'
  }[type] || '记忆';
}

function memorySourceLabel(sourceRefs) {
  const refs = asArray(sourceRefs);
  if (!refs.length) return '来源：已验证业务结果';
  const first = refs[0] || {};
  return `来源：${first.object_type || '业务记录'} ${first.object_id || ''}`.trim();
}

function memoryRecallReason(memory) {
  const path = asArray(memory.recall_path).join(' → ');
  return path || memory.rank_reason || '按当前线索/获客执行范围召回';
}

function renderLeadOutcomeReview(review, nextBatchPlan) {
  if (!review) {
    return renderEmpty('完成通话或任务后点击“复盘结果/下一批建议”，系统会把结果变成可执行的下一批获客建议。');
  }
  const metrics = review.metrics || {};
  const wins = asArray(review.winning_signals).slice(0, 3);
  const blockers = asArray(review.blocked_or_cold).slice(0, 4);
  const routeLearning = review.route_learning || null;
  const promptLearning = review.prompt_learning || null;
  const nextBatch = review.next_batch_recommendation || {};
  const plan = nextBatchPlan || null;
  return `
    <div class="lead-run-outcome-grid">
      <div>
        <span class="chip success">结果复盘</span>
        <div class="quality-metrics">
          ${[
            ['已通话', metrics.completed_calls ?? 0],
            ['已接通', metrics.connected_calls ?? 0],
            ['正向结果', metrics.positive_outcomes ?? 0],
            ['待处理', metrics.open_tasks ?? 0]
          ].map(([label, value]) => `
            <article>
              <strong>${escapeHtml(String(value))}</strong>
              <span>${escapeHtml(label)}</span>
            </article>
          `).join('')}
        </div>
        <p class="muted">${escapeHtml(review.summary || '已生成结果复盘。')}</p>
      </div>
      <div>
        <span class="chip info">可重复信号</span>
        <div class="action-stack compact-stack">
          ${wins.length
            ? wins.map((item) => `
              <article class="mini-card">
                <strong>${escapeHtml(item.name || item.lead_id || '线索')}</strong>
                <p>${escapeHtml(item.signal || '正向结果')} · ${escapeHtml(item.evidence || '')}</p>
                <small>${escapeHtml(item.repeat_rule || '')}</small>
              </article>
            `).join('')
            : renderEmpty('还没有正向信号；先完成一轮真实跟进再判断要重复什么。')}
        </div>
      </div>
      <div>
        <span class="chip warning">下一批建议</span>
        ${plan ? renderLeadNextBatchPlan(plan) : `
          <article class="mini-card">
            <strong>${escapeHtml(nextBatch.profile || '先按当前目标继续')}</strong>
            <p>${escapeHtml(nextBatch.source || '')}</p>
            <small>${escapeHtml(nextBatch.action || review.next_action || '继续回写结果后再扩大名单。')}</small>
          </article>
          <p class="muted">点击“生成下一批采集清单”后，会把这条建议变成可执行的收集步骤和导入标准。</p>
        `}
        <div class="action-stack compact-stack">
          ${blockers.length
            ? blockers.map((item) => `
              <article class="mini-card">
                <strong>${escapeHtml(item.name || item.lead_id || '阻断项')}</strong>
                <p>${escapeHtml(item.issue || '需要处理')}</p>
                <small>${escapeHtml(item.action || '')}</small>
              </article>
            `).join('')
            : ''}
        </div>
      </div>
      ${renderLeadRouteLearningCard(routeLearning, {
        title: '这轮话术学习',
        badge: '路由学习',
        emptyCopy: '完成更多带结果标签的回写后，这里会告诉你哪类路由该继续复用、哪类该先纠正。'
      })}
      ${renderLeadPromptLearningCard(promptLearning, {
        title: '这轮继续沿哪版 Prompt',
        badge: 'Prompt 学习',
        emptyCopy: '完成更多可回写结果后，这里会告诉你当前下一轮该继续沿哪版 prompt。'
      })}
      ${renderLeadOutcomeReasonPacket(review.outcome_reason_packet, {
        title: '这轮为什么赢 / 输 / 没接通',
        maxItems: 2
      })}
      ${renderLeadCallOutcomeProofPacket(review.call_outcome_proof_packet, {
        title: '这轮最近一通电话证明了什么'
      })}
      ${renderLeadCallProofContinuityPacket(review.call_proof_continuity_packet, {
        title: '这轮最近一通电话后怎么继续不断线',
        compact: true
      })}
      ${renderLeadPromiseFulfillmentPack(review.promise_fulfillment_pack, {
        title: '这轮承诺怎么兑现',
        compact: true
      })}
      ${renderLeadNextActionCommitmentPack(review.next_action_commitment_pack, {
        title: '复盘后下一步承诺'
      })}
      ${renderLeadMultiChannelFollowupPack(review.multi_channel_followup_pack, {
        title: '复盘后多渠道跟进包'
      })}
      ${renderLeadOutcomeScriptFeedbackCard(review)}
      ${renderLeadOutcomeWinLossCard(review, plan)}
    </div>
  `;
}

function renderLeadOutcomeScriptFeedbackCard(review) {
  const evidencePack = review?.evidence_pack || null;
  const conditions = review?.script_feedback_conditions || null;
  const proofPoints = asArray(evidencePack?.proof_points).slice(0, 2);
  const objectionAnswers = asArray(evidencePack?.objection_answers).slice(0, 2);
  const experiments = asArray(review?.next_experiments).slice(0, 2);
  if (!evidencePack && !conditions && !experiments.length) return '';
  const chips = [
    proofPoints.length ? `${proofPoints.length} 条证据` : '',
    objectionAnswers.length ? `${objectionAnswers.length} 条异议回应` : '',
    experiments.length ? `${experiments.length} 个测试点` : ''
  ].filter(Boolean);
  const lines = [
    evidencePack?.summary || '',
    conditions?.summary ? `回流条件：${conditions.summary}` : '',
    proofPoints[0]?.proof_point ? `优先证据：${proofPoints.map((item) => item.proof_point).join('；')}` : '',
    objectionAnswers[0]?.label ? `优先异议：${objectionAnswers.map((item) => `${item.label} → ${item.answer}`).join('；')}` : '',
    experiments[0]?.instruction ? `下一轮先测：${experiments[0].instruction}` : ''
  ].filter(Boolean).slice(0, 4);
  return `
    <div>
      <span class="chip info">复盘回流到话术</span>
      <div class="action-stack compact-stack">
        <article class="mini-card">
          <strong>${escapeHtml(conditions?.keep?.[0] || '下一版脚本已带上复盘条件')}</strong>
          ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
          ${lines.map((item) => `<p>${escapeHtml(item)}</p>`).join('')}
          <small>这块不会单独长成内容平台，只负责把证据、异议和实验条件带回下一版开口。</small>
        </article>
      </div>
    </div>
  `;
}

function renderLeadOutcomeWinLossCard(review, nextBatchPlan) {
  const winLossBrief = review?.win_loss_brief || nextBatchPlan?.win_loss_brief || null;
  const recalibrationPacket = review?.source_authority_recalibration_packet || nextBatchPlan?.source_authority_recalibration_packet || null;
  const nextExperiments = asArray(review?.next_experiments || nextBatchPlan?.next_experiments).slice(0, 2);
  const riskFlags = asArray(review?.risk_flags || nextBatchPlan?.risk_flags).slice(0, 2);
  const winningSources = asArray(winLossBrief?.winning_sources).slice(0, 2);
  const losingSources = asArray(winLossBrief?.losing_sources).slice(0, 2);
  if (!winLossBrief && !recalibrationPacket && !nextExperiments.length && !riskFlags.length) return '';
  const chips = [
    winningSources[0]?.source_label ? `多采 ${winningSources[0].source_label}` : '',
    losingSources[0]?.source_label ? `少采 ${losingSources[0].source_label}` : '',
    riskFlags.length ? `${riskFlags.length} 个风险提醒` : ''
  ].filter(Boolean);
  const lines = [
    winLossBrief?.summary || '',
    winningSources[0]?.source_label ? `本轮赢：${winningSources.map((item) => `${item.source_label}（${item.validated_count || 0} 条验证）`).join('；')}` : '',
    losingSources[0]?.source_label ? `本轮输：${losingSources.map((item) => `${item.source_label}（${item.blocked_count || 0} 条阻断）`).join('；')}` : '',
    recalibrationPacket?.summary ? `动态校准：${recalibrationPacket.summary}` : '',
    nextExperiments[0]?.instruction ? `下一轮实验：${nextExperiments[0].instruction}` : '',
    riskFlags[0]?.action ? `风险提示：${riskFlags.map((item) => `${item.label} → ${item.action || item.reason}`).join('；')}` : ''
  ].filter(Boolean).slice(0, 4);
  return `
    <div>
      <span class="chip warning">来源赢/输原因</span>
      <div class="action-stack compact-stack">
        <article class="mini-card">
          <strong>${escapeHtml(winningSources[0]?.source_label || losingSources[0]?.source_label || '来源诊断已生成')}</strong>
          ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
          ${lines.map((item) => `<p>${escapeHtml(item)}</p>`).join('')}
          <small>这里只用业务语言说明下一轮该多采什么、少采什么，不会展开成独立报表中心。</small>
        </article>
      </div>
    </div>
  `;
}

function renderCustomerReactivationPacket(packet) {
  if (!packet) return '';
  const candidates = asArray(packet.candidates).slice(0, 3);
  const bridgeItems = new Map(asArray(packet.reactivation_run_bridge_packet?.items).map((item) => [String(item?.lead_id || ''), item]));
  const nextExperiments = asArray(packet.next_experiments).slice(0, 2);
  const riskFlags = asArray(packet.risk_flags).slice(0, 2);
  const signalGuidance = packet.signal_guidance_snapshot || null;
  const preferredSources = asArray(signalGuidance?.preferred_sources).slice(0, 1);
  const queryClusters = asArray(signalGuidance?.query_clusters).slice(0, 1);
  const sourcePriorityReason = String(signalGuidance?.source_priority_reason || preferredSources[0]?.source_priority_reason || '').trim();
  const scriptFeedback = packet.script_feedback_conditions || null;
  if (!candidates.length) {
    return `
      <div>
        <span class="chip info">老客户唤醒包</span>
        <div class="action-stack compact-stack">
          <article class="mini-card">
            <strong>${escapeHtml(packet.title || '老客户唤醒包')}</strong>
            <p>${escapeHtml(packet.summary || '当前还没有可重新唤醒的对象。')}</p>
            <small>${escapeHtml(packet.next_action || '')}</small>
          </article>
        </div>
      </div>
    `;
  }
  return `
    <div>
      <span class="chip info">老客户唤醒包</span>
      <div class="action-stack compact-stack">
        <article class="mini-card">
          <strong>${escapeHtml(packet.summary || '已生成可重新唤醒对象')}</strong>
          ${packet.win_loss_brief?.summary ? `<p>${escapeHtml(packet.win_loss_brief.summary)}</p>` : `<p>${escapeHtml(packet.next_action || '')}</p>`}
          ${scriptFeedback?.summary ? `<small>回流条件：${escapeHtml(scriptFeedback.summary)}</small>` : ''}
          ${leadPreferredSourceLine(preferredSources) ? `<small>${escapeHtml(leadPreferredSourceLine(preferredSources))}</small>` : ''}
          ${leadQueryClusterLine(queryClusters) ? `<small>${escapeHtml(leadQueryClusterLine(queryClusters))}</small>` : ''}
          ${leadSourcePriorityReasonLine(sourcePriorityReason) ? `<small>${escapeHtml(leadSourcePriorityReasonLine(sourcePriorityReason))}</small>` : ''}
          ${nextExperiments[0]?.instruction ? `<small>下一轮先测：${escapeHtml(nextExperiments.map((item) => item.instruction).join('；'))}</small>` : ''}
          ${riskFlags[0]?.label ? `<small>风险：${escapeHtml(riskFlags.map((item) => `${item.label}${item.action ? ` → ${item.action}` : ''}`).join('；'))}</small>` : ''}
          ${packet.reactivation_run_bridge_packet?.last_applied?.lead_name
            ? `<small>最近一次桥接：${escapeHtml(packet.reactivation_run_bridge_packet.last_applied.lead_name)} → ${escapeHtml(packet.reactivation_run_bridge_packet.last_applied.bridge_action === 'create_new_run_from_reactivation' ? '已单独起新 run' : '已追加回当前执行')}</small>`
            : ''}
        </article>
        ${candidates.map((candidate) => {
          const scriptBasisPack = candidate.script_basis_pack || null;
          const bridgeItem = bridgeItems.get(String(candidate.lead_id || '')) || null;
          const candidateGuidance = candidate.signal_guidance_snapshot || null;
          const proofPoint = asArray(scriptBasisPack?.evidence_pack?.proof_points || candidate.evidence_pack?.proof_points).slice(0, 1)[0] || null;
          const messageAngle = asArray(scriptBasisPack?.message_angles || candidate.message_angles).slice(0, 1)[0] || null;
          const candidatePreferredSources = asArray(candidateGuidance?.preferred_sources).slice(0, 1);
          const candidatePriorityReason = String(candidateGuidance?.source_priority_reason || candidatePreferredSources[0]?.source_priority_reason || '').trim();
          const candidateExperiments = asArray(candidate.next_experiments).slice(0, 1);
          return `
            <article class="mini-card">
              <strong>${escapeHtml(candidate.lead_name || '老客户')}</strong>
              <p>${escapeHtml(candidate.reason || '')}</p>
              <div class="keyword-list compact">
                ${candidate.phone ? `<code>${escapeHtml(candidate.phone)}</code>` : ''}
                ${candidate.last_touch_label ? `<code>${escapeHtml(candidate.last_touch_label)}</code>` : ''}
                ${messageAngle?.angle ? `<code>${escapeHtml(messageAngle.angle)}</code>` : ''}
              </div>
              ${proofPoint?.proof_point ? `<p>${escapeHtml(proofPoint.proof_point)}</p>` : ''}
              ${leadPreferredSourceLine(candidatePreferredSources) ? `<small>${escapeHtml(leadPreferredSourceLine(candidatePreferredSources))}</small>` : ''}
              ${leadSourcePriorityReasonLine(candidatePriorityReason) ? `<small>${escapeHtml(leadSourcePriorityReasonLine(candidatePriorityReason))}</small>` : ''}
              ${candidate.last_touch_summary ? `<small>上次结果：${escapeHtml(candidate.last_touch_summary)}</small>` : ''}
              ${renderLeadObjectionAnswerPack(candidate.objection_answer_pack || scriptBasisPack?.objection_answer_pack, {
                title: '回访异议先这样回',
                maxItems: 1,
                asArticle: false
              })}
              ${candidateExperiments[0]?.instruction ? `<small>先测：${escapeHtml(candidateExperiments[0].instruction)}</small>` : ''}
              ${bridgeItem?.suggested_next_action ? `<small>桥接后先做：${escapeHtml(bridgeItem.suggested_next_action)}</small>` : ''}
              ${bridgeItem?.source_evidence?.summary ? `<small>桥接依据：${escapeHtml(bridgeItem.source_evidence.summary)}</small>` : ''}
              ${candidate.primary_action
                ? `<button class="button secondary" data-lead-run-action="${escapeHtml(candidate.primary_action.action || '')}" data-lead-id="${escapeHtml(candidate.lead_id || '')}">${escapeHtml(candidate.primary_action.label || '提交审批')}</button>`
                : ''}
              ${bridgeItem?.bridge_actions
                ? bridgeItem.bridge_actions.map((actionItem) => `
                    <button
                      class="button ghost"
                      data-lead-run-action="${escapeHtml(actionItem.action || '')}"
                      data-lead-id="${escapeHtml(candidate.lead_id || '')}"
                      data-target-run-id="${escapeHtml(actionItem.target_run_id || '')}"
                    >${escapeHtml(actionItem.label || '桥接回主链')}</button>
                  `).join('')
                : ''}
            </article>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderLeadWritebackConfirmationCard(card) {
  if (!card || card.status === 'waiting') return '';
  const primary = card.primary_action || null;
  const proofCard = card.lead_execution_proof_card || null;
  const promptLearning = card.prompt_learning || null;
  const feedbackPacket = card.review_feedback_packet || null;
  const signalGuidance = card.signal_guidance_snapshot || feedbackPacket?.signal_guidance_snapshot || null;
  const preferredSources = asArray(signalGuidance?.preferred_sources).slice(0, 1);
  const queryClusters = asArray(signalGuidance?.query_clusters).slice(0, 1);
  const sourcePriorityReason = String(signalGuidance?.source_priority_reason || preferredSources[0]?.source_priority_reason || '').trim();
  const nextExperiments = asArray(card.next_experiments || feedbackPacket?.next_experiments).slice(0, 1);
  const riskFlags = asArray(card.risk_flags || feedbackPacket?.risk_flags).slice(0, 2);
  return `
    <div class="lead-writeback-confirmation-card ${escapeHtml(card.status || 'writeback_recorded')}">
      <div>
        <span class="chip success">结果已落表</span>
        <strong>${escapeHtml(card.title || '本次结果已回写')}</strong>
        <p>${escapeHtml(card.summary || '通话结果已写回当前获客执行。')}</p>
        <small>${escapeHtml(card.route_label || '继续跟进')} · ${escapeHtml(card.outcome_tag || callDispositionText(card.disposition || '') || '已记录')}</small>
        ${primary?.action ? `
          <button class="button primary" data-lead-run-action="${escapeHtml(primary.action)}"
            data-task-id="${escapeHtml(primary.task_id || '')}"
            data-lead-id="${escapeHtml(primary.lead_id || '')}"
            data-focus-title="${escapeHtml(primary.title || '')}"
            data-focus-lead="${escapeHtml(card.lead_name || '')}"
            data-focus-reason="${escapeHtml(primary.reason || card.next_action || '')}">${escapeHtml(primary.label || '继续下一步')}</button>
        ` : ''}
      </div>
      <div class="action-stack compact-stack">
        ${card.completed_task ? `
          <article class="mini-card">
            <span class="chip success">已完成</span>
            <strong>${escapeHtml(card.completed_task.title || '本次承接任务')}</strong>
            <p>${escapeHtml(card.completed_task.completion_result || '已记录结果')}</p>
            <small>${escapeHtml(card.completed_task.completion_reason || '原任务已完成')}</small>
          </article>
        ` : ''}
        ${card.next_task ? `
          <article class="mini-card">
            <span class="chip warning">下一步</span>
            <strong>${escapeHtml(card.next_task.title || '下一步跟进任务')}</strong>
            <p>${escapeHtml(card.next_action || '继续按任务处理。')}</p>
            ${card.next_task.micro_script ? renderLeadMicroScriptBrief(card.next_task.micro_script) : card.micro_script ? renderLeadMicroScriptBrief(card.micro_script) : ''}
            <small>${escapeHtml(formatDateTime(card.next_task.due_at) || formatDate(card.next_task.due_at) || '待安排')}</small>
          </article>
        ` : `
          <article class="mini-card">
            <span class="chip info">下一步</span>
            <strong>${escapeHtml(card.next_action || '继续推进当前获客执行')}</strong>
            <p>如需要继续跟进，可生成明天队列或复盘下一批线索。</p>
          </article>
        `}
        ${(feedbackPacket || preferredSources.length || nextExperiments.length) ? `
          <article class="mini-card">
            <span class="chip info">这次回写学到了什么</span>
            <strong>${escapeHtml(feedbackPacket?.win_loss_brief?.summary || feedbackPacket?.summary || '当前结果已收成下一轮打法')}</strong>
            ${feedbackPacket?.script_feedback_conditions?.summary ? `<p>${escapeHtml(feedbackPacket.script_feedback_conditions.summary)}</p>` : ''}
            ${leadPreferredSourceLine(preferredSources) ? `<small>${escapeHtml(leadPreferredSourceLine(preferredSources))}</small>` : ''}
            ${leadQueryClusterLine(queryClusters) ? `<small>${escapeHtml(leadQueryClusterLine(queryClusters))}</small>` : ''}
            ${leadSourcePriorityReasonLine(sourcePriorityReason) ? `<small>${escapeHtml(leadSourcePriorityReasonLine(sourcePriorityReason))}</small>` : ''}
            ${nextExperiments[0]?.instruction ? `<small>先测：${escapeHtml(nextExperiments[0].instruction)}</small>` : ''}
            ${riskFlags[0]?.label ? `<small>风险：${escapeHtml(riskFlags.map((item) => `${item.label}${item.action ? ` → ${item.action}` : ''}`).join('；'))}</small>` : ''}
          </article>
        ` : ''}
        ${renderLeadResultProofHandoffPack(card.result_proof_handoff_pack, {
          mode: 'writeback'
        })}
        ${renderLeadExecutionProofCard(proofCard, {
          mode: 'writeback'
        })}
        ${renderLeadOutcomeReasonPacket(card.outcome_reason_packet || feedbackPacket?.outcome_reason_packet, {
          title: '这次为什么会这样',
          maxItems: 1
        })}
        ${renderLeadCallOutcomeProofPacket(card.call_outcome_proof_packet, {
          title: '这通电话具体证明了什么',
          compact: true
        })}
        ${renderLeadCallProofContinuityPacket(card.call_proof_continuity_packet, {
          title: '这通电话后怎么不断线',
          compact: true
        })}
        ${renderLeadThreadBrief(card.lead_thread_brief, {
          title: '这条 lead 当前线程',
          compact: true
        })}
        ${renderLeadPromiseFulfillmentPack(card.promise_fulfillment_pack, {
          title: '这次答应发什么',
          compact: true
        })}
        ${renderLeadNextTouchAssetPack(card.next_touch_asset_pack, {
          title: '这次下一触达带什么',
          compact: true
        })}
        ${renderLeadFollowupExperimentCard(card.followup_experiment_card, {
          mode: 'writeback'
        })}
        ${renderLeadFollowupDefaultActivationCard(card.followup_default_activation_card)}
        ${renderLeadNextActionCommitmentPack(card.next_action_commitment_pack, {
          title: '这次承诺型下一步'
        })}
        ${renderLeadMultiChannelFollowupPack(card.multi_channel_followup_pack, {
          title: '这次多渠道跟进包'
        })}
        ${promptLearning ? renderLeadPromptLearningCard(promptLearning, {
          title: '这次为什么继续沿当前话术',
          badge: 'Prompt 学习'
        }) : ''}
      </div>
    </div>
  `;
}

function renderLeadWeeklyReview(review) {
  if (!review) return '';
  const sources = asArray(review.source_effectiveness).slice(0, 3);
  const scripts = asArray(review.script_effectiveness).slice(0, 3);
  const microScripts = asArray(review.micro_script_effectiveness).slice(0, 3);
  const leadTypes = asArray(review.lead_type_effectiveness).slice(0, 3);
  const promptLearning = review.prompt_learning || null;
  return `
    <div class="lead-run-weekly-review">
      <div>
        <span class="chip success">轻量周复盘</span>
        <strong>${escapeHtml(review.summary || '已生成轻量复盘。')}</strong>
        <p class="muted">${escapeHtml(review.next_action || '')}</p>
      </div>
      <div class="weekly-review-grid">
        ${renderWeeklyReviewColumn('哪个来源有效', sources)}
        ${renderWeeklyReviewColumn('哪种话术有效', scripts.map((item) => ({
          name: item.title,
          positive: item.positive,
          touched: item.touched,
          recommendation: item.recommendation,
          examples: item.evidence
        })))}
        ${renderWeeklyReviewColumn('哪类微话术有效', microScripts.map((item) => ({
          name: item.route_label || item.route_type,
          positive: item.aligned,
          touched: item.touched,
          recommendation: item.recommendation,
          examples: item.examples
        })))}
        ${renderWeeklyReviewColumn('哪类线索有效', leadTypes)}
        ${renderLeadPromptLearningCard(promptLearning, {
          title: '下一轮保留哪版 Prompt',
          badge: 'Prompt 学习',
          emptyCopy: '当前还没有形成可带入下一轮的话术学习依据。'
        })}
      </div>
      <div class="next-batch-checklist">
        ${asArray(review.decisions).map((decision) => `<p>· ${escapeHtml(decision)}</p>`).join('')}
      </div>
    </div>
  `;
}

function renderLeadNextLoopPlan(plan) {
  if (!plan) return '';
  const actions = asArray(plan.collection_actions).slice(0, 3);
  const gates = asArray(plan.quality_gate).slice(0, 4);
  const keywords = asArray(plan.keywords).slice(0, 6);
  const focus = plan.micro_script_focus || {};
  const weakRouteAction = plan.weak_route_action;
  const routeLearning = plan.route_learning || null;
  const promptLearning = plan.prompt_learning || null;
  return `
    <div class="lead-run-next-loop-plan">
      <div>
        <span class="chip success">下一轮获客行动</span>
        <strong>${escapeHtml(plan.summary || '已生成下一轮行动计划。')}</strong>
        <p class="muted">${escapeHtml(plan.next_action || '')}</p>
        <div class="keyword-list compact">
          ${keywords.map((keyword) => `<code>${escapeHtml(keyword)}</code>`).join('')}
          ${focus.best_route?.route_label ? `<code>优先：${escapeHtml(focus.best_route.route_label)}</code>` : ''}
          ${focus.weak_route?.route_label ? `<code>复盘：${escapeHtml(focus.weak_route.route_label)}</code>` : ''}
        </div>
      </div>
      <div class="weekly-review-grid">
        ${focus.best_route?.route_label || focus.weak_route?.route_label ? `
          <article class="mini-card">
            <strong>微话术优先级</strong>
            ${focus.best_route?.route_label ? `<p>继续排前：${escapeHtml(focus.best_route.route_label)} · 匹配 ${escapeHtml(String(focus.best_route.aligned || 0))}/${escapeHtml(String(focus.best_route.touched || 0))}</p>` : ''}
            ${focus.weak_route?.route_label ? `
              <p>先复盘：${escapeHtml(focus.weak_route.route_label)} · 偏离 ${escapeHtml(String(focus.weak_route.off_route || 0))}/${escapeHtml(String(focus.weak_route.touched || 0))}</p>
              ${weakRouteAction ? `
                <p class="muted"><small>${escapeHtml(weakRouteAction.reason || '检测到此路由需要优化。')}</small></p>
                <button class="button ghost" data-lead-run-action="script-refresh" data-weak-route-type="${escapeHtml(focus.weak_route.route_type || '')}" title="${escapeHtml(weakRouteAction.reason || '')}">
                  ${escapeHtml(weakRouteAction.action_label || '刷新脚本确认点')}
                </button>
              ` : `<button class="button ghost" data-lead-run-action="script-refresh" data-weak-route-type="${escapeHtml(focus.weak_route.route_type || '')}">刷新脚本确认点</button>`}
            ` : ''}
            <small>${escapeHtml(focus.queue_hint || '')}</small>
          </article>
        ` : ''}
        ${renderLeadRouteLearningCard(routeLearning, {
          title: '下次生成优先纠正',
          badge: '下一轮学习',
          emptyCopy: '下一轮行动会在这里说明该沿哪种路由表达继续生成。'
        })}
        ${renderLeadPromptLearningCard(promptLearning, {
          title: '下次生成保留什么',
          badge: 'Prompt 学习',
          emptyCopy: '下一轮行动会在这里说明该保留哪版 prompt 和记忆线索。'
        })}
        ${actions.map((action) => `
          <article class="mini-card">
            <strong>${escapeHtml(action.title || '下一步')}</strong>
            <p>${escapeHtml(action.instruction || '')}</p>
            <small>验收：${escapeHtml(action.acceptance || '')}</small>
            ${action.action ? `<button class="button ghost" data-lead-run-action="${escapeHtml(action.action)}">去执行</button>` : ''}
          </article>
        `).join('')}
      </div>
      <div class="next-batch-checklist">
        ${gates.map((gate) => `<small>验收：${escapeHtml(gate)}</small>`).join('')}
      </div>
    </div>
  `;
}

function renderLeadRouteLearningCard(routeLearning, options = {}) {
  const title = options.title || '话术学习';
  const badge = options.badge || '学习';
  const emptyCopy = options.emptyCopy || '当前还没有足够的路由学习结果。';
  if (!routeLearning) {
    return `
      <article class="mini-card route-learning-card">
        <span class="chip info">${escapeHtml(badge)}</span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(emptyCopy)}</p>
      </article>
    `;
  }
  const notes = asArray(routeLearning.adjustment_notes).slice(0, 3);
  const evidence = asArray(routeLearning.evidence).slice(0, 3);
  return `
    <article class="mini-card route-learning-card">
      <span class="chip ${routeLearning.status === 'needs_correction' ? 'warning' : 'success'}">${escapeHtml(badge)}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(routeLearning.summary || routeLearning.next_generation_hint || '')}</p>
      <div class="keyword-list compact">
        ${routeLearning.weak_route?.route_label ? `<code>复盘 ${escapeHtml(routeLearning.weak_route.route_label)}</code>` : ''}
        ${routeLearning.best_route?.route_label ? `<code>保留 ${escapeHtml(routeLearning.best_route.route_label)}</code>` : ''}
        ${routeLearning.prompt_learning_phase ? `<code>Prompt ${escapeHtml(leadPromptPhaseLabel(routeLearning.prompt_learning_phase))}</code>` : ''}
      </div>
      ${routeLearning.correction_focus ? `<small>${escapeHtml(routeLearning.correction_focus)}</small>` : ''}
      ${notes.length ? `<div class="route-learning-list">${notes.map((item) => `<small>· ${escapeHtml(item)}</small>`).join('')}</div>` : ''}
      ${evidence.length ? `<div class="route-learning-list">${evidence.map((item) => `<small>${escapeHtml(item)}</small>`).join('')}</div>` : ''}
      ${routeLearning.next_generation_hint ? `<small>${escapeHtml(routeLearning.next_generation_hint)}</small>` : ''}
    </article>
  `;
}

function renderLeadPromptLearningCard(promptLearning, options = {}) {
  const title = options.title || 'Prompt 学习';
  const badge = options.badge || 'Prompt';
  const emptyCopy = options.emptyCopy || '当前还没有可带入下一轮的 prompt 学习结果。';
  if (!promptLearning) {
    return `
      <article class="mini-card route-learning-card">
        <span class="chip info">${escapeHtml(badge)}</span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(emptyCopy)}</p>
      </article>
    `;
  }
  const rules = asArray(promptLearning.carryover_rules).slice(0, 3);
  const memories = asArray(promptLearning.top_memories).slice(0, 3);
  const promptPromotion = promptLearning.prompt_promotion || null;
  const chips = [
    promptLearning.prompt_learning_phase ? `Prompt ${leadPromptPhaseLabel(promptLearning.prompt_learning_phase)}` : '',
    promptLearning.prompt_version_hash ? `版本 ${truncateText(promptLearning.prompt_version_hash, 16)}` : '',
    leadSampleConfidenceChip(promptLearning.sample_count),
    promptLearning.focus_variant?.label ? `复用 ${promptLearning.focus_variant.label}` : '',
    promptPromotion?.status === 'ready_to_promote' ? '可升版' : '',
    promptPromotion?.status === 'promoted' ? '已升版' : ''
  ].filter(Boolean);
  const meta = leadPromptMeta(promptLearning);
  return `
    <article class="mini-card route-learning-card">
      <span class="chip success">${escapeHtml(badge)}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(promptLearning.summary || promptLearning.next_action || '')}</p>
      ${chips.length ? `<div class="keyword-list compact">${chips.map((chip) => `<code>${escapeHtml(chip)}</code>`).join('')}</div>` : ''}
      ${rules.length ? `<div class="route-learning-list">${rules.map((item) => `<small>· ${escapeHtml(item)}</small>`).join('')}</div>` : ''}
      ${memories.length ? `<div class="route-learning-list">${memories.map((item) => `<small>${escapeHtml(`${item.label || '记忆'}：${truncateText(item.content || '', 36)}`)}</small>`).join('')}</div>` : ''}
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ''}
      ${promptPromotion?.summary ? `<small>${escapeHtml(promptPromotion.summary)}</small>` : ''}
      ${promptLearning.next_action ? `<small>${escapeHtml(promptLearning.next_action)}</small>` : ''}
    </article>
  `;
}

function leadPromptMeta(promptLearning) {
  if (!promptLearning) return '';
  return [
    promptLearning.prompt_industry ? `版本适用：${promptLearning.prompt_industry}` : '',
    promptLearning.prompt_created_at ? `生成于 ${formatDateTime(promptLearning.prompt_created_at) || formatDate(promptLearning.prompt_created_at)}` : ''
  ].filter(Boolean).join(' · ');
}

function renderWeeklyReviewColumn(title, items) {
  return `
    <article class="mini-card">
      <strong>${escapeHtml(title)}</strong>
      <div class="action-stack compact-stack">
        ${items.length ? items.map((item) => `
          <div>
            <p>${escapeHtml(item.name || item.key || '未命名')}</p>
            <small>正向 ${escapeHtml(String(item.positive || 0))} / 触达 ${escapeHtml(String(item.touched || 0))} · ${escapeHtml(item.recommendation || '')}</small>
          </div>
        `).join('') : '<small>还没有足够回写结果。</small>'}
      </div>
    </article>
  `;
}

function renderLeadNextBatchPlan(plan) {
  const steps = asArray(plan.collection_steps).slice(0, 4);
  const brief = plan.next_batch_collection_brief || null;
  const keywords = asArray(brief?.collection_keywords || plan.collection_keywords || plan.keywords).slice(0, 6);
  const gates = asArray(plan.quality_gate).slice(0, 4);
  const memoryGuidance = plan.memory_guidance || null;
  const memoryItems = asArray(memoryGuidance?.memories).slice(0, 3);
  const feedbackPacket = plan.review_feedback_packet || null;
  const signalGuidance = plan.signal_guidance_snapshot || feedbackPacket?.signal_guidance_snapshot || plan.signal_guidance || null;
  const recalibrationPacket = plan.source_authority_recalibration_packet
    || signalGuidance?.source_authority_recalibration_packet
    || feedbackPacket?.source_authority_recalibration_packet
    || brief?.source_authority_recalibration_packet
    || null;
  const promptLearning = plan.prompt_learning || null;
  const preferredSources = asArray(signalGuidance?.preferred_sources).slice(0, 2);
  const queryClusters = asArray(signalGuidance?.query_clusters).slice(0, 2);
  const sourcePriorityReason = String(signalGuidance?.source_priority_reason || preferredSources[0]?.source_priority_reason || '').trim();
  const validatedSignals = asArray(signalGuidance?.validated_signals).slice(0, 3);
  const nextExperiments = asArray(plan.next_experiments || feedbackPacket?.next_experiments).slice(0, 2);
  const riskFlags = asArray(plan.risk_flags || feedbackPacket?.risk_flags).slice(0, 2);
  return `
    <article class="mini-card next-batch-plan-card">
      <strong>${escapeHtml(plan.summary || `下一批 ${plan.batch_size || ''} 条真实线索`)}</strong>
      <p>${escapeHtml(plan.target_profile || '')}</p>
      <small>${escapeHtml(plan.source || '')}</small>
      ${memoryItems.length ? `
        <div class="next-batch-memory-guidance">
          <span class="chip info">长期记忆指导下一批</span>
          <p>${escapeHtml(memoryGuidance.summary || '已根据历史有效信号调整下一批采集。')}</p>
          ${memoryItems.map((memory) => `
            <small>${escapeHtml(memoryTypeLabel(memory.memory_type))}：${escapeHtml(truncateText(memory.content || '', 88))}</small>
          `).join('')}
        </div>
      ` : ''}
      ${signalGuidance ? `
        <div class="next-batch-memory-guidance">
          <span class="chip success">signal guidance</span>
          <p>${escapeHtml(signalGuidance.summary || '已根据已验证 signal 调整下一批采集。')}</p>
          ${leadPreferredSourceLine(preferredSources) ? `<small>${escapeHtml(leadPreferredSourceLine(preferredSources))}</small>` : ''}
          ${leadQueryClusterLine(queryClusters) ? `<small>${escapeHtml(leadQueryClusterLine(queryClusters))}</small>` : ''}
          ${leadSourcePriorityReasonLine(sourcePriorityReason) ? `<small>${escapeHtml(leadSourcePriorityReasonLine(sourcePriorityReason))}</small>` : ''}
          ${validatedSignals.length ? `<small>优先信号：${validatedSignals.map((item) => escapeHtml(item.signal || '')).filter(Boolean).join('、')}</small>` : ''}
        </div>
      ` : ''}
      ${feedbackPacket ? `
        <div class="next-batch-memory-guidance">
          <span class="chip info">复盘回流到下一批</span>
          <p>${escapeHtml(feedbackPacket.win_loss_brief?.summary || feedbackPacket.summary || '已把这轮结果带回下一批采集。')}</p>
          ${nextExperiments[0]?.instruction ? `<small>先测：${escapeHtml(nextExperiments[0].instruction)}</small>` : ''}
          ${riskFlags[0]?.label ? `<small>风险：${escapeHtml(riskFlags.map((item) => `${item.label}${item.action ? ` → ${item.action}` : ''}`).join('；'))}</small>` : ''}
        </div>
      ` : ''}
      ${renderLeadSourceAuthorityRecalibrationPacket(recalibrationPacket, {
        title: '下一批沿这个来源权重继续'
      })}
      ${renderLeadNextBatchCollectionBrief(brief, {
        title: '下一批采集 brief'
      })}
      ${renderLeadCallOutcomeProofPacket(plan.call_outcome_proof_packet || feedbackPacket?.call_outcome_proof_packet, {
        title: '下一批先吸收这通电话里的证明',
        compact: true
      })}
      ${renderLeadCallProofContinuityPacket(plan.call_proof_continuity_packet || feedbackPacket?.call_proof_continuity_packet, {
        title: '下一批别丢掉这通电话的续桥',
        compact: true
      })}
      ${renderLeadNextActionCommitmentPack(plan.next_action_commitment_pack, {
        title: '下一批承诺动作'
      })}
      ${renderLeadPromptLearningCard(promptLearning, {
        title: '导入后继续沿哪版 Prompt',
        badge: 'Prompt 学习',
        emptyCopy: '下一批导入后，这里会说明该继续沿用哪版 prompt。'
      })}
      <div class="keyword-list">
        ${keywords.map((keyword) => `<code>${escapeHtml(keyword)}</code>`).join('')}
      </div>
      <div class="next-batch-checklist">
        ${steps.map((step) => `<p>· ${escapeHtml(step)}</p>`).join('')}
      </div>
      <div class="next-batch-checklist">
        ${gates.map((gate) => `<small>验收：${escapeHtml(gate)}</small>`).join('')}
      </div>
      <small>导入格式：${escapeHtml(plan.import_format || '公司名，联系人，电话，需求描述')}</small>
    </article>
  `;
}

function renderLeadRunStageRail(currentStage) {
  const currentIndex = leadRunStages().findIndex((stage) => stage.id === currentStage);
  return leadRunStages().map((stage, index) => {
    const status = currentIndex < 0
      ? 'todo'
      : index < currentIndex
        ? 'done'
        : index === currentIndex
          ? 'doing'
          : 'todo';
    return `
      <article class="lead-run-stage ${status}">
        <span>${escapeHtml(stage.short)}</span>
        <strong>${escapeHtml(stage.label)}</strong>
      </article>
    `;
  }).join('');
}

function renderLeadRunLeadCard(lead) {
  const memoryMatch = lead.run_metadata?.memory_guidance_match || null;
  return `
    <article class="crm-handoff-item">
      <div>
        <span class="chip ${Number(lead.score_total || 0) >= 80 ? 'warning' : 'info'}">评分 ${escapeHtml(String(lead.score_total ?? '-'))}</span>
        ${memoryMatch?.matched ? `<span class="chip success">命中长期记忆 +${escapeHtml(String(memoryMatch.score || 0))}</span>` : ''}
        <strong>${escapeHtml(leadDisplayName(lead))}</strong>
        <p>${escapeHtml(lead.score_reason || lead.run_metadata?.recommendation_reason || lead.next_action || '等待跟进')}</p>
        ${memoryMatch?.matched ? `<small>${escapeHtml(asArray(memoryMatch.reasons).join('；') || '与历史有效信号相似')}</small>` : ''}
      </div>
      <button class="button secondary" data-next-command="${escapeHtml(`帮我跟进获客执行里的线索：${leadDisplayName(lead)}`)}" data-commander-template="crm_followup" data-prefill-json="${escapeHtml(JSON.stringify({ object_type: 'lead', object_id: lead.id || '', title: `跟进 ${leadDisplayName(lead)}`, priority: Number(lead.score_total || 0) >= 80 ? 'P1' : 'P2' }))}">安排跟进</button>
    </article>
  `;
}

function buildWorkbenchSummary() {
  const summary = state.data.workbench?.summary || {};
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  return [
    { label: '今日必须处理', value: buildMustDoItems().length, tone: 'warning' },
    { label: '高意向商机', value: buildHighIntentItems().length, tone: 'info' },
    { label: '待人工确认', value: buildUserConfirmationItems().length, tone: 'pending' },
    { label: '获客执行', value: run ? leadRunStageLabel(run.current_stage) : 0, tone: run ? 'info' : 'pending' },
    { label: '自动完成', value: buildAutoCompletedRecords().length || Number(summary.completed_tasks || 0), tone: 'success' }
  ];
}

function buildMustDoItems() {
  return [...state.data.tasks]
    .filter((task) => {
      const priority = String(task.priority || 'P2').toUpperCase();
      return priority === 'P0' || priority === 'P1' || isOverdue(task.due_at) || hoursUntil(task.due_at) <= 24;
    })
    .sort((a, b) => (rankTaskAction(b).score || 0) - (rankTaskAction(a).score || 0))
    .map((task) => ({
      kind: 'task',
      title: task.title || '今日任务',
      priority: task.priority || 'P2',
      meta: `${task.priority || 'P2'} · ${task.object_type || 'task'} · ${formatDate(task.due_at)}`,
      action: '记录结果',
      secondaryAction: '继续处理',
      taskId: task.id,
      command: `帮我继续处理这个跟进任务：${task.title || task.id}`,
      templateKey: 'crm_followup',
      prefill: {
        object_type: task.object_type || 'lead',
        object_id: task.object_id || '',
        title: task.title || '继续处理当前任务',
        priority: task.priority || 'P1'
      }
    }));
}

function buildHighIntentItems() {
  const candidates = state.data.workbench?.hot_leads?.length ? state.data.workbench.hot_leads : state.data.leads;
  return [...candidates]
    .filter((lead) => Number(lead.score_total || 0) >= 80 || String(lead.status || '').toLowerCase() === 'opportunity')
    .sort((a, b) => Number(b.score_total || 0) - Number(a.score_total || 0))
    .map((lead) => ({
      kind: 'lead',
      title: leadDisplayName(lead),
      meta: `评分 ${lead.score_total ?? '-'} · ${lead.status || 'lead'} · ${lead.next_action || '等待下一步'}`,
      action: '创建跟进',
      command: `帮我为 ${leadDisplayName(lead)} 创建一个高优先级跟进任务`,
      templateKey: 'crm_followup',
      prefill: {
        object_type: 'lead',
        object_id: lead.id || '',
        title: `优先跟进 ${leadDisplayName(lead)}`,
        priority: Number(lead.score_total || 0) >= 90 ? 'P0' : 'P1'
      }
    }));
}

function buildExceptionItems() {
  const items = state.data.tasks
    .filter((task) => String(task.status || '').toLowerCase().includes('failed') || isOverdue(task.due_at))
    .map((task) => ({
      kind: 'exception',
      title: task.title || '异常任务',
      meta: isOverdue(task.due_at) ? `已逾期 · ${formatDate(task.due_at)}` : `状态异常 · ${task.status || 'unknown'}`,
      action: '继续处理',
      command: `帮我处理这个异常任务：${task.title || task.id}`,
      templateKey: 'crm_followup',
      prefill: {
        object_type: task.object_type || 'lead',
        object_id: task.object_id || '',
        title: task.title || '处理异常任务',
        priority: 'P0'
      }
    }));

  const run = state.commander.lastRun;
  const plan = run?.plan || state.commander.lastPlan;
  const missingInputs = asArray(run?.missing_inputs || plan?.route?.missing_inputs);
  if (missingInputs.length) {
    items.unshift({
      kind: 'blocked',
      title: 'Commander 被缺字段阻断',
      meta: `还缺：${missingInputs.join(', ')}`,
      action: '立即补齐',
      command: $('#commander-goal')?.value || COMMANDER_TEMPLATES[state.commander.templateKey].goal,
      templateKey: state.commander.templateKey
    });
  }

  state.data.leads
    .filter((lead) => Number(lead.score_total || 0) >= 80 && !lead.next_action)
    .slice(0, 1)
    .forEach((lead) => {
      items.push({
        kind: 'missing',
        title: `高分线索缺下一步：${leadDisplayName(lead)}`,
        meta: `评分 ${lead.score_total ?? '-'} · 需要立即生成下一步动作`,
        action: '补一条跟进',
        command: `帮我为 ${leadDisplayName(lead)} 创建一个跟进任务`,
        templateKey: 'crm_followup',
        prefill: {
          object_type: 'lead',
          object_id: lead.id || '',
          title: `补充跟进 ${leadDisplayName(lead)}`,
          priority: 'P1'
        }
      });
    });

  return items;
}

function buildAutoCompletedRecords() {
  const records = [];
  state.data.completedTasks.slice(0, 3).forEach((task) => {
    records.push({
      title: `任务已完成：${task.title || task.id}`,
      copy: [
        task.completion_result ? readableTaskResult(task.completion_result) : `${task.priority || 'P2'} · ${task.object_type || 'task'}`,
        task.completion_reason || '',
        task.next_step_due_at ? `下一步 ${formatDate(task.next_step_due_at)}` : formatDate(task.updated_at || task.due_at)
      ].filter(Boolean).join(' · '),
      tone: 'success'
    });
  });
  buildAgentCompletedItems().slice(0, 3).forEach((item) => records.push(item));
  asArray(state.campaign.runner?.steps)
    .filter((step) => step.status === 'completed')
    .slice(0, 2)
    .forEach((step) => {
      records.push({
        title: `${step.label} 已自动完成`,
        copy: step.detail || '已进入下一步。',
        tone: 'success'
      });
    });
  return dedupeBy(records, (item) => `${item.title}|${item.copy}`);
}

function renderWorkbenchSummaryChip(item) {
  return `
    <article class="workbench-summary-chip">
      <span class="chip ${escapeHtml(item.tone || 'info')}">${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(String(item.value))}</strong>
    </article>
  `;
}

function renderFocusedWorkbenchTaskContext() {
  const taskId = state.ui.focusedWorkbenchTaskId;
  if (!taskId || currentHomePanel() !== 'today') return '';
  const task = state.data.tasks.find((item) => String(item.id || '') === String(taskId));
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const review = run?.repair_requeue_review || {};
  const context = state.ui.focusedWorkbenchTaskContext || {};
  const title = context.title || task?.title || '已修复入队的跟进任务';
  const leadName = context.leadName || review.lead_name || task?.object_id || '这条线索';
  const reason = context.reason || review.admission_reason || '补齐阻断信息后，已进入今天可处理队列。';
  const nextAction = context.nextAction || review.next_action || '现在可以记录结果、继续处理或直接呼叫。';
  const microScript = context.microScript || null;
  const writebackPreview = context.writebackPreview || findLeadRunWritebackPreviewForTask(run, taskId);
  return `
    <article class="workbench-focus-context span-2">
      <div>
        <span class="chip success">${microScript ? '下一步微话术' : '刚修复入队'}</span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(leadName)} · ${escapeHtml(reason)}</p>
        ${microScript ? renderLeadMicroScriptBrief(microScript) : ''}
        ${writebackPreview ? renderLeadWritebackPreviewBrief(writebackPreview, { compact: true }) : ''}
        <small>${escapeHtml(nextAction)}</small>
      </div>
      <span class="meta-pill">已定位到下方任务</span>
    </article>
  `;
}

function findLeadById(leadId) {
  if (!leadId) return null;
  return [
    ...asArray(state.data.activeLeadRun?.leads),
    ...asArray(state.commander.lastLeadRun?.leads),
    ...asArray(state.data.leads)
  ].find((lead) => String(lead.id || '') === String(leadId)) || null;
}

function leadForWorkbenchItem(item) {
  const objectId = item?.prefill?.object_id || '';
  const objectType = String(item?.prefill?.object_type || '').toLowerCase();
  if (objectType && objectType !== 'lead') return null;
  const lead = findLeadById(objectId);
  return lead?.contact_phone ? lead : null;
}

function callFocusedWorkbenchLead(button) {
  const lead = findLeadById(button.dataset.workbenchCallLead || '');
  if (!lead?.contact_phone) throw new Error('这条任务没有可呼叫号码');
  const run = state.data.activeLeadRun || state.commander.lastLeadRun || {};
  const context = state.ui.focusedWorkbenchTaskContext || {};
  preloadLeadRunCall(run, lead, {
    runId: run.id || '',
    leadId: lead.id || '',
    leadName: context.leadName || leadDisplayName(lead),
    phone: lead.contact_phone || '',
    taskId: button.dataset.taskId || state.ui.focusedWorkbenchTaskId || '',
    reason: context.reason || '这是 Today 当前聚焦的获客跟进任务。',
    nextAction: '先呼叫这条线索，通话结束后回写结果并接下一步。',
    writebackPreview: context.writebackPreview || findLeadRunWritebackPreviewForTask(run, button.dataset.taskId || state.ui.focusedWorkbenchTaskId || '')
  });
}

function renderWorkbenchActionCard(item) {
  const delayHours = suggestedTaskDelayHours(item.priority);
  const focused = isFocusedWorkbenchTask(item.taskId);
  const callLead = focused ? leadForWorkbenchItem(item) : null;
  const callButton = callLead
    ? `<button class="button secondary" data-workbench-call-lead="${escapeHtml(callLead.id || '')}" data-task-id="${escapeHtml(item.taskId || '')}">呼叫这条线索</button>`
    : '';
  const buttons = item.taskId
    ? `
        <div class="button-stack">
          <button class="button secondary" data-action="complete-task" data-task-id="${escapeHtml(item.taskId)}">记录结果</button>
          ${callButton}
          <button class="button ghost" data-action="delay-task" data-task-id="${escapeHtml(item.taskId)}" data-delay-hours="${escapeHtml(String(delayHours))}">${escapeHtml(taskDelayLabel(delayHours))}</button>
          <button class="button ghost" data-next-command="${escapeHtml(item.command)}" data-commander-template="${escapeHtml(item.templateKey)}" data-prefill-json="${escapeHtml(JSON.stringify(item.prefill || {}))}">${escapeHtml(item.secondaryAction || '继续处理')}</button>
        </div>
      `
    : `
        <button class="button secondary" data-next-command="${escapeHtml(item.command)}" data-commander-template="${escapeHtml(item.templateKey)}" data-prefill-json="${escapeHtml(JSON.stringify(item.prefill || {}))}">${escapeHtml(item.action || '交给 Commander')}</button>
      `;
  return `
    <article class="crm-handoff-item compact ${focused ? 'task-focus-card' : ''}" ${item.taskId ? `data-workbench-task-id="${escapeHtml(item.taskId)}"` : ''}>
      <div>
        <span class="chip info">${escapeHtml(item.kind || 'item')}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.meta || '')}</p>
        ${focused ? '<p class="task-focus-note">刚由修复入队产生，优先处理这一条。</p>' : ''}
      </div>
      ${buttons}
    </article>
  `;
}

function renderCallCenter() {
  const callCenter = state.data.callCenter || {};
  const summary = callCenter.summary || {};
  const activeCalls = asArray(callCenter.active_calls);
  const inboundQueue = asArray(callCenter.inbound_queue);
  const recentSessions = asArray(callCenter.recent_sessions);
  const selectedId = $('#call-session-id')?.value;
  const selectedSession = recentSessions.find((session) => session.id === selectedId)
    || activeCalls[0]
    || null;

  $('#call-center-updated').textContent = state.tenant
    ? `已同步 · 当前 ${Number(summary.active_calls || 0)} 通`
    : '等待开始';
  $('#call-center-summary').innerHTML = [
    { label: '当前通话', value: Number(summary.active_calls || 0), tone: 'info' },
    { label: '待接呼入', value: Number(summary.inbound_waiting || 0), tone: Number(summary.inbound_waiting || 0) ? 'warning' : 'success' },
    { label: '今日外呼', value: Number(summary.outbound_today || 0), tone: 'pending' },
    { label: '今日呼入', value: Number(summary.inbound_today || 0), tone: 'pending' },
    { label: '已完成', value: Number(summary.completed_calls || 0), tone: 'success' }
  ].map(renderWorkbenchSummaryChip).join('');

  renderCallLeadOptions();
  renderActiveCallCard(selectedSession);
  renderCallContextSurfaces();
  $('#inbound-queue').innerHTML = inboundQueue.length
    ? inboundQueue.map(renderInboundQueueItem).join('')
    : renderEmpty('暂无待接呼入；有来电时可先点“记录呼入”。');
  $('#call-history').innerHTML = recentSessions.length
    ? recentSessions.slice(0, 8).map(renderCallHistoryItem).join('')
    : renderEmpty('外呼或呼入记录会显示在这里。');
}

function renderCallLeadOptions() {
  const select = $('#call-lead-select');
  if (!select) return;
  const leads = dedupeBy([...asArray(state.data.activeLeadRun?.leads), ...asArray(state.data.leads)], (lead) => lead.id || lead.contact_phone || leadDisplayName(lead));
  select.innerHTML = [
    '<option value="">不关联线索，先直接拨</option>',
    ...leads.slice(0, 30).map((lead) => {
      const label = [leadDisplayName(lead), lead.contact_phone || '', lead.status || 'lead']
        .filter(Boolean)
        .join(' · ');
      return `<option value="${escapeHtml(lead.id)}" data-phone="${escapeHtml(lead.contact_phone || '')}">${escapeHtml(label)}</option>`;
    })
  ].join('');
  select.onchange = () => {
    const option = select.selectedOptions?.[0];
    const phone = option?.dataset?.phone || '';
    if (phone && !$('#call-phone').value.trim()) $('#call-phone').value = phone;
  };
}

function callSessionDirectionLabel(session) {
  const meta = session?.metadata || {};
  if (session?.direction === 'inbound') return '呼入来电';
  if (meta.lead_run_context_kind === 'ai_outbound_approved_draft' || meta.mode === 'ai_outbound') return 'AI 外呼';
  return '人工外呼';
}

function renderActiveCallCard(session) {
  const container = $('#active-call-card');
  if (!container) return;
  const dispositionForm = $('#call-disposition-form');
  if (!session) {
    container.innerHTML = renderEmpty('当前没有通话。你可以发起外呼，或从呼入队列接听一个来电。');
    $('#call-session-id').value = '';
    if (dispositionForm) dispositionForm.dataset.boundSessionId = '';
    resetCallWritebackQuickActions();
    return;
  }
  if (dispositionForm && dispositionForm.dataset.boundSessionId !== session.id) {
    dispositionForm.reset();
    dispositionForm.dataset.boundSessionId = session.id;
    const dispositionField = $('#call-disposition');
    if (dispositionField) dispositionField.dataset.autoDisposition = dispositionField.value;
    const summaryField = activeCallSummaryField();
    if (summaryField) summaryField.dataset.autoSummary = summaryField.value;
    const dueField = activeCallDueAtField();
    if (dueField) dueField.dataset.autoDueAt = dueField.value;
  }
  $('#call-session-id').value = session.id;
  const meta = session.metadata || {};
  container.innerHTML = `
    <article class="call-session-card active">
      <div>
        <span class="chip ${toneForCallStatus(session.status)}">${escapeHtml(callStatusLabel(session.status))}</span>
        <strong>${escapeHtml(callSessionDirectionLabel(session))}</strong>
        <p>${escapeHtml(meta.contact_name || meta.caller_name || session.lead_id || session.phone_redacted || session.id)}</p>
        <p class="muted">${escapeHtml(meta.intent || meta.script || meta.notes || '记录摘要后点击“结束并回写 CRM”。')}</p>
      </div>
      <button class="button ghost" data-call-action="select-call" data-call-session-id="${escapeHtml(session.id)}">正在处理</button>
    </article>
  `;
  syncActiveCallWritebackForm();
}

function renderInboundQueueItem(session) {
  const meta = session.metadata || {};
  const button = session.status === 'ringing' || session.status === 'queued'
    ? `<button class="button secondary" data-call-action="answer-call" data-call-session-id="${escapeHtml(session.id)}">接听</button>`
    : `<button class="button ghost" data-call-action="select-call" data-call-session-id="${escapeHtml(session.id)}">记录结果</button>`;
  return `
    <article class="call-session-card">
      <div>
        <span class="chip ${toneForCallStatus(session.status)}">${escapeHtml(callStatusLabel(session.status))}</span>
        <strong>${escapeHtml(meta.caller_name || session.phone_redacted || '未知来电')}</strong>
        <p>${escapeHtml(meta.intent || '等待接听')}</p>
      </div>
      ${button}
    </article>
  `;
}

function renderCallHistoryItem(session) {
  const meta = session.metadata || {};
  const subject = meta.contact_name || meta.caller_name || session.lead_id || session.phone_redacted || session.id;
  const action = ['queued', 'ringing', 'active'].includes(session.status)
    ? `<button class="button ghost" data-call-action="select-call" data-call-session-id="${escapeHtml(session.id)}">继续记录</button>`
    : '';
  return `
    <article class="call-session-card">
      <div>
        <span class="chip ${toneForCallStatus(session.status)}">${escapeHtml(callSessionDirectionLabel(session))} · ${escapeHtml(callStatusLabel(session.status))}</span>
        <strong>${escapeHtml(subject)}</strong>
        <p>${escapeHtml(meta.disposition ? callDispositionText(meta.disposition) : meta.summary || formatDate(session.created_at))}</p>
      </div>
      ${action}
    </article>
  `;
}

function toneForCallStatus(status) {
  if (status === 'active') return 'success';
  if (status === 'ringing' || status === 'queued') return 'warning';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  return 'info';
}

function callStatusLabel(status) {
  return {
    planned: '计划中',
    queued: '排队中',
    ringing: '振铃中',
    active: '通话中',
    completed: '已完成',
    failed: '未接通',
    cancelled: '已取消'
  }[status] || status || '未知';
}

function callDispositionText(disposition) {
  return {
    connected_booked: '已预约',
    connected_callback: '需回拨',
    connected_not_interested: '暂不考虑',
    transfer_required: '需升级处理',
    completed: '已接通',
    no_answer: '未接通，需重拨',
    invalid_number: '号码无效'
  }[disposition] || disposition || '已记录';
}

function renderWeeklyCampaign() {
  const campaign = buildWeeklyCampaign();
  $('#campaign-updated').textContent = state.tenant ? `已汇总 · ${campaign.steps.filter((step) => step.status === 'done').length}/${campaign.steps.length}` : '等待开始';
  $('#campaign-goal-title').textContent = campaign.goal;
  $('#campaign-goal-copy').textContent = campaign.copy;
  $('#campaign-metric-row').innerHTML = campaign.metrics
    .map(
      (item) => `
        <div class="campaign-metric">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(String(item.value))}</strong>
        </div>
      `
    )
    .join('');
  $('#campaign-runner-status').innerHTML = renderCampaignRunnerStatus(campaign.runner);
  $('#campaign-history-list').innerHTML = renderCampaignHistory();
  $('#campaign-timeline').innerHTML = campaign.steps.map(renderCampaignStep).join('');
}

function renderCustomerTimeline() {
  const events = buildCustomerTimeline().slice(0, 8);
  $('#timeline-updated').textContent = state.tenant ? `已聚合 · ${events.length} 个事件` : '等待开始';
  $('#customer-timeline-list').innerHTML = events.length
    ? events.map(renderCustomerTimelineEvent).join('')
    : renderEmpty('工作区就绪后，系统会把来源、咨询、线索、任务和 Agent 结果串成客户时间线。');
}

function buildCustomerTimeline() {
  const events = [];
  const sourceTag = state.sourceTag || state.data.sourceTags[0];
  const page = state.page || state.data.pages[0];
  const run = state.commander.lastRun;
  const leadRun = state.data.activeLeadRun || state.commander.lastLeadRun || null;

  if (leadRun) {
    events.push({
      type: 'run',
      title: `获客执行：${leadRun.goal || leadRun.id}`,
      copy: `${leadRunStageLabel(leadRun.current_stage)} · ${leadRun.summary || leadRun.next_recommended_action || '等待下一步'}`,
      action: leadRun.next_recommended_action || '继续推进',
      tone: 'success'
    });
  }

  if (sourceTag) {
    events.push({
      type: 'source',
      title: `来源已建立：${sourceTag.platform || '渠道'}`,
      copy: `入口 ${sourceTag.entry_point || '-'} · ${sourceTag.tracking_url || '可追踪链接'}`,
      action: '渠道已能追踪',
      tone: 'success'
    });
  }
  if (page) {
    events.push({
      type: 'landing',
      title: `落地页已上线：${page.title || page.slug}`,
      copy: page.headline || `/p/${page.slug}`,
      action: '可直接承接咨询',
      tone: 'success'
    });
  }
  state.data.inquiries.slice(0, 2).forEach((inquiry) => {
    events.push({
      type: 'inquiry',
      title: `收到咨询：${inquiry.contact_name || inquiry.contact_email || '未知客户'}`,
      copy: inquiry.message || inquiry.status || '等待筛选',
      action: '转入线索判断',
      tone: 'info'
    });
  });
  state.data.leads.slice(0, 2).forEach((lead) => {
    events.push({
      type: 'lead',
      title: `线索已评分：${leadDisplayName(lead)}`,
      copy: `评分 ${lead.score_total ?? '-'} · ${lead.status || 'lead'} · ${lead.next_action || '等待下一步'}`,
      action: Number(lead.score_total || 0) >= 80 ? '高意向优先跟进' : '进入正常跟进',
      tone: Number(lead.score_total || 0) >= 80 ? 'warning' : 'info'
    });
  });
  state.data.tasks.slice(0, 2).forEach((task) => {
    events.push({
      type: 'task',
      title: `跟进任务：${task.title || task.id}`,
      copy: `${task.priority || 'P2'} · ${task.status || 'open'} · ${formatDate(task.due_at)}`,
      action: isOverdue(task.due_at) ? '已逾期' : '等待处理',
      tone: isOverdue(task.due_at) ? 'warning' : 'pending'
    });
  });
  state.data.completedTasks.slice(0, 1).forEach((task) => {
    events.push({
      type: 'task-result',
      title: `任务结果：${task.title || task.id}`,
      copy: `${readableTaskResult(task.completion_result || 'completed')} · ${task.completion_reason || formatDate(task.updated_at)}`,
      action: task.next_step_type ? `${humanTaskStepLabel(task.next_step_type)}已承接` : '本次任务已收尾',
      tone: 'success'
    });
  });
  asArray(run?.artifacts).slice(0, 2).forEach((artifact) => {
    events.push({
      type: 'agent',
      title: `Agent 产物：${artifact.type || artifact.artifact_type}`,
      copy: artifact.status ? `状态 ${artifact.status}` : '已写入结果页和工作台',
      action: '可进入下一步',
      tone: 'success'
    });
  });
  if (!events.length && state.tenant) {
    events.push({
      type: 'start',
      title: '等待第一个获客动作',
      copy: '选择默认流程或运行 Commander 后，这里会自动形成客户时间线。',
      action: '建议先跑获客闭环',
      tone: 'info'
    });
  }
  return events;
}

function renderCustomerTimelineEvent(event) {
  return `
    <article class="timeline-event">
      <span class="timeline-type">${escapeHtml(event.type)}</span>
      <div>
        <strong>${escapeHtml(event.title)}</strong>
        <p>${escapeHtml(event.copy)}</p>
      </div>
      <span class="chip ${escapeHtml(event.tone)}">${escapeHtml(event.action)}</span>
    </article>
  `;
}

function buildWeeklyCampaign() {
  const persisted = state.campaign.snapshot || loadCampaignSnapshot();
  const leadRun = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  const goal = $('#commander-goal')?.value?.trim() || persisted?.goal || '本周多拿 10 个高质量咨询';
  const sourceTag = state.sourceTag || state.data.sourceTags[0] || {};
  const page = state.page || state.data.pages[0] || {};
  const bestChannel = state.data.weeklyReport?.best_channel || state.data.channels[0] || {};
  const leadCount = leadRun ? asArray(leadRun.leads).length : state.data.leads.length;
  const taskCount = leadRun ? asArray(leadRun.tasks).filter((task) => task.status === 'open').length : state.data.tasks.length;
  const submitRate = percent(state.data.funnel?.rates?.form_submit_rate ?? 0);
  const completedArtifacts = asArray(state.commander.lastRun?.artifacts).length;

  return {
    goal,
    copy: state.tenant
      ? '系统会把 Commander、获客主流程、CRM 承接和周报聚合成一个当前获客闭环，不要求用户理解每个 Agent。'
      : '开始后这里会显示当前目标、渠道、落地页、线索、跟进和下一步。',
    metrics: [
      { label: '线索', value: leadCount },
      { label: '待办', value: taskCount },
      { label: '提交率', value: submitRate },
      { label: '获客阶段', value: leadRun ? leadRunStageLabel(leadRun.current_stage) : completedArtifacts }
    ],
    steps: [
      {
        label: '目标',
        title: leadRun?.goal || goal,
        copy: leadRun ? leadRun.summary || '获客执行已建立。' : state.tenant ? '已进入工作区作用域，可以自动调度 Agent。' : '首次执行时会自动创建默认工作区。',
        status: state.tenant ? 'done' : 'todo'
      },
      {
        label: 'Offer',
        title: page.headline || '免费增长诊断',
        copy: page.subheadline || '用默认模板先承接高意向咨询，后续再优化 Offer。',
        status: page.headline ? 'done' : 'doing'
      },
      {
        label: '渠道',
        title: sourceTag.platform || bestChannel.platform || 'LinkedIn / 小红书 / Google SEO',
        copy: sourceTag.entry_point ? `入口：${sourceTag.entry_point}` : '系统会优先使用可追踪来源链接。',
        status: state.data.sourceTags.length || bestChannel.platform ? 'done' : 'doing'
      },
      {
        label: '落地页',
        title: page.title || '等待创建落地页',
        copy: page.slug ? `/p/${page.slug}` : '运行获客闭环后自动生成可访问页面。',
        status: page.slug ? 'done' : 'todo'
      },
      {
        label: '线索',
        title: leadCount ? `${leadCount} 条线索已进入 CRM` : '等待线索进入',
        copy: leadRun?.next_recommended_action || (leadCount ? '系统会按评分和下一步动作排序。' : '提交咨询或运行获客执行后自动生成。'),
        status: leadCount ? 'done' : 'todo'
      },
      {
        label: '跟进',
        title: taskCount ? `${taskCount} 个待处理动作` : '等待生成跟进任务',
        copy: taskCount ? '今日工作台会优先展示 P0/P1。' : 'Commander 可直接创建跟进任务。',
        status: taskCount ? 'done' : 'todo'
      },
      {
        label: '结果',
        title: state.data.weeklyReport ? '周报已生成' : '等待复盘',
        copy: state.data.weeklyReport?.recommendations?.[0] || '运行“帮我生成本周复盘”后自动汇总。',
        status: state.data.weeklyReport ? 'done' : 'todo'
      },
      {
        label: '下一步',
        title: leadRun?.next_recommended_action || buildNextActions()[0]?.title || '等待下一步建议',
        copy: leadRun?.computed_next_recommended_action || buildNextActions()[0]?.copy || '系统会把下一步放到今日最该做。',
        status: buildNextActions().length ? 'doing' : 'todo'
      }
    ],
    runner: state.campaign.runner || persisted?.runner || null
  };
}

function renderCampaignStep(step) {
  return `
    <article class="campaign-step ${escapeHtml(step.status)}">
      <span class="campaign-step-label">${escapeHtml(step.label)}</span>
      <div>
        <strong>${escapeHtml(step.title)}</strong>
        <p>${escapeHtml(step.copy)}</p>
      </div>
    </article>
  `;
}

function renderCampaignRunnerStatus(runner) {
  if (!runner) {
    return '<div class="command-help">点击“一键运行本周战役”后，系统会按默认流程连续执行稳定可用的 Commander 能力。</div>';
  }
  const items = asArray(runner.steps).map((step) => {
    const tone = step.status === 'completed' ? 'success' : step.status === 'blocked' ? 'warning' : 'pending';
    return renderCommanderNoteItem({
      title: step.label,
      copy: step.detail || step.status,
      tone
    });
  });
  return `
    <div class="campaign-runner-summary">
      <span class="chip ${runner.status === 'completed' ? 'success' : 'pending'}">${escapeHtml(runner.title || 'campaign')}</span>
      <span class="muted">开始于 ${escapeHtml(formatDate(runner.startedAt))}</span>
    </div>
    <div class="review-list">${items.join('')}</div>
  `;
}

function renderCampaignHistory() {
  if (!state.campaign.history.length) {
    return '<div class="command-help">战役版本会自动保存在服务端，这里显示最近几次可恢复版本。</div>';
  }
  return `
    <div class="campaign-history-header">
      <strong>最近战役版本</strong>
      <span class="muted">服务端 artifact</span>
    </div>
    <div class="action-stack">
      ${state.campaign.history
        .slice(0, 3)
        .map(
          (artifact) => `
            <article class="campaign-history-item">
              <div>
                <strong>${escapeHtml(artifact.payload?.goal || artifact.type)}</strong>
                <p>版本 ${escapeHtml(String(artifact.version || 1))} · ${escapeHtml(formatDate(artifact.updated_at || artifact.created_at))}</p>
              </div>
              <button class="button secondary" data-campaign-history-id="${escapeHtml(artifact.id)}">恢复这个版本</button>
            </article>
          `
        )
        .join('')}
    </div>
  `;
}

function buildNextActions() {
  const actions = [];
  const run = state.commander.lastRun;
  const plan = run?.plan || state.commander.lastPlan;
  const missingInputs = asArray(run?.missing_inputs || plan?.route?.missing_inputs);

  if (!state.tenant) {
    return [
      {
        priority: 'P0',
        title: '开始默认工作区并运行主流程',
        copy: '首次执行会自动创建工作区，后续 Commander 动作都能直接写入任务、线索和复盘。',
        command: '帮我跑一个默认获客流程',
        templateKey: 'growth_loop'
      }
    ];
  }

  const activeLeadRun = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (activeLeadRun) {
    actions.push({
      score: 150,
      title: `推进获客执行：${leadRunStageLabel(activeLeadRun.current_stage)}`,
      copy: activeLeadRun.next_recommended_action || activeLeadRun.computed_next_recommended_action || activeLeadRun.summary || '查看当前获客执行并处理下一步。',
      command: activeLeadRun.goal || $('#commander-goal')?.value || COMMANDER_TEMPLATES.lead_acquisition.goal,
      templateKey: 'lead_acquisition',
      rankReason: '当前主线对象已经形成，优先推进线索、话术、跟进和结果回写'
    });
  }

  if (missingInputs.length) {
    actions.push({
      score: 160,
      title: '补齐 Commander 缺失上下文',
      copy: `还缺：${missingInputs.join(', ')}。补完即可继续自动执行。`,
      command: $('#commander-goal')?.value || COMMANDER_TEMPLATES[state.commander.templateKey].goal,
      templateKey: state.commander.templateKey,
      rankReason: '缺关键字段会直接阻断自动执行'
    });
  }

  state.data.tasks.slice(0, 6).forEach((task) => {
    const ranked = rankTaskAction(task);
    actions.push({
      score: ranked.score,
      title: task.title || '处理高优先级任务',
      copy: `${task.object_type || 'task'} · ${task.status || 'open'} · ${formatDate(task.due_at)}`,
      taskId: task.id,
      command: `帮我处理这个跟进任务：${task.title || task.id}`,
      templateKey: 'crm_followup',
      prefill: {
        object_type: task.object_type || 'lead',
        object_id: task.object_id || '',
        title: task.title || '跟进当前任务',
        priority: task.priority || 'P1'
      },
      rankReason: ranked.reason
    });
  });

  const rankedLeads = [...state.data.leads]
    .map((lead) => ({ lead, ranked: rankLeadAction(lead) }))
    .sort((a, b) => b.ranked.score - a.ranked.score);
  rankedLeads.slice(0, 2).forEach(({ lead, ranked }) => {
    actions.push({
      score: ranked.score,
      title: `跟进高意向线索：${leadDisplayName(lead)}`,
      copy: `评分 ${lead.score_total ?? '-'} · ${lead.next_action || '建议今天跟进'}`,
      command: `帮我为 ${leadDisplayName(lead)} 创建一个跟进任务`,
      templateKey: 'crm_followup',
      prefill: {
        object_type: 'lead',
        object_id: lead.id || '',
        title: `跟进 ${leadDisplayName(lead)}`,
        priority: Number(lead.score_total || 0) >= 80 ? 'P1' : 'P2'
      },
      rankReason: ranked.reason
    });
  });

  if (state.data.weeklyReport?.recommendations?.[0]) {
    actions.push({
      score: 82,
      title: '执行本周复盘建议',
      copy: state.data.weeklyReport.recommendations[0],
      command: '帮我根据本周复盘安排下一步获客跟进',
      templateKey: 'weekly_review',
      rankReason: '复盘已经识别出可执行的改进方向'
    });
  }

  if (!state.data.leads.length && !state.data.inquiries.length) {
    actions.push({
      score: 74,
      title: '先跑一个获客闭环',
      copy: '自动创建渠道、落地页、咨询、线索和复盘数据，用于后续真实工作台承接。',
      command: '帮我跑一个默认获客流程',
      templateKey: 'growth_loop',
      rankReason: '当前还没有线索与咨询，先补全最小业务闭环'
    });
  }

  actions.push({
    score: 52,
    title: '生成今日复盘和下一步建议',
    copy: '把渠道、线索、任务和咨询汇总成可执行的下一步。',
    command: '帮我生成本周复盘',
    templateKey: 'weekly_review',
    rankReason: '保持本周目标和当前执行状态同步'
  });

  return dedupeActions(actions)
    .map((action) => ({
      ...action,
      priority: action.priority || priorityFromScore(action.score || 0)
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function buildAgentCompletedItems() {
  const items = [];
  const run = state.commander.lastRun;
  const activeLeadRun = state.data.activeLeadRun || state.commander.lastLeadRun || null;
  if (activeLeadRun) {
    items.push({
      title: '获客执行已建立',
      copy: `${leadRunStageLabel(activeLeadRun.current_stage)} · ${asArray(activeLeadRun.leads).length} 条线索 · ${asArray(activeLeadRun.tasks).length} 个任务`,
      tone: 'success'
    });
    if (activeLeadRun.script) {
      items.push({
        title: '跟进话术已生成',
        copy: '话术已写回获客执行，可用于人工外呼或今日跟进。',
        tone: 'success'
      });
    }
  }
  asArray(run?.artifacts).forEach((artifact) => {
    items.push({
      title: artifact.type || artifact.artifact_type || 'Agent 产物',
      copy: artifact.status ? `已生成，状态：${artifact.status}` : 'Commander 已自动生成该结果。',
      tone: 'success'
    });
  });
  if (state.data.weeklyReport) {
    items.push({
      title: '本周复盘已可用',
      copy: `建议 ${asArray(state.data.weeklyReport.recommendations).length} 条，提醒 ${asArray(state.data.weeklyReport.warnings).length} 条。`,
      tone: 'success'
    });
  }
  if (state.data.pages.length) {
    items.push({
      title: '落地页已准备',
      copy: `${state.data.pages.length} 个页面可直接承接流量。`,
      tone: 'success'
    });
  }
  if (state.data.sourceTags.length) {
    items.push({
      title: '来源追踪已准备',
      copy: `${state.data.sourceTags.length} 个来源链接可用于渠道分发。`,
      tone: 'success'
    });
  }
  return items;
}

function buildUserConfirmationItems() {
  const run = state.commander.lastRun;
  const plan = run?.plan || state.commander.lastPlan;
  const missingInputs = asArray(run?.missing_inputs || plan?.route?.missing_inputs);
  const items = buildCommanderConfirmItems(plan, run, missingInputs);

  state.data.tasks
    .filter((task) => String(task.status || '').toLowerCase().includes('failed') || isOverdue(task.due_at))
    .slice(0, 3)
    .forEach((task) => {
      items.push({
        title: task.title || '异常任务',
        copy: isOverdue(task.due_at) ? `已逾期：${formatDate(task.due_at)}` : `状态异常：${task.status}`,
        tone: 'warning'
      });
    });

  return items;
}

function buildCrmHandoffItems() {
  const items = [];
  state.data.tasks.slice(0, 2).forEach((task) => {
    items.push({
      kind: 'task',
      title: task.title || '待处理任务',
      priority: task.priority || 'P2',
      meta: `${task.priority || 'P2'} · ${task.object_type || 'task'} · ${formatDate(task.due_at)}`,
      action: '记录结果',
      taskId: task.id,
      command: `帮我处理这个跟进任务：${task.title || task.id}`,
      templateKey: 'crm_followup',
      prefill: {
        object_type: task.object_type || 'lead',
        object_id: task.object_id || '',
        title: task.title || '跟进当前任务',
        priority: task.priority || 'P1'
      }
    });
  });
  state.data.leads.slice(0, 2).forEach((lead) => {
    items.push({
      kind: 'lead',
      title: leadDisplayName(lead),
      meta: `评分 ${lead.score_total ?? '-'} · ${lead.status || 'lead'} · ${lead.next_action || '等待下一步'}`,
      action: '安排跟进',
      command: `帮我为 ${leadDisplayName(lead)} 创建一个跟进任务`,
      templateKey: 'crm_followup',
      prefill: {
        object_type: 'lead',
        object_id: lead.id || '',
        title: `跟进 ${leadDisplayName(lead)}`,
        priority: Number(lead.score_total || 0) >= 80 ? 'P1' : 'P2'
      }
    });
  });
  state.data.inquiries.slice(0, 1).forEach((inquiry) => {
    items.push({
      kind: 'inquiry',
      title: inquiry.contact_name || inquiry.contact_email || '最新咨询',
      meta: `${inquiry.status || 'new'} · ${inquiry.message || '等待筛选'}`,
      action: '转成跟进',
      command: `帮我为 ${inquiry.contact_name || inquiry.contact_email || '这个咨询'} 创建一个跟进任务`,
      templateKey: 'crm_followup',
      prefill: {
        object_type: 'inquiry',
        object_id: inquiry.id || '',
        title: `跟进 ${inquiry.contact_name || inquiry.contact_email || '最新咨询'}`,
        priority: 'P1'
      }
    });
  });
  return items;
}

function renderNextActionCard(action) {
  const delayHours = suggestedTaskDelayHours(action.priority);
  const button = action.taskId
    ? `
        <div class="button-stack">
          <button class="button secondary" data-action="complete-task" data-task-id="${escapeHtml(action.taskId)}">记录结果</button>
          <button class="button ghost" data-action="delay-task" data-task-id="${escapeHtml(action.taskId)}" data-delay-hours="${escapeHtml(String(delayHours))}">${escapeHtml(taskDelayLabel(delayHours))}</button>
          <button class="button ghost" data-next-command="${escapeHtml(action.command)}" data-commander-template="${escapeHtml(action.templateKey)}" data-prefill-json="${escapeHtml(JSON.stringify(action.prefill || {}))}">继续处理</button>
        </div>
      `
    : `<button class="button secondary" data-next-command="${escapeHtml(action.command)}" data-commander-template="${escapeHtml(action.templateKey)}" data-prefill-json="${escapeHtml(JSON.stringify(action.prefill || {}))}">交给 Commander</button>`;
  return `
    <article class="next-action-item">
      <div>
        <div class="task-head">
          <span class="pill pill-${escapeHtml(String(action.priority || 'P2').toLowerCase())}">${escapeHtml(action.priority || 'P2')}</span>
          <span class="muted">next best action</span>
        </div>
        <strong>${escapeHtml(action.title)}</strong>
        <p>${escapeHtml(action.copy)}</p>
        ${action.rankReason ? `<div class="inline-rank-reason">${escapeHtml(action.rankReason)}</div>` : ''}
      </div>
      ${button}
    </article>
  `;
}

function renderCrmHandoffCard(item) {
  const delayHours = suggestedTaskDelayHours(item.priority);
  const focused = isFocusedWorkbenchTask(item.taskId);
  const button = item.taskId
    ? `
        <div class="button-stack">
          <button class="button secondary" data-action="complete-task" data-task-id="${escapeHtml(item.taskId)}">${escapeHtml(item.action)}</button>
          <button class="button ghost" data-action="delay-task" data-task-id="${escapeHtml(item.taskId)}" data-delay-hours="${escapeHtml(String(delayHours))}">${escapeHtml(taskDelayLabel(delayHours))}</button>
          <button class="button ghost" data-next-command="${escapeHtml(item.command)}" data-commander-template="${escapeHtml(item.templateKey)}" data-prefill-json="${escapeHtml(JSON.stringify(item.prefill || {}))}">继续处理</button>
       </div>
      `
    : `<button class="button secondary" data-next-command="${escapeHtml(item.command)}" data-commander-template="${escapeHtml(item.templateKey)}" data-prefill-json="${escapeHtml(JSON.stringify(item.prefill || {}))}">${escapeHtml(item.action)}</button>`;
  return `
    <article class="crm-handoff-item ${focused ? 'task-focus-card' : ''}" ${item.taskId ? `data-workbench-task-id="${escapeHtml(item.taskId)}"` : ''}>
      <div>
        <span class="chip info">${escapeHtml(item.kind)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.meta)}</p>
        ${focused ? '<p class="task-focus-note">当前正在聚焦这条新入队任务。</p>' : ''}
      </div>
      ${button}
    </article>
  `;
}

function renderAdminOps(ops, p1) {
  const components = ops?.components || {};
  const p1Summary = p1 || {};
  const focusItems = [
    ...(ops?.remediation_needed || []),
    ...collectP1Remediation(p1Summary)
  ].slice(0, 5);

  const kpis = [
    ['Pending approvals', components.approvals?.pending ?? 0, '等待人工确认的高风险动作'],
    ['Failed tool calls', components.audit?.failed_tool_calls ?? 0, '最近失败或异常的工具调用'],
    ['Sidecar count', components.sidecars?.sidecars?.length ?? 0, 'Go / Python / Rust sidecar readiness'],
    ['Geo pending', components.geo_routing?.pending_approvals ?? 0, 'geo routing 待处理审批'],
    ['Voice overflow', components.voice?.summary?.overflow_routing_snapshots ?? 0, '呼叫中心路由溢出快照'],
    ['Media due', components.media?.summary?.due_recording_count ?? 0, '到期录音留存处理项'],
    ['Recent artifacts', components.audit?.recent_artifacts ?? 0, '最近 agent artifact 数量'],
    ['Provider health', components.providers?.recent_health_snapshots ?? 0, '近期 provider health snapshot']
  ];
  $('#kpi-grid').innerHTML = kpis.map(([label, value, copy]) => renderKpi(label, value, copy)).join('');

  renderP1Summaries(p1Summary);
  renderP1Drilldowns(p1Summary);
  renderOpsDomainPanels(components);
  $('#remediation-list').innerHTML = focusItems.length
    ? focusItems.map(renderReviewItem).join('')
    : renderEmpty('当前没有 remediation item。');
}

function renderP1Summaries(p1) {
  const provider = p1.provider_routing || {};
  const crm = p1.crm_sync_mapping || {};
  const billing = p1.billing_quota || {};
  const knowledge = p1.notebook_knowledge || {};
  const quality = p1.quality_contracts || {};

  $('#provider-summary').innerHTML = renderMetricStack([
    ['Readiness', provider.readiness_status || 'not_configured'],
    ['Configured integrations', provider.summary?.configured_integrations ?? 0],
    ['Active policies', provider.policy_coverage?.active_policy_count ?? 0],
    ['Estimated model cost', money(provider.summary?.estimated_model_cost ?? 0)]
  ]);
  $('#crm-summary').innerHTML = renderMetricStack([
    ['Readiness', crm.readiness_status || 'not_configured'],
    ['Leads', crm.summary?.lead_count ?? 0],
    ['High priority tasks', crm.summary?.high_priority_open_task_count ?? 0],
    ['Missing contact keys', crm.summary?.missing_contact_key_count ?? 0]
  ]);
  $('#billing-summary').innerHTML = renderMetricStack([
    ['Readiness', billing.readiness_status || 'not_configured'],
    ['Quota limits', billing.summary?.quota_limit_count ?? 0],
    ['Warning quotas', billing.summary?.warning_quota_count ?? 0],
    ['Estimated cost', money(billing.summary?.estimated_model_cost ?? 0)]
  ]);
  $('#knowledge-summary').innerHTML = renderMetricStack([
    ['Readiness', knowledge.readiness_status || 'not_configured'],
    ['Active notebooks', knowledge.summary?.active_notebooks ?? 0],
    ['Knowledge sources', knowledge.summary?.knowledge_source_count ?? 0],
    ['Ungrounded pages', knowledge.summary?.ungrounded_wiki_pages ?? 0]
  ]);
  $('#quality-summary').innerHTML = renderMetricStack([
    ['Readiness', quality.readiness_status || 'not_configured'],
    ['Registered tools', quality.summary?.registered_tool_count ?? 0],
    ['Contract coverage', percent(quality.summary?.tool_contract_coverage ?? 0)],
    ['Failed calls', quality.summary?.failed_or_denied_tool_calls ?? 0]
  ]);
}

function renderP1Drilldowns(p1) {
  renderProviderMatrix(p1.provider_routing || {});
  renderCrmMappingPanel(p1.crm_sync_mapping || {});
  renderKnowledgeGroundingPanel(p1.notebook_knowledge || {});
  renderQuotaMeters(p1.billing_quota || {});
  renderQualityContractPanel(p1.quality_contracts || {});
}

function renderProviderMatrix(provider) {
  const integrations = provider.configured_integrations || [];
  const modelConfigs = provider.model_configs || [];
  const health = provider.latest_provider_health || [];
  const rows = [
    ...integrations.map((item) => ({
      type: 'Integration',
      name: item.integration_id,
      status: item.health_status || item.status,
      detail: item.last_checked_at ? `checked ${formatDate(item.last_checked_at)}` : item.updated_at ? `updated ${formatDate(item.updated_at)}` : '-'
    })),
    ...modelConfigs.map((item) => ({
      type: 'Model',
      name: `${item.provider}/${item.model}`,
      status: item.status,
      detail: item.purpose || 'default'
    })),
    ...health.map((item) => ({
      type: 'Health',
      name: item.integration_id,
      status: item.status,
      detail: item.summary || item.category || '-'
    }))
  ].slice(0, 10);

  $('#provider-matrix').innerHTML = rows.length
    ? renderMiniTable(
        ['Type', 'Name', 'Status', 'Detail'],
        rows.map((row) => [
          row.type,
          row.name,
          renderStatusChip(row.status),
          row.detail
        ]),
        true
      )
    : renderEmpty('还没有 provider integration、model config 或 health snapshot。');
}

function renderCrmMappingPanel(crm) {
  const rows = (crm.field_mapping_template || []).map((field) => [
    field.opc_field,
    asArray(field.source_columns).join(', '),
    field.required ? renderStatusChip('required') : renderStatusChip('optional'),
    field.required ? '必须映射后才能稳定同步' : '可按业务成熟度补充'
  ]);
  $('#crm-mapping-table').innerHTML = rows.length
    ? renderMiniTable(['OPC Field', 'Source Columns', 'Required', 'Rule'], rows, true)
    : renderEmpty('还没有 CRM mapping template。');
}

function renderKnowledgeGroundingPanel(knowledge) {
  const providerCoverage = knowledge.provider_coverage || {};
  const rows = [
    ['Active notebooks', knowledge.summary?.active_notebooks ?? 0],
    ['Knowledge sources', knowledge.summary?.knowledge_source_count ?? 0],
    ['Wiki pages', knowledge.summary?.wiki_page_count ?? 0],
    ['Ungrounded pages', knowledge.summary?.ungrounded_wiki_pages ?? 0],
    ['Search providers', asArray(providerCoverage.search_providers).join(', ') || '-'],
    ['Notebook providers', asArray(providerCoverage.notebook_providers).join(', ') || '-']
  ];
  const remediation = knowledge.remediation?.length
    ? `<div class="chip-row">${knowledge.remediation.map((item) => renderStatusChip(item.severity || 'review', readableAction(item.action))).join('')}</div>`
    : '<p class="muted">当前没有 grounding remediation。</p>';
  $('#knowledge-grounding-panel').innerHTML = `${renderMetricStack(rows)}${remediation}`;
}

function renderQuotaMeters(billing) {
  const usage = billing.quota_usage || [];
  if (!usage.length) {
    $('#quota-meters').innerHTML = renderEmpty('还没有 quota limit；后续可从 billing 设置创建默认额度。');
    return;
  }
  $('#quota-meters').innerHTML = usage.map(renderQuotaMeter).join('');
}

function renderQuotaMeter(item) {
  const used = Number(item.used ?? item.amount ?? 0);
  const hard = Number(item.hard_limit ?? item.limit ?? 0);
  const soft = Number(item.soft_limit ?? 0);
  const pct = hard > 0 ? Math.min(100, Math.round((used / hard) * 100)) : 0;
  const tone = item.status === 'blocked' ? 'danger' : item.status === 'warning' ? 'warning' : '';
  return `
    <article class="quota-meter">
      <div class="meter-head">
        <strong>${escapeHtml(item.quota_key || 'quota')}</strong>
        ${renderStatusChip(item.status || 'ok')}
      </div>
      <div class="meter-track"><div class="meter-fill ${tone}" style="width:${pct}%"></div></div>
      <div class="meter-meta">
        <span>${escapeHtml(String(used))} used</span>
        <span>soft ${escapeHtml(String(soft))} / hard ${escapeHtml(String(hard || '∞'))}</span>
      </div>
    </article>
  `;
}

function renderQualityContractPanel(quality) {
  const coverage = quality.contract_coverage || {};
  const rows = [
    ['Tools with schemas', coverage.tools_with_input_output_schema ?? 0],
    ['Side-effect tools', coverage.side_effect_tools ?? 0],
    ['Approval tools', coverage.approval_required_tools ?? 0],
    ['Missing contracts', asArray(coverage.missing_contract_tools).length]
  ];
  const missing = asArray(coverage.missing_contract_tools).slice(0, 6);
  const missingHtml = missing.length
    ? `<div class="chip-row">${missing.map((toolId) => renderStatusChip('review', toolId)).join('')}</div>`
    : '<p class="muted">当前没有明显 contract 缺口。</p>';
  $('#quality-contract-panel').innerHTML = `${renderMetricStack(rows)}${missingHtml}`;
}

function renderOpsDomainPanels(components) {
  const voice = components.voice?.summary || {};
  const media = components.media?.summary || {};
  const geo = components.geo_routing || {};
  const sidecars = components.sidecars?.sidecars || [];
  $('#callcenter-panel').innerHTML = renderMetricStack([
    ['Agents', voice.agent_count ?? 0],
    ['Active agents', voice.active_agent_count ?? 0],
    ['Skill queues', voice.skill_queue_count ?? 0],
    ['Overflow snapshots', voice.overflow_routing_snapshots ?? 0]
  ]);
  $('#media-panel').innerHTML = renderMetricStack([
    ['Policies', media.storage_policy_count ?? 0],
    ['Recordings', media.recording_count ?? 0],
    ['Due recordings', media.due_recording_count ?? 0],
    ['Archive before delete', media.archive_before_delete_count ?? 0]
  ]);
  $('#geo-panel').innerHTML = renderMetricStack([
    ['Policies', geo.policy_count ?? 0],
    ['Pending approvals', geo.pending_approvals ?? 0],
    ['Recent history', geo.recent_action_history ?? 0],
    ['Blocked actions', geo.blocked_actions ?? 0]
  ]);
  $('#sidecar-panel').innerHTML = sidecars.length
    ? sidecars.map(renderSidecarItem).join('')
    : renderEmpty('还没有 sidecar readiness 数据。');
}

function renderSidecarItem(sidecar) {
  return `
    <article class="sidecar-item">
      <div>
        <strong>${escapeHtml(sidecar.sidecar_id || sidecar.name || 'sidecar')}</strong>
        <span>${escapeHtml(sidecar.runtime || sidecar.command || sidecar.url || 'runtime check')}</span>
      </div>
      ${renderStatusChip(sidecar.status || 'unknown')}
    </article>
  `;
}

function renderBusinessSummary(summary = {}, funnel = null) {
  if (!summary && !funnel) return;
  renderCommanderHome();
}

function renderTasks(tasks) {
  $('#task-list').innerHTML = tasks.length
    ? tasks
        .map(
          (task) => `
            <article class="task-item">
              <div>
                <div class="task-head">
                  <span class="pill pill-${escapeHtml(String(task.priority || 'P2').toLowerCase())}">${escapeHtml(task.priority || 'P2')}</span>
                  <span class="muted">${escapeHtml(formatDate(task.due_at))}</span>
                </div>
                <strong>${escapeHtml(task.title)}</strong>
                <div class="muted">${escapeHtml(task.object_type)} · ${escapeHtml(task.status)}</div>
              </div>
              <div class="button-stack">
                <button class="button secondary" data-action="complete-task" data-task-id="${escapeHtml(task.id)}">记录结果</button>
                <button class="button ghost" data-action="delay-task" data-task-id="${escapeHtml(task.id)}" data-delay-hours="${escapeHtml(String(suggestedTaskDelayHours(task.priority)))}">${escapeHtml(taskDelayLabel(suggestedTaskDelayHours(task.priority)))}</button>
                <button
                  class="button ghost"
                  data-next-command="${escapeHtml(`帮我继续处理这个跟进任务：${task.title || task.id}`)}"
                  data-commander-template="crm_followup"
                  data-prefill-json="${escapeHtml(
                    JSON.stringify({
                      object_type: task.object_type || 'lead',
                      object_id: task.object_id || '',
                      title: task.title || '继续处理当前任务',
                      priority: task.priority || 'P1'
                    })
                  )}"
                >
                  继续处理
                </button>
              </div>
            </article>
          `
        )
        .join('')
    : renderEmpty('当前没有待处理任务');
}

function renderInquiries(inquiries) {
  $('#inquiries-table').innerHTML = renderTable(
    [
      ['姓名', (row) => row.contact_name || '-'],
      ['邮箱', (row) => row.contact_email || '-'],
      ['状态', (row) => row.status],
      ['问题', (row) => row.message || '-']
    ],
    inquiries.slice(0, 6)
  );
}

function renderLeads(leads) {
  $('#leads-table').innerHTML = renderTable(
    [
      ['联系人', (row) => row.contact_name || row.contact_email || row.contact_phone || '-'],
      ['状态', (row) => row.status],
      ['评分', (row) => row.score_total],
      ['下一步', (row) => row.next_action || '-']
    ],
    leads.slice(0, 6)
  );
}

function renderWeeklyReport(report) {
  if (!report) {
    $('#weekly-report').innerHTML = renderEmpty('暂无周报');
    return;
  }
  const warnings = report.warnings?.length
    ? `<ul>${report.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p class="muted">当前没有异常提醒。</p>';
  const actions = `<ul>${(report.recommendations || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  const bestChannel = report.best_channel
    ? `<p><strong>最佳渠道：</strong>${escapeHtml(report.best_channel.platform)} · 商机率 ${percent(
        report.best_channel.opportunity_rate
      )}</p>`
    : '<p class="muted">还没有足够数据判断最佳渠道。</p>';
  const bestPage = report.best_page
    ? `<p><strong>最佳页面：</strong>${escapeHtml(report.best_page.title)} · 提交率 ${percent(
        report.best_page.submit_rate
      )}</p>`
    : '';

  $('#weekly-report').innerHTML = `
    <p class="muted">生成时间：${escapeHtml(formatDate(report.generated_at))}</p>
    ${bestChannel}
    ${bestPage}
    <h4>建议动作</h4>
    ${actions || '<p class="muted">暂无建议。</p>'}
    <h4>提醒</h4>
    ${warnings}
  `;
}

function renderFunnel(funnel) {
  if (!funnel) {
    $('#funnel-table').innerHTML = renderEmpty('暂无漏斗');
    return;
  }
  $('#funnel-table').innerHTML = renderTable(
    [
      ['节点', (row) => row.label],
      ['数量', (row) => row.count],
      ['比率', (row) => row.rate]
    ],
    [
      { label: '页面访问', count: funnel.counts?.page_view ?? 0, rate: '-' },
      { label: 'CTA 点击', count: funnel.counts?.cta_click ?? 0, rate: percent(funnel.rates?.cta_click_rate ?? 0) },
      { label: '表单提交', count: funnel.counts?.form_submit ?? 0, rate: percent(funnel.rates?.form_submit_rate ?? 0) },
      { label: '原始咨询', count: funnel.counts?.inquiry_created ?? 0, rate: '-' },
      { label: '合格线索', count: funnel.counts?.lead_qualified ?? 0, rate: percent(funnel.rates?.qualified_rate ?? 0) },
      { label: '商机', count: funnel.counts?.opportunity_created ?? 0, rate: percent(funnel.rates?.opportunity_rate ?? 0) }
    ]
  );
}

function renderChannels(channels) {
  $('#channels-table').innerHTML = renderTable(
    [
      ['平台', (row) => row.platform],
      ['咨询', (row) => row.inquiries],
      ['合格', (row) => row.qualified_leads],
      ['商机率', (row) => percent(row.opportunity_rate)]
    ],
    channels.slice(0, 6)
  );
}

function renderSourceTags(sourceTags) {
  $('#source-tags-table').innerHTML = renderTable(
    [
      ['平台', (row) => escapeHtml(row.platform)],
      ['入口', (row) => escapeHtml(row.entry_point)],
      ['优先级', (row) => escapeHtml(row.priority_tier)],
      ['链接', (row) => anchorHtml(row.tracking_url, '打开')]
    ],
    sourceTags.slice(0, 6),
    true
  );
}

function renderPages(pages) {
  $('#pages-table').innerHTML = renderTable(
    [
      ['页面', (row) => escapeHtml(row.title)],
      ['访问', (row) => escapeHtml(String(row.page_views ?? '-'))],
      ['提交', (row) => escapeHtml(String(row.form_submits ?? '-'))],
      ['提交率', (row) => escapeHtml(row.submit_rate !== undefined ? percent(row.submit_rate) : '-')],
      ['链接', (row) => anchorHtml(`/p/${row.slug}${state.sourceTag ? `?source_tag_id=${state.sourceTag.id}` : ''}`, '打开')]
    ],
    pages.slice(0, 6),
    true
  );
}

function renderTable(columns, rows, containsHtml = false) {
  if (!rows?.length) return renderEmpty('还没有数据');

  const head = columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join('');
  const body = rows
    .map(
      (row) => `
        <tr>
          ${columns
            .map(([, render]) => {
              const value = render(row);
              return `<td>${containsHtml ? value : escapeHtml(String(value ?? '-'))}</td>`;
            })
            .join('')}
        </tr>
      `
    )
    .join('');

  return `<table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderEmptyState() {
  renderCommanderHome();
  renderDefaultRecipes();
  renderCommanderResults(null, null);
  renderUserWorkbench();
  renderCallCenter();
  renderActiveLeadRun();
  renderWeeklyCampaign();
  renderCustomerTimeline();
  $('#kpi-grid').innerHTML = [
    ['Pending approvals', '-', '等待人工确认的高风险动作'],
    ['Failed tool calls', '-', '最近失败或异常的工具调用'],
    ['Sidecar count', '-', 'Go / Python / Rust sidecar readiness'],
    ['Geo pending', '-', 'geo routing 待处理审批']
  ].map(([label, value, copy]) => renderKpi(label, value, copy)).join('');
  renderP1Summaries({});
  renderP1Drilldowns({});
  renderOpsDomainPanels({});
  $('#remediation-list').innerHTML = renderEmpty('工作区就绪后展示需要处理的事项。');
  $('#task-list').innerHTML = renderEmpty('暂无任务');
  $('#inquiries-table').innerHTML = renderEmpty('暂无咨询');
  $('#leads-table').innerHTML = renderEmpty('暂无线索');
  $('#weekly-report').innerHTML = renderEmpty('暂无周报');
  $('#funnel-table').innerHTML = renderEmpty('暂无漏斗');
  $('#channels-table').innerHTML = renderEmpty('暂无渠道数据');
  $('#source-tags-table').innerHTML = renderEmpty('暂无来源标签');
  $('#pages-table').innerHTML = renderEmpty('暂无落地页');
}

function renderLoading() {
  $('#ops-updated').textContent = '刷新中...';
  $('#commander-updated').textContent = '处理中...';
  $('#workbench-updated').textContent = '生成中...';
  $('#call-center-updated').textContent = '同步中...';
  $('#campaign-updated').textContent = '汇总中...';
  $('#timeline-updated').textContent = '聚合中...';
}

function renderTenantStatus() {
  $('#tenant-status').textContent = state.tenant
    ? `${normalizeTenantName(state.tenant.name)} · ${state.tenant.plan_code}`
    : '点击开始使用';
}

function renderLinks() {
  const sourceUrl = state.sourceTag ? renderAnchor(state.sourceTag.tracking_url) : '还没有来源链接';
  $('#active-link').innerHTML = wrapLink(sourceUrl, Boolean(state.sourceTag));

  const pageUrl = state.page ? renderAnchor(landingUrl()) : '还没有落地页';
  $('#page-link').innerHTML = wrapLink(pageUrl, Boolean(state.page));
  $('#landing-preview').innerHTML = wrapLink(pageUrl, Boolean(state.page));
}

function renderHeroStat(label, value) {
  return `
    <article class="hero-stat">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </article>
  `;
}

function renderKpi(label, value, copy) {
  return `
    <article class="kpi-card">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${escapeHtml(String(value))}</div>
      <p class="kpi-copy">${escapeHtml(copy)}</p>
    </article>
  `;
}

function renderCommanderNoteItem({ title, copy, tone = 'info' }) {
  return `
    <article class="review-item">
      <span class="chip ${escapeHtml(tone)}">${escapeHtml(readableAction(tone))}</span>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(copy)}</p>
    </article>
  `;
}

function buildCommanderPlanProgress(plan) {
  const route = plan.route || {};
  const missingInputs = asArray(route.missing_inputs);
  return [
    ['已理解目标', route.playbook_id || '系统已完成路由', 'success'],
    ['已识别 Agent', route.agent_id || '等待识别', 'success'],
    missingInputs.length
      ? ['需要补少量字段', `还差 ${missingInputs.join(', ')}`, 'warning']
      : ['可以直接执行', '当前没有缺失字段，可直接进入运行。', 'success']
  ];
}

function buildCommanderRunProgress(run) {
  const artifacts = asArray(run.artifacts);
  const approvals = asArray(run.plan?.approval_points);
  return [
    ['已执行 Commander', `当前状态：${run.status || 'unknown'}`, toneForStatus(String(run.status || ''))],
    ['已产出结果', artifacts.length ? `${artifacts.length} 个 artifact` : '执行结果已返回到结果页', 'success'],
    approvals.length
      ? ['仍有待确认动作', `${approvals.length} 个审批点需要人工确认`, 'pending']
      : ['无需额外审批', '当前执行结果可以直接继续往下做。', 'success']
  ];
}

function buildCommanderAutoItems(run, plan) {
  const items = [];
  asArray(run?.artifacts).slice(0, 4).forEach((artifact) => {
    items.push({
      title: artifact.type || artifact.artifact_type || 'artifact',
      copy: artifact.status ? `状态：${artifact.status}` : '系统已自动产出结果',
      tone: 'success'
    });
  });
  Object.entries(run?.step_outputs || {})
    .slice(0, 4)
    .forEach(([stepId, value]) => {
      items.push({
        title: `步骤 ${stepId}`,
        copy: commanderValuePreview(value),
        tone: 'success'
      });
    });
  if (!items.length && plan?.plan_summary) {
    items.push({
      title: '计划已完成理解',
      copy: plan.plan_summary,
      tone: 'info'
    });
  }
  return items.slice(0, 6);
}

function buildCommanderConfirmItems(plan, run, missingInputs) {
  const items = [];
  if (missingInputs.length) {
    items.push({
      title: '补充关键字段',
      copy: `请补充：${missingInputs.join(', ')}`,
      tone: 'warning'
    });
  }
  asArray(plan?.approval_points).forEach((item) => {
    items.push({
      title: item.tool_id || item.step_id || 'approval',
      copy: item.reason || '该动作需要人工确认后执行',
      tone: 'pending'
    });
  });
  if (run?.status && ['failed', 'failed_blocked'].includes(run.status)) {
    items.push({
      title: '当前执行被阻断',
      copy: run.next_required_action || '请检查结果页中的下一步提示。',
      tone: 'danger'
    });
  }
  return items;
}

function renderSuggestedCommands(templateKey) {
  const suggestions = {
    weekly_review: [
      '帮我创建一个跟进任务',
      '给这个线索安排一次外呼跟进',
      '帮我跑一个默认获客流程'
    ],
    crm_followup: [
      '给这个线索安排一次外呼跟进',
      '帮我生成本周复盘',
      '帮我推荐适合 OPC 的工具组合'
    ],
    voice_followup: [
      '帮我创建一个跟进任务',
      '帮我生成本周复盘',
      '帮我跑一个默认获客流程'
    ],
    integration_stack: [
      '帮我生成本周复盘',
      '帮我跑一个默认获客流程',
      '帮我创建一个跟进任务'
    ],
    lead_acquisition: [
      '帮我在杭州找 20 家可能需要代理记账的小公司',
      '帮我为当前获客执行生成今日跟进队列',
      '给第一条高优先级线索安排外呼'
    ],
    growth_loop: [
      '帮我生成本周复盘',
      '帮我创建一个跟进任务',
      '给这个线索安排一次外呼跟进'
    ]
  }[templateKey || 'growth_loop'] || [];

  return suggestions
    .map((command) => renderCommanderNoteItem({ title: command, copy: '点击上方一句话输入后可以直接替换执行。', tone: 'info' }))
    .join('');
}

function renderMetricStack(rows) {
  return rows
    .map(
      ([label, value]) => `
        <div class="metric-row">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(value))}</strong>
        </div>
      `
    )
    .join('');
}

function renderMiniTable(headers, rows, containsHtml = false) {
  const head = headers.map((label) => `<th>${escapeHtml(label)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((value) => `<td>${containsHtml ? value : escapeHtml(String(value ?? '-'))}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="mini-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderStatusChip(status, label = null) {
  const text = label || status || 'unknown';
  return `<span class="chip ${toneForStatus(String(status || '').toLowerCase())}">${escapeHtml(text)}</span>`;
}

function renderFocusItem(item) {
  return `
    <article class="focus-item">
      <span class="chip ${toneForSeverity(item.severity)}">${escapeHtml(item.severity || 'info')}</span>
      <strong>${escapeHtml(readableAction(item.action || 'review'))}</strong>
      <p>${escapeHtml(item.component || 'ops')}${item.count !== undefined ? ` · ${escapeHtml(String(item.count))} item(s)` : ''}</p>
    </article>
  `;
}

function renderReviewItem(item) {
  return `
    <article class="review-item">
      <span class="chip ${toneForSeverity(item.severity)}">${escapeHtml(item.severity || 'info')}</span>
      <strong>${escapeHtml(readableAction(item.action || 'review'))}</strong>
      <p>${escapeHtml(item.component || 'ops')}${item.count !== undefined ? ` · ${escapeHtml(String(item.count))} item(s)` : ''}</p>
    </article>
  `;
}

function renderEmpty(message) {
  return `<div class="empty">${escapeHtml(message)}</div>`;
}

function commanderValuePreview(value) {
  if (value === null || value === undefined) return '系统已完成该步骤';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length ? `${value.length} 条结果` : '空数组结果';
  if (typeof value === 'object') {
    const keys = Object.keys(value).slice(0, 4);
    return keys.length ? `返回字段：${keys.join(', ')}` : '对象结果';
  }
  return '系统已完成该步骤';
}

async function settle(requests) {
  const entries = await Promise.all(
    Object.entries(requests).map(async ([key, promise]) => {
      try {
        return [key, await promise];
      } catch (error) {
        console.warn(`[opc] ${key} request failed`, error);
        return [key, null];
      }
    })
  );
  return Object.fromEntries(entries);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '请求失败');
  return data;
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function ensureTenant() {
  if (!state.tenant) {
    throw new Error('请先点击“开始使用”或直接执行一句话目标');
  }
}

function normalizeTenantName(name) {
  const value = String(name || '').trim();
  if (!value || value === '我的一人公司') return '默认工作区';
  return value;
}

function countReadyP1Modules(p1) {
  return [
    p1.provider_routing,
    p1.crm_sync_mapping,
    p1.notebook_knowledge,
    p1.billing_quota,
    p1.quality_contracts
  ].filter((item) => item && !['not_configured', 'blocked'].includes(item.readiness_status)).length;
}

function collectP1Remediation(p1) {
  return [
    ...(p1.provider_routing?.remediation || []),
    ...(p1.crm_sync_mapping?.remediation || []),
    ...(p1.notebook_knowledge?.remediation || []),
    ...(p1.billing_quota?.remediation || []),
    ...(p1.quality_contracts?.remediation || [])
  ];
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function truncateText(value, maxLength = 120) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function dedupeActions(actions) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = `${action.priority}:${action.title}:${action.command || action.taskId || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function priorityRank(priority) {
  return { P0: 0, P1: 1, P2: 2, P3: 3 }[String(priority || 'P2').toUpperCase()] ?? 4;
}

function priorityFromScore(score) {
  if (score >= 120) return 'P0';
  if (score >= 82) return 'P1';
  if (score >= 55) return 'P2';
  return 'P3';
}

function rankTaskAction(task) {
  let score = 40;
  const reasons = [];
  const priority = String(task.priority || 'P2').toUpperCase();
  score += { P0: 65, P1: 42, P2: 18, P3: 8 }[priority] ?? 0;
  if (isOverdue(task.due_at)) {
    score += 40;
    reasons.push('已逾期');
  } else if (hoursUntil(task.due_at) <= 2) {
    score += 24;
    reasons.push('2 小时内到期');
  } else if (hoursUntil(task.due_at) <= 24) {
    score += 12;
    reasons.push('今天到期');
  }
  if (String(task.object_type || '').includes('lead')) {
    score += 10;
    reasons.push('直接关联线索');
  }
  if (String(task.status || '').toLowerCase().includes('failed')) {
    score += 18;
    reasons.push('上次执行失败');
  }
  return {
    score,
    reason: reasons.join(' · ') || '高优先级任务承接'
  };
}

function rankLeadAction(lead) {
  let score = Number(lead.score_total || 0);
  const reasons = [];
  if (score >= 80) reasons.push('高意向商机');
  if (lead.next_action) {
    score += 15;
    reasons.push('已有下一步动作');
  }
  if (String(lead.status || '').toLowerCase().includes('opportunity')) {
    score += 18;
    reasons.push('已进入商机阶段');
  }
  const recentHours = hoursSince(lead.last_interaction || lead.updated_at || lead.created_at);
  if (recentHours <= 24) {
    score += 10;
    reasons.push('最近有互动');
  }
  if (recentHours > 48 && Number(lead.score_total || 0) >= 80) {
    score += 22;
    reasons.push('高分线索超过 48 小时未跟进');
  }
  return {
    score,
    reason: reasons.join(' · ') || '等待线索判断'
  };
}

function isOverdue(value) {
  if (!value) return false;
  return new Date(value).getTime() < Date.now();
}

function hoursUntil(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  return (new Date(value).getTime() - Date.now()) / 36e5;
}

function hoursSince(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(value).getTime()) / 36e5;
}

function leadDisplayName(lead) {
  return lead.contact_name || lead.contact_email || lead.contact_phone || lead.id || '未命名线索';
}

function leadRunStages() {
  return [
    { id: 'goal_created', short: '01', label: '目标' },
    { id: 'lead_discovery_ready', short: '02', label: '找线索' },
    { id: 'lead_scored', short: '03', label: '评分' },
    { id: 'script_ready', short: '04', label: '话术' },
    { id: 'followup_queue_ready', short: '05', label: '跟进队列' },
    { id: 'calling_or_followup_running', short: '06', label: '呼叫/跟进' },
    { id: 'outcomes_collected', short: '07', label: '结果回写' },
    { id: 'review_ready', short: '08', label: '复盘' },
    { id: 'completed', short: '09', label: '完成' }
  ];
}

function leadRunStageLabel(stage) {
  return leadRunStages().find((item) => item.id === stage)?.label || stage || '等待开始';
}

function inferIndustryFromGoal(goal) {
  const text = String(goal || '');
  if (/财税|代理记账|记账|税务/.test(text)) return '财税服务';
  if (/装修|家装|设计|建材/.test(text)) return '本地装修服务';
  if (/教培|培训|课程|招生/.test(text)) return '教育培训';
  if (/法务|法律|合同/.test(text)) return '法务服务';
  if (/SaaS|软件|系统|企业服务/.test(text)) return '软件服务';
  return '';
}

function inferLocationFromGoal(goal) {
  const text = String(goal || '');
  const cities = ['北京', '上海', '广州', '深圳', '杭州', '成都', '南京', '苏州', '武汉', '西安', '重庆', '天津'];
  return cities.find((city) => text.includes(city)) || '';
}

function inferLeadCountFromGoal(goal) {
  const match = String(goal || '').match(/(\d+)\s*(个|家|条|位)?/);
  return match ? Number(match[1]) : 10;
}

function buildCommanderGoalClarificationBrief(context) {
  if (!context?.goal) return null;
  const library = commanderGoalBriefLibrary(context.industry);
  const missingInputs = (context.missing || []).map((item) => {
    if (item.name === 'industry') return '缺少更具体的服务行业，系统还无法稳判断该先找哪类客户。';
    if (item.name === 'location') return '城市范围太宽，先补一个优先城市，今天的找客和排序会更快。';
    if (item.name === 'target_customer_profile') return '缺少更具体的客户画像，先说明最想联系哪类老板、门店或公司。';
    return '还缺少一项关键信息，补齐后更容易排出今天先联系谁。';
  });
  const targetProfileHypotheses = [...new Set([
    localizeCommanderBriefText(context.profile, context.location),
    ...library.personas.map((item) => localizeCommanderBriefText(item, context.location))
  ].filter(Boolean))].slice(0, 3);
  const collectionKeywords = [...new Set([
    ...library.keywords,
    ...library.queryClusters
  ].map((item) => localizeCommanderBriefKeyword(item, context.location)).filter(Boolean))].slice(0, 6);
  const preferredSources = [...new Set(library.preferredSources.filter(Boolean))].slice(0, 4);
  const queryClusters = [...new Set(library.queryClusters.filter(Boolean))].slice(0, 3);
  const collectionAdvice = missingInputs.length
    ? `先补齐${missingInputs.length === 1 ? '这一处关键信息' : '行业/区域/画像里的关键缺口'}，再围绕 ${collectionKeywords.slice(0, 2).join('、') || '高意向公开线索'} 收第一批名单。`
    : `可直接从 ${preferredSources[0] || '公开来源'} 开始，先采 ${context.leadCountTarget || 10} 条候选，再让系统继续做排序和开口。`;
  return {
    summary: missingInputs.length
      ? `一句话目标已经能起步，但还差 ${missingInputs.length} 处关键信息；补齐后更容易把第一批线索排进今天。`
      : '一句话目标已经足够清晰，可以直接进入第一批线索采集、排序和开口准备。',
    collection_advice: collectionAdvice,
    industry_guess: {
      value: context.industry || '待补充',
      confidence: context.industry ? 'high' : 'low',
      reason: context.industry
        ? `当前会先按「${context.industry}」来选来源、筛线索和组织第一轮开口。`
        : '还没有明确行业，系统暂时只能按泛目标给出采集建议。'
    },
    location_scope: {
      value: context.location || '未限定城市',
      scope_type: context.location ? 'single_city' : 'broad',
      summary: context.location
        ? `先围绕 ${context.location} 收第一批公开线索和可联系名单，再排今天先联系谁。`
        : '还没有优先城市，先补一个城市会更容易把今天的名单排出来。'
    },
    target_profile_hypotheses: targetProfileHypotheses,
    missing_inputs: missingInputs,
    search_seed_pack: {
      summary: collectionAdvice,
      lead_count_target: context.leadCountTarget || 10,
      query_clusters: queryClusters,
      preferred_sources: preferredSources,
      collection_keywords: collectionKeywords
    }
  };
}

function commanderGoalBriefLibrary(industry) {
  if (industry === '财税服务') {
    return {
      personas: [
        '本地小微企业主、个体工商户、刚注册公司且可能需要代理记账/税务咨询的人',
        '正在比较代理记账报价、想先问清服务边界的老板'
      ],
      preferredSources: ['地图商户', '企业名录/招聘', '社媒问答/旧咨询'],
      queryClusters: ['新注册公司', '代理记账报价', '工商变更/年报异常'],
      keywords: ['新注册公司', '代理记账报价', '税务咨询', '工商变更']
    };
  }
  if (industry === '本地装修服务' || industry === '装修/设计服务') {
    return {
      personas: [
        '近期准备装修、翻新、设计咨询的本地业主',
        '正在比方案、比报价、比工期的门店或公司负责人'
      ],
      preferredSources: ['本地地图商户', '装修问答/案例评论', '表单咨询'],
      queryClusters: ['装修报价', '设计咨询', '翻新/施工节点'],
      keywords: ['装修报价', '设计咨询', '翻新需求', '施工周期']
    };
  }
  if (industry === '教育培训') {
    return {
      personas: [
        '正在比较试听、报名方案的家长/学员',
        '近期已经表达课程意向、愿意继续沟通的人'
      ],
      preferredSources: ['表单咨询', '社媒私信/评论', '问答社区'],
      queryClusters: ['试听预约', '课程对比', '报名决策'],
      keywords: ['试听预约', '课程咨询', '报名方案', '升学/考证需求']
    };
  }
  if (industry === '法务服务' || industry === '企业服务' || industry === '软件服务') {
    return {
      personas: [
        '近期遇到合同、合规、经营手续问题的企业负责人',
        '已经在比较服务方案、想先确认风险和报价边界的老板'
      ],
      preferredSources: ['企业问答/社媒', '表单咨询', '历史 CRM 线索'],
      queryClusters: ['合同/合规问题', '经营手续处理', '报价咨询'],
      keywords: ['合同咨询', '合规问题', '经营手续', '报价方案']
    };
  }
  return {
    personas: ['近期表达明确需求、留下可联系信息、适合在 24 小时内跟进的潜在客户'],
    preferredSources: ['公开线索', '地图商户', '表单咨询'],
    queryClusters: ['高意向需求', '近期咨询动作', '可快速跟进对象'],
    keywords: ['高意向客户', '近期咨询', '可联系名单', '回拨需求']
  };
}

function defaultTargetProfile(goal) {
  const industry = inferIndustryFromGoal(goal);
  if (industry === '财税服务') return '本地小微企业主、个体工商户、刚注册公司且可能需要代理记账/税务咨询的人';
  if (industry === '本地装修服务' || industry === '装修/设计服务') return '近期有装修、翻新、设计咨询需求的本地业主或门店经营者';
  if (industry === '教育培训') return '正在比较课程、需要咨询试听或报名方案的家长/学员';
  return '近期表达明确需求、留下可联系信息、适合在 24 小时内跟进的潜在客户';
}

function defaultSourceStrategy(goal) {
  const location = inferLocationFromGoal(goal);
  return `${location ? `${location}本地` : '目标区域'}公开线索、地图商户、表单咨询、社媒留言和历史 CRM 线索混合筛选`;
}

function localizeCommanderBriefText(text, location) {
  const value = String(text || '').trim();
  if (!value || !location || value.includes(location)) return value;
  if (value.startsWith('本地')) return `${location}${value.slice(2)}`;
  return value;
}

function localizeCommanderBriefKeyword(keyword, location) {
  const value = String(keyword || '').trim();
  if (!value || !location || value.includes(location)) return value;
  if (/^(公开线索|地图商户|表单咨询|社媒留言|历史 CRM 线索)/.test(value)) return value;
  return `${location} ${value}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function mergeRecord(target, source) {
  Object.entries(source || {}).forEach(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] ||= {};
      mergeRecord(target[key], value);
      return;
    }
    target[key] = value;
  });
  return target;
}

function writePath(target, path, value) {
  const parts = String(path).split('.');
  let cursor = target;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    cursor[part] ||= {};
    cursor = cursor[part];
  });
  return target;
}

function readPath(target, path) {
  return String(path)
    .split('.')
    .reduce((cursor, part) => (cursor && typeof cursor === 'object' ? cursor[part] : undefined), target);
}

function campaignStorageKey() {
  return state.tenant ? `opc.campaign.${state.tenant.id}` : null;
}

function persistCampaignSnapshot(snapshot) {
  const key = campaignStorageKey();
  if (!snapshot) return;
  state.campaign.snapshot = {
    goal: snapshot.goal,
    copy: snapshot.copy,
    metrics: snapshot.metrics,
    steps: snapshot.steps,
    runner: snapshot.runner,
    recipeId: state.commander.activeRecipe,
    savedAt: new Date().toISOString()
  };
  if (key) {
    localStorage.setItem(key, JSON.stringify(state.campaign.snapshot));
  }
  void postCampaignArtifact(state.campaign.snapshot);
}

function loadCampaignSnapshot() {
  if (state.campaign.snapshot) return state.campaign.snapshot;
  const key = campaignStorageKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    state.campaign.snapshot = JSON.parse(raw);
    return state.campaign.snapshot;
  } catch (error) {
    console.warn('[opc] failed to load campaign snapshot', error);
    return null;
  }
}

async function postCampaignArtifact(snapshot) {
  if (!state.tenant || !snapshot) return null;
  try {
    const result = await api('/api/campaign-artifacts', {
      method: 'POST',
      body: {
        tenant_id: state.tenant.id,
        snapshot
      }
    });
    state.campaign.snapshot = result.artifact?.payload || state.campaign.snapshot;
    return result;
  } catch (error) {
    console.warn('[opc] failed to persist campaign artifact', error);
    return null;
  }
}

async function fetchCampaignArtifact() {
  if (!state.tenant) return null;
  try {
    const result = await api(`/api/campaign-artifacts/latest?tenant_id=${encodeURIComponent(state.tenant.id)}`);
    state.campaign.snapshot = result.artifact?.payload || state.campaign.snapshot;
    return result.artifact?.payload || null;
  } catch (error) {
    console.warn('[opc] failed to load campaign artifact', error);
    return null;
  }
}

async function restoreCampaignSnapshot() {
  const snapshot = (await fetchCampaignArtifact()) || loadCampaignSnapshot();
  if (!snapshot) return false;
  state.commander.activeRecipe = snapshot.recipeId || state.commander.activeRecipe;
  if (snapshot.goal) {
    const templateKey = DEFAULT_RECIPES.find((recipe) => recipe.id === state.commander.activeRecipe)?.templateKey || state.commander.templateKey;
    applyCommanderTemplate(templateKey, { preserveGoal: true });
    $('#commander-goal').value = snapshot.goal;
  }
  state.campaign.runner = snapshot.runner || null;
  return true;
}

function heroTitle(health) {
  if (health === 'healthy') return '运营底座健康，可以进入日常处理';
  if (health === 'critical') return '存在关键阻断，需要优先处理';
  if (health === 'degraded') return '部分运营能力需要关注';
  return '运营工作台等待数据';
}

function healthLabel(health) {
  return {
    healthy: 'Healthy',
    degraded: 'Degraded',
    critical: 'Critical',
    not_configured: 'Not configured'
  }[health] || health;
}

function toneForStatus(status) {
  if (['healthy', 'ready', 'ok', 'success'].includes(status)) return 'success';
  if (['critical', 'blocked', 'failed', 'error'].includes(status)) return 'danger';
  if (['degraded', 'warning', 'planned', 'blocked_missing_context', 'needs_attention', 'needs_mapping_review', 'needs_grounding_review', 'needs_regression_review'].includes(status)) return 'warning';
  if (['awaiting_human_approval', 'pending'].includes(status)) return 'pending';
  return 'info';
}

function toneForSeverity(severity) {
  if (severity === 'critical' || severity === 'high') return 'danger';
  if (severity === 'medium') return 'warning';
  if (severity === 'low') return 'info';
  return 'pending';
}

function readableAction(action) {
  return String(action || '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function output(selector, value) {
  $(selector).textContent = JSON.stringify(value, null, 2);
}

function landingUrl() {
  if (!state.page) return '';
  const suffix = state.sourceTag ? `?source_tag_id=${encodeURIComponent(state.sourceTag.id)}` : '';
  return `/p/${state.page.slug}${suffix}`;
}

function wrapLink(content, enabled) {
  return enabled ? content : `<span class="empty">${escapeHtml(content)}</span>`;
}

function renderAnchor(path) {
  return anchorHtml(path, path, true);
}

function anchorHtml(path, label, newTab = true) {
  const target = newTab ? ' target="_blank" rel="noreferrer"' : '';
  return `<a href="${escapeHtml(path)}"${target}>${escapeHtml(label)}</a>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 100)}%`;
}

function money(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function findTaskById(taskId) {
  return [...state.data.tasks, ...state.data.completedTasks].find((task) => task.id === taskId) || null;
}

function defaultCompletionResultForTask(task) {
  if (String(task.title || '').includes('预约')) return 'appointment_booked';
  if (String(task.title || '').includes('回拨')) return 'callback_requested';
  return 'contacted';
}

function defaultNextStepTypeForResult(result) {
  return {
    contacted: 'followup',
    callback_requested: 'callback',
    appointment_booked: 'appointment',
    no_response: 'callback',
    disqualified: 'none',
    won: 'none',
    completed: 'none'
  }[result] || 'none';
}

function humanTaskStepLabel(step) {
  return {
    followup: '继续跟进',
    callback: '回拨',
    appointment: '预约准备',
    none: '收尾'
  }[step] || '下一步';
}

function suggestedTaskDelayHours(priority) {
  if (String(priority || 'P2').toUpperCase() === 'P0') return 4;
  if (String(priority || 'P2').toUpperCase() === 'P1') return 24;
  return 48;
}

function taskDelayLabel(hours) {
  if (hours >= 48) return '延后 2 天';
  if (hours >= 24) return '延后 1 天';
  return `延后 ${hours}h`;
}

function readableTaskResult(result) {
  return {
    contacted: '已联系上，继续推进',
    callback_requested: '客户要求回拨',
    appointment_booked: '已经约好沟通',
    no_response: '暂未联系上',
    disqualified: '暂不继续跟进',
    won: '已成交',
    completed: '任务已完成'
  }[result] || result || '任务已完成';
}

function defaultLocalDateTimeForStep(step) {
  const hours = { callback: 4, appointment: 24, followup: 24 }[step] ?? 24;
  return formatLocalDateTimeInput(Date.now() + hours * 60 * 60 * 1000);
}

function formatLocalDateTimeInput(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatDateTime(value) {
  return formatDate(value);
}

function bind(selector, eventName, handler) {
  $(selector)?.addEventListener(eventName, (event) => {
    Promise.resolve(handler(event)).catch(showError);
  });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

function showError(error) {
  toast(error.message || '操作失败');
}

window.addEventListener('error', (event) => showError(event.error || new Error(event.message)));

// ===== Single-screen workbench renderer helpers =====

function buildClientLeadAcquisitionWorkbenchView(run) {
  if (!run) {
    return {
      run_header: { goal: '', stage: '', meta: [] },
      focus_queue: [],
      current_action: {
        title: '先创建获客执行',
        summary: '输入一句获客目标，然后点击"创建获客执行"。',
        primary_cta: { action: 'create', label: '创建获客执行', tone: 'primary' },
        secondary_actions: []
      },
      outcome_dock: null,
      drawer_payloads: []
    };
  }

  const focusQueue = [];
  const priorityLadder = run.priority_ladder_packet || null;
  const topLeads = asArray(priorityLadder?.ladder).slice(0, 3);
  topLeads.forEach((item) => {
    focusQueue.push({
      title: item.lead_name || '线索',
      reason: item.why_now || item.reason || '',
      tone: 'info'
    });
  });

  const todayCard = run.today_contact_card || null;
  const approvalBridge = run.approval_safe_action_bridge || null;
  const scriptPack = run.script_pack || null;
  const writebackCard = run.writeback_confirmation_card || null;
  const deliveryGate = run.service_delivery_readiness_gate || null;

  let currentAction = {
    title: '继续处理今天主动作',
    summary: run.next_recommended_action || run.computed_next_recommended_action || '继续推进线索发现和跟进队列。',
    approval_required: approvalBridge?.approval_status === 'pending_approval',
    primary_cta: { action: 'call-first', label: '呼叫第一条线索', tone: 'primary' },
    secondary_actions: [
      { action: 'script', label: '刷新话术' },
      { action: 'queue', label: '创建跟进队列' }
    ]
  };

  if (approvalBridge?.approval_status === 'pending_approval') {
    currentAction.title = '等待审批';
    currentAction.summary = '当前首触达动作需要审批通过后才能继续执行。';
    currentAction.primary_cta = { action: 'approval-action', label: '批准执行', tone: 'primary' };
  } else if (todayCard?.phone) {
    currentAction.title = todayCard.title || `先联系 ${todayCard.lead_name || '当前线索'}`;
    currentAction.summary = todayCard.reason || todayCard.summary || '';
    currentAction.primary_cta = {
      action: 'call-lead',
      label: `呼叫 ${todayCard.phone}`,
      tone: 'primary'
    };
  } else if (Number(run.public_source_adapter?.imported_count || 0) > 0 && asArray(run.leads).length === 0) {
    currentAction.title = '导入线索推进到今日联系';
    currentAction.summary = '已完成采集，现在导入线索并推进到今日联系阶段。';
    currentAction.primary_cta = { action: 'advance-today', label: '导入线索推进', tone: 'primary' };
  } else if (asArray(run.leads).length === 0) {
    currentAction.title = '先发现线索';
    currentAction.summary = '当前执行还没有线索，先从地图获客、公开来源或现有线索导入第一批客户。';
    currentAction.primary_cta = { action: 'discovery', label: '开始线索发现', tone: 'primary' };
  }

  const outcomeDock = writebackCard ? {
    title: '结果回写与下一步',
    summary: writebackCard.summary || '通话结束后，立刻回写结果并确认下一步。',
    next_task: writebackCard.next_task || null,
    next_revenue_action: run.next_revenue_action_card || null,
    next_batch_launch: run.next_batch_launch_plan || null,
    delivery_status: deliveryGate?.status || 'draft'
  } : null;

  const drawerPayloads = [
    { key: 'evidence', label: '证据与来源', content: run.signal_packet || run.capture_proof_surface || null },
    { key: 'script_basis', label: '话术依据', content: scriptPack || run.script || null },
    { key: 'execution_log', label: '执行记录', content: run.today_workbench || run.mainline_checkpoint_resume_pack || null },
    { key: 'sellable_delivery', label: '交付包', content: run.sellable_delivery_pack || null },
    { key: 'learning_delta', label: '学习差量', content: run.signal_learning_delta || null },
    { key: 'execution_receipt', label: '执行回执', content: run.execution_receipt_rollup || null },
    {
      key: 'next_batch_launch',
      label: '下一批启动',
      content: run.next_batch_launch_plan || run.next_batch_run_request || run.next_batch_launch_writeback
        ? {
            next_batch_launch_plan: run.next_batch_launch_plan || null,
            next_batch_run_request: run.next_batch_run_request || null,
            next_batch_launch_writeback: run.next_batch_launch_writeback || null
          }
        : null
    }
  ].filter((item) => item.content);

  return {
    run_header: {
      goal: run.goal || '',
      stage: leadRunStageLabel(run.current_stage),
      meta: [
        { label: '线索', value: asArray(run.leads).length },
        { label: '待跟进', value: asArray(run.tasks).filter((task) => task.status === 'open').length },
        { label: '已通话', value: asArray(run.call_sessions).filter((call) => call.status === 'completed').length }
      ]
    },
    focus_queue: focusQueue,
    current_action: currentAction,
    outcome_dock: outcomeDock,
    drawer_payloads: drawerPayloads
  };
}

// renderLeadAcquisitionWorkbenchView renders the single-screen workbench
// from lead_acquisition_workbench_view built server-side.
// Revenue continuation packets handled server-side and surfaced in drawers:
// - revenue_action_execution_pack
// - next_batch_learning_profile  
// - channel_adapter_execution_request
function renderLeadAcquisitionWorkbenchView(view, run) {
  renderWorkbenchRunHeader(view.run_header, run);
  renderWorkbenchFocusQueue(view.focus_queue);
  renderWorkbenchActionStage(view.current_action, run, view);
  renderWorkbenchOutcomeDock(view.outcome_dock, view, run);
  renderWorkbenchDetailDrawer(view.drawer_payloads);
}

function renderWorkbenchRunHeader(header, run) {
  const mount = $('#workbench-run-header');
  if (!mount) return;
  mount.innerHTML = `
    <div class="workbench-run-header-content">
      <h2>${escapeHtml(header.goal || '获客执行')}</h2>
      <p class="workbench-run-stage">${escapeHtml(header.stage)}</p>
      <div class="workbench-run-meta">
        ${header.meta.map((item) => `<span>${escapeHtml(item.label)}：${escapeHtml(String(item.value))}</span>`).join('')}
      </div>
    </div>
  `;
}

function renderWorkbenchFocusQueue(items) {
  const mount = $('#workbench-focus-queue');
  if (!mount) return;
  const activeTab = state.commander.assetTab || 'runs';
  const tenantLabel = state.tenant
    ? `${normalizeTenantName(state.tenant.name)} · ${state.tenant.plan_code}`
    : '尚未开始';
  const tabs = [
    { key: 'runs', label: '执行' },
    { key: 'leads', label: '线索' },
    { key: 'calls', label: '通话' },
    { key: 'scripts', label: '话术' }
  ];
  mount.innerHTML = `
    <div class="workbench-focus-queue-content">
      <header class="workbench-assets-brand">
        <div class="workbench-assets-brand-row">
          <span class="brand-dot" aria-hidden="true"></span>
          <strong>OPC 一人公司</strong>
          <button class="workbench-assets-refresh" type="button" data-agent-workbench-action="refresh" title="刷新" aria-label="刷新">↻</button>
        </div>
        <p class="workbench-assets-tenant">${escapeHtml(tenantLabel)}</p>
        <p class="workbench-zone-kicker">Assets / History</p>
        <h3>资产管理 / 历史记录</h3>
      </header>
      <nav class="workbench-assets-tabs" aria-label="资产分类">
        ${tabs.map((tab) => `
          <button type="button" data-asset-tab="${tab.key}" class="${tab.key === activeTab ? 'active' : ''}">${escapeHtml(tab.label)}</button>
        `).join('')}
      </nav>
      <div class="workbench-assets-list" data-asset-list>
        ${renderAssetTabContent(activeTab, items)}
      </div>
    </div>
  `;
}

function renderAssetTabContent(tab, focusItems) {
  if (tab === 'runs') {
    const runs = asArray(state.data?.leadRuns);
    const active = state.data?.activeLeadRun || state.commander.lastLeadRun || null;
    const ordered = active
      ? [active, ...runs.filter((r) => r && r.id !== active.id)]
      : runs;
    if (!ordered.length) {
      return assetEmpty('还没有获客执行，点击右侧 Agent 干活区创建。');
    }
    return ordered.slice(0, 10).map((run) => `
      <article class="focus-queue-item" tabindex="0" data-asset-run-id="${escapeHtml(run.id || '')}">
        <strong>${escapeHtml(run.goal || '获客执行')}</strong>
        <p>${escapeHtml(leadRunStageLabel(run.current_stage) || '执行中')} · ${escapeHtml(String(asArray(run.leads).length || 0))} 个线索</p>
      </article>
    `).join('');
  }
  if (tab === 'leads') {
    const leads = asArray(state.data?.leads);
    if (!leads.length) {
      return assetEmpty('线索资产为空，启动获客执行后会自动汇入。');
    }
    return leads.slice(0, 12).map((lead) => `
      <article class="focus-queue-item" tabindex="0">
        <strong>${escapeHtml(leadDisplayName(lead) || '未命名线索')}</strong>
        <p>${escapeHtml(lead.industry || lead.tag || '')} ${lead.score ? `· 评分 ${escapeHtml(String(lead.score))}` : ''}</p>
      </article>
    `).join('');
  }
  if (tab === 'calls') {
    const sessions = [
      ...asArray(state.data?.callCenter?.active_calls),
      ...asArray(state.data?.callCenter?.recent_sessions)
    ];
    if (!sessions.length) {
      return assetEmpty('暂无通话记录，呼出或接通后会汇入这里。');
    }
    return sessions.slice(0, 12).map((session) => `
      <article class="focus-queue-item" tabindex="0">
        <strong>${escapeHtml(session.lead_name || session.phone || '通话会话')}</strong>
        <p>${escapeHtml(session.status || session.outcome || '')} ${session.duration ? `· ${escapeHtml(String(session.duration))}s` : ''}</p>
      </article>
    `).join('');
  }
  if (tab === 'scripts') {
    const run = state.data?.activeLeadRun || state.commander.lastLeadRun;
    const pack = run?.script_pack || null;
    const scripts = pack
      ? [{ title: pack.title || '当前话术包', reason: pack.summary || '当前 run 推荐照读话术。' }]
      : [];
    const fallback = asArray(focusItems).filter((item) => /话术|script/i.test(item.title || ''));
    const items = scripts.length ? scripts : fallback;
    if (!items.length) {
      return assetEmpty('暂无话术资产，启动执行后会沉淀可复用话术。');
    }
    return items.slice(0, 10).map((item) => `
      <article class="focus-queue-item" tabindex="0">
        <strong>${escapeHtml(item.title || '话术')}</strong>
        <p>${escapeHtml(item.reason || '')}</p>
      </article>
    `).join('');
  }
  return assetEmpty('选择左上方分类查看资产。');
}

function assetEmpty(text) {
  return `<p class="workbench-assets-empty">${escapeHtml(text)}</p>`;
}

function handleAssetTabSwitch(tab) {
  if (!tab) return;
  state.commander.assetTab = tab;
  persistCommanderState();
  const view = state.data?.activeLeadRun?.lead_acquisition_workbench_view
    || state.commander.lastLeadRun?.lead_acquisition_workbench_view
    || null;
  renderWorkbenchFocusQueue(view?.focus_queue || []);
}

function renderWorkbenchActionStage(action, run, view = null) {
  const mount = $('#workbench-action-stage');
  if (!mount) return;
  const contact = run?.today_contact_card || null;
  const model = run ? buildTodayMainlineModel(run) : null;
  const outreachPacks = asArray(view?.prospect_outreach_packs || run?.lead_acquisition_workbench_view?.prospect_outreach_packs);
  const entityCards = run ? [
    { label: '当前 run', value: run.goal || '获客执行', hint: leadRunStageLabel(run.current_stage) },
    { label: '当前 lead', value: contact?.lead_name || contact?.phone || '等待排出今日优先线索', hint: contact?.reason || contact?.summary || action?.summary || '' },
    { label: '当前 script', value: contact?.script || contact?.opening_line || run.script_pack?.title || '等待生成可照读话术', hint: contact?.script_basis_pack?.summary || run.script_pack?.summary || '' },
    { label: '下一步', value: run.next_recommended_action || run.computed_next_recommended_action || action?.primary_cta?.label || '继续推进', hint: action?.summary || '' }
  ] : [
    { label: '业务目标', value: $('#commander-goal')?.value || state.commander.goal || COMMANDER_TEMPLATES.lead_acquisition.goal, hint: '右侧 Agent 会把这句话变成获客执行。' },
    { label: '业务实体', value: 'Lead Acquisition Run', hint: '目标、线索、话术、回写和交付包都收口在同一个实体。' },
    { label: '今日对象', value: '等待生成', hint: '执行后中间区域只显示当前最该处理的对象。' }
  ];
  mount.innerHTML = `
    <div class="workbench-action-stage-content">
      <header class="workbench-entity-hero">
        <p class="workbench-zone-kicker">Business Entity</p>
        <h3>一切业务抽象实体</h3>
        <p>${escapeHtml(action?.summary || '中间区不是空白概念板：它承载当前 run、当前 lead、推荐理由、话术、呼叫动作和回写承诺。')}</p>
        ${action?.approval_required ? '<span class="chip warning">等待审批</span>' : ''}
      </header>
      <div class="workbench-entity-grid">
        ${entityCards.map((item) => `
          <article class="workbench-entity-card">
            <span>${escapeHtml(item.label)}</span>
            <strong>${escapeHtml(String(item.value || '-'))}</strong>
            ${item.hint ? `<small>${escapeHtml(truncateText(item.hint, 88))}</small>` : ''}
          </article>
        `).join('')}
      </div>
      ${outreachPacks.length ? renderProspectOutreachCards(outreachPacks, action) : ''}
      ${run ? renderProspectOutreachAcceptanceDock(run) : ''}
      ${run ? renderWorkbenchMainlinePanel(run, model) : renderWorkbenchStarterPanel()}
    </div>
  `;
}

function renderProspectOutreachCards(packs, action) {
  const primaryPackId = action?.prospect_outreach_pack?.pack_id || action?.prospect_outreach_pack?.lead_id || '';
  return `
    <section class="prospect-outreach-stack" data-prospect-outreach-stack>
      <header class="workbench-entity-hero">
        <p class="workbench-zone-kicker">Prospect Outreach Pack</p>
        <h3>Agent 交付的触达方案</h3>
        <p>每条包含需求证据、成交意愿、推荐渠道和可直接复制的话术；主操作是「去联系」，不是固定拨号。</p>
      </header>
      <div class="prospect-outreach-list">
        ${packs.slice(0, 5).map((pack, index) => {
          const need = pack.need_summary || {};
          const intent = pack.purchase_intent || {};
          const channel = pack.contact_plan || {};
          const script = pack.outreach_script || {};
          const evidence = pack.trigger_evidence || {};
          const profile = pack.profile_analysis || null;
          const isPrimary = primaryPackId
            ? (pack.pack_id === primaryPackId || pack.lead_id === primaryPackId)
            : index === 0;
          return `
            <article class="prospect-outreach-card${isPrimary ? ' is-primary' : ''}">
              <div class="prospect-outreach-head">
                <span class="chip ${intent.level === '高' ? 'success' : intent.level === '中' ? 'warning' : 'info'}">意愿 ${escapeHtml(intent.level || '待判')}</span>
                <strong>${escapeHtml(pack.display_name || `触达机会 ${index + 1}`)}</strong>
                <p>${escapeHtml(need.primary_need || '待补充需求')}</p>
              </div>
              <div class="prospect-outreach-meta">
                <code>${escapeHtml(channel.recommended_channel_label || '平台私信')}</code>
                ${evidence.source_platform ? `<code>${escapeHtml(evidence.source_platform)}</code>` : ''}
                ${intent.score != null ? `<code>评分 ${escapeHtml(String(intent.score))}</code>` : ''}
              </div>
              ${evidence.source_quote ? `<blockquote>${escapeHtml(truncateText(evidence.source_quote, 160))}</blockquote>` : ''}
              ${profile?.recent_topics?.length ? `
                <div class="prospect-outreach-profile">
                  <strong>主页追读</strong>
                  <p>${escapeHtml(truncateText(asArray(profile.behavior_signals).join(' · ') || profile.cross_validation || '已关联作者主页', 140))}</p>
                  <div class="prospect-outreach-meta">
                    ${asArray(profile.recent_topics).slice(0, 3).map((topic) => `<code>${escapeHtml(typeof topic === 'string' ? topic : topic.label || topic.title || '')}</code>`).join('')}
                  </div>
                </div>
              ` : ''}
              ${script.opening ? `<p class="prospect-outreach-script"><strong>开口：</strong>${escapeHtml(truncateText(script.opening, 180))}</p>` : ''}
              <div class="prospect-outreach-actions">
                <button class="button ${isPrimary ? 'primary' : 'secondary'}" type="button"
                  data-lead-run-action="${escapeHtml(pack.primary_cta?.action || 'outreach-contact')}"
                  data-lead-id="${escapeHtml(pack.lead_id || '')}"
                  data-outreach-opening="${escapeHtml(script.opening || '')}"
                  data-outreach-channel="${escapeHtml(channel.recommended_channel_label || '')}">
                  ${escapeHtml(pack.primary_cta?.label || '去联系')}
                </button>
                <button class="button ghost" type="button"
                  data-lead-run-action="outreach-channel-receipt"
                  data-pack-id="${escapeHtml(pack.pack_id || pack.lead_id || '')}"
                  data-lead-id="${escapeHtml(pack.lead_id || '')}"
                  data-receipt-note="已复制话术并手动发送">
                  已手动发送
                </button>
                ${evidence.source_url ? `<a class="button ghost" href="${escapeHtml(evidence.source_url)}" target="_blank" rel="noopener noreferrer">看原帖</a>` : ''}
              </div>
              <div class="prospect-outreach-writeback">
                ${asArray(pack.writeback_options).slice(0, 5).map((option) => `
                  <button class="button ghost" type="button"
                    data-lead-run-action="outreach-writeback"
                    data-writeback-key="${escapeHtml(option.key || '')}"
                    data-writeback-label="${escapeHtml(option.label || '')}"
                    data-pack-id="${escapeHtml(pack.pack_id || pack.lead_id || '')}"
                    data-pack-name="${escapeHtml(pack.display_name || '')}"
                    data-lead-id="${escapeHtml(pack.lead_id || '')}">
                    ${escapeHtml(option.label || option.key || '回写')}
                  </button>
                `).join('')}
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

function renderWorkbenchMainlinePanel(run, model = buildTodayMainlineModel(run)) {
  const card = model?.card || null;
  if (!card) {
    return `
      <div class="workbench-mainline-panel">
        <article class="workbench-starter-card">
          <strong>当前执行还没排出“今日第一通”</strong>
          <p>${escapeHtml(run?.next_recommended_action || '先让 Agent 生成/刷新线索、评分和今日跟进队列。')}</p>
        </article>
        <article class="workbench-starter-card">
          <strong>接下来会补齐</strong>
          <p>推荐线索、推荐原因、照读话术、呼叫入口、结果回写和下一步承接都会回到这一栏。</p>
        </article>
      </div>
    `;
  }
  return `
    <div class="workbench-mainline-panel">
      ${renderTodayCockpitPriorityStack(run, model)}
      ${renderTodayEvidenceChainCard(run, model)}
      ${renderTodayContextHeaderCard(run, model)}
      ${renderTodayEvidenceReasonCard(run, model)}
      ${renderTodayScriptActionStrip(run, model)}
    </div>
  `;
}

function buildTodayCockpitPriorityItems(run, model = buildTodayMainlineModel(run)) {
  const outreachPacks = asArray(
    run?.prospect_outreach_packs
    || run?.lead_acquisition_workbench_view?.prospect_outreach_packs
  );
  const packItems = outreachPacks.slice(0, 5).map((pack, index) => ({
    title: pack.display_name || pack.contact_name || `触达机会 ${index + 1}`,
    reason: pack.need_summary?.primary_need || pack.agent_reasoning || 'Agent 已整理需求、意愿和推荐渠道。',
    score: pack.purchase_intent?.score || pack.confidence || '',
    evidence: [
      pack.contact_plan?.recommended_channel_label || '',
      pack.trigger_evidence?.source_platform || '',
      pack.trigger_evidence?.source_quote || ''
    ].filter(Boolean).slice(0, 3),
    source: pack.trigger_evidence?.source_platform || pack.contact_plan?.recommended_channel_label || '',
    pack
  }));
  if (packItems.length >= 3) return packItems;

  const card = model?.card || run?.today_contact_card || null;
  const ladderItems = asArray(run?.priority_ladder_packet?.ladder);
  const leadItems = ladderItems.map((item, index) => ({
    title: item.lead_name || item.title || `推荐线索 ${index + 1}`,
    reason: item.why_now || item.reason || item.summary || '系统判断这条线索更适合今天先推进。',
    score: item.score_total || item.score || item.priority_score || '',
    evidence: asArray(item.evidence_lines || item.reasons || item.signals).slice(0, 3),
    source: item.source_label || item.source_kind || ''
  }));
  const todayItem = card ? [{
    title: card.lead_name || card.title || '今日第一通',
    reason: card.reason || card.summary || card.next_action || '这是当前最该先处理的今日对象。',
    score: card.score_total || '',
    evidence: [
      model.sourceLabel ? `来源：${model.sourceLabel}` : '',
      asArray(model.needSignals)[0]?.signal || asArray(model.needSignals)[0]?.label || '',
      asArray(model.messageAngles)[0]?.angle || asArray(model.messageAngles)[0]?.label || ''
    ].filter(Boolean),
    source: model.sourceLabel || ''
  }] : [];
  const fallbackLeadItems = asArray(run?.leads).slice(0, 5).map((lead, index) => ({
    title: leadDisplayName(lead) || `线索 ${index + 1}`,
    reason: lead.recommendation_reason || lead.reason || lead.industry || '已进入当前获客执行。',
    score: lead.score || lead.quality_score || '',
    evidence: [lead.source || lead.source_label || '', lead.industry || '', lead.tag || ''].filter(Boolean).slice(0, 3),
    source: lead.source || lead.source_label || ''
  }));
  const merged = [...packItems, ...todayItem, ...leadItems, ...fallbackLeadItems];
  const seen = new Set();
  return merged.filter((item) => {
    const key = `${item.title}::${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return item.title || item.reason;
  }).slice(0, 5);
}

function renderTodayCockpitPriorityStack(run, model = buildTodayMainlineModel(run)) {
  const items = buildTodayCockpitPriorityItems(run, model);
  const learning = run?.next_batch_learning_profile || run?.signal_learning_delta || null;
  const learningLine = learning?.summary || learning?.next_batch_reason || run?.next_batch_launch_plan?.launch_reason || '';
  return `
    <article class="today-mainline-card today-cockpit-priority-stack" data-today-cockpit="priority-stack">
      <div class="today-mainline-head">
        <div>
          <span class="chip success">今日焦点</span>
          <strong>Top ${items.length || 3} 今日推荐线索</strong>
          <p>先看谁最值得今天推进，再看证据、话术和右侧执行台；不要让老板在后台模块里找入口。</p>
        </div>
        <span class="chip info">${escapeHtml(leadRunStageLabel(run?.current_stage) || '执行中')}</span>
      </div>
      <div class="today-priority-list">
        ${(items.length ? items : [{ title: '等待推荐线索', reason: run?.next_recommended_action || '刷新来源、导入或评分后，这里会出现今天最该先联系的对象。', score: '', evidence: [] }]).map((item, index) => `
          <section class="today-priority-item">
            <div class="today-priority-rank">${index + 1}</div>
            <div>
              <strong>${escapeHtml(item.title)}</strong>
              <p>${escapeHtml(item.reason)}</p>
              <div class="today-priority-proofline">
                ${item.score ? `<code>匹配度 ${escapeHtml(String(item.score))}</code>` : '<code>待评分</code>'}
                ${(item.evidence || []).slice(0, 3).map((line) => `<code>${escapeHtml(String(line))}</code>`).join('')}
              </div>
            </div>
          </section>
        `).join('')}
      </div>
      <small>${escapeHtml(learningLine ? `下一批为什么更准：${learningLine}` : '下一批为什么更准：通话和回写结果会继续反哺来源、评分和话术。')}</small>
    </article>
  `;
}

function evidenceChainStrengthLabel(model) {
  const count = [
    asArray(model?.sourceEvidence).length,
    asArray(model?.painEvidence).length,
    asArray(model?.needSignals).length,
    asArray(model?.messageAngles).length
  ].filter((value) => value > 0).length;
  if (count >= 3) return { label: '证据强度：强', tone: 'success' };
  if (count === 2) return { label: '证据强度：中', tone: 'warning' };
  return { label: '证据强度：弱', tone: 'info' };
}

function renderTodayEvidenceChainCard(run, model = buildTodayMainlineModel(run)) {
  const strength = evidenceChainStrengthLabel(model);
  const sourceLine = asArray(model?.sourceEvidence)[0]?.evidence_text
    || asArray(model?.sourceEvidence)[0]?.summary
    || model?.sourceLabel
    || run?.today_contact_card?.source_task_title
    || '来源页证据待补齐';
  const painLine = asArray(model?.painEvidence)[0]?.pain
    || asArray(model?.painEvidence)[0]?.evidence_text
    || asArray(model?.painEvidence)[0]?.summary
    || '痛点证据待继续沉淀';
  const signalLine = asArray(model?.needSignals)[0]?.signal
    || asArray(model?.needSignals)[0]?.label
    || asArray(model?.messageAngles)[0]?.angle
    || '需求信号待通过回写验证';
  const scriptLine = run?.today_contact_card?.script_basis_pack?.summary
    || asArray(model?.messageAngles)[0]?.label
    || run?.today_contact_card?.script_snippet
    || '话术会优先承接当前证据链。';
  return `
    <article class="today-mainline-card today-evidence-chain-card" data-evidence-chain>
      <div class="today-mainline-head">
        <div>
          <span class="chip info">证据链</span>
          <strong>为什么推荐、为什么这样开口</strong>
          <p>把页面、视觉补位、GEO/评论痛点、需求信号和话术依据压成老板能读懂的四段链路。</p>
        </div>
        <span class="chip ${strength.tone}">${strength.label}</span>
      </div>
      <div class="today-evidence-chain-steps">
        <section><span>来源页</span><p>${escapeHtml(sourceLine)}</p></section>
        <section><span>痛点</span><p>${escapeHtml(painLine)}</p></section>
        <section><span>信号</span><p>${escapeHtml(signalLine)}</p></section>
        <section><span>话术依据</span><p>${escapeHtml(scriptLine)}</p></section>
      </div>
    </article>
  `;
}

function renderWorkbenchStarterPanel() {
  return `
    <div class="workbench-starter-grid">
      <article class="workbench-starter-card">
        <strong>1. 找谁</strong>
        <p>Agent 会把一句话目标拆成行业、区域、客户画像和来源任务。</p>
      </article>
      <article class="workbench-starter-card">
        <strong>2. 为什么先联系</strong>
        <p>中区会展示评分、来源证据、痛点信号和优先联系理由。</p>
      </article>
      <article class="workbench-starter-card">
        <strong>3. 怎么打</strong>
        <p>话术、呼叫入口、结果标签和下一步会连成一条执行链。</p>
      </article>
    </div>
  `;
}

function renderWorkbenchOutcomeDock(outcome) {
  const view = arguments[1] || null;
  const run = arguments[2] || null;
  const mount = $('#workbench-outcome-dock');
  if (!mount) return;
  mount.innerHTML = renderAgentWorkArea(outcome, view, run);
}

function renderAgentWorkArea(outcome, view = null, run = null) {
  const action = view?.current_action || null;
  const primary = action?.primary_cta || null;
  const primaryAttrs = leadRunActionDataAttrs(primary, run);
  const secondaryHtml = asArray(action?.secondary_actions).slice(0, 2).map((act) => {
    const attrs = leadRunActionDataAttrs(act, run);
    return `<button class="button secondary" data-agent-workbench-action="lead-run-action" data-lead-run-action-value="${escapeHtml(act.action || '')}"${attrs ? ` ${attrs}` : ''}>${escapeHtml(act.label || '操作')}</button>`;
  }).join('');
  const goal = $('#commander-goal')?.value || state.commander.goal || COMMANDER_TEMPLATES.lead_acquisition.goal;

  // Build next task preview from next_revenue_action or next_task
  let nextTaskHtml = '';
  if (outcome?.next_revenue_action) {
    const revenueAction = outcome.next_revenue_action;
    const actionLabel = revenueAction.primary_cta?.label || revenueAction.action_type || '下一步';
    const actionReason = revenueAction.why_this_action || '';
    nextTaskHtml = `
      <div class="next-task-preview">
        <strong>下一步：${escapeHtml(actionLabel)}</strong>
        ${actionReason ? `<small>${escapeHtml(actionReason)}</small>` : ''}
      </div>
    `;
  } else if (outcome?.next_task) {
    const taskReason = outcome.next_task.reason || '';
    nextTaskHtml = `
      <div class="next-task-preview">
        <strong>下一步：${escapeHtml(outcome.next_task.title || '')}</strong>
        ${taskReason ? `<small>${escapeHtml(taskReason)}</small>` : ''}
      </div>
    `;
  }
  
  // Build additional outcome sections
  let additionalOutcomeHtml = '';
  if (outcome?.revenue_action_writeback?.writeback_status) {
    additionalOutcomeHtml += `<p><strong>收入动作：</strong>${escapeHtml(outcome.revenue_action_writeback.writeback_status)} ${escapeHtml(outcome.revenue_action_writeback.next_action_hint || '')}</p>`;
  }
  if (outcome?.next_batch_recommendation?.queue_status) {
    additionalOutcomeHtml += `<p><strong>下一批：</strong>${escapeHtml(outcome.next_batch_recommendation.queue_status)} · ${Number(outcome.next_batch_recommendation.seed_count || 0)} 个 seed</p>`;
  }
  if (outcome?.next_batch_launch?.launch_status) {
    const launch = outcome.next_batch_launch;
    additionalOutcomeHtml += `<p><strong>下一批启动：</strong>${escapeHtml(launch.launch_status)} ${escapeHtml(launch.launched_run_id || launch.blocking_reason || launch.launch_reason || '')}</p>`;
  }
  if (outcome?.channel_adapter_status?.receipt_status) {
    additionalOutcomeHtml += `<p><strong>渠道执行：</strong>${escapeHtml(outcome.channel_adapter_status.receipt_status)} ${escapeHtml(outcome.channel_adapter_status.failure_reason || '')}</p>`;
  }
  
  const drawerButton = asArray(view?.drawer_payloads).length
    ? `<button class="button ghost" data-agent-workbench-action="open-drawer" data-drawer-key="${escapeHtml(view.drawer_payloads[0].key)}">查看依据</button>`
    : '<button class="button ghost" data-agent-workbench-action="open-drawer" data-drawer-key="evidence">查看依据</button>';
  const primaryPack = run?.primary_prospect_outreach_pack
    || run?.lead_acquisition_workbench_view?.primary_prospect_outreach_pack
    || view?.primary_prospect_outreach_pack
    || null;
  const secondaryActionLabel = primaryPack?.contact_plan?.recommended_channel === 'phone'
    ? '呼叫今日对象'
    : (primaryPack?.primary_cta?.label || '去联系今日对象');
  const secondaryActionMode = primaryPack?.contact_plan?.recommended_channel === 'phone' ? 'call' : 'outreach';

  return `
    <div class="workbench-outcome-dock-content">
      <p class="workbench-zone-kicker">Agent Workspace</p>
      <h3>Agent 干活区</h3>
      ${renderAgentPresenceRail(run, outcome, action)}
      ${renderAgentCallConsole(run)}
      ${renderAgentOutcomeRail(run)}
      ${renderAgentIntelligenceBrief(run, outcome, action)}
      ${run ? `
        <p>${escapeHtml(outcome?.summary || action?.summary || 'Agent 会在这里集中推进联系、回写、刷新话术和打开依据。')}</p>
      ` : `
        <label class="agent-goal-composer">
          <span>今天要 Agent 帮你拿什么客户？</span>
          <textarea data-agent-goal-input rows="5">${escapeHtml(goal)}</textarea>
        </label>
      `}
      <div class="workbench-action-buttons agent-workbench-actions">
        ${run && primary
          ? `<button class="button ${escapeHtml(primary.tone || 'primary')}" data-agent-workbench-action="lead-run-action" data-lead-run-action-value="${escapeHtml(primary.action || '')}"${primaryAttrs ? ` ${primaryAttrs}` : ''}>${escapeHtml(primary.label || '继续推进')}</button>`
          : '<button class="button primary" data-agent-workbench-action="create-run">创建获客执行</button>'}
        ${run ? (secondaryActionMode === 'call'
          ? '<button class="button secondary" data-agent-workbench-action="call">呼叫今日对象</button>'
          : `<button class="button secondary" data-agent-workbench-action="lead-run-action" data-lead-run-action-value="outreach-contact">${escapeHtml(secondaryActionLabel)}</button>`) : ''}
        ${run ? '<button class="button secondary" data-agent-workbench-action="writeback">写结果 / 下一步</button>' : ''}
        <button class="button ghost" data-agent-workbench-action="refresh">刷新</button>
        ${drawerButton}
        ${secondaryHtml}
      </div>
      ${additionalOutcomeHtml}
      ${nextTaskHtml}
      ${renderAuthorProfileFollowUpPreview(run)}
      ${renderAgentLearningPreview(run, outcome)}
      <span class="chip ${outcomeDeliveryTone(outcome?.delivery_status)}">${outcomeDeliveryLabel(outcome?.delivery_status)}</span>
    </div>
  `;
}

function buildAgentPresenceSteps(run, outcome = null, action = null) {
  const card = run?.today_contact_card || null;
  const leadName = card?.lead_name || leadDisplayName(card?.lead || null) || card?.phone || '今日优先线索';
  const currentAction = action?.primary_cta?.label || run?.next_recommended_action || outcome?.next_action || '继续推进获客执行';
  if (!run) {
    const goal = $('#commander-goal')?.value || state.commander.goal || COMMANDER_TEMPLATES.lead_acquisition.goal;
    return [
      { label: '已理解', detail: truncateText(`你的目标是：${goal}`, 92), tone: 'ready' },
      { label: '正在判断', detail: 'Agent 会把目标拆成行业、区域、客户画像、来源任务和今日动作。', tone: 'working' },
      { label: '等待你确认', detail: '先点击创建获客执行，系统才会写入 run 并开始排今日优先线索。', tone: 'waiting' },
      { label: '确认后继续', detail: '创建后会生成线索、证据、话术、呼叫入口和结果回写链。', tone: 'next' }
    ];
  }
  const evidenceText = card?.reason
    || card?.summary
    || run?.summary
    || '正在把来源证据、评分、话术和下一步收口到当前执行。';
  const waitText = action?.approval_required
    ? '高风险动作已停下，等待你确认后再继续执行。'
    : action?.primary_cta?.action === 'outreach-contact'
      ? '等待你复制话术、去推荐渠道触达，并一键回写结果。'
      : card
        ? '等待你去联系、发消息或点选结果回写。'
        : '等待补齐可联系线索或刷新今日执行队列。';
  return [
    { label: '已理解', detail: truncateText(`${run.goal || '当前获客执行'} · 当前对象：${leadName}`, 92), tone: 'ready' },
    { label: '正在判断', detail: truncateText(evidenceText, 98), tone: 'working' },
    { label: '等待你确认', detail: waitText, tone: 'waiting' },
    { label: '确认后继续', detail: truncateText(`${currentAction}；随后刷新下一步、交付状态和下一批学习。`, 98), tone: 'next' }
  ];
}

function renderAgentPresenceRail(run, outcome = null, action = null) {
  const steps = buildAgentPresenceSteps(run, outcome, action);
  return `
    <section class="agent-presence-rail" aria-label="Agent 正在做什么">
      <div class="agent-presence-head">
        <strong>Agent 正在做什么</strong>
        <span>智能执行感</span>
      </div>
      <p class="agent-thinking-line">不是聊天框，是围绕当前获客 Run 的理解、判断、确认和继续执行。</p>
      <div class="agent-presence-steps">
        ${steps.map((step) => `
          <article class="agent-presence-step ${agentPresenceToneClass(step.tone)}">
            <span>${escapeHtml(step.label)}</span>
            <p>${escapeHtml(step.detail)}</p>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function agentPresenceToneClass(tone) {
  const validTones = new Set(['ready', 'working', 'waiting', 'next']);
  return validTones.has(tone) ? tone : 'next';
}

function renderAgentIntelligenceBrief(run, outcome = null, action = null) {
  const pack = resolvePrimaryOutreachPack(run);
  const card = run?.today_contact_card || null;
  const actionLabel = action?.primary_cta?.label || pack?.primary_cta?.label || outcome?.next_revenue_action?.primary_cta?.label || '联系 / 回写 / 下一步';
  const basis = pack?.agent_reasoning
    || card?.script_basis_pack?.summary
    || card?.reason
    || run?.signal_packet?.summary
    || outcome?.summary
    || '依据当前线索、证据强度、话术和回写状态做下一步判断。';
  const risk = action?.approval_required
    ? '需要确认后才执行，避免 Agent 自动外发高风险动作。'
    : pack && pack.contact_plan?.recommended_channel !== 'phone'
      ? '当前优先平台私信/评论触达；复制话术后手动联系，再用一键回写推进下一批学习。'
      : card?.phone
        ? '当前可先联系；打完结果会直接回写到同一条获客执行。'
        : '如果联系方式或证据不足，Agent 会把这条转为修复或下一步补证据。';
  return `
    <section class="agent-intelligence-brief" aria-label="Agent 判断依据">
      <strong>Agent 判断依据</strong>
      <p><span>建议动作</span>${escapeHtml(actionLabel)}</p>
      <p><span>为什么</span>${escapeHtml(truncateText(basis, 110))}</p>
      <p><span>边界</span>${escapeHtml(risk)}</p>
    </section>
  `;
}

function resolvePrimaryOutreachPack(run) {
  return run?.primary_prospect_outreach_pack
    || run?.lead_acquisition_workbench_view?.primary_prospect_outreach_pack
    || asArray(run?.prospect_outreach_packs || run?.lead_acquisition_workbench_view?.prospect_outreach_packs)[0]
    || null;
}

function isPhonePrimaryOutreachRun(run) {
  const pack = resolvePrimaryOutreachPack(run);
  if (pack) return pack.contact_plan?.recommended_channel === 'phone';
  const action = run?.lead_acquisition_workbench_view?.current_action;
  if (action?.primary_cta?.action === 'call-first') return true;
  return Boolean(run?.today_contact_card?.phone);
}

function renderAgentOutcomeRail(run) {
  if (!run) return '';
  const pack = resolvePrimaryOutreachPack(run);
  if (pack && pack.contact_plan?.recommended_channel !== 'phone') {
    const options = asArray(pack.writeback_options).slice(0, 5);
    return `
      <section class="agent-outcome-rail" aria-label="一键触达回写">
        <strong>联系后直接点结果</strong>
        <p>回写「${escapeHtml(pack.display_name || '当前对象')}」后，系统会刷新下一步建议、交付状态和下一批学习。</p>
        <div class="agent-outcome-buttons">
          ${options.map((option) => `
            <button type="button" class="button ghost"
              data-lead-run-action="outreach-writeback"
              data-writeback-key="${escapeHtml(option.key || '')}"
              data-writeback-label="${escapeHtml(option.label || '')}"
              data-pack-id="${escapeHtml(pack.pack_id || pack.lead_id || '')}"
              data-pack-name="${escapeHtml(pack.display_name || '')}"
              data-lead-id="${escapeHtml(pack.lead_id || '')}">
              ${escapeHtml(option.label || option.key || '回写')}
            </button>
          `).join('')}
        </div>
      </section>
    `;
  }

  const card = run.today_contact_card || null;
  const taskId = card?.task_id || '';
  const options = [
    { label: '接通-感兴趣', value: 'interested' },
    { label: '要资料', value: 'callback_requested' },
    { label: '拒绝', value: 'disqualified' },
    { label: '未接', value: 'no_response' }
  ];
  return `
    <section class="agent-outcome-rail" aria-label="一键结果回写">
      <strong>打完直接点结果</strong>
      <p>结果写回后，系统会立即刷新下一步建议、交付状态和下一批学习。</p>
      <div class="agent-outcome-buttons">
        ${options.map((option) => taskId
          ? `<button type="button" class="button ghost" data-task-outcome-quick data-task-id="${escapeHtml(taskId)}" data-outcome-value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</button>`
          : `<button type="button" class="button ghost" data-agent-workbench-action="writeback">${escapeHtml(option.label)}</button>`
        ).join('')}
      </div>
    </section>
  `;
}

function renderAuthorProfileFollowUpPreview(run) {
  const followUp = run?.discovery_mission_packet?.author_profile_follow_up
    || run?.public_source_adapter?.discovery_mission_packet?.author_profile_follow_up
    || null;
  if (!followUp || typeof followUp !== 'object') return '';
  const pendingCount = Number(followUp.pending_count || 0);
  const completedCount = Number(followUp.completed_count || 0);
  const status = String(followUp.status || '');
  if (!pendingCount && !completedCount && status !== 'ready' && status !== 'queued') return '';

  const summary = pendingCount
    ? `Agent 正在追读 ${pendingCount} 个作者主页，补全触达依据。`
    : status === 'ready' || completedCount
      ? `已完成 ${completedCount || 1} 个作者主页追读，触达包可交叉验证需求。`
      : '作者主页追读已排队。';
  const missions = asArray(followUp.missions).slice(0, 3);
  const autoplayCount = Number(
    run?.public_source_adapter?.mission_autoplay_guard?.author_profile_autoplay_count
    || run?.mission_autoplay_guard?.author_profile_autoplay_count
    || 0
  );

  return `
    <section class="author-profile-follow-up-preview">
      <div class="author-profile-follow-up-head">
        <strong>作者主页追读</strong>
        <span class="chip ${pendingCount ? 'info' : 'success'}">${escapeHtml(pendingCount ? `排队 ${pendingCount}` : '已追读')}</span>
      </div>
      <p>${escapeHtml(summary)}${autoplayCount ? ` 本轮回写已自动执行 ${autoplayCount} 次。` : ''}</p>
      ${missions.length ? `
        <ul>
          ${missions.map((mission) => `
            <li>
              <code>${escapeHtml(mission.author_name || '待补作者')}</code>
              <span>${escapeHtml(mission.status === 'done' ? '已完成' : '待追读')}</span>
            </li>
          `).join('')}
        </ul>
      ` : ''}
    </section>
  `;
}

function buildOutreachLearningHistory(run) {
  const snapshots = asArray(run?.particle_snapshots).filter((item) => {
    return String(item?.particle_key || '') === 'next_batch_learning_profile';
  });
  return snapshots
    .map((snapshot) => {
      const payload = snapshot?.payload && typeof snapshot.payload === 'object' ? snapshot.payload : {};
      return {
        recorded_at: snapshot?.updated_at || snapshot?.created_at || '',
        source_stage: snapshot?.source_ref || snapshot?.source_stage || '',
        profile_status: payload.profile_status || 'partial',
        learning_source: payload.learning_source || '',
        learning_summary: payload.learning_summary || payload.summary || '',
        buyer_signals: asArray(payload.buyer_signals_to_seek).slice(0, 3),
        script_lessons: asArray(payload.script_lessons).slice(0, 2)
      };
    })
    .sort((a, b) => String(b.recorded_at).localeCompare(String(a.recorded_at)))
    .slice(0, 6);
}

function renderAgentLearningPreview(run, outcome = null) {
  if (!run) return '';
  const profile = run.next_batch_learning_profile || run.signal_learning_delta || null;
  const launch = run.next_batch_launch_plan || outcome?.next_batch_launch || null;
  const seedQueue = run.next_batch_seed_queue || null;
  const history = buildOutreachLearningHistory(run);
  const summary = profile?.learning_summary
    || profile?.summary
    || launch?.launch_reason
    || launch?.summary
    || '本轮回写会继续校准来源、匹配度、话术和下一批 seed。';
  const status = launch?.launch_status || profile?.profile_status || profile?.status || 'learning';
  const buyerSignals = asArray(profile?.buyer_signals_to_seek).slice(0, 3);
  const scriptLessons = asArray(profile?.script_lessons).slice(0, 2);
  const seeds = asArray(seedQueue?.seed_items).slice(0, 3);
  return `
    <section class="agent-learning-preview">
      <div class="agent-learning-head">
        <strong>下一批为什么更准</strong>
        <span class="chip ${status === 'ready' ? 'success' : 'info'}">${escapeHtml(`学习 ${status}`)}</span>
      </div>
      <p>${escapeHtml(summary)}</p>
      ${buyerSignals.length ? `
        <div class="agent-learning-tags">
          ${buyerSignals.map((signal) => `<code>${escapeHtml(signal)}</code>`).join('')}
        </div>
      ` : ''}
      ${scriptLessons.length ? `
        <ul class="agent-learning-lessons">
          ${scriptLessons.map((lesson) => `<li>${escapeHtml(lesson)}</li>`).join('')}
        </ul>
      ` : ''}
      ${seeds.length ? `
        <div class="agent-learning-seeds">
          <small>下一批 seed</small>
          ${seeds.map((seed) => `<code>${escapeHtml(seed.query || seed.seed_id || 'seed')}</code>`).join('')}
        </div>
      ` : ''}
      ${history.length ? `
        <div class="agent-learning-history">
          <strong>学习历史</strong>
          <ul>
            ${history.map((entry) => `
              <li>
                <span>${escapeHtml(entry.recorded_at ? formatDateTime(entry.recorded_at) : '最近')}</span>
                <span class="chip ${entry.profile_status === 'ready' ? 'success' : 'info'}">${escapeHtml(entry.profile_status)}</span>
                <p>${escapeHtml(truncateText(entry.learning_summary || entry.source_stage, 120))}</p>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}
    </section>
  `;
}

function renderAgentCallConsole(run) {
  if (run && !isPhonePrimaryOutreachRun(run)) return '';
  const target = resolveWorkbenchCallTarget(run);
  const activeSession = state.ui.focusedCallSessionId
    ? asArray(state.data?.callCenter?.recent_sessions).find((session) => String(session.id || '') === String(state.ui.focusedCallSessionId))
    : null;
  const card = run?.today_contact_card || null;
  const script = card?.micro_script || run?.writeback_confirmation_card?.micro_script || null;
  const phone = target.phone || card?.phone || '';
  const leadName = target.leadName || card?.lead_name || '今日对象';
  const statusText = activeSession
    ? `当前通话：${activeSession.status || 'active'}`
    : phone
      ? '号码已就绪，点击呼叫后会创建外呼会话'
      : '当前还缺号码，先补联系方式或推进今日队列';
  return `
    <section class="workbench-call-console" aria-label="呼叫模块">
      <div class="workbench-call-console-head">
        <div>
          <strong>呼叫模块</strong>
          <small>${escapeHtml(leadName)}</small>
        </div>
        <span class="chip ${phone ? 'success' : 'warning'}">${phone ? '可呼叫' : '待补号码'}</span>
      </div>
      <div class="workbench-call-phone-row">
        <input data-agent-call-phone inputmode="tel" autocomplete="tel" value="${escapeHtml(phone)}" placeholder="输入或补充电话号码" aria-label="呼叫号码" />
        <button class="button primary" data-agent-workbench-action="agent-call">呼叫</button>
      </div>
      <div class="workbench-call-script">
        <strong>通话开口</strong>
        ${script ? renderLeadMicroScriptBrief(script) : `<p>${escapeHtml(card?.script_snippet || card?.next_action || '先确认对方当前需求、预算/时间和是否方便继续沟通。')}</p>`}
      </div>
      <div class="workbench-call-status">
        <small>${escapeHtml(statusText)}</small>
        <button class="button secondary" data-agent-workbench-action="writeback">记录结果 / 接下一步</button>
      </div>
    </section>
  `;
}

function resolveWorkbenchCallTarget(run) {
  if (!run) return { lead: null, phone: '', leadName: '' };
  const lead = selectLeadForImmediateCall(run);
  const card = run.today_contact_card || null;
  const fallbackLead = lead || (card?.phone ? {
    id: card.lead_id || '',
    contact_phone: card.phone || '',
    contact_name: card.lead_name || card.title || ''
  } : null);
  return {
    lead: fallbackLead,
    phone: fallbackLead?.contact_phone || card?.phone || '',
    leadName: fallbackLead ? leadDisplayName(fallbackLead) : card?.lead_name || ''
  };
}

async function handleAgentWorkbenchAction(action, button) {
  if (action === 'create-run') {
    syncAgentGoalInput(button);
    await handleLeadRunAction('create', button);
    return;
  }
  if (action === 'refresh') {
    const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
    if (run?.id) {
      await handleLeadRunAction('refresh', button);
      return;
    }
    await refresh();
    toast('已刷新当前页面');
    return;
  }
  if (action === 'open-drawer') {
    const key = button.dataset.drawerKey || 'evidence';
    const drawer = $('#workbench-detail-drawer');
    if (!drawer || !drawer.querySelector(`[data-workbench-drawer-panel="${CSS.escape(key)}"]`)) {
      toast('创建执行后会在这里展开证据、话术和交付包');
      return;
    }
    openWorkbenchDrawer(key);
    return;
  }
  if (action === 'lead-run-action') {
    await handleLeadRunAction(button.dataset.leadRunActionValue || '', button);
    return;
  }
  if (action === 'call') {
    await handleAgentWorkbenchAction('agent-call', button);
    return;
  }
  if (action === 'agent-call') {
    const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
    const target = resolveWorkbenchCallTarget(run);
    const phone = String(button.closest('.workbench-call-console')?.querySelector('[data-agent-call-phone]')?.value || target.phone || '').trim();
    const phoneInput = $('#call-phone');
    if (phoneInput && phone) phoneInput.value = phone;
    if (run && target.lead?.contact_phone) {
      preloadLeadRunCall(run, target.lead, buildLeadRunCallContext(run, target.lead, run.today_contact_card || null));
      if (phoneInput) phoneInput.value = phone;
    }
    if (phone) {
      try {
        await placeOutboundCall();
      } catch (error) {
        toast('呼叫失败，请稍后重试');
      }
      return;
    }
    toast('当前 run 还没有今日联系对象');
    return;
  }
  if (action === 'writeback') {
    const run = state.data.activeLeadRun || state.commander.lastLeadRun || null;
    if (!run?.id) {
      toast('请先创建获客执行');
      return;
    }
    await handleLeadRunAction('outcome', button);
  }
}

function syncAgentGoalInput(button) {
  const input = button.closest('.workbench-outcome-dock')?.querySelector('[data-agent-goal-input]');
  if (!input) return;
  const goal = String(input.value || '').trim();
  if (!goal) return;
  const commanderGoal = $('#commander-goal');
  if (commanderGoal) commanderGoal.value = goal;
  state.commander.goal = goal;
  state.commander.templateKey = inferCommanderTemplateKey(goal) || 'lead_acquisition';
  renderCommanderFields(state.commander.templateKey, mergeCommanderMissingInputs(state.commander.templateKey));
  persistCommanderState();
}

function renderWorkbenchDetailDrawer(drawers) {
  const mount = $('#workbench-detail-drawer');
  if (!mount) return;
  if (!drawers || drawers.length === 0) {
    mount.innerHTML = '';
    mount.setAttribute('aria-hidden', 'true');
    return;
  }
  mount.innerHTML = `
    <div class="workbench-drawer-header">
      <h4>当前动作依据</h4>
      <button class="button ghost" data-workbench-drawer-close aria-label="关闭抽屉">关闭</button>
    </div>
    <nav class="workbench-drawer-tabs">
      ${drawers.map((item) => `
        <button type="button" data-workbench-drawer="${escapeHtml(item.key)}">${escapeHtml(workbenchDrawerLabel(item.key))}</button>
      `).join('')}
    </nav>
    ${drawers.map((item) => `
      <div class="workbench-drawer-panel" data-workbench-drawer-panel="${escapeHtml(item.key)}" hidden>
        <pre>${escapeHtml(JSON.stringify(item.content, null, 2))}</pre>
      </div>
    `).join('')}
  `;
  mount.setAttribute('aria-hidden', 'true');
}

function workbenchDrawerLabel(key) {
  const labels = {
    evidence: '证据与来源',
    script_basis: '话术依据',
    execution_log: '执行记录',
    sellable_delivery: '交付包',
    learning_delta: '学习差量',
    execution_receipt: '执行回执',
    revenue_action: '收入动作',
    next_batch_learning: '下一批学习',
    next_batch_launch: '下一批启动',
    channel_adapter: '渠道执行'
  };
  return labels[key] || key;
}

function leadRunActionDataAttrs(cta, run) {
  if (!cta) return '';
  const attrs = [];
  const leadId = run?.today_contact_card?.lead_id || '';
  const taskId = run?.today_contact_card?.task_id || '';
  if (leadId) attrs.push(`data-lead-id="${escapeHtml(String(leadId))}"`);
  if (taskId) attrs.push(`data-task-id="${escapeHtml(String(taskId))}"`);
  return attrs.join(' ');
}

function outcomeDeliveryTone(status) {
  if (status === 'ready') return 'success';
  if (status === 'partial') return 'warning';
  if (status === 'blocked') return 'danger';
  return 'info';
}

function outcomeDeliveryLabel(status) {
  const labels = {
    ready: '可交付',
    partial: '部分完成',
    blocked: '阻塞',
    draft: '草稿'
  };
  return labels[status] || status || '待确认';
}

function openWorkbenchDrawer(key) {
  const drawer = $('#workbench-detail-drawer');
  if (!drawer) return;
  drawer.setAttribute('aria-hidden', 'false');
  drawer.classList.add('open');
  drawer.querySelectorAll('[data-workbench-drawer-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.workbenchDrawerPanel !== key;
  });
}

function closeWorkbenchDrawer() {
  const drawer = $('#workbench-detail-drawer');
  if (!drawer) return;
  drawer.setAttribute('aria-hidden', 'true');
  drawer.classList.remove('open');
  drawer.querySelectorAll('[data-workbench-drawer-panel]').forEach((panel) => {
    panel.hidden = true;
  });
}
