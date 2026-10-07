# 04 · MCP 注册、浏览器与连接校验

## 目标与交付结果

Agent 可装配无密钥的示例仓库、Playwright 和 Chrome DevTools MCP；配置页统一管理内置与自定义 MCP，保存定义后检查连接及工具清单，再装配给特定 Agent。Apify 保留为接收者自行填写凭据的可选定义。

## 前置模块

完成 [03 SDK 运行时](03-runtime-and-conversations.md)：新会话可传入工具定义，工具调用可审批，事件可展示。

## 技术栈规划

Qoder SDK 管理 MCP 生命周期；`@playwright/mcp@0.0.83`、`chrome-devtools-mcp@1.10.1` 提供浏览器工具；自定义服务接入限于 SDK 当前类型支持的 stdio、Streamable HTTP、SSE。后端做连接检查与秘密值保存，前端只展示可公开状态。OAuth 是可选的授权流程，不影响无密钥内置服务。

## 相关模块文件架构

| 层 | 文件与技术 | 职责 |
| --- | --- | --- |
| 类型／持久化 | `shared/types.ts`、`server/mcp-registry.ts` | `McpServerInput/Record/Check`、内置与自定义定义、凭据分离、会话快照 |
| SDK 适配 | `server/runtime.ts`、`server/mcp-check.ts` | 组装 stdio／HTTP／SSE 配置、无任务握手、工具发现和 OAuth |
| API | `server/index.ts` | 注册、更新、删除、检查与授权回调；校验互斥字段 |
| UI | `src/McpManager.tsx`、`src/mcp.css` | 表单、状态、工具列表、使用者和装配按钮 |
| 测试 | `scripts/mock-mcp.mjs`、`scripts/mcp-integration-test.mjs` | 本地模拟传输、认证、空工具、超时和失败 |

浏览器运行依赖本机 Chrome；`repo-facts` 不依赖外部浏览器或服务 Key。

## 需求契约

| ID | 必须成立的行为 | 失败／边界 |
| --- | --- | --- |
| MCP-01 | 内置服务可展示、校验、发现工具，定义不可被 UI 覆盖 | 未安装浏览器或启动失败要显示原因 |
| MCP-02 | 自定义服务支持 stdio、HTTP、SSE 与对应认证配置 | 字段冲突、非法地址／命令拒绝保存 |
| MCP-03 | 保存和连接检查分开；成功且非空工具的自定义服务才可装配 | 校验绝不调用业务工具 |
| MCP-04 | 明文只在本机秘密文件／连接快照，API 和事件脱敏 | 修改服务后旧校验结果失效 |
| MCP-05 | 浏览器导航首次访问来源审批，同会话可复用允许结果 | 截图／填写仍受工具策略限制 |

## 数据与调用链

内置 `repo-facts` 是 SDK 进程内示例仓库工具；`playwright` 和 `chrome-devtools` 通过锁定版本的本地包以 stdio 启动；`bailian-image`、`bailian-video` 的本地工具在 [06](06-aigc-and-media.md) 完成。`server/runtime.ts` 根据会话快照构造 SDK `mcpServers`、`allowedMcpServerNames` 和可见工具名。

`server/mcp-registry.ts` 管理 MCP 定义、校验状态和凭据分离。自定义服务支持 stdio、Streamable HTTP、SSE；远程认证支持无认证、Bearer、请求头和 OAuth。定义及连接检查写入 `data/mcp-servers.json`，秘密值单独写到权限受限的 `data/mcp-secrets.json`。新会话把当时的连接信息快照到本机私有目录，旧会话继续按当时配置运行。删除正在被 Agent 使用的服务前必须先卸载。

`server/mcp-check.ts` 用无任务输入的临时 SDK 查询连接服务、等待状态并读取工具清单；**检查不调用工具**。只有连接成功且发现至少一个工具的自定义服务可供装配。`src/McpManager.tsx` 显示来源、传输、认证是否已配置、最近检查状态、工具详情、使用该服务的 Agent；不回显凭据。

浏览器导航首次访问某来源时需要审批；同一运行会话可记住获准来源。点击、填表、截图等动作仍按工具及 Agent 权限策略处理。浏览器使用独立会话，不借用接收者日常 Chrome 登录资料。

## 关键文件和接口

`GET/POST /api/mcp-servers`、`PUT/DELETE /api/mcp-servers/:id`、`POST /api/mcp-servers/:id/check`；OAuth 另有开始和回调接口。`server/mcp-registry.ts` 负责保存与脱敏，`server/mcp-check.ts` 负责 SDK 握手，`src/McpManager.tsx` 负责界面，`scripts/mock-mcp.mjs` 与 `scripts/mcp-integration-test.mjs` 验证传输和认证。

