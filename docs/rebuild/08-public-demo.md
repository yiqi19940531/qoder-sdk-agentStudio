# 08 · 演示存档、脱敏包与公开发布

## 要实现的效果

接收者克隆仓库或解压一个 ZIP，使用自己的 Qoder 账号登录并启动，就能看到 6 个 Agent、3 个 Skill、无密钥 MCP、34 条历史存档及 4 个成功媒体文件；可选 Apify／百炼功能由其自行配置。公开内容不含原作者的可复用凭据。

## 前置模块

完成 [07 界面](07-interface-and-flow.md)，核心运行路径和演示数据已准备好。公开打包必须从经过核对的来源按白名单生成，不能直接把原工作目录整体压缩。

## 数据与调用链

`scripts/package-public.mjs` 只复制指定源码、锁文件、插件、活动 Agent 配置、安全示例仓库、演示会话及媒体。复制会话时做文本脱敏，设置 `demoArchive: true`、空待决审批、空会话授权，并重置无法在接收者账号恢复的 SDK 状态；服务端拒绝对存档直接 `POST /api/conversations/:id/messages`，前端提问改发创建会话请求。

打包器把公开 Agent 模型限定为内置 `auto`／`efficient`，移除 Apify 装配但保留无凭据服务定义；权限改为逐次审批和工作目录，全局允许列表置空。`data/mcp-secrets.json`、`data/mcp-session-config/`、本机登录文件和任何凭据文件完全排除。配置清单由接收者首次运行时重新生成。

压缩前和压缩后逐条扫描密钥模式、认证头、私人路径、禁止文件及已知原始密钥；发现问题删除输出 ZIP。图片、视频和截图还需人工查看可见画面。`DEMO-MANIFEST.json` 保存预期数量供核对。`scripts/quickstart.mjs` 做 Node/Qoder 环境检查、必要时安装依赖、构建并启动；`start.sh` 和 `start.cmd` 调用同一入口。

`README.md`、`README.demo.md`、中英文 QUICKSTART 说明运行与可选凭据；`VALIDATION.md` 分清真实 macOS 验证、模拟服务验证和未做实机测试的 Linux／Windows x64。公开仓库首页及 ZIP 均须包含本复建目录。

## 关键文件和接口

`scripts/package-public.mjs`、`scripts/quickstart.mjs`、`start.sh`、`start.cmd`、`README.md`、`README.demo.md`、`QUICKSTART.zh-CN.md`、`QUICKSTART.en.md`、`VALIDATION.md`、`DEMO-MANIFEST.json`。发布时从扫描通过的 ZIP 同步公开仓库；不要把原工作目录中的私有运行文件复制进去。

## 架构约束

- 演示存档可看消息、事件和流程；不能用原 SDK session 续聊。新提问产生新 ID、新配置快照和接收者账号下的查询。
- 历史 JSON、图片、视频及截图都视为待检查发布物；文本自动扫描与画面人工检查缺一不可。
- 无 Token Plan 的账号可使用当前可用的内置模型；不可用模型只在新会话临时回退并明示。无 Apify／百炼 Key 仍能体验仓库、浏览器、Skill 与历史案例。
- 公开说明如实写出版本基线：SDK 1.0.50、自带运行时 1.1.64、本地验证 CLI 1.1.65；不把这些版本说成永久最新版。

## 可直接复制的复建提示词

> 请把当前本地 Agent 工程制作成可分享的演示仓库和单个 ZIP。打包脚本必须使用源码／数据白名单，保留 6 个 Agent、3 个 Skill、34 条已脱敏只读会话、4 个成功媒体和安全截图；禁止发布原作者百炼 Key、Apify Token、Qoder 登录状态、私有 MCP 快照、原始本机路径。历史存档可查看但 API 不可直接续接；历史页提问用接收者账号创建新会话。公开默认使用可用的 Qoder 内置 auto／efficient、逐次审批和工作目录访问，Apify 只保留空凭据定义且不装配。提供跨 macOS、Linux、Windows x64 的共用 Node 快速启动逻辑与中英指南；可选服务由接收者自己填 Key。压缩前后扫描所有文件和 ZIP 条目，媒体画面人工检查。先在全新目录解压并完成安装、构建、服务 API 和模拟 MCP／AIGC 测试，再同步公开仓库、README 与下载包；如实列出哪些系统实际测试过。

## 验收方法

运行 `npm run package:public`；确认失败时不留下发布 ZIP。全新临时目录解压后运行 `node scripts/quickstart.mjs`、类型检查、构建、模型／流程／MCP／Skill／AIGC 测试；服务返回 6 个 Agent、3 个 Skill、34 条存档及 4 个成功媒体。存档直接续接返回冲突，新提问创建新会话；检查所有文档链接、ZIP 内的 `docs/rebuild/` 和公开仓库同版内容。任何系统未实机执行的项目，在发布说明中保持“未验证”。
