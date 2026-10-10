# 13 · 京东商城后台研究与按需人工接管

## 目标与交付结果

把第 12 阶段的京东登录原型扩展为商品研究 Agent。用户给出“洗发水、按销量排序、前 20 个商品、促销和高评分评论”后，Agent 先在后台使用同一 Browserless 浏览器搜索与读取页面。只有京东显示登录、滑块或风险验证时，才在本地 Web 运行台呈现可交互 Live URL。人工处理后续接保存的商品任务；浏览器到期也不能丢失已采集进度。认证状态可通过 Browserless Authenticated Profile 跨新浏览器恢复。

边界：页面排序不一定代表京东全站真实销量，20 个商品不等于 20 个独立品牌；看不到的促销和评论不能编造。京东风控与浏览器套餐可能阻止真实采集，模拟测试不能冒充实站成功。

## 技术栈规划与模块文件架构

| 模块 | 主要文件 | 职责 |
| --- | --- | --- |
| 共享契约 | `shared/types.ts` | 商品、评论、任务、浏览器核验状态及 MCP 工具清单 |
| Agent 装配 | `data/agents.json`、`data/profiles/jd-login/{persona.md,AGENTS.md}`、`server/storage.ts` | 后台优先、按需接管、证据与排名用语约束 |
| 云浏览器 | `server/browser-service.ts`、`server/jd-login.ts` | 隐藏操作、人工交接、登录／商城可访问状态、超时与重开 |
| 档案 | `server/jd-profile.ts`、`data/jd-browser-profile.json`（私有） | Browserless 档案创建、保存与恢复；本机只保存随机名称 |
| 采集 | `server/jd-shop.ts`、`data/jd-tasks/`（私有） | 搜索、销量排序检查、商品／促销提取、评论分批与进度持久化 |
| Qoder 工具 | `server/runtime.ts` | `browser_search_products`、`browser_collect_reviews`、`browser_task_status` |
| 本地 API／Web | `server/index.ts`、`src/RemoteBrowser.tsx`、`src/remote-browser.css` | 任务表、SSE 状态、倒计时、人工完成按钮 |
| 验证 | `scripts/browser-integration-test.ts`、`scripts/browserless-profile-smoke.ts` | 模拟控制权和任务断点；测试 Cookie 的真实档案恢复 |

## 需求契约

- **JD-R1 后台优先：**启动搜索不得生成 Live URL。仅收到京东人工关卡信号后，从同一 Page 创建可交互 Live URL；Agent 停止页面操作，用户按“完成并继续”才交还控制权。
- **JD-R2 正确站点：**中国区商城以 `www.jd.com` 和 `search.jd.com` 为目标；`corporate.jd.com`、`global.jd.com` 不能视为商城成功。默认 Browserless 中国住宅出口，登录档案的创建与恢复使用相同国家配置。代理流量会消耗账户单位。
- **JD-R3 任务数据：**每条商品保存名次、SKU、名称、可见品牌、价格、促销、评论数量、官方商品 URL 和最多三条当前页面可见的高评分评论。记录 `sortApplied`；未确认销量排序时不报告“销量前 20”。
- **JD-R4 档案与断点：**人工完成后保存 Browserless 档案、关闭原浏览器、用档案开新浏览器复核。区分“账号登录确认”和“商城可访问但登录未单独确认”。本机任务文件和档案名称不进入演示 ZIP。
- **JD-R5 安全：**不读取或保存用户账号、密码、短信码、Cookie 值；只记录 Cookie 名称是否满足核验条件。评论文本中手机号和邮箱脱敏。完整 Live URL 只通过本机无缓存响应进入 iframe，不进入会话事件或日志。

## 实现步骤

