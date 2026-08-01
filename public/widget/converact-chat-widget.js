(function () {
  const script = document.currentScript;
  const tenantId = script?.getAttribute('data-tenant-id') || '';
  const apiBase = script?.getAttribute('data-api-base') || '';
  const title = script?.getAttribute('data-title') || 'Converact 在线客服';
  const primary = script?.getAttribute('data-color') || '#2563eb';

  if (!tenantId) {
    console.warn('[converact-chat] data-tenant-id is required');
    return;
  }

  let conversationId = '';
  let open = false;

  const root = document.createElement('div');
  root.id = 'converact-chat-root';
  root.innerHTML = `
    <style>
      #converact-chat-root { position: fixed; right: 20px; bottom: 20px; z-index: 99999; font-family: system-ui, sans-serif; }
      #converact-chat-toggle { width: 56px; height: 56px; border-radius: 50%; border: none; background: ${primary}; color: #fff; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.2); font-size: 22px; }
      #converact-chat-panel { display: none; width: 340px; height: 460px; background: #fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.18); overflow: hidden; flex-direction: column; margin-bottom: 12px; }
      #converact-chat-panel.open { display: flex; }
      #converact-chat-header { background: ${primary}; color: #fff; padding: 12px 14px; font-weight: 600; }
      #converact-chat-messages { flex: 1; overflow-y: auto; padding: 12px; background: #f8fafc; }
      .converact-msg { margin-bottom: 10px; max-width: 85%; padding: 8px 10px; border-radius: 10px; font-size: 14px; line-height: 1.4; }
      .converact-msg.customer { background: #e2e8f0; margin-right: auto; }
      .converact-msg.bot { background: #dbeafe; margin-left: auto; }
      #converact-chat-input-row { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e2e8f0; }
      #converact-chat-input { flex: 1; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; font-size: 14px; }
      #converact-chat-send { border: none; background: ${primary}; color: #fff; border-radius: 8px; padding: 8px 12px; cursor: pointer; }
    </style>
    <div id="converact-chat-panel">
      <div id="converact-chat-header">${title}</div>
      <div id="converact-chat-messages"></div>
      <div id="converact-chat-input-row">
        <input id="converact-chat-input" placeholder="输入消息..." />
        <button id="converact-chat-send">发送</button>
      </div>
    </div>
    <button id="converact-chat-toggle" aria-label="打开聊天">💬</button>
  `;
  document.body.appendChild(root);

  const panel = root.querySelector('#converact-chat-panel');
  const messages = root.querySelector('#converact-chat-messages');
  const input = root.querySelector('#converact-chat-input');
  const toggle = root.querySelector('#converact-chat-toggle');
  const sendBtn = root.querySelector('#converact-chat-send');

  function appendMessage(text, role) {
    const el = document.createElement('div');
    el.className = `converact-msg ${role}`;
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  async function sendMessage() {
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    appendMessage(content, 'customer');

    try {
      const res = await fetch(`${apiBase}/api/call-center/omni/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          content,
          conversation_id: conversationId || undefined
        })
      });
      const json = await res.json();
      const data = json.data || json;
      if (data.conversation_id) conversationId = data.conversation_id;
      if (data.reply) appendMessage(data.reply, 'bot');
    } catch (err) {
      appendMessage('发送失败，请稍后重试。', 'bot');
      console.error('[converact-chat]', err);
    }
  }

  toggle.addEventListener('click', () => {
    open = !open;
    panel.classList.toggle('open', open);
  });
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  appendMessage('您好，有什么可以帮您？', 'bot');
})();
