# OPC 架构底座文档总入口

本目录统一组织 OPC 的两条当前设计主线：

1. 通信底座：SIP/PSTN、RustPBX、rvoip 能力吸收、RTPengine、LiveKit、媒体、
   G.729、Voice/Video 切换和未来 ViLTE。
2. AI-native 产品：多模态技术问题解决平台、Resolution 领域模型、人工与 AI 协作、
   Speech Runtime、Agent、Evidence、Action、Outcome 和商业演化。

## 当前状态

| 主线 | 文档完整度 | 当前权威状态 | 实现与生产状态 |
| --- | --- | --- | --- |
| [通信底座](./communication/README.md) | R5 总设计、ADR、目标、机器合同、Schema、追踪矩阵和 TDD 计划齐全 | `accepted architecture / target` | R4 已有开发事实；R5 delta 未自动授权；未验证项为 `not_run`，不能宣称 production eligible |
| [AI-native 产品](./ai-native/README.md) | R1 产品与目标架构总纲已完成三路独立预审 | `complete_for_user_review / proposed_for_review` | 尚待用户批准；R1 机器合同、追踪矩阵和实施计划尚未生成；能力证据均不得推断 |

因此，“文档完整”只表示当前设计范围已经写清楚，不表示功能已经开发、容量已经证明或
生产资格已经获得。

## 权威边界

- 通信、媒体和实时互通的现行技术 Authority 由通信 R5/R4 组合合同决定。
- AI-native R1 决定未来产品类别、领域模型、商业形态和目标 AI 架构，但在用户批准前
  保持 `proposed_for_review`。
- 两份文档重叠时不得静默互相覆盖。R1 获批后，必须通过新的 machine contract、
  traceability 和 ADR 把产品目标映射到通信底座；在此之前，R5 仍是现有通信实现边界。
- 未被原始 Evidence 独立证明的性能、容量、故障恢复和商业结果一律保持 `not_run`。

## 为什么不物理搬动原件

本目录是统一入口和清单，不复制、不移动绑定原件。原因是通信机器合同已经固定：

- artifact path 和 SHA-256；
- JSON Schema 的相对路径；
- Markdown 的相对链接；
- R4 objective、contract 和 362 条 trace 的继承身份；
- 现有测试、交付脚本和跨平台 Git 文件模式。

物理移动、重复复制或用符号链接替换原件都会引入路径漂移、双 Authority 或
Windows/归档交付差异。所有链接因此直接指向唯一原件。

## 推荐阅读顺序

1. 先读 [通信底座清单](./communication/README.md)，确认通信 Authority、性能底线和
   当前证据边界。
2. 再读 [AI-native 清单](./ai-native/README.md)，评审未来产品、业务模型和 AI-native
   演化路线。
3. AI-native R1 获得用户批准后，再生成跨两条主线的统一实施合同和 TDD 计划。

## 目录职责

```text
architecture-foundation/
├── README.md
├── communication/
│   └── README.md   # R5 current + R4 binding inheritance + machine artifacts
└── ai-native/
    └── README.md   # R1 authority + review status + supporting references
```

本目录只负责权威导航和状态说明，不存放运行时密码、服务器资料、临时测试结果或未经
审计的性能宣称。
