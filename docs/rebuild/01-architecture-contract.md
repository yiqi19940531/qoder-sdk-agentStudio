# 01 · 架构契约

## 目标与技术栈规划

本 spec 的目标是约束后续七个功能阶段，使“装配配置、SDK 运行、会话记录和公开演示”沿同一数据契约实现。技术选择以当前工程锁定版本为复现基线，不追求升级到构建当天的最新版。

| 层 | 选型 | 职责 | 不放在这一层的东西 |
| --- | --- | --- | --- |
| UI | React 19、TypeScript、Vite 7、CSS | Agent 装配、配置管理、事件与媒体展示 | SDK 凭据、直接文件写入 |
| 本地 API | Node.js、Express 5、Zod | 输入校验、REST／SSE、配置存储、任务编排 | 公开网络上的多租户身份系统 |
| Agent runtime | `@qoder-ai/qoder-agent-sdk@1.0.50` 与自带运行时 | 模型查询、工具、Skill、MCP、子 Agent、会话恢复 | 在浏览器中执行 Agent |
| 扩展 | MCP SDK、Playwright MCP、Chrome DevTools MCP、本地插件 | 可发现的工具与 Skill | 把 Skill 当作安全沙箱 |
| 可选媒体 | Python 3 标准库脚本 | 百炼图片／视频 HTTP 请求 | 强制所有读者提供百炼 Key |
| 存储 | 本地 JSON、Markdown、媒体文件 | 单用户原型的配置和历史 | 数据库、云存储、团队共享 |

依赖方向固定为 `src → shared types + /api → server → SDK/MCP/文件`；`server` 可以读取 `shared`，不得反向导入 UI。`scripts` 是测试、启动和发布入口，不承担在线请求处理。

## 进程与数据流

```text
浏览器 React UI
    │ HTTP + SSE
    ▼
本机 Express API ── 配置 / 会话 / 产物 JSON 文件
    │
    ├── Qoder Agent SDK ── SDK 附带的 qodercli 运行时 ── 模型、工具、子 Agent
    ├── 内置或自定义 MCP ── 浏览器、示例仓库、可选远程服务
    └── 可选 Python 3 ── 百炼媒体生成脚本
```

运行时调用发生在服务所在电脑，不发生在浏览器里。服务只监听本机回环地址；本原型没有用户登录层，也没有为互联网开放设计。系统 CLI 主要用于接收者登录和模型管理；项目锁定的 SDK 自带其运行时。跨机器搬迁时不得复制 Qoder 登录状态。

## 单一事实来源

| 数据 | 持久化位置 | 谁写入／何时生效 |
| --- | --- | --- |
| Agent 元数据和装配 | `data/agents.json` | Agent 保存接口；新会话生效 |
| 人格、规则、记忆 | `data/profiles/<id>/persona.md`、`AGENTS.md`、`memory/INDEX.md` | 各 Agent 独立；新会话读取规则快照 |
| Skill | `plugins/workbench/skills/<slug>/` | 校验发布后供新会话发现 |
| MCP 定义与检查结果 | `data/mcp-servers.json` | 注册表写入；自定义服务通过检查后可装配 |
| MCP 凭据与会话连接 | `data/mcp-secrets.json`、`data/mcp-session-config/` | 仅本机私有文件，不进入公开包 |
| 工具全局授权 | `data/permission-settings.json` | 运行时实时核对 |
| 会话、轮次、事件 | `data/conversations/<id>.json` | 创建时保存配置快照，事件持续持久化 |
| AIGC 设置与产物 | `data/aigc-settings.json`、`data/generated/` | 任务元数据和成功文件分开保存 |
| 配置清单 | `data/config-catalog.json` | 从真实配置文件重新生成，不作为输入来源 |

后端入口 `server/index.ts` 暴露 REST 和 SSE；`shared/types.ts` 是两端契约。前端不能直接读取凭据文件。写配置时校验，再原子化保存或使用版本检查；运行中的会话继续使用创建时的装配快照。

## SDK 参数边界

- 主 Agent 的人格／规则映射为 `systemPrompt`；子 Agent 映射为 `agents` 定义中的 `prompt`。`tools` 是可见工具，`allowedTools` 是预授权，二者用途不同。
- 主 Agent 需要 `Agent` 工具才能委派；子 Agent 必须有 SDK 可接受的工具集。`Skill` 需要真实插件发现，并加入受限工具集。
- `maxTurns` 是 SDK 查询的模型与工具往返上限，不是聊天消息数；子 Agent 的同名设置可能受到 SDK 限制。
- 模型列表从当前账号发现。保存的模型不可用时，新会话暂选可用的内置 `auto` 并记录诊断，不修改原配置。
- 每个 Agent 的规则与记忆隔离；不要自动加载示例仓库共享规则来冒充专属规则。

## 安全与发布契约

默认工具逐次审批、仅工作目录访问，全局允许列表为空；`AskUserQuestion` 始终交给用户，危险的浏览器任意代码工具禁止。目录授权并非操作系统沙箱，外部 MCP 与 Bash 仍以本机用户身份运行。

公开包只能从白名单生成。密钥、认证头、私人路径、登录状态、运行时私有连接快照不发布；演示会话脱敏并标为只读。发布前扫描每个文件及 ZIP 解压条目，失败时不输出包。避免将真实私人聊天原文当作示例提示词。

## 变更原则

每完成一章，优先新增明确边界的模块，不把服务状态散放到 UI；保留先前公开 API 与磁盘格式。需要改格式时写迁移或向后兼容读取。测试应证明行为，而不是仅断言内部函数存在。

## Spec Coding 的跨模块实现顺序

1. **定义共享类型和错误语义**：先在 `shared/types.ts` 明确 Agent、MCP、Skill、会话与事件的最小形状。HTTP 层用 Zod 拒绝非法输入，不让无效数据落盘。
2. **建立存储和运行边界**：`server/storage.ts` 管理 Agent 文件；各领域模块分别管理会话、MCP、Skill 和 AIGC，不让 `server/index.ts` 直接承担所有业务状态。
3. **实现 API 再接 UI**：服务端先可通过 HTTP 验证创建、查询、更新与失败；前端使用同一类型和返回数据，不另造事实来源。
4. **把配置转换成 SDK 会话快照**：新会话解析模型、规则、工具和 MCP；SDK 执行只读取快照。运行事件保留真实归属和轮次，供流程图与存档重放。
5. **逐层验收并发布**：先类型检查和本地模拟，再真实账号只读调用，最后制作脱敏演示包。公开扫描在最终 ZIP 内容上再执行一次。

## 架构级验收逻辑

| 契约 | 检查方法 | 失败信号 |
| --- | --- | --- |
| 本地运行 | 服务启动日志及监听地址为 `127.0.0.1` | 默认绑定所有网卡 |
| 单一事实来源 | 改 Agent 后检查 `data/agents.json` 和配置清单一致 | 清单与源文件冲突 |
| 快照隔离 | 创建会话后改 Agent，旧会话配置保持原值 | 历史图或运行模型跟着新配置变 |
| 秘密值隔离 | API、会话 JSON、日志与 ZIP 扫描 | 返回 Token／Key 或私人路径 |
| 真实与模拟分开 | 测试记录注明 SDK 实时调用、mock、未验证 | 仅凭单元测试宣称外部服务可用 |
