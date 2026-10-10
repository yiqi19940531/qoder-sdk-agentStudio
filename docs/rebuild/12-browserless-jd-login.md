# 12 · Browserless 云浏览器与京东人工登录

## 目标与完成标准

在第 1–7 阶段的本地工作台中新增可装配的 `jd-browser` 进程内 MCP 和“京东登录 Agent”。Agent 在本机 Qoder SDK 中运行，但 Chromium 浏览器运行在 Browserless；本地 React 运行台用 iframe 显示**同一个**云端浏览器。人工接管时，用户在 Web 画面内完成手机号、滑块和短信验证，后端再检查该浏览器中的京东页面与登录状态。人工点击“完成”不是登录成功证据。

本阶段不自动识别或绕过滑块，不采集京东商品，不持久化 Cookie／验证码，也不把当前单用户后端直接暴露到公网。没有 Browserless Token 时，之前六个 Agent 的功能保持可用。

## 技术栈与文件架构

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 类型 | `shared/types.ts` | `RemoteBrowserState`、安全摘要与临时视图类型；注册 `jd-browser` 工具名 |
| SDK 装配 | `server/runtime.ts`、`server/mcp-registry.ts` | `createSdkMcpServer()`、`tool()`；会话级工具闭包；内置服务发现 |
| 浏览器服务 | `server/browser-service.ts` | Puppeteer CDP 连接、默认 Context、页面级 CDP、Live URL、状态机、清理 |
| 站点规则 | `server/jd-login.ts` | 官方登录入口和账户页保守核验 |
| Agent 与规则 | `server/storage.ts`、`data/profiles/jd-login/` | 在原有数据中补入第七个 Agent；禁止模型索取凭据或操作滑块 |
| API 与事件 | `server/index.ts`、`server/conversations.ts` | 查询视图、SSE、人工完成、关闭、核验后同会话续轮 |
| Web | `src/RemoteBrowser.tsx`、`src/remote-browser.css`、`src/main.tsx` | iframe、状态、手动完成、关闭和事件反馈 |
| 配置与验收 | `.env.example`、`scripts/browser-integration-test.ts` | 环境变量占位与无真实凭据模拟测试 |

