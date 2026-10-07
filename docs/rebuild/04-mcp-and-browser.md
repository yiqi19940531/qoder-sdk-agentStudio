# 04 · MCP 注册、浏览器与连接校验

## 要实现的效果

Agent 可装配无密钥的示例仓库、Playwright 和 Chrome DevTools MCP；配置页统一管理内置与自定义 MCP，保存定义后检查连接及工具清单，再装配给特定 Agent。Apify 保留为接收者自行填写凭据的可选定义。

## 前置模块

完成 [03 SDK 运行时](03-runtime-and-conversations.md)：新会话可传入工具定义，工具调用可审批，事件可展示。

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

## 可直接复制的复建提示词

> 在现有多轮 Agent 工程中增加统一 MCP 注册表和配置页面。先接入无密钥的 repo-facts、Playwright、Chrome DevTools，允许 Agent 按服务装配，并在会话创建时固定工具清单。再支持自定义 stdio、Streamable HTTP、SSE 服务及无认证、Bearer、请求头、OAuth；定义和密钥分文件保存，API 只返回“已配置”状态。提供只握手和发现工具的连接校验，不执行工具；成功且至少发现一个工具的自定义服务才可装配。内置服务只读。浏览器导航按来源审批并在当前会话记住允许结果，其他动作沿用工具授权；禁止任意浏览器代码工具。页面展示连接状态、工具及使用者。用本地模拟服务验证传输、超时、凭据脱敏和装配；再检查无密钥浏览器工具能发现。

## 验收方法

运行 `npm run test:mcp`，检查示例仓库工具及两种浏览器 MCP 的连接和发现结果；使用本地模拟服务覆盖 stdio、HTTP、SSE、认证、超时和脱敏。新建网页探索 Agent，用 Playwright 或 Chrome DevTools 读取本地测试页面，检查审批和事件。验证不填 Apify Token 时核心路径仍可运行；填入**模拟** Token 后可检查并装配对应服务，不产生真实外部任务。
