# Qoder Agent Workbench / Agent Studio Demo

一个基于 **Qoder Agent SDK** 的本地多 Agent 工作台。项目内提供 6 个 Agent、3 个 Skill、无需 API Key 的浏览器与示例仓库 MCP，以及 34 条经过脱敏的历史对话和已生成的图片、视频。克隆仓库或下载演示 ZIP 后，只需使用自己的 Qoder 账号登录，即可在本机体验。

**快速入口：** [下载完整演示 ZIP](downloads/qoder-agent-workbench-demo.zip) · [中文详细指南](QUICKSTART.zh-CN.md) · [English guide](QUICKSTART.en.md) · [实际验证记录](VALIDATION.md)

> ZIP 与仓库源码都不包含原作者的百炼 Key、Apify Token、Qoder 登录状态或可复用的认证文件。需要联网模型时，请使用你自己的 Qoder 账号。

## 三步运行

1. 安装 [Node.js](https://nodejs.org/) **22.12+**、npm 与 [Qoder CLI](https://docs.qoder.com/cli/installation)。在终端运行 `qoder` 完成登录，然后用 `qoder --list-models` 查看当前账号模型。制作此包时使用的 CLI 为 **1.1.65**。
2. 获取工程：`git clone https://github.com/yiqi19940531/qoder-sdk-agentStudio.git`；或者下载上方 ZIP 并解压，进入 `qoder-agent-workbench-demo` 目录。
3. 在工程根目录执行：

   ```sh
   node scripts/quickstart.mjs
   ```

   脚本首次运行会执行 `npm ci`，随后构建并启动服务。打开 **http://127.0.0.1:8787**。macOS/Linux 也可以运行 `sh start.sh`，Windows x64 命令提示符可运行 `start.cmd`。停止服务按 Ctrl+C。如果端口已占用，可设置 `PORT` 环境变量后重新启动。

Node.js 最低支持版本为 20.19，推荐 22.12+。SDK 固定为 **1.0.50**，内置 **1.1.64** 运行时；系统 CLI 用于登录和管理模型，不需要与 SDK 运行时版本完全一致。[Qoder SDK 说明](https://docs.qoder.com/cli/sdk/overview)

## 启动后能看到什么

| 内容 | 作用 |
| --- | --- |
| 仓库协调 Agent | 读取示例仓库并按需委派代码审查 |
| 代码审查 Sub-Agent | 用 `repo-review` Skill 检查具体代码问题 |
| 网页效果探索 Agent | 通过 Playwright / Chrome DevTools MCP 探索页面 |
| AIGC 任务编排 Agent | 编排图片和视频生成任务 |
| 图片生成 Sub-Agent | 使用 `bailian-image` Skill 与工具生成图片 |
| 视频生成 Sub-Agent | 使用 `bailian-video` Skill 与工具生成视频 |

三个 Skill 的源码在 [`plugins/workbench/skills`](plugins/workbench/skills)。内置 MCP 包含 `repo-facts`、`playwright`、`chrome-devtools`、`bailian-image`、`bailian-video`。Apify 作为**未配置凭据、未装配**的服务定义保留，供接收者自行启用。

项目附带 **34 条演示存档会话**、成功与失败的生成记录、**2 张图片与 2 段视频**、示例仓库截图。可在“运行台”选择已有对话，查看消息、事件和 Agent 流程图；在原对话输入新问题会创建使用你自己账号的**新会话**，不会自动继承旧 SDK 上下文。直接通过 API 续接演示存档会被拒绝。图片与视频可在历史产物区域打开，原文件位于 [`data/generated`](data/generated)。

## 不配置可选 Key，先体验核心功能

- 选择“代码审查 Agent”：提问“只读审查 `calculator.ts`，指出一个边界情况，并给出可验证的修改建议”。
- 选择“仓库协调 Agent”：提问“请阅读示例仓库，委派代码审查 Sub-Agent，并汇总证据”。
- 安装 Google Chrome 后，选择“网页效果探索 Agent”：让它使用 Playwright 或 Chrome DevTools MCP 观察一个本地或公开网页。
- 浏览 34 条历史对话、流程事件和已有媒体，不需要 Apify 或百炼 Key。

所有 Agent 初始使用**逐次审批**和**仅工作目录访问**；全局始终允许工具列表为空。请在运行台按具体工具请求授权。

## 模型：无需 Token Plan

公开版 Agent 默认使用 Qoder 内置 `auto` 或 `efficient`。模型列表会从当前登录账号获取。如果保存的自定义模型对当前账号不可用，新会话会临时选用内置 `auto`，在事件中说明实际模型，同时保留原配置。若要接入自己的 Token Plan 或其他模型，在 Qoder CLI 的 `/model` 中设置，再到工作台选择；参考 [Qoder 自定义模型说明](https://docs.qoder.com/cli/custom-models)。

## 可选配置

### Apify MCP

在“配置 → MCP 服务”打开现成的 `apify` 定义，输入**你自己的** Bearer Token，保存后点击“校验连接”。发现工具后，再点击“装配到当前 Agent”，建议用于网页效果探索 Agent。Token 只保存在你的本机 `data/mcp-secrets.json`；新会话连接快照保存在 `data/mcp-session-config/`。这些文件均未上传，且被 `.gitignore` 排除。无需 Apify 也可使用内置浏览器 MCP。

### 百炼图片与视频

只有**新生成**图片或视频时才需要配置。安装 Python 3（Windows x64 默认通过 `py -3` 调用），在工程根目录自行创建 `api-key.md`，写入**恰好一个**你自己的 `sk-` 百炼 Key，以及**恰好一个**北京地域业务空间的 HTTPS 地址，路径以 `/compatible-mode/v1` 开头，然后重启服务：

```text
Key: <你自己的百炼 Key>
接口: <你自己的完整业务空间 compatible-mode/v1 地址>
```

`api-key.md` 被 Git 忽略。不要把自己的凭据、运行中的对话或本机生成的连接快照提交到公开仓库。没有百炼 Key 时，已附带的媒体和失败案例仍可查看。

## 工程文件和发布包

- `src/` 是前端；`server/` 是本地 API 与 SDK 执行逻辑；`shared/` 放共享类型和模型选择逻辑。
- `plugins/workbench/skills/` 是 3 个 Skill；`data/` 中提交的是经脱敏的演示配置、会话和产物。
- `scripts/quickstart.mjs` 是三系统共用的启动入口。`npm run typecheck`、`npm run build`、`npm run test:models`、`npm run test:flow` 可做基础验证。
- `npm run package:public` 可重建 ZIP。打包器按白名单复制，并对压缩前后所有条目扫描密钥、认证头、私有路径及禁止文件；检测失败会删除输出包。

发布包大小约 13 MB；在 macOS arm64 上已从全新目录验证自动安装、构建、启动、模型、MCP、Skill 和模拟 AIGC 测试。Linux 与 Windows x64 有共用启动逻辑和说明，但尚未在这两个系统上实机验证，详情见 [`VALIDATION.md`](VALIDATION.md)。

---

**English:** Download the [complete demo ZIP](downloads/qoder-agent-workbench-demo.zip) or clone this repository, sign in with your own Qoder CLI account, then run `node scripts/quickstart.mjs`. The project includes six Agents, three Skills, 34 sanitized read-only conversations, and four media files. Apify and Bailian credentials are optional and must be supplied by each user. See the [English quick start](QUICKSTART.en.md) for setup details.