1. **JD-T1 · 身份与地区。** 把首次人工登录改为 Browserless `/profile` 创建会话。新连接使用 `?profile=<随机名称>`；用户的 Browserless Token 仅在本地服务读取。使用中国住宅出口打开商城，验证首页可访问；若搜索被引导到京东风险页，不假设已取得商品。
2. **JD-T2 · 搜索工具。** `browser_search_products(keyword)` 先隐藏浏览器，访问京东搜索页，尝试点击实际页面上的“销量”排序，最多收集 20 个可核实商品卡片。页面转到京东验证域时返回 `needs-human` 并暂停。人工接管前可打开带原搜索返回目标的京东官方登录入口，免去用户寻找入口。
3. **JD-T3 · 评论和 Web 表格。** `browser_collect_reviews(maxProducts)` 每次只处理少量商品，优先选择当前可见高评分且互动数较多的评论；没有数据则说明不可得。每个商品完成后将进度写入本机任务文件。`GET /api/conversations/:id/jd-task` 为 Web 表格提供数据；HTML 中不展示账号信息。
4. **JD-T4 · 恢复与失败。** 账号确认与商城访问分别给出结论；短会话到期后重新加载档案和任务断点。登录失效、再次出现滑块、商品页结构变化、无法验证排序等情况返回明确状态，不填造结果。

## 可直接复制的构建提示词

> 请在当前 React + Express + Qoder Agent SDK 工作台中，将 `jd-login` Agent 扩展为中国区京东商城研究 Agent，保留原 ID 和历史会话兼容性。给它增加后台商品搜索、页面实际销量排序检查、促销提取、评论分批读取和本地进度持久化。浏览器使用现有 Browserless Puppeteer CDP 会话；不要调用另一个隔离的 Playwright MCP 来假装共享登录。只有京东页面要求登录、滑块或风险验证时才生成交互式 Live URL，并在服务层禁止 Agent 与用户同时操作。首次人工登录后调用 Browserless `saveProfile`，关闭原浏览器，再加载档案验证；区分账号登录确认与仅商城访问可用。本机只保存随机档案名称，用户认证内容保留在其 Browserless 账号内，且所有私有任务与档案文件排除公开 ZIP。搜索结果必须有来源 URL、排序是否验证及不可得字段；不得编造销量、促销和评论。完成类型检查、模拟 CDP 测试、无认证的真实云浏览器探针、真实人工验收，并分别写明已通过与未通过的环节。

## 实现后的校验逻辑

| 验收 ID | 操作 | 通过条件 |
| --- | --- | --- |
| JD-A1 | `npm run typecheck && npm run build && npm run test:browser` | 类型、构建、隐藏搜索、按需交接、档案恢复和断点模拟通过 |
| JD-A2 | `npm run test:browserless-profile` | 仅使用测试 Cookie：保存档案、关闭原浏览器、新浏览器读取 Cookie，结束后清理测试档案 |
| JD-A3 | 无账号访问真实商城 | `www.jd.com` 中国区主页可访问；搜索若转到风险页，工具返回 `needs-human` 且不伪造 20 个商品 |
| JD-A4 | 真人完成人工验证 | 原会话内完成登录或滑块；新浏览器恢复后实际读取商城商品或账户页，结论对应证据 |
| JD-A5 | 真实商品与评论 | 20 个商品的排名口径、价格、促销、评论和 URL 可逐项在页面核对；失败项留空且标注原因 |
| JD-A6 | 公开包审计 | 无 `data/jd-browser-profile.json`、`data/jd-tasks/`、Token、Cookie、Live URL 或私人新会话 |

当前已通过 JD-A1、JD-A2，以及 JD-A3 中“商城首页可打开、搜索触发风险页并按需接管”的部分。真人登录后的档案已在另一个云浏览器的 `www.jd.com` 恢复并确认，验证了 JD-A4 的账号恢复部分；搜索页仍触发额外风险／登录验证，JD-A4 的搜索继续执行及 JD-A5 商品与评论仍未通过。最近一次续接失败后，Browserless 返回免费套餐单位用量已达上限；这是云服务额度限制，不能当成登录档案丢失。实现中分别记录此前登录证据、当前页面证据、连接状态和额度错误。免费套餐单次浏览器连接最多两分钟，保存档案能跨连接复用但不能保证搜索放行。[Browserless 档案](https://docs.browserless.io/baas/features/authenticated-profiles)、[持久化会话](https://docs.browserless.io/baas/session-management/persisting-state)。
