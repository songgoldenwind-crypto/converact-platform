import { createDatabase } from '../src/db.js';
import { createChannel, createLandingPage, createSourceTag, createTenant, submitInquiry } from '../src/services.js';

const db = createDatabase();

const tenant = createTenant(db, { name: '演示一人公司' });
const channel = createChannel(db, {
  tenant_id: tenant.id,
  platform_code: 'xiaohongshu',
  target_goal: '预约咨询'
});
const sourceTag = createSourceTag(db, {
  tenant_id: tenant.id,
  channel_id: channel.id,
  entry_point: 'bio_link',
  slug: 'growth-diagnosis'
});
const page = createLandingPage(db, {
  tenant_id: tenant.id,
  source_tag_id: sourceTag.id,
  title: '免费增长诊断',
  slug: 'growth-diagnosis',
  headline: '帮一人公司判断下一个最值得做的获客动作',
  subheadline: '提交问题后，系统会自动进入咨询池、评分并创建跟进任务。',
  status: 'live'
});
const inquiry = submitInquiry(db, {
  tenant_id: tenant.id,
  landing_page_id: page.id,
  source_tag_id: sourceTag.id,
  name: '王老板',
  email: 'founder@example.com',
  phone: '+8613800000000',
  message: '我想预约一次增长诊断，看看价格和方案，最好今天能聊。'
});

console.log(
  JSON.stringify(
    {
      tenant,
      channel,
      sourceTag,
      page,
      inquiry,
      open: `http://localhost:3000/p/${page.slug}?source_tag_id=${sourceTag.id}`
    },
    null,
    2
  )
);
