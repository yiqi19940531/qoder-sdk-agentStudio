# 02 · 基础工程与 Agent 装配

## 要实现的效果

从空目录启动一个本地页面，能列出、创建、修改主 Agent 和子 Agent，并把人格、规则、记忆与装配配置分开保存。第一阶段可先有“创建任务”占位入口，实际 SDK 执行在下一章接入。

## 前置模块

只需要 Node.js、npm、TypeScript 和本机 Qoder CLI 登录。推荐 Node.js 22.12+；当前锁文件固定 `@qoder-ai/qoder-agent-sdk@1.0.50`。不要在此阶段要求 Apify 或百炼凭据。

## 数据与调用链

`src/main.tsx` 从 `GET /api/bootstrap` 获取 Agent、工作目录、Skill/MCP 发现概况与 SDK 版本。新增和保存 Agent 使用 `POST /api/agents`、`PUT /api/agents/:id`；规则和记忆分别通过 `/api/agents/:id/instructions` 与 `/api/agents/:id/memory` 读写。`server/storage.ts` 把 Agent 元数据写到 `data/agents.json`，将每个 Agent 的 `persona.md`、`AGENTS.md`、`memory/INDEX.md` 放在独立目录。`server/config-catalog.ts` 从真实来源重建可核对的配置清单。

`shared/types.ts` 定义 `AgentConfig`、`AgentPermissions`、`Bootstrap` 等两端共享形状。主 Agent 的 `subAgentIds` 只能指向子 Agent；子 Agent 不能再挂子 Agent。Agent 保存前应检查 ID、名称、模型、最大轮数、工具、Skill/MCP 引用和本地路径。

## 关键文件和接口

工程骨架：`package.json`、`package-lock.json`、两个 TypeScript 配置、`vite.config.ts`、`index.html`。后端：`server/index.ts`、`server/storage.ts`、`server/config-catalog.ts`。前端：`src/main.tsx` 与样式文件。示例仓库 `data/example-repo/calculator.ts` 用于后续真实只读测试。

初始装配可先创建“仓库协调”主 Agent 和“代码审查”子 Agent；本项目的网页探索及 AIGC Agent 在后续章节加入。内置模型优先使用 `auto` 或 `efficient`，不将作者的自定义模型 ID 写成新环境必需值。

## 架构约束

- Agent ID 是持久化和跨文件引用的键；显示名称可变。删除被主 Agent 引用的子 Agent 前先处理引用。
- 人格、项目规则、记忆是三种不同数据，不用一个 Markdown 文件代替全部。
- 配置清单是派生结果；不能用它覆盖 `data/agents.json` 等来源文件。
- 页面保存后重新读取并显示成功／失败及文件路径；未保存草稿不能用于新会话。

## 可直接复制的复建提示词

> 已确定架构见“总提示词”。现在完成阶段 1：建立 TypeScript + Express + React + Vite 的本地工程，锁定 Qoder SDK 版本，服务只监听 127.0.0.1。实现共享 AgentConfig 类型、文件型 Agent 存储与原子写入、每 Agent 独立 persona.md／AGENTS.md／memory/INDEX.md、配置清单再生成。提供 GET /api/bootstrap、Agent CRUD、规则和记忆读取／保存接口；页面可创建、编辑、选择主 Agent 与一层子 Agent，配置模型、最大轮数、工具、Skill、MCP、权限。默认逐次审批和仅工作目录访问。先提供仓库协调主 Agent、代码审查子 Agent及隔离的 calculator.ts 示例仓库。校验非法引用、循环、空工具集和最大轮数；保存后重新读取显示结果。完成类型检查、构建和 API 持久化验证，列出实际新增文件与未接入的 SDK 执行功能。

## 验收方法

运行 `npm run typecheck` 与 `npm run build`；启动后创建一个临时 Agent，保存、刷新并再次读取，确认元数据和三份专属文件仍在且没有改变其他 Agent。编辑最大轮数时核对磁盘值；只接受 1–1000。删除临时 Agent 后，基础配置保持可用。