`puppeteer-core` 作为项目直接依赖锁定在 `package-lock.json`。最初按原方案使用 Playwright `connectOverCDP()`，真实 Live URL 连接触发 Playwright 内部 `Duplicate target` 异常并使 Node 服务退出；改用 Browserless 官方同时支持的 Puppeteer CDP 接口。已有 Playwright MCP 保留给网页探索 Agent。云浏览器不要求在本机安装 Chrome。[Browserless 混合自动化说明](https://docs.browserless.io/baas/monitor-sessions/hybrid-automation)

## 数据和 API 契约

`BrowserService` 用 `conversationId` 关联一个内部 `sessionId` 与 `browser/context/page/cdp`。当前项目没有认证用户 ID，所以只声明本机单用户所有权，不伪造多用户隔离。浏览器状态独立于 SDK 会话轮次：

`CREATED → AI_RUNNING → HUMAN_CONTROL → VERIFYING → COMPLETED`，并处理 `FAILED / UNVERIFIED / EXPIRED / CLOSED`。明确仍在登录表单时转为 `FAILED`；核验期间连接断开或证据不足时转为 `UNVERIFIED`，不得向用户宣称“没有登录”。用户可在同一 Qoder 对话中新建浏览器尝试。人工控制期间，Agent 的页面操作与关闭调用都必须被服务层拒绝。

接口：`GET /api/conversations/:id/browser` 返回浏览器状态和**仅供当前 iframe 使用**的临时 Live URL；`GET .../browser/events` 用 SSE 推送不含 URL 的状态摘要；`POST .../browser/complete` 接收用户完成信号并实际核验；`POST .../browser/close` 关闭云浏览器。完整 Live URL 不得写入会话 JSON、SSE 事件、Agent 工具返回或日志。Live URL 是持有者即可控制浏览器的临时凭据。[Browserless Live URL 安全说明](https://docs.browserless.io/baas/monitor-sessions/manage-live-url-over-rest)

`browser_handoff` 立即返回等待人工状态，让 Qoder 当前轮自然结束，避免长时间 MCP 工具调用超时。后端完成核验后，以标为“浏览器核验”的系统来源消息在**同一对话**开启后续轮次；模型还须调用 `browser_check_login`，只有 `verified=true` 才能回复“京东登录成功”。服务重启后内存中的 Browserless 连接不保证恢复，页面提供重新开始云浏览器登录的入口。

## 实现任务

1. **BROWSER-T1 · 配置和连接**：只从 `.env`／进程环境读取 `BROWSERLESS_API_TOKEN`、无 Token 的 `BROWSERLESS_WS_ENDPOINT` 和超时。后端连接时才构造带 Token 的 WSS 地址；校验返回的 Live URL 来源。优先用 CDP 默认 Context，创建页面级 CDP Session。
2. **BROWSER-T2 · Agent 能力**：在注册表和 `runtime.ts` 中新增 `jd-browser` 的 `browser_open/get_state/handoff/check_login/close`。仅 `browser_open` 能打开固定京东官方入口；其他工具只访问当前会话。新增 Agent 的模型使用内置 `auto`，默认审批和工作目录授权。
3. **BROWSER-T3 · 实时画面**：Agent 操作时不生成 Live URL；人工接管时为当前页面生成一次 `interactable: true`、固定视口的 Live URL。省略 Browserless `instructions`，让其右上角说明浮层和 Done 按钮不遮挡京东页面；把操作说明与“完成并继续”放在 Web 面板。React iframe 配置 `allow-same-origin allow-scripts` 和剪贴板权限；CSP `frame-src` 仅允许 Browserless 来源。左侧栏可折叠并记住选择，浏览器面板可全屏。本地 Web 浏览器直连 Browserless HTTPS/WSS，画面不是定时截图。[嵌入说明](https://docs.browserless.io/baas/monitor-sessions/embedding-live-url)
4. **BROWSER-T4 · 核验和清理**：前端完成按钮只触发 `VERIFYING`。先在同一云浏览器的所有京东标签页只读检查域名、可见登录与账户控件，以及登录 Cookie **名称是否成对出现**；不读取或记录 Cookie 值、手机号、验证码、账号名。人工操作期间定时及页面导航后检查强阳性证据，可在用户按按钮之前确认。仅在证据不足且剩余时间充足时访问京东账户页复核。明确未登录为 `FAILED`；证据不足或核验断线为 `UNVERIFIED`。打开登录页时，即使 `domcontentloaded` 等待超时，只要已进入京东官方域名，也应继续展示可操作页面。超时、主动关闭、网络断开均要释放资源；到期后提供用户主动点击的重新开始入口。
5. **BROWSER-T5 · 发布**：将源码、占位环境文件、Agent 配置和测试加入公开包白名单；更新数量检查与敏感信息扫描。不得打包 `.env`、Live URL、Cookie、手机号或验证码。

## 可复制的复建提示词

> 在现有 React + Express + Qoder Agent SDK 本地工作台中新增 Browserless 云浏览器人工接管。保留当前六个 Agent、会话 SSE、审批和文件存储。新增 `jd-browser` 进程内 MCP 与京东登录 Agent；用 `puppeteer-core` 的 `puppeteer.connect()` 连接使用者通过环境变量配置的 Browserless Chromium Endpoint。每次登录尝试只使用一个云浏览器；从初始 Page 创建页面级 CDP Session 供 Live URL 使用，同时考虑人工操作可能打开其他标签页。仅在人工接管时生成一次交互式 Live URL；不传 Browserless `instructions`，操作说明和完成按钮放在 Web 面板。允许折叠侧栏和全屏显示 iframe。Agent 进入 `HUMAN_CONTROL` 后停止页面操作；用户手动完成手机号、滑块和短信验证期间，后端只读监测浏览器内的京东页面。完成时先检查各京东页及登录状态，再按剩余时间决定是否访问账户页。只有强阳性证据才能报告成功；超时或证据不足必须报告“未确认”，不得说用户没有登录。Live URL 和凭据只在后端内存及当前 iframe 请求中短暂存在，禁止写入会话、日志和公开包。处理断线、到期、关闭、重复提交及服务重启。先通过模拟 CDP 测试，再由真人在真实京东页面做端到端验收；若风控拒绝云浏览器，记录具体失败，不伪造成功。

## 校验逻辑与已知边界

运行 `npm run typecheck && npm run build && npm run test:browser`。模拟测试应证明：Agent 工具和 iframe 对应同一 `page`；单次交互链接无说明浮层；人工控制期间 Agent 不能关闭会话；当前页强阳性无需跳转即可确认，核验断线变为 `UNVERIFIED`；成功时浏览器保持连接；状态事件和历史不含 Token 或 Live URL。

真实 Browserless 与京东验收需使用者自己的 Token，并由真人在 iframe 中实际完成点击、输入、连续拖拽和短信验证。Browserless 免费套餐单次会话最多 2 分钟；Live URL 的 `timeout` 和重连都不能延长该时限。更长测试需要更高时限的套餐或部署。[Browserless 会话时长说明](https://docs.browserless.io/baas/session-management/standard-sessions)。京东可能按云端 IP 或风控规则拒绝登录；只有真实完成并通过后端核验才能记录端到端成功。
