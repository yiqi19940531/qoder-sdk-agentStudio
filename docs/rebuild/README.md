# Agent Hub 构建指南

这套文档说明 Qoder Agent Workbench 从 SDK 可行性实验发展为本地 Agent 装配工作台的过程，并提供从空目录构建同类工程的分阶段提示词。它记录的是**当前公开演示版的实际实现**；提示词是根据代码与历史需求重写的可执行版本，不是历史对话的逐字转录。每个阶段按照 **目标 → 技术栈与文件架构 → 接口和数据契约 → 实现任务 → 验收** 组织，便于按 spec coding 的方式逐项实施。

## 使用方法

1. 阅读 [需求演进](00-history-and-goals.md)、[架构契约](01-architecture-contract.md) 和 [Spec Coding 工作法](11-spec-coding-workflow.md)。
2. 将本页的“总提示词”交给编码 Agent，然后按下表顺序逐章执行：先锁定该章需求和接口，再实现任务，最后逐条通过验收。未通过时修复本阶段，避免把不确定的接口带入下一阶段。
3. 用 [逐文件索引](09-file-map.md) 对照产出，用 [总验收表](10-verification.md) 检查最终工程。每一章保留需求 ID、任务 ID 和验收证据，形成可追溯链。

| 顺序 | 阶段 | 交付物 |
| --- | --- | --- |
| 1 | [基础工程与 Agent](02-foundation-and-agents.md) | React/Express 工程、共享类型、文件存储、主子 Agent 配置 |
| 2 | [运行时与会话](03-runtime-and-conversations.md) | SDK 查询、多轮会话、审批、模型与记忆 |
| 3 | [MCP 与浏览器](04-mcp-and-browser.md) | 工具注册、连接检查、浏览器和自定义 MCP |
| 4 | [Skill 管理](05-skills.md) | 插件 Skill、草稿、校验和安全发布 |
| 5 | [AIGC 与媒体](06-aigc-and-media.md) | 图片和视频子 Agent、工具及产物 |
| 6 | [界面与流程图](07-interface-and-flow.md) | 装配页、运行台、流程图、语言和主题 |
| 7 | [公开演示包](08-public-demo.md) | 演示存档、脱敏 ZIP、启动脚本 |
| 8 | [Browserless 与京东人工登录](12-browserless-jd-login.md) | 可装配云浏览器、Web 实时接管、登录核验 |
| 9 | [京东商城研究与按需接管](13-jd-mall-research.md) | 后台商品搜索、促销／评论、档案恢复和任务断点 |

推荐顺序按代码依赖组织；[历史演进](00-history-and-goals.md)保留了实际需求出现的顺序。历史会话、图片和视频是演示数据，构建时可用自己的测试数据，不要求生成相同内容。

## 总提示词：先交给编码 Agent

> 我要从空目录构建一个本地单用户的 Qoder Agent Workbench。技术栈固定为 TypeScript、Node.js、Express、React、Vite 和 @qoder-ai/qoder-agent-sdk；SDK 固定使用项目锁文件中的版本。浏览器只访问本地 API，SDK 与 Qoder CLI 在本机后端执行。配置、会话与演示数据用文件保存，不引入数据库、云端多租户或远程执行代理。请按我随后发送的阶段 spec 依次实现。每阶段先输出需求 ID 对应的文件／接口方案，再按任务 ID 实施，最后给出命令、API 响应或事件等可复核证据；验收失败先修复本阶段。保留已完成阶段的数据格式和行为；如需更改契约，先说明迁移。任何密钥只由使用者在本机配置，绝不写进源码、文档、测试夹具、日志或公开包。全局始终允许工具列表默认置空；只读安全工具可按内置基线预授权，写入、网页导航等操作按权限策略审批；本地路径默认仅工作目录。不要把 Qoder SDK 能力、模型效果或自动记忆写入写成已验证，除非实际测到。

提示词可用于 Codex、Qoder 或其他编码 Agent。每章会给出目标、允许修改的模块、关键契约和验收要求；执行者可参考本仓库代码核对行为，但提示词本身不依赖私人聊天记录。

## 范围与语言

- 目标是**本地单用户原型**：Web 界面负责装配与展示；后端负责 SDK 调用、MCP、审批、文件与凭据。不是现成的团队 SaaS。
- 当前演示版包含 7 个 Agent、3 个 Skill、34 条只读历史会话和 4 个成功媒体文件。第 7 个京东商城研究 Agent 需要接收者自己的 Browserless Token；数量用于核对演示包，不是 SDK 固有限制。
- 现有 [快速指南](../../QUICKSTART.zh-CN.md)说明如何运行；本目录说明如何重新构建。English navigation: foundation → runtime → MCP → Skills → AIGC → UI → public demo. API、CLI、MCP、Skill 等术语沿用代码中的英文名称。
- 版本基线以 `package-lock.json` 为准。现有验证记录在 [VALIDATION.md](../../VALIDATION.md)；Linux 和 Windows x64 有启动脚本，但此前没有实机验证。
