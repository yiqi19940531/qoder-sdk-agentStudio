# 06 · AIGC 编排与媒体产物

## 目标与交付结果

用户给“AIGC 任务编排 Agent”提出图片或视频需求；主 Agent 拆解任务并委派“图片生成”或“视频生成”子 Agent。两个子 Agent 分别预载对应 Skill、只看见对应的生成 MCP 工具。生成记录和成功媒体在本地保存，页面能查看成功与失败。

## 前置模块

完成 [05 Skill](05-skills.md)：主子 Agent 会话、工具事件、插件发现及 Skill 装配可用。Python 3 和接收者自己的百炼凭据仅在实际新生成时需要；浏览现有媒体不需要。

## 技术栈规划

Qoder SDK 完成任务理解与子 Agent 委派；Node 进程内 MCP 把受控任务交给 `server/aigc.ts`；Python 3 标准库脚本负责实际 HTTP 请求。Node 的 `fetch` 下载成功媒体，本地 JSON 和文件系统保存任务及产物。百炼只是可选外部依赖，构建与模拟测试不需要真实 Key。

## 相关模块文件架构

| 层 | 文件与技术 | 职责 |
| --- | --- | --- |
| 编排 | `data/agents.json`、三个 Agent 的 `persona.md`／`AGENTS.md` | 主 Agent 路由任务，子 Agent 只负责一种媒体 |
| Skill／工具 | 两个 `SKILL.md`、两个 `generate.py`、`server/runtime.ts` 的本地 MCP | 用受控工具把子 Agent 指令映射为图片／视频任务 |
| 任务服务 | `server/aigc.ts`、Node 子进程、`fetch` | 读本机凭据、调用 Python、保存状态、下载与恢复 |
| 类型／数据 | `shared/types.ts`、`data/aigc-settings.json`、`data/generated/` | 设置、`MediaArtifact`、文件和任务 ID |
| API／UI | `server/index.ts`、`src/main.tsx` | 设置、凭据状态、产物读取、会话媒体展示 |
| 测试 | `scripts/aigc-mock-server.ts`、`scripts/aigc-integration-test.ts` | 不花费真实配额的完整状态机回归 |

`MediaArtifact` 至少保留会话 ID、轮次 ID、类型、状态、提示词、模型、时间、云端任务 ID 与结果文件信息。状态只允许按 `queued → running → succeeded/failed` 推进；失败元数据保留，不能被“没有文件”误当成从未执行。

## 需求契约

| ID | 必须成立的行为 | 失败／边界 |
| --- | --- | --- |
| AIGC-01 | 主 Agent 分流并委派图片／视频子 Agent | 主 Agent 不直接持有两种生成工具 |
| AIGC-02 | 两个子 Agent 只见对应 Skill 和 MCP 工具 | 未配 Key 时明确失败，不影响其他 Agent |
| AIGC-03 | 图片同步、视频提交后保存 ID 再轮询 | 重启可续查已提交任务，不重复提交 |
| AIGC-04 | 成功媒体下载、校验并原子写入，失败记录保留 | 不接受非预期主机、类型、过大或空内容 |
| AIGC-05 | 凭据只在服务进程与 Python 子进程中使用 | API、事件、配置清单和公开包不含明文 |

## 数据与调用链

`data/agents.json` 保存一个主 Agent 和两个子 Agent 的装配。`plugins/workbench/skills/bailian-image/`、`bailian-video/` 各含 `SKILL.md` 和 `generate.py`。主 Agent 只决定委派对象；子 Agent 通过自己的 Skill 理解调用要求，再使用受控的 `mcp__bailian-image__generate_image` 或 `mcp__bailian-video__generate_video`。服务端在 `server/runtime.ts` 建立这两个本地 MCP 工具，调用 `server/aigc.ts`，由它启动 Python 脚本。

`server/aigc.ts` 从本机未发布的凭据文件读取 Key 和服务地址，向脚本传入必要环境值，不把明文放进 Agent 提示词、事件、响应或配置清单。图片走同步生成；视频提交异步任务、保存任务 ID 并轮询。`data/generated/<id>.json` 保存任务状态、模型、时间、失败原因和关联会话／轮次；成功文件单独保存并通过 `GET /api/artifacts/:id` 提供。服务重启应能继续处理可恢复的视频任务；产物接口只提供已完成的本地文件。

`data/aigc-settings.json` 保存可调的图片／视频模型、尺寸、时长和分辨率，不保存密钥。项目默认轻量规格用于演示；最终支持项以代码和实际服务能力为准。

## 关键文件和接口

`server/aigc.ts` 是任务与下载管理；两个 `generate.py` 是百炼 HTTP 调用；`server/index.ts` 提供设置和产物 API；`scripts/aigc-mock-server.ts` 与 `scripts/aigc-integration-test.ts` 在无真实 Key 的隔离环境验证流程。前端运行台根据会话产物及状态事件显示预览。

