# 02 · 基础工程与 Agent 装配

## 目标与交付结果

从空目录启动一个本地页面，能列出、创建、修改主 Agent 和子 Agent，并把人格、规则、记忆与装配配置分开保存。第一阶段可先有“创建任务”占位入口，实际 SDK 执行在下一章接入。

## 前置模块

只需要 Node.js、npm、TypeScript 和本机 Qoder CLI 登录。推荐 Node.js 22.12+；当前锁文件固定 `@qoder-ai/qoder-agent-sdk@1.0.50`。不要在此阶段要求 Apify 或百炼凭据。

## 技术栈规划

沿用 [01 架构契约](01-architecture-contract.md) 的 Node.js、Express 5、React 19、Vite 7 与 TypeScript。前后端分别类型检查，运行时不依赖数据库；`zod` 只在 HTTP 边界校验，文件写入使用 Node 标准库。此阶段不发起模型调用，因此可以先完成确定性的存储和页面验证。

## 相关模块文件架构

| 层 | 文件 | 在本阶段承担的职责 |
| --- | --- | --- |
| 构建 | `package.json`、`package-lock.json`、`tsconfig.server.json`、`tsconfig.web.json`、`vite.config.ts` | 固定依赖、分开编译浏览器与 Node 代码、开发代理与生产静态资源 |
| 类型 | `shared/types.ts` | 唯一的 Agent 与 Bootstrap 数据契约；前后端共用 |
| 存储 | `server/storage.ts`、`server/config-catalog.ts` | 初始化样例、按 Agent ID 读写配置与专属文件、重建派生清单 |
| HTTP | `server/index.ts` | Zod 输入校验、Agent CRUD、规则／记忆接口、错误状态 |
| UI | `src/main.tsx`、`src/styles.css` | Agent 列表与草稿、保存反馈、工作区信息 |
| 夹具 | `data/agents.json`、`data/profiles/<id>/`、`data/example-repo/` | 可被真实 SDK 后续读取的最小数据 |

HTTP 层只接收与返回 `AgentConfig`，磁盘层把 `persona` 拆入 `persona.md`，`agents.json` 保存其余字段。`Bootstrap` 包含可用 Agent 与扩展发现概况，UI 不直接读 `data/`。

## 需求契约

| ID | 必须成立的行为 | 失败／边界 |
| --- | --- | --- |
| FND-01 | `npm ci`、类型检查、构建和本地 API 启动可重复 | Node 或依赖不匹配时明确报错 |
| FND-02 | 主 Agent 可挂一层已存在的子 Agent；子 Agent 不能继续委派 | 重复、无效 ID 和非法工具组合拒绝保存 |
| FND-03 | 每个 Agent 的人格、规则和记忆拥有独立文件 | 切换 Agent 不串写，缺失文件可初始化 |
| FND-04 | 保存配置后从磁盘重读并刷新配置清单 | 最大轮数仅接受整数 1–1000；错误不显示成功 |
| FND-05 | UI 草稿与已保存配置区分 | 未保存草稿不允许开启新会话 |

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

## 实现步骤（Spec Coding Tasks）

1. **FND-T1 · 固定运行骨架**：创建 npm 脚本、两份 tsconfig、Vite 与 Express 入口；先让 `npm run typecheck`、`npm run build` 通过，服务只监听回环地址。
2. **FND-T2 · 定义契约**：在 `shared/types.ts` 建立 `AgentConfig`、`AgentPermissions`、`Bootstrap`，明确主／子 Agent、工具／Skill／MCP 引用和默认权限。前端与 API 直接复用这些类型。
3. **FND-T3 · 落地文件存储**：实现 `data/agents.json` 与按 ID 分开的三份 Markdown 文件；创建示例仓库。保存使用临时文件与重命名，读取时补齐旧配置缺少的默认权限。
4. **FND-T4 · 建立配置 API**：实现 `GET /api/bootstrap`、Agent CRUD、规则和记忆读写。Zod 校验字段、最大轮数、引用关系、目录存在性；失败返回可理解的错误，不部分覆盖旧配置。
5. **FND-T5 · 接装配 UI**：列表、选择、新建、编辑、保存、删除；显示当前文件路径和保存反馈，切换 Agent 时保留各自未保存草稿。
6. **FND-T6 · 派生配置清单**：从真实文件重新生成 `data/config-catalog.json`，在保存和打开清单时刷新；对照磁盘内容验证最大轮数及装配引用。

每步完成后至少运行相关类型检查；FND-T3 和 FND-T4 还应做“保存→重启→读取”的 API 验证。最后把实际文件清单与 [09-file-map.md](09-file-map.md) 对齐。

## 可直接复制的复建提示词

> 已确定架构见“总提示词”。现在完成阶段 1：建立 TypeScript + Express + React + Vite 的本地工程，锁定 Qoder SDK 版本，服务只监听 127.0.0.1。实现共享 AgentConfig 类型、文件型 Agent 存储与原子写入、每 Agent 独立 persona.md／AGENTS.md／memory/INDEX.md、配置清单再生成。提供 GET /api/bootstrap、Agent CRUD、规则和记忆读取／保存接口；页面可创建、编辑、选择主 Agent 与一层子 Agent，配置模型、最大轮数、工具、Skill、MCP、权限。默认逐次审批和仅工作目录访问。先提供仓库协调主 Agent、代码审查子 Agent及隔离的 calculator.ts 示例仓库。校验非法引用、循环、空工具集和最大轮数；保存后重新读取显示结果。完成类型检查、构建和 API 持久化验证，列出实际新增文件与未接入的 SDK 执行功能。

## 验收方法

运行 `npm run typecheck` 与 `npm run build`；启动后创建一个临时 Agent，保存、刷新并再次读取，确认元数据和三份专属文件仍在且没有改变其他 Agent。编辑最大轮数时核对磁盘值；只接受 1–1000。删除临时 Agent 后，基础配置保持可用。

## 实现后的校验逻辑

| 对应需求 | 操作 | 通过条件 |
| --- | --- | --- |
| FND-01 | 全新目录安装、构建并启动 | 首页与 `GET /api/bootstrap` 正常返回，绑定地址为本机回环 |
| FND-02 | 创建主 Agent，挂子 Agent；再尝试给子 Agent 挂子 Agent | 前者保存并刷新仍在；后者返回校验错误，原配置不变 |
| FND-03 | 修改 A 的 `AGENTS.md` 和 `INDEX.md`，读取 B | B 文件字节不变；重启后 A 内容仍在 |
| FND-04 | 保存 `maxTurns=100`，随后试 0、1001 和小数 | 100 写入真实文件与清单；非法值拒绝且 UI 不显示成功 |
| FND-05 | 修改草稿不保存，切到运行台 | UI 阻止新会话并提示先保存 |

阶段封版条件：无未处理的类型错误；新增／删除临时 Agent 后数据可恢复；不需要任何可选第三方 Key。
