# 发布验证 / Release validation

## 最近一次京东真人操作与修正（2026-10-10）

最近一次“洗发水前 20”会话的事件显示：新 Browserless 浏览器先加载已保存的京东档案，在 `www.jd.com` 确认了登录；约 5 秒后搜索页另触发人工风险验证，任务保持 `needs-human`、商品数为 0。人工接管期间京东页面再次进入 `passport.jd.com`，可见登录表单。随后持久化连接续接失败，旧服务一边保留此前的 `loginVerified=true`，一边把会话标为 `UNVERIFIED`，造成相互矛盾的展示。之后两次新建持久化会话均返回 HTTP 401；只读额度请求的响应明确指出 **Browserless 免费套餐单位用量已达上限**。因此有证据证明此前登录档案可恢复；没有证据证明当前搜索页已放行，也不能把这次失败解释为档案未保存。

修正后，已结束或断开的会话不再报告“当前已登录”；此前成功的档案核验作为独立历史信号保留。京东当前页若再次显示登录表单，会撤销当前登录确认并提示重新验证。Browserless 的免费额度错误会直述原因，不再被改写成“登录未确认”或悄悄尝试空白新浏览器。模拟浏览器测试覆盖这三种状态，类型检查通过。真实 Browserless 操作需等待账户恢复可用额度；**尚未取得真实商品、促销或评论**。

## 京东商城研究与按需人工接管（2026-10-10）

应使用者要求，第 7 个 Agent 由“先登录”改为“先后台搜索商品，遇到京东人工关卡再显示云浏览器”。新增 `browser_search_products`、`browser_collect_reviews`、`browser_task_status`，商品与评论进度只写入本机私有 `data/jd-tasks/`。Web 运行台显示商品表、促销、可见评论和销量排序核验标志。京东风险页出现时会把同一云浏览器切到人工模式；人工接管前可直接打开带原任务返回目标的官方登录页，不要求用户在商城首页寻找入口。模拟 BrowserService 测试已覆盖隐藏搜索、只在关卡时生成 Live URL、评论断点、档案保存与新浏览器恢复；类型检查和构建通过。

真实 Browserless Token 的探针验证：档案创建 API 可用；使用**测试 Cookie** 的 `Browserless.saveProfile → 关闭原浏览器 → 新浏览器加载 profile` 成功，随后列表确认测试档案已清理。使用中国住宅出口可打开 `www.jd.com` 中国区商城首页，看到搜索框；后台搜索“洗发水”实际转向 `cfe.m.jd.com` 风险验证，并最终显示 `passport.jd.com` 登录页。Agent 按需交出同一浏览器，任务状态为 `needs-human`，没有生成任何虚构商品。后续真人操作已完成登录档案的真实恢复与商城首页核验，结果见本页首节；**销量排序前 20 商品、促销及评论仍未完成实站验收**。SFO 出口曾把登录后页面导向 `corporate.jd.com`，现明确不把该集团介绍页视为中国区商城成功。中国住宅出口有额外 Browserless 单位消耗；跨新连接的出口 IP 可能变化，京东可能再次要求人工验证。

最终公开 ZIP 共 192 个逐项审计条目，固定收入 7 个 Agent、3 个 Skill、34 条只读演示会话和 4 个成功媒体。打包扫描通过，`data/jd-browser-profile.json`、`data/jd-tasks/`、本机 `.env`、Browserless Token、Live URL 与新京东私人会话均未进入包。在全新临时目录解压后，`npm ci`、`npm run typecheck`、`npm run test:browser`、`npm run build` 均通过；新增的构建指南第 13 阶段随包发布。Linux 与 Windows x64 仍未实机验证。

## Browserless 京东人工接管增量（2026-10-10）

当前工程新增第 7 个“京东登录 Agent”、`jd-browser` 进程内 MCP 和运行台实时浏览器面板。新 ZIP 在全新临时目录执行 `npm ci`、`npm run typecheck`、`npm run build`、`npm run test:browser`、`npm run test:models`、`npm run test:flow` 均通过；运行服务读到 7 个 Agent、34 条演示会话和第 6 个内置 MCP。`npm run test:mcp`、`npm run test:skills`、`npm run test:aigc` 也在该隔离目录通过。`test:browser` 使用模拟 CDP，验证同一页面、单次交互链接、断开与完成信号、未确认时重新开始、人工期间拒绝 Agent 关闭、核验后保留浏览器以及事件中不含链接或 Token。没有 Browserless Token 时，Qoder 实际会话调用了 `browser_open` 并得到明确配置错误；工作台显示配置提示，未误报登录成功。此阶段尚未使用真实 Browserless Token；后续真实连接验证见下一段。下文保留原 6 个 Agent 演示包发布时的历史验证记录。