## 架构约束

- “主 Agent 判断类型”和“子 Agent 调用对应工具”必须可从事件及 Agent 流程图核对；不要让主 Agent 直接持有两种生成工具。
- 生成请求可能耗时或失败。先持久化元数据，再执行／轮询；失败不删除记录；重复提交和恢复需避免重复下载或误报成功。
- 只允许预期的媒体下载地址和文件类型；错误与日志要清理凭据。`AIGC_PYTHON` 可指定 Python；Windows x64 默认使用 `py -3`，macOS/Linux 默认 `python3`。
- 没有百炼 Key 时应给出明确配置错误，同时保证仓库、浏览器、Skill 管理和历史媒体查看仍可工作。

## 实现步骤（Spec Coding Tasks）

1. **AIGC-T1 · 配置 Agent**：创建编排主 Agent、图片／视频子 Agent，保存三份专属文件；主 Agent 装配两个子 Agent，但自身不装配媒体 MCP。
2. **AIGC-T2 · Skill 与本地工具**：两个 Skill 各含 `SKILL.md`、`generate.py`，只给对应子 Agent 装配。`runtime.ts` 注册生成图片和视频的进程内 MCP 工具；工具输入只含任务说明、会话及轮次定位。
3. **AIGC-T3 · 设置和凭据**：通过设置 API 校验模型、尺寸、时长与分辨率；启动时读本机凭据文件，只公开“可用／不可用”。Python 选择支持 `AIGC_PYTHON`、Windows `py -3` 和其他系统 `python3`。
4. **AIGC-T4 · 状态机**：写入 `queued` 元数据后开始工作；图片同步请求，视频提交后立即持久化任务 ID 再轮询；同会话同轮同类型重复调用复用原产物，不并发提交第二次。
5. **AIGC-T5 · 下载边界**：仅接收可信 HTTPS 媒体主机；测试模式只允许指定本地 mock 来源。限制重定向次数和大小，校验 PNG／MP4 文件头，写入临时文件后重命名，再标记成功。
6. **AIGC-T6 · 恢复与展示**：启动时读取元数据，恢复可继续的任务；产物 API 只返回成功文件，运行台展示状态事件、预览和错误原因。
7. **AIGC-T7 · 模拟覆盖**：用本地假服务验证提交、轮询、失败、超时、重启、重复调用、非法媒体和无 Key；真实付费调用单独记录。

## 可直接复制的构建提示词

> 在现有 Agent／MCP／Skill 工程中加入文生图和文生视频工作流。新增 AIGC 编排主 Agent、图片子 Agent、视频子 Agent；主 Agent 按需求委派，模糊需求通过结构化提问，两个子 Agent 各自只装配对应 Skill 和本地 MCP 生成工具。为每个 Skill 添加 SKILL.md 与只用 Python 标准库的脚本；Node 后端读取接收者本机凭据，向 Python 传入必要值，不把 Key 写入配置、事件、API 或公开文件。图片同步生成，视频异步提交并保存任务 ID、轮询和恢复。持久化成功／失败元数据及本地媒体，提供只读产物接口和设置页。用本地模拟百炼服务覆盖图片、视频、失败、超时、重启恢复与重复请求；真实付费调用作为单独可选验收，不能以模拟通过冒充。

## 验收方法

运行 `npm run test:aigc`、类型检查和构建；在隔离目录用模拟凭据执行图片、视频、失败和恢复路径，检查元数据、文件、API MIME 类型及事件归属。无 Key 启动时能浏览示例媒体但新生成明确失败。若执行真实服务验收，记录调用日期、模型和产物结果，不公开 Key 或私人业务空间地址。

## 实现后的校验逻辑

| 对应需求 | 操作 | 通过条件 |
| --- | --- | --- |
| AIGC-01 | 分别提出图片、视频和模糊需求 | 前两者委派对应子 Agent；模糊任务出现用户选择；事件中的目标 Agent 可核对 |
| AIGC-02 | 无 Key 查询设置并尝试新生成 | 状态为不可用，生成失败可理解，仓库／浏览器功能仍能运行 |
| AIGC-03 | mock 视频提交后停服重启；同轮重试 | 已保存云端 ID，恢复只轮询，不发生第二次提交 |
| AIGC-04 | mock 返回合法、错误类型、过大或不可信 URL | 仅合法媒体提供 `/api/artifacts/:id`；其余记为失败且不留下成功文件 |
| AIGC-05 | 扫描 JSON、API、日志、ZIP | 无明文 Key 或私有服务 URL |

`test:aigc` 的结果只证明本地状态机与模拟接口。真实百炼模型、费用和服务端响应需要独立实测。
