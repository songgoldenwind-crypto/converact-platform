# IVR 流程设计器 设计方案

## 概述

基于 React Flow 的可视化 IVR 流程编辑器，支持 23 种节点类型（12 种传统电信 IVR + 11 种 AI/视频增强），AI 从表格/自然语言生成流程，自动测试验证。

## 节点类型（23 种）

### 传统电信 IVR 节点（12 种，来自自有设计文档）

| # | 节点 | 关键配置 | 出边 |
|---|------|---------|------|
| 1 | 开始 | 推送参数（从自定义参数取值） | 单一 |
| 2 | 播放 | 类型(语音/语音变量/TTS/TTS变量)+语音库(公共/企业)+SSML+多条 | 单一 |
| 3 | 按键菜单 | 提示语+按键(0-9*#)→目标(坐席/队列/分机/群呼) | 按键数+超时 |
| 4 | 收号 | 最大/最小位数+结束方式+输入等待+超时+循环次数 | 单一(存变量) |
| 5 | 设置变量 | 变量名+值类型(字符串/表达式) | 单一 |
| 6 | 分支路由-判断 | 逻辑(并且/或者)+12种操作符 | true+false |
| 7 | 分支路由-时间 | 关联时间组 | true+false |
| 8 | 队列 | 队列名+等待策略+超时 | 单一(+超时转出) |
| 9 | 交互(HTTP) | 方法+URL+请求参数映射+响应赋值 | 成功+失败 |
| 10 | 直呼 | 目标(坐席同振/随机/顺振/分机/队列/群呼/固话) | 终端 |
| 11 | 留言 | 语音信箱配置 | 终端 |
| 12 | SIP | SIP URI+自定义头 | 终端 |

### AI 原生节点（5 种，差异化核心）

| # | 节点 | 关键配置 | 出边 |
|---|------|---------|------|
| 13 | AI 对话 | AI角色(外呼/客服)+话术脚本ID+最大轮数+超时 | 单一(+超时转出) |
| 14 | 意图判断 | 判断维度(意向分/关键词/情绪)+阈值 | 高意向+低意向+继续 |
| 15 | 知识库问答 | 知识库ID+最大搜索结果+无答案时路由 | 找到+未找到 |
| 16 | 数字人切换 | 切换方向(语音→视频/视频→语音)+avatar_id | 单一 |
| 17 | 合规播报 | 播报类型(AI身份/录音同意/隐私声明)+语言 | 单一 |

### 视频/增强节点（6 种）

| # | 节点 | 关键配置 | 出边 |
|---|------|---------|------|
| 18 | 视频播放 | 视频源(预录制URL/屏幕共享/数字人)+循环+跳过 | 单一 |
| 19 | 屏幕共享 | 共享源(坐席/AI)+权限控制 | 单一 |
| 20 | 可视化菜单 | 菜单项(图标+文字+动作)+与按键菜单联动 | 按键数+超时 |
| 21 | 子流程 | 引用另一个IvrFlowGraph+参数传递 | 单一 |
| 22 | 录音控制 | 动作(开始/停止)+格式 | 单一 |
| 23 | Webhook推送 | URL+事件类型+payload | 成功+失败 |

## 图数据结构

```typescript
interface IvrFlowGraph {
  version: number;           // schema 版本，便于未来迁移
  entryNodeId: string;       // 流程入口
  nodes: IvrNode[];          // 23 种节点的 discriminated union
  edges: IvrEdge[];          // 连线
  variables: IvrVariable[];  // 流程级变量声明
}

interface IvrNode {
  id: string;
  type: IvrNodeType;         // 'play' | 'menu' | 'condition' | ... 23种
  name: string;              // 用户起的节点名
  position: { x: number; y: number };  // React Flow 画布坐标
  data: IvrNodeData;         // 按 type 区分的具体配置
}

interface IvrEdge {
  id: string;
  source: string;             // 源节点 ID
  target: string;             // 目标节点 ID
  sourceHandle?: string;      // 多出边节点的出口标识 (如 'true'/'false'/'digit_1')
  label?: string;             // 连线标签
}
```

## React Flow 编辑器

- 23 种自定义节点组件（图标+标题+配置摘要预览）
- 左侧调色板分三组：传统节点 / AI 节点 / 视频节点
- 画布拖拽+连线+自动布局
- 右侧配置面板：选中节点显示对应表单
- 保存/加载：IvrFlowGraph JSON ↔ 后端

## AI 生成

生成 API（`/api/ivr/generate-from-text`、`/api/ivr/generate-from-csv`）经双栈 LLM（主用 Qwen3.6-27B，传输失败时 fallback DeepSeek）产出 `IvrFlowGraph`，并在服务端执行 `completeFlowMissingEdges` + `publishBlockingIssues` 闸门；响应携带 `llmTier`、`model`、`warnings`、`publishReady`，前端据此展示模型来源与是否可直接发布，**禁止**在 LLM 失败或 JSON/校验失败时静默回退到内置模板图。

- **`llmTier`**：`primary`（27B）或 `fallback`（DeepSeek）；仅 HTTP 传输层失败（5xx/超时/连接错误）才切换，401/403/422 与烂 JSON **不**换模型
- **`publishReady`**：`publishBlockingIssues(validation)` 为空时为 `true`；为 `false` 时不应发布，需修图或重新生成
- **双栈 env**：primary 仅 `LLM_API_KEY` + `LLM_BASE_URL`；fallback 仅 `DEEPSEEK_API_KEY`；双栈均失败返回 502/422，画布不变
- **无静默 fallback**：删除生产路径上的 `generateFallback` / `buildMenuFlow`；M1 联调样例见 `scripts/seed-ivr-m1-flow.ts`（与 few-shot 同构）

### Excel/CSV 上传
- 解析表格行（按键→描述→目标映射）
- LLM 生成对应 IvrFlowGraph JSON
- 生成结果加载到画布，可继续编辑

### 自然语言描述
- 输入业务需求描述
- LLM 生成 IvrFlowGraph JSON
- 支持 23 种节点类型

## 自动测试验证

### DTMF 序列回放
- 输入按键序列（如 "1,2,0"），模拟器逐步执行流程图
- 当前节点高亮、走过的路径标记
- 超时/无效输入/最大重试边界测试

### 断言检查
- 验证最终到达的终端节点（Transfer/SIP/留言）是否正确
- 变量值断言（"设置变量"后变量是否正确）

### AI 节点模拟
- AI 对话节点：mock LLM 响应或连接真实 LLM
- 意图判断节点：mock 意向分
- 知识库问答节点：mock 检索结果

## 后端

### IvrFlowExecutor（图解释器）
- 输入：IvrFlowGraph + 当前状态(当前节点+变量+按键序列)
- 输出：下一步动作(播放TTS/采集DTMF/转接/AI对话...)
- 支持 23 种节点的执行

### API
- `POST /api/ivr/flows` — 保存流程图
- `GET /api/ivr/flows/:id` — 加载流程图
- `POST /api/ivr/generate-from-csv` — AI 从表格生成
- `POST /api/ivr/generate-from-text` — AI 从自然语言生成
- `POST /api/ivr/simulate` — 模拟测试

## 与现有系统的关系
- 现有 `navigateVoiceAgentNode` 作为 AI 导航模式保留
- 新 `IvrFlowExecutor` 是独立的 23 节点图解释器
- 现有 `IvrNodeEditor.tsx` 列表编辑器被 React Flow 画布替换
- `action:'ivr'` 路由结果接上 `IvrFlowExecutor`（修掉死代码）
- AI 原生节点复用现有工具（check_intent / query_knowledge / disclosure）