随后使用使用者本机提供的 Browserless Token 验证：云端 Chromium 可打开公开测试页并生成 Live URL；京东登录 Agent 实际打开 `passport.jd.com`，本地 Web iframe 显示同一页面并进入可交互的 `HUMAN_CONTROL`。最初的 Playwright CDP 实现使用 `playwright-core 1.64.0`，接管时触发 `Duplicate target` 进程崩溃；按 Browserless [版本兼容清单](https://docs.browserless.io/baas/versions)改为 1.62.1 后仍在画面重连或会话后期复现。Browserless 会话层因此改用官方支持的 `puppeteer-core 25.4.0` CDP 接口，保留原有 Playwright MCP；真实 Live URL 在本地 iframe 成功加载，重连及会话到期后本地服务继续响应。随后在未登录状态提交“完成并继续”，后端实际访问京东账户页并判为 `FAILED`，Agent 明确回复登录未完成；没有把用户完成信号当作登录成功。当前 Browserless 套餐拒绝 5 分钟配置，最大会话时长为 **2 分钟**；测试会话在真人完成滑块和短信前到期，后端记录 `EXPIRED`，Agent 未报告登录成功。新增“准备好后重新开始登录”按钮，同一对话可按需创建新云会话。**真实滑块通过、短信核验和登录成功后的页面保留仍未完成验收。**

后续用户报告曾在京东画面看到已登录状态，但那次持久化事件显示：云会话创建约 109 秒后才开始 `VERIFYING`，又过约 8 秒 Browserless 连接断开。旧核验器先跳转账户页且依赖固定文案，记录中的登录页地址是创建时的旧快照，因而不能证明用户没有登录。新版改为先读取当前页的域名、可见登录／账户控件及**登录 Cookie 名称是否成对出现**（不读取、保存或返回 Cookie 值），人工接管期间只读监测页面变化；只在证据不足且时间足够时再访问账户页。核验断线或证据不足转为 `UNVERIFIED`，Agent 不再宣称用户未登录。UI 已验证：侧栏可收起并扩大工作区，Browserless 说明浮层消失，浏览器面板提供全屏按钮。真实无登录页面的安全信号读取返回“登录表单可见／凭据未出现”；模拟测试覆盖当前页强阳性、自动监测确认与核验中断。**新版尚待真人成功登录复测。**

再次真人测试中，第一次云浏览器已打开，但京东 `domcontentloaded` 等待 30 秒超时而未进入人工接管；已改为较短等待，并在页面已经到达官方京东域名时继续展示浏览器。随后一轮在人工操作后依次进入 `aq.jd.com` 与 `corporate.jd.com/home`；用户表示画面上已显示自己的账号。后端读取的安全信号仍无已识别的登录 Cookie 对或账户控件，且“完成并继续”发生在会话到期前约 13 秒，账户页复核时间不足，故报告 `UNVERIFIED`。该结果不能证明登录失败，也**不能算系统已确认登录成功**。为排查用户所见与 Agent 所查页面可能不同的问题，现已让监测与完成核验检查同一云浏览器里的所有京东标签页；模拟多标签页阳性测试通过。第二轮真人重试到期时仍位于 `aq.jd.com` 安全验证页，未取得成功信号。受当前账号 2 分钟绝对时限限制，真实成功登录与后续会话保留仍待验收；延长会话需更换支持更长时限的 Browserless 套餐或部署，单改本地超时或重连无效。

最终公开 ZIP 在原工程已有 36 条本地会话的情况下，仍只按 `data/demo-archive-index.json` 收入原先 34 条演示存档；另外两条京东测试会话被排除。ZIP 共 188 个审计条目，未包含 `.env`、本机 Browserless Token 或 MCP/百炼凭据文件；全新解压目录的 `npm ci`、类型检查、构建和 BrowserService 模拟测试再次通过。

## 原演示包发布记录

实际测试环境：**macOS arm64**，Node.js **24.13.1**，npm **11.8.0**，Qoder CLI **1.1.65**。SDK 锁定 **1.0.50**，自带运行时 **1.1.64**。Linux 和 Windows x64 的启动脚本使用相同的 Node 入口，但**没有在这两个系统上实际执行**。

从 ZIP 解压到全新临时目录后，`npm ci`、`npm run typecheck`、`npm run build`、`npm run test:models`、`npm run test:flow` 均通过。最终包又在第二个全新目录运行 `node scripts/quickstart.mjs`，完成自动安装、构建和本地启动。服务 API 读到 6 个 Agent、3 个 Skill、34 条只读演示会话和 4 个媒体文件；旧会话详情含事件和流程记录，直接续接返回 HTTP 409。使用同一 Agent 新建的会话采用内置 `auto` 并完成了 SDK 回复。

隔离目录中 `npm run test:mcp`、`npm run test:skills`、`npm run test:aigc` 通过。无 Apify/百炼 Key 时，`repo-facts`、Playwright、Chrome DevTools 的 MCP 连接检查分别发现 1、25、30 个工具。使用本地模拟 Bearer 服务验证了 Apify 保存 Token、连接、发现工具并装配回网页 Agent；使用本地模拟百炼接口验证了图片、视频、续查、失败和超时流程。这些测试没有调用真实 Apify 或百炼付费接口。

发布打包器会对所有白名单文件及生成后的 ZIP 条目逐项扫描；最终 ZIP 在加入用户名和业务空间地址脱敏规则后重建并复检。`npm install` 最终报告 0 个已知漏洞；使用 `shell-quote` 1.11.0+ 的覆盖配置修复了开发依赖链中此前的告警。

English: Tested on macOS arm64 with Node 24.13.1, npm 11.8.0, and Qoder CLI 1.1.65. Clean extraction passed install, typecheck, build, model/flow tests, MCP/Skill/AIGC mock tests, API archive checks, and a live built-in `auto` response. Linux and Windows x64 have shared launch logic and guides but were not run on those operating systems. No real paid Apify or Bailian call was made during validation.

## 浏览器演示短片

在 macOS 的 Google Chrome 中操作公开演示包页面，录制了六段 1600 × 900、约 1.5 倍速、单段不足 20 秒的无声短片。画面裁剪为工作台页面，未包含 Chrome 标签栏、书签和账号信息；逐段检查封面与时间轴。主子 Agent 与媒体展示来自脱敏只读历史，拍摄期间未发起新的百炼付费生成。拍摄时发现“工具授权”标签页缺少主体渲染，已恢复工具分组、逐项全局授权控件与反馈，并在隔离演示副本的 Chrome 页面验证。
