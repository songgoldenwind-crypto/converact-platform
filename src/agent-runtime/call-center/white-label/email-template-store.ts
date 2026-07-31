import { all, id, one, run } from '../../../db.js';

export type EmailTemplateKey = 'welcome' | 'password_reset' | 'call_summary' | 'omni_reply';

export interface EmailTemplate {
  id: string;
  tenant_id: string;
  template_key: EmailTemplateKey;
  subject: string;
  body_html: string;
  body_text: string;
  updated_at: string;
}

const DEFAULT_TEMPLATES: Record<EmailTemplateKey, { subject: string; body_html: string; body_text: string }> = {
  welcome: {
    subject: '欢迎使用 {{brand_name}}',
    body_html: '<p>您好 {{customer_name}}，欢迎加入 {{brand_name}}。</p>',
    body_text: '您好 {{customer_name}}，欢迎加入 {{brand_name}}。'
  },
  password_reset: {
    subject: '{{brand_name}} 密码重置',
    body_html: '<p>请点击链接重置密码：{{reset_link}}</p>',
    body_text: '请访问 {{reset_link}} 重置密码。'
  },
  call_summary: {
    subject: '{{brand_name}} 通话摘要',
    body_html: '<p>通话时间：{{call_time}}<br/>摘要：{{summary}}</p>',
    body_text: '通话时间：{{call_time}}\n摘要：{{summary}}'
  },
  omni_reply: {
    subject: 'Re: {{conversation_subject}}',
    body_html: '<p>{{agent_name}} 回复：</p><p>{{message_body}}</p>',
    body_text: '{{agent_name}} 回复：\n{{message_body}}'
  }
};

export class EmailTemplateStore {
  constructor(private readonly db: unknown) {}

  list(tenantId: string): EmailTemplate[] {
    const rows = all(
      this.db,
      'SELECT * FROM white_label_email_templates WHERE tenant_id = ? ORDER BY template_key',
      [tenantId]
    );
    const existing = new Map(
      rows.map((r) => [String((r as { template_key: string }).template_key), decode(r as Record<string, unknown>)])
    );
    return (Object.keys(DEFAULT_TEMPLATES) as EmailTemplateKey[]).map((key) => {
      if (existing.has(key)) return existing.get(key)!;
      return this.defaultTemplate(tenantId, key);
    });
  }

  get(tenantId: string, templateKey: EmailTemplateKey): EmailTemplate {
    const row = one(this.db, 'SELECT * FROM white_label_email_templates WHERE tenant_id = ? AND template_key = ?', [
      tenantId,
      templateKey
    ]);
    return row ? decode(row as Record<string, unknown>) : this.defaultTemplate(tenantId, templateKey);
  }

  upsert(
    tenantId: string,
    templateKey: EmailTemplateKey,
    patch: Partial<Pick<EmailTemplate, 'subject' | 'body_html' | 'body_text'>>
  ): EmailTemplate {
    const existing = one(this.db, 'SELECT id FROM white_label_email_templates WHERE tenant_id = ? AND template_key = ?', [
      tenantId,
      templateKey
    ]);
    if (!existing) {
      const defaults = DEFAULT_TEMPLATES[templateKey];
      run(
        this.db,
        `INSERT INTO white_label_email_templates (id, tenant_id, template_key, subject, body_html, body_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id('etpl'),
          tenantId,
          templateKey,
          patch.subject ?? defaults.subject,
          patch.body_html ?? defaults.body_html,
          patch.body_text ?? defaults.body_text
        ]
      );
    } else {
      const fields: string[] = [];
      const params: string[] = [];
      if (patch.subject !== undefined) {
        fields.push('subject = ?');
        params.push(patch.subject);
      }
      if (patch.body_html !== undefined) {
        fields.push('body_html = ?');
        params.push(patch.body_html);
      }
      if (patch.body_text !== undefined) {
        fields.push('body_text = ?');
        params.push(patch.body_text);
      }
      if (fields.length) {
        fields.push('updated_at = CURRENT_TIMESTAMP');
        params.push(String((existing as { id: string }).id));
        run(this.db, `UPDATE white_label_email_templates SET ${fields.join(', ')} WHERE id = ?`, params);
      }
    }
    return this.get(tenantId, templateKey);
  }

  private defaultTemplate(tenantId: string, templateKey: EmailTemplateKey): EmailTemplate {
    const defaults = DEFAULT_TEMPLATES[templateKey];
    return {
      id: `default_${templateKey}`,
      tenant_id: tenantId,
      template_key: templateKey,
      subject: defaults.subject,
      body_html: defaults.body_html,
      body_text: defaults.body_text,
      updated_at: new Date().toISOString()
    };
  }
}

export function renderEmailTemplate(
  template: Pick<EmailTemplate, 'subject' | 'body_html' | 'body_text'>,
  variables: Record<string, string>
): { subject: string; body_html: string; body_text: string } {
  return {
    subject: interpolate(template.subject, variables),
    body_html: interpolate(template.body_html, variables),
    body_text: interpolate(template.body_text, variables)
  };
}

function interpolate(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? '');
}

function decode(row: Record<string, unknown>): EmailTemplate {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    template_key: String(row.template_key) as EmailTemplateKey,
    subject: String(row.subject),
    body_html: String(row.body_html),
    body_text: String(row.body_text),
    updated_at: String(row.updated_at)
  };
}
