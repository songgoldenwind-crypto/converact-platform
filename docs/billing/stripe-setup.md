# Stripe 订阅配置指南

> 本指南帮助你在 Stripe Dashboard 创建产品/价格、配置环境变量、测试 webhook。
> 代码侧已完全就绪（SDK 接真、webhook 签名验证、幂等去重、5 事件处理）。

## 1. 创建 Stripe 产品和价格

### 1.1 Pro 计划

1. 登录 [Stripe Dashboard](https://dashboard.stripe.com/products)
2. 点击 **添加产品**
3. 名称：`OPC Pro`
4. 描述：`Pro plan — 20 seats, 2000 AI minutes/month`
5. 定价模式：**标准定价**
6. 价格：**$29 USD / 月**
7. 点击 **保存产品**
8. 在产品详情页，复制 **Price ID**（格式 `price_xxxx`）

### 1.2 Enterprise 计划

1. 再次 **添加产品**
2. 名称：`OPC Enterprise`
3. 描述：`Enterprise plan — unlimited seats, unlimited AI minutes`
4. 价格：**$59 USD / 月**
5. 保存后复制 **Price ID**

## 2. 配置环境变量

在 `.env` 文件中填入：

```bash
# Stripe 密钥（从 Dashboard > Developers > API keys 获取）
STRIPE_SECRET_KEY=sk_live_xxxx        # 生产用 sk_live_，测试用 sk_test_

# Webhook 签名密钥（见下方第 3 步）
STRIPE_WEBHOOK_SECRET=whsec_xxxx

# 产品价格 ID（从第 1 步复制）
STRIPE_PRICE_PRO=price_xxxx
STRIPE_PRICE_ENTERPRISE=price_xxxx

# 公网回调地址（Checkout 成功/取消后跳转）
OPC_BASE_URL=https://your-domain.com
```

## 3. 配置 Webhook

### 3.1 本地开发（Stripe CLI）

```bash
# 安装 Stripe CLI: https://stripe.com/docs/stripe-cli
stripe login

# 转发 webhook 到本地 OPC
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# 输出会显示 whsec_xxxx，填入 STRIPE_WEBHOOK_SECRET
```

### 3.2 生产环境

1. Dashboard > Developers > Webhooks > **添加端点**
2. URL: `https://your-domain.com/api/webhooks/stripe`
3. 事件选择：
   - `checkout.session.completed`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. 创建后复制 **Signing secret**（`whsec_xxxx`）

## 4. 测试

### 4.1 测试 Checkout

```bash
# 用 API 触发 checkout（需认证）
curl -X POST http://localhost:3000/api/billing/checkout \
  -H "X-API-Key: $OPC_API_KEY" \
  -H "X-Tenant-Id: your-tenant-id" \
  -H "Content-Type: application/json" \
  -d '{"plan_code": "pro"}'

# 返回 { "url": "https://checkout.stripe.com/c/..." }
# 用浏览器打开 URL，用测试卡 4242 4242 4242 4242 完成支付
```

### 4.2 验证 Webhook

```bash
# 用 Stripe CLI 触发测试事件
stripe trigger checkout.session.completed
stripe trigger invoice.paid

# 查看 OPC 日志确认 webhook 处理成功
```

### 4.3 验证订阅状态

```bash
curl http://localhost:3000/api/billing/subscription \
  -H "X-API-Key: $OPC_API_KEY" \
  -H "X-Tenant-Id: your-tenant-id"
```

## 5. 代码参考

| 文件 | 用途 |
|---|---|
| `src/plan-definitions.ts` | Plan 定义 + `getStripePriceId()` 按 env 取 price_id |
| `src/agent-runtime/call-center/billing/billing-http.ts` | Checkout/Portal/Subscription/Usage/Quota API |
| `src/agent-runtime/call-center/billing/stripe-webhook.ts` | Webhook 处理（5 事件 + 签名验证 + 幂等） |
| `src/agent-runtime/call-center/billing/billing-store.ts` | 订阅/用量/配额存储 |

## 6. 事件处理流程

```
客户点击订阅
  → POST /api/billing/checkout { plan_code: "pro" }
  → Stripe Checkout 页面
  → 支付成功
  → Stripe 发 checkout.session.completed webhook
  → OPC 创建/更新 billing_subscriptions 记录
  → 每月续费 → invoice.paid webhook → 更新 current_period
  → 支付失败 → invoice.payment_failed → status='past_due'
  → 取消订阅 → customer.subscription.deleted → plan='free', status='canceled'
```

## 7. 注意事项

- 未配 `STRIPE_SECRET_KEY` 时，Checkout/Portal 返回 mock URL（开发模式）
- `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ENTERPRISE` 未配时，对应 plan 的 checkout 会返回 400
- Webhook 幂等：同一 event.id 重复处理会被跳过（内存 Set，保留 1000 条）
- 配额执行：`OutboundDialerDeps.billingStore` 可选传入，传入后每次外呼前检查配额
