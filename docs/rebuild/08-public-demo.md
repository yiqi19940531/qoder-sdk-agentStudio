# 08 · 演示存档、脱敏包与公开发布

## 目标与交付结果

接收者克隆仓库或解压一个 ZIP，使用自己的 Qoder 账号登录并启动，就能看到 6 个 Agent、3 个 Skill、无密钥 MCP、34 条历史存档、4 个成功媒体文件及 6 段 Chrome 页面演示短片；可选 Apify／百炼功能由其自行配置。公开内容不含原作者的可复用凭据。

## 前置模块

完成 [07 界面](07-interface-and-flow.md)，核心运行路径和演示数据已准备好。公开打包必须从经过核对的来源按白名单生成，不能直接把原工作目录整体压缩。

## 技术栈规划

发布逻辑使用 Node.js 脚本、`yazl` 生成 ZIP、`yauzl` 解压复检，不依赖用户本机的系统 ZIP 工具。启动脚本共用一个 Node 入口，macOS／Linux 用 shell 包装，Windows x64 用 cmd 包装。打包和运行使用相同锁文件，发布文档固定写明实测版本及平台。

## 相关模块文件架构

| 层 | 文件与技术 | 职责 |
| --- | --- | --- |
| 打包 | `scripts/package-public.mjs`；Node 文件 API、`yazl/yauzl` | 白名单、脱敏、ZIP 创建和条目复检 |
| 历史语义 | `shared/types.ts`、`server/conversations.ts`、`src/main.tsx` | `demoArchive` 标识、服务端拒绝续接、前端重新起聊 |
| 模型兼容 | `shared/model-selection.ts`、`data/agents.json` | 内置默认模型及当前账号回退 |
| 启动 | `scripts/quickstart.mjs`、`start.sh`、`start.cmd` | Node／CLI 检查、安装、构建、本地服务 |
| 交付文档 | 根 README、两份 QUICKSTART、`VALIDATION.md`、本目录 | 下载、配置、效果与验证边界 |
| 演示数据 | `DEMO-MANIFEST.json`、`data/conversations/`、`data/generated/`、`artifacts/promo-videos/` | 数量自检、只读历史、媒体及浏览器操作短片 |

公开仓库是扫描通过的演示版本；打包器必须可以在公开仓库自身重新生成同结构 ZIP。ZIP 的根目录名固定，接收者解压后进入该目录运行统一 Node 快启入口。

## 需求契约

| ID | 必须成立的行为 | 失败／边界 |
| --- | --- | --- |
| PUB-01 | 白名单只含可公开代码、配置、Skill、文档和演示数据 | 私有凭据、登录态、缓存和探针不得出现 |
| PUB-02 | 34 条历史完整可读，旧 SDK session 不可续接 | 从存档提问创建接收者账号的新会话 |
| PUB-03 | 六 Agent、三 Skill、四成功媒体在新机器可见 | 无 Token Plan 仍用内置模型 |
| PUB-04 | 包前及 ZIP 解压后逐文件扫描秘密和路径 | 任一命中阻止产出，不能保留半成品 |
| PUB-05 | 解压后按指南一条启动命令运行 | 无可选 Key 时核心仓库／浏览器仍可体验 |
| PUB-06 | README 与验证记录说明真实测试平台 | 未实机验证的系统、真实付费调用不能宣称通过 |

## 数据与调用链

`scripts/package-public.mjs` 只复制指定源码、锁文件、插件、活动 Agent 配置、安全示例仓库、演示会话及媒体。复制会话时做文本脱敏，设置 `demoArchive: true`、空待决审批、空会话授权，并重置无法在接收者账号恢复的 SDK 状态；服务端拒绝对存档直接 `POST /api/conversations/:id/messages`，前端提问改发创建会话请求。

打包器把公开 Agent 模型限定为内置 `auto`／`efficient`，移除 Apify 装配但保留无凭据服务定义；权限改为逐次审批和工作目录，全局允许列表置空。`data/mcp-secrets.json`、`data/mcp-session-config/`、本机登录文件和任何凭据文件完全排除。配置清单由接收者首次运行时重新生成。

压缩前和压缩后逐条扫描密钥模式、认证头、私人路径、禁止文件及已知原始密钥；发现问题删除输出 ZIP。图片、视频和截图还需人工查看可见画面。`DEMO-MANIFEST.json` 保存预期数量供核对。`scripts/quickstart.mjs` 做 Node/Qoder 环境检查、必要时安装依赖、构建并启动；`start.sh` 和 `start.cmd` 调用同一入口。

`README.md`、`README.demo.md`、中英文 QUICKSTART 说明运行与可选凭据；`VALIDATION.md` 分清真实 macOS 验证、模拟服务验证和未做实机测试的 Linux／Windows x64。公开仓库首页及 ZIP 均须包含本构建指南目录。

## 关键文件和接口

`scripts/package-public.mjs`、`scripts/quickstart.mjs`、`start.sh`、`start.cmd`、`README.md`、`README.demo.md`、`QUICKSTART.zh-CN.md`、`QUICKSTART.en.md`、`VALIDATION.md`、`DEMO-MANIFEST.json`。发布时从扫描通过的 ZIP 同步公开仓库；不要把原工作目录中的私有运行文件复制进去。

