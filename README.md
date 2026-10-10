# Qoder Agent Workbench / Agent Studio Demo

一个基于 **Qoder Agent SDK** 的本地多 Agent 工作台。项目内提供 7 个 Agent、3 个 Skill、无需 API Key 的基础浏览器与示例仓库 MCP，以及 34 条经过脱敏的历史对话和已生成的图片、视频。京东商城研究 Agent 是可选的 Browserless 云浏览器体验：先后台搜索商品，只有京东要求登录或风险验证时才显示可交互页面；需要使用者自己的 Token。其他功能可直接用自己的 Qoder 账号在本机体验。

**构建指南：** [按阶段构建 Agent Hub](docs/rebuild/README.md)，逐章说明目标、技术栈、模块文件架构、需求与接口、实现任务、可复制提示词及验收逻辑；[Browserless 登录接管](docs/rebuild/12-browserless-jd-login.md)和[京东商城研究](docs/rebuild/13-jd-mall-research.md)分别说明演进与当前流程。

**快速入口：** [直接下载完整演示 ZIP](https://raw.githubusercontent.com/yiqi19940531/qoder-sdk-agentStudio/main/downloads/qoder-agent-workbench-demo.zip) · [中文详细指南](QUICKSTART.zh-CN.md) · [English guide](QUICKSTART.en.md) · [实际验证记录](VALIDATION.md)

> ZIP 与仓库源码都不包含原作者的百炼 Key、Apify Token、Browserless Token、Qoder 登录状态或可复用的认证文件。需要联网模型时，请使用你自己的 Qoder 账号。

## 三步运行

1. 安装 [Node.js](https://nodejs.org/) **22.12+**、npm 与 [Qoder CLI](https://docs.qoder.com/cli/installation)。在终端运行 `qoder` 完成登录，然后用 `qoder --list-models` 查看当前账号模型。制作此包时使用的 CLI 为 **1.1.65**。
2. 获取工程：`git clone https://github.com/yiqi19940531/qoder-sdk-agentStudio.git`；或者下载上方 ZIP 并解压，进入 `qoder-agent-workbench-demo` 目录。
3. 在工程根目录执行：

   ```sh
   node scripts/quickstart.mjs
   ```

   脚本首次运行会执行 `npm ci`，随后构建并启动服务。打开 **http://127.0.0.1:8787**。macOS/Linux 也可以运行 `sh start.sh`，Windows x64 命令提示符可运行 `start.cmd`。停止服务按 Ctrl+C。如果端口已占用，可设置 `PORT` 环境变量后重新启动。

Node.js 最低支持版本为 20.19，推荐 22.12+。SDK 固定为 **1.0.50**，内置 **1.1.64** 运行时；系统 CLI 用于登录和管理模型，不需要与 SDK 运行时版本完全一致。[Qoder SDK 说明](https://docs.qoder.com/cli/sdk/overview)

## 六段功能演示

向下浏览动态预览；[打开完整展示页](https://yiqi19940531.github.io/qoder-sdk-agentStudio/)后，视频进入画面时会自动播放，离开时暂停。

### 1. Agent 装配

[![Agent 装配动态预览](artifacts/promo-videos/01-overview-preview.gif)](https://yiqi19940531.github.io/qoder-sdk-agentStudio/#clip-01)

浏览六个 Agent，查看主 Agent 与子 Agent 的模型、工具、Skill 和 MCP 如何组合。

### 2. 主子 Agent 委派

[![主子 Agent 委派动态预览](artifacts/promo-videos/02-repo-delegation-preview.gif)](https://yiqi19940531.github.io/qoder-sdk-agentStudio/#clip-02)

查看仓库协调 Agent 将任务交给代码审查子 Agent，并在流程图中查看双方的执行动作。

### 3. 图片与视频协作

[![图片与视频协作动态预览](artifacts/promo-videos/03-aigc-flow-preview.gif)](https://yiqi19940531.github.io/qoder-sdk-agentStudio/#clip-03)

查看编排 Agent 分配图片、视频任务，并回看已生成的媒体示例。

### 4. MCP 服务配置

[![MCP 服务动态预览](artifacts/promo-videos/04-mcp-config-preview.gif)](https://yiqi19940531.github.io/qoder-sdk-agentStudio/#clip-04)

校验 MCP 连接、查看实际发现的工具，再将服务装配给需要的 Agent。

### 5. Skill 管理

[![Skill 管理动态预览](artifacts/promo-videos/05-skills-preview.gif)](https://yiqi19940531.github.io/qoder-sdk-agentStudio/#clip-05)

查看 Skill 目录和脚本，编辑草稿并校验格式与 SDK 发现结果。

### 6. 权限控制

[![权限控制动态预览](artifacts/promo-videos/06-permissions-preview.gif)](https://yiqi19940531.github.io/qoder-sdk-agentStudio/#clip-06)

查看全局工具授权、Agent 默认审批策略和本地路径范围。

## 启动后能看到什么

| 内容 | 作用 |
| --- | --- |
| 仓库协调 Agent | 读取示例仓库并按需委派代码审查 |
| 代码审查 Sub-Agent | 用 `repo-review` Skill 检查具体代码问题 |
| 网页效果探索 Agent | 通过 Playwright / Chrome DevTools MCP 探索页面 |
| AIGC 任务编排 Agent | 编排图片和视频生成任务 |
| 图片生成 Sub-Agent | 使用 `bailian-image` Skill 与工具生成图片 |
| 视频生成 Sub-Agent | 使用 `bailian-video` Skill 与工具生成视频 |
| 京东商城研究 Agent | 后台搜索中国区商品、促销和评论；遇到登录或风险验证才把同一云浏览器交给用户 |

三个 Skill 的源码在 [`plugins/workbench/skills`](plugins/workbench/skills)。内置 MCP 包含 `repo-facts`、`playwright`、`chrome-devtools`、`bailian-image`、`bailian-video`、`jd-browser`。Apify 作为**未配置凭据、未装配**的服务定义保留，供接收者自行启用。

项目附带 **34 条演示存档会话**、成功与失败的生成记录、**2 张图片与 2 段视频**、示例仓库截图。可在“运行台”选择已有对话，查看消息、事件和 Agent 流程图；在原对话输入新问题会创建使用你自己账号的**新会话**，不会自动继承旧 SDK 上下文。直接通过 API 续接演示存档会被拒绝。图片与视频可在历史产物区域打开，原文件位于 [`data/generated`](data/generated)。

## 不配置可选 Key，先体验核心功能

- 选择“代码审查 Agent”：提问“只读审查 `calculator.ts`，指出一个边界情况，并给出可验证的修改建议”。
- 选择“仓库协调 Agent”：提问“请阅读示例仓库，委派代码审查 Sub-Agent，并汇总证据”。
- 安装 Google Chrome 后，选择“网页效果探索 Agent”：让它使用 Playwright 或 Chrome DevTools MCP 观察一个本地或公开网页。
- 浏览 34 条历史对话、流程事件和已有媒体，不需要 Apify 或百炼 Key。

所有 Agent 初始使用**按规则审批**和**仅工作目录访问**；基础安全读取工具预授权，其他操作按策略询问，全局始终允许工具列表为空。请在运行台按具体工具请求授权。

## 模型：无需 Token Plan

公开版 Agent 默认使用 Qoder 内置 `auto` 或 `efficient`。模型列表会从当前登录账号获取。如果保存的自定义模型对当前账号不可用，新会话会临时选用内置 `auto`，在事件中说明实际模型，同时保留原配置。若要接入自己的 Token Plan 或其他模型，在 Qoder CLI 的 `/model` 中设置，再到工作台选择；参考 [Qoder 自定义模型说明](https://docs.qoder.com/cli/custom-models)。

## 可选配置

### Apify MCP

在“配置 → MCP 服务”打开现成的 `apify` 定义，输入**你自己的** Bearer Token，保存后点击“校验连接”。发现工具后，再点击“装配到当前 Agent”，建议用于网页效果探索 Agent。Token 只保存在你的本机 `data/mcp-secrets.json`；新会话连接快照保存在 `data/mcp-session-config/`。这些文件均未上传，且被 `.gitignore` 排除。无需 Apify 也可使用内置浏览器 MCP。

### Browserless 京东商城研究与人工接管

将 `.env.example` 复制为 `.env`，只在本机填入自己的 `BROWSERLESS_API_TOKEN`，重启服务。选择“京东商城研究 Agent”，提问“后台搜索洗发水，尝试按销量排序，列出前 20 个商品的名称、价格、促销和高评分评论”。Agent 先在**隐藏的云浏览器**操作；京东要求登录、滑块或风险验证时，运行台才显示同一浏览器供你操作，并尽量直接打开带原搜索返回目标的官方登录页。完成人工步骤后点“完成并继续”。商品和评论按批次保存进度，并在 Web 页面显示；销量排序未核实时不会冒称“销量前 20”。[完整步骤](QUICKSTART.zh-CN.md#browserless-京东商城研究与人工接管)

默认使用 Browserless 中国住宅出口访问 `www.jd.com` 商城，代理流量会消耗 Browserless 单位。最近一次真人操作后，保存的京东档案已在新云浏览器中恢复，并在商城首页确认登录；但洗发水搜索另触发京东风险／登录验证，尚未取得真实商品或评论。此后 Browserless 免费套餐用量达到上限，暂时无法继续云端验收。工作台现在区分“此前确认登录”“当前搜索需验证”和“账户额度不足”。私有 `.env`、登录档案、任务结果、Live URL 和新会话不进入公开 ZIP；详见 [验证记录](VALIDATION.md)。

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
- `npm run package:public` 可重建 ZIP。打包器按白名单复制，并对压缩前后所有条目扫描密钥、认证头、私有路径及禁止文件；仅从固定演示索引收入 34 条存档，后来产生的私人登录会话不会被上传；检测失败会删除输出包。

发布包大小约 15 MB；在 macOS arm64 上已从全新目录验证自动安装、构建、启动、模型、MCP、Skill 和模拟 AIGC 测试。Linux 与 Windows x64 有共用启动逻辑和说明，但尚未在这两个系统上实机验证，详情见 [`VALIDATION.md`](VALIDATION.md)。

---

**English:** [Download the complete demo ZIP](https://raw.githubusercontent.com/yiqi19940531/qoder-sdk-agentStudio/main/downloads/qoder-agent-workbench-demo.zip) or clone this repository, sign in with your own Qoder CLI account, then run `node scripts/quickstart.mjs`. The project includes seven Agents, three Skills, 34 sanitized read-only conversations, four media files, and six short walkthroughs. The optional JD mall research Agent needs your own Browserless token and requests human control only when JD requires it; real product extraction remains unverified. See the [English quick start](QUICKSTART.en.md).
