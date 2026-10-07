# 01 · 架构契约

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