## 架构约束

- 演示存档可看消息、事件和流程；不能用原 SDK session 续聊。新提问产生新 ID、新配置快照和接收者账号下的查询。
- 历史 JSON、图片、视频及截图都视为待检查发布物；文本自动扫描与画面人工检查缺一不可。
- 无 Token Plan 的账号可使用当前可用的内置模型；不可用模型只在新会话临时回退并明示。无 Apify／百炼 Key 仍能体验仓库、浏览器、Skill 与历史案例。
- 公开说明如实写出版本基线：SDK 1.0.50、自带运行时 1.1.64、本地验证 CLI 1.1.65；不把这些版本说成永久最新版。

## 实现步骤（Spec Coding Tasks）

1. **PUB-T1 · 盘点发布物**：列源文件、活动 Agent、Skill、34 会话、成功／失败媒体及截图；分离原始私有数据和允许公开的演示数据。逐张检查媒体可见画面。
2. **PUB-T2 · 历史语义**：给每条导入历史打 `demoArchive` 标记，清空失效审批与会话授权；API 直接续接返回 409，UI 新提问调用创建会话并提示上下文不继承。
3. **PUB-T3 · 安全默认**：公开 Agent 使用内置 `auto/efficient`、工作目录路径和逐次审批策略，清空全局允许列表；移除 Apify 装配但保留空凭据定义。
4. **PUB-T4 · 白名单与脱敏**：复制源码、锁文件、插件清单、活动配置、文档和经检查的数据；按字符串和常见格式去除密钥、认证头、敏感 URL 参数与私人绝对路径。禁止文件路径必须在复制前拒绝。
5. **PUB-T5 · 压缩后复检**：逐条解压 ZIP 到内存扫描，不只扫描生成的压缩字节；核对条目集合、演示数量、媒体实际存在及文档入口。任一失败删除输出 ZIP。
6. **PUB-T6 · 一键启动与说明**：共用 Node 脚本校验版本和 Qoder 登录，必要时执行 `npm ci`、构建并启动；macOS/Linux 与 Windows x64 包装脚本只负责调用它。README 说明内置模型、可选 Token、可选百炼、演示存档及安装步骤。
7. **PUB-T7 · 公开仓库同步**：从通过扫描的 ZIP 同步公开内容，根 README 加指南和下载入口；在公开仓库自身重新打包，对比 ZIP 条目，提交后核对 GitHub 文件与下载包哈希。

## 可直接复制的构建提示词

> 请把当前本地 Agent 工程制作成可分享的演示仓库和单个 ZIP。打包脚本必须使用源码／数据白名单，保留 6 个 Agent、3 个 Skill、34 条已脱敏只读会话、4 个成功媒体和安全截图；禁止发布原作者百炼 Key、Apify Token、Qoder 登录状态、私有 MCP 快照、原始本机路径。历史存档可查看但 API 不可直接续接；历史页提问用接收者账号创建新会话。公开默认使用可用的 Qoder 内置 auto／efficient、逐次审批和工作目录访问，Apify 只保留空凭据定义且不装配。提供跨 macOS、Linux、Windows x64 的共用 Node 快速启动逻辑与中英指南；可选服务由接收者自己填 Key。压缩前后扫描所有文件和 ZIP 条目，媒体画面人工检查。先在全新目录解压并完成安装、构建、服务 API 和模拟 MCP／AIGC 测试，再同步公开仓库、README 与下载包；如实列出哪些系统实际测试过。

## 验收方法

运行 `npm run package:public`；确认失败时不留下发布 ZIP。全新临时目录解压后运行 `node scripts/quickstart.mjs`、类型检查、构建、模型／流程／MCP／Skill／AIGC 测试；服务返回 6 个 Agent、3 个 Skill、34 条存档及 4 个成功媒体，ZIP 内另有 6 段可播放宣传视频。存档直接续接返回冲突，新提问创建新会话；检查所有文档链接、ZIP 内的 `docs/rebuild/` 和公开仓库同版内容。任何系统未实机执行的项目，在发布说明中保持“未验证”。

## 实现后的校验逻辑

| 对应需求 | 操作 | 通过条件 |
| --- | --- | --- |
| PUB-01/04 | 检查打包输入、每个 ZIP 条目和二进制画面；注入模拟密钥再试打包 | 正常包无禁入文件与私密信息；注入后打包失败且删除输出 |
| PUB-02 | GET 历史详情、POST 旧会话消息、从页面输入新问题 | 历史可读；直接 POST 为 409；页面生成新 ID 且旧消息未继承 |
| PUB-03 | 无自定义模型、无 Apify／百炼 Key 的干净环境启动 | 6／3／34／4 数量正确，仓库与浏览器核心功能可用 |
| PUB-05 | 清空依赖目录，在全新位置执行快启 | 自动安装、构建、服务启动；错误依赖给可理解提示 |
| PUB-06 | 检查发布 README 和 `VALIDATION.md` | 明确区分 macOS 真机、模拟服务和 Linux／Windows 未实机项 |

公开仓库与 ZIP 的文档字节内容要一致；可允许仓库根 README 与 ZIP README 为不同入口文案，但两者必须指向同一构建指南。
