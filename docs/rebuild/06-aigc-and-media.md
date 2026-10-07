# 06 · AIGC 编排与媒体产物

## 要实现的效果

用户给“AIGC 任务编排 Agent”提出图片或视频需求；主 Agent 拆解任务并委派“图片生成”或“视频生成”子 Agent。两个子 Agent 分别预载对应 Skill、只看见对应的生成 MCP 工具。生成记录和成功媒体在本地保存，页面能查看成功与失败。

## 前置模块

完成 [05 Skill](05-skills.md)：主子 Agent 会话、工具事件、插件发现及 Skill 装配可用。Python 3 和接收者自己的百炼凭据仅在实际新生成时需要；浏览现有媒体不需要。

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

## 可直接复制的复建提示词

> 在现有 Agent／MCP／Skill 工程中加入文生图和文生视频工作流。新增 AIGC 编排主 Agent、图片子 Agent、视频子 Agent；主 Agent 按需求委派，模糊需求通过结构化提问，两个子 Agent 各自只装配对应 Skill 和本地 MCP 生成工具。为每个 Skill 添加 SKILL.md 与只用 Python 标准库的脚本；Node 后端读取接收者本机凭据，向 Python 传入必要值，不把 Key 写入配置、事件、API 或公开文件。图片同步生成，视频异步提交并保存任务 ID、轮询和恢复。持久化成功／失败元数据及本地媒体，提供只读产物接口和设置页。用本地模拟百炼服务覆盖图片、视频、失败、超时、重启恢复与重复请求；真实付费调用作为单独可选验收，不能以模拟通过冒充。

## 验收方法

运行 `npm run test:aigc`、类型检查和构建；在隔离目录用模拟凭据执行图片、视频、失败和恢复路径，检查元数据、文件、API MIME 类型及事件归属。无 Key 启动时能浏览示例媒体但新生成明确失败。若执行真实服务验收，记录调用日期、模型和产物结果，不公开 Key 或私人业务空间地址。