## 架构约束

- 内置定义可以查看和校验，不通过配置页覆盖实现；自定义服务保存与连接检查分开。
- MCP 凭据绝不进入配置清单、Agent 文件、API 响应、会话 JSON、错误事件和公开 ZIP。错误消息需经过脱敏。
- Agent 装配的是服务；工具可见性还取决于实际发现结果，调用仍经过审批。
- 网页操作有实际网络副作用；连接检查只做握手和列工具。无 Apify Token 时浏览器与示例仓库 MCP 仍可用。

## 实现步骤（Spec Coding Tasks）

1. **MCP-T1 · 类型与注册表**：定义传输、认证、检查状态、工具注解；初始化五个内置服务并读取自定义定义，列表同时给出 `usedBy`。
2. **MCP-T2 · 安全存储**：把 Token、请求头值和环境变量值写入独立权限受限文件；只在构造 SDK MCP 配置时合并；API 响应仅返回字段名及“是否有 Token”。
3. **MCP-T3 · 连接检查**：在 `mcp-check.ts` 创建没有任务输入的临时 SDK 查询，等待服务状态并获取工具；限制总时长，记录 `connected/failed/needs-auth` 和脱敏错误。
4. **MCP-T4 · 生命周期 API**：实现列表、创建、更新、删除、检查、OAuth 开始／回调；修改定义后重置检查状态。删除前检查 Agent 引用并清除相关全局授权。
5. **MCP-T5 · 会话装配**：新会话先确认自定义服务可装配，保存当时工具名与连接快照，再把可见工具拼为 `mcp__服务__工具` 名。Agent 保存页只能选择已通过校验的自定义服务。
6. **MCP-T6 · 浏览器策略与界面**：接入 Playwright、Chrome DevTools，显示工具列表和运行事件；实现来源级导航审批和工具级操作审批；Apify 只作为空凭据定义保留。
7. **MCP-T7 · 模拟回归**：验证 stdio／HTTP／SSE、Bearer／请求头、空工具、错误、超时、秘密值脱敏和修改后失效。

## 可直接复制的复建提示词

> 在现有多轮 Agent 工程中增加统一 MCP 注册表和配置页面。先接入无密钥的 repo-facts、Playwright、Chrome DevTools，允许 Agent 按服务装配，并在会话创建时固定工具清单。再支持自定义 stdio、Streamable HTTP、SSE 服务及无认证、Bearer、请求头、OAuth；定义和密钥分文件保存，API 只返回“已配置”状态。提供只握手和发现工具的连接校验，不执行工具；成功且至少发现一个工具的自定义服务才可装配。内置服务只读。浏览器导航按来源审批并在当前会话记住允许结果，其他动作沿用工具授权；禁止任意浏览器代码工具。页面展示连接状态、工具及使用者。用本地模拟服务验证传输、超时、凭据脱敏和装配；再检查无密钥浏览器工具能发现。

## 验收方法

运行 `npm run test:mcp`，检查示例仓库工具及两种浏览器 MCP 的连接和发现结果；使用本地模拟服务覆盖 stdio、HTTP、SSE、认证、超时和脱敏。新建网页探索 Agent，用 Playwright 或 Chrome DevTools 读取本地测试页面，检查审批和事件。验证不填 Apify Token 时核心路径仍可运行；填入**模拟** Token 后可检查并装配对应服务，不产生真实外部任务。

## 实现后的校验逻辑

| 对应需求 | 操作 | 通过条件 |
| --- | --- | --- |
| MCP-01 | 检查 `repo-facts`、Playwright、Chrome DevTools | 状态与发现工具可见；内置项修改／删除入口不可用 |
| MCP-02 | 分别保存 stdio、HTTP、SSE 模拟服务；试不匹配字段 | 合法配置保存，非法配置 400 且旧值不变 |
| MCP-03 | 模拟服务返回 0 个工具，再返回 1 个工具 | 前者不可装配；后者可装配；模拟工具调用计数仍为零 |
| MCP-04 | 保存模拟 Token，读取列表、清单、会话 JSON 和错误事件 | 均无明文；修改定义后显示待重新检查 |
| MCP-05 | 同一会话两次导航同来源，再尝试填写表单 | 首次导航询问，后续同来源按策略复用；填写仍按工具授权 |

集成测试需先启动本地 API；真实 Chrome 浏览器调用要与 mock 握手测试分别记录。
