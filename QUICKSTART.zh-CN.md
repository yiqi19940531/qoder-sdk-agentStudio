# Qoder Agent Workbench 演示包：快速开始

## 1. 安装并登录

支持 macOS、Linux 和 Windows x64。推荐 Node.js **22.12+** 与 npm；项目最低要求 Node.js 20.19。先安装 [Qoder CLI](https://docs.qoder.com/cli/installation)，在终端运行 `qoder` 并按提示登录，然后可运行 `qoder --version` 与 `qoder --list-models` 检查。制作演示包时本机验证的 CLI 为 **1.1.65**。项目锁定 [Qoder SDK](https://docs.qoder.com/cli/sdk/overview) **1.0.50**，它自带 **1.1.64** 运行时；系统 CLI 用来登录和管理模型，不必降级到 SDK 的运行时版本。

浏览器 MCP 需要安装 Google Chrome。图片或视频的**新生成**另需 Python 3 与你自己的百炼 Key；查看已有媒体不需要它们。Windows x64 可通过 `py -3 --version` 检查 Python。Windows arm64 暂未作为目标平台。

## 2. 一条命令启动

解压后进入 `qoder-agent-workbench-demo` 目录，运行：

```sh
node scripts/quickstart.mjs
```

也可以在 macOS/Linux 执行 `sh start.sh`，Windows 命令提示符执行 `start.cmd`。脚本检查环境，在首次运行时执行 `npm ci`，随后构建并启动本地服务。打开 **http://127.0.0.1:8787**。`npm ci` 需要网络；依赖来自包内锁文件。停止服务按 Ctrl+C。

## 3. 先看演示，再尝试自己的任务

左侧可查看 7 个 Agent、3 个 Skill、34 条历史会话及事件/流程图、成功和失败的生成记录，以及 4 个成功媒体文件。历史会话标记为**演示存档**。它们只能阅读；在历史页输入新问题，会以所选 Agent、当前账号和这条新问题创建一个全新会话。旧 SDK 上下文**不会自动继承**。如需引用历史内容，请自行在新问题中摘录。

无需 Apify 或百炼 Key 即可尝试：

- **仓库编排 Agent**：请阅读示例仓库 `calculator.ts`，让代码审查 Sub-Agent 检查边界情况并汇总。
- **代码审查 Sub-Agent**：请只读审查 `calculator.ts`，列出一个可验证的改进建议。
- **网页效果探索 Agent**：使用已装配的 Playwright/Chrome DevTools MCP 查看本地页面或公开网页，并描述页面结构。需安装 Chrome。
- **AIGC 导演 Agent**：查看已有生成记录，规划一段新的图片与视频提示词。新生成需要百炼 Key。
- **图片生成 Sub-Agent / 视频生成 Sub-Agent**：浏览既有图片或视频；配置百炼后再请求新生成。
- **京东商城研究 Agent**：配置自己的 Browserless Token 后，先让 Agent 后台搜索商品；仅在京东要求登录或风险验证时接管云浏览器。

默认所有 Agent 为“逐次审批 + 仅工作目录访问”，全局始终允许工具清单为空。演示时请在运行台根据具体工具请求作出决定。

## 4. 模型与可选能力

公开包的 Agent 使用 Qoder 内置 `auto` 或 `efficient`。模型列表由当前登录账号实时返回。无需 Token Plan 或自定义模型。若你后来把 Agent 保存为当前账号不可用的模型，新会话会临时使用可用的内置 `auto`，在事件中说明回退；原 Agent 配置保持原样。要使用自己的自定义模型，在 Qoder CLI 中运行 `/model` 并按 [自定义模型说明](https://docs.qoder.com/cli/custom-models) 配置，然后在工作台选择该模型。

### Apify

在“配置 → MCP 服务”选择保留的 `apify` 定义，在 **Bearer Token** 输入你自己的 Apify Token，保存并“校验连接”。发现工具后点击“装配到当前 Agent”，建议装配到网页效果探索 Agent。配置会写入本机 `data/mcp-secrets.json`，新会话另存本机连接快照；这些文件不在发布包内。没有 Token 时，Playwright、Chrome DevTools 和示例仓库 MCP 仍可用。

### Browserless 京东商城研究与人工接管

在项目根目录复制 `.env.example` 为 `.env`，填入**你自己的** `BROWSERLESS_API_TOKEN`；`BROWSERLESS_WS_ENDPOINT` 填不含 Token 的 Browserless Chromium CDP 地址。重启本地服务。`.env` 不会进入公开包。按账户套餐上限设置 `BROWSERLESS_SESSION_TIMEOUT_MS` 和 `BROWSERLESS_LIVE_TIMEOUT_MS`；免费套餐时长可能不足以完成短信验证。

选择“京东商城研究 Agent”，在新对话输入“后台搜索洗发水，尝试按销量排序，列出前 20 个商品的名称、价格、促销和高评分评论”。批准 `browser_search_products` 后，Agent 先在后台操作；只有京东要求登录、滑块或风险验证时，下方才出现可交互浏览器。可收起侧栏或全屏。**只在浏览器画面内**输入手机号和短信验证码、拖动滑块；完成人工步骤后尽快点击常驻的“完成并继续”。任务结果会显示在运行台商品表中。销量排序未核实时，不应把结果称为销量前 20；评论和促销只以页面实际读取内容为准。此功能无需本机安装 Chrome。

Live URL 是可控制浏览器的临时链接，只在本机运行台显示；不要把它、Token、登录 Cookie 或验证码复制到公开文档与问题报告。Browserless 免费套餐单次会话最多 2 分钟，刷新或重新生成 Live URL 不能延长原会话；要使用更长会话，需更换支持更长时限的套餐或部署，再按上限修改 `.env` 中的两个超时值并重启服务。若链接到期，可在同一对话点击“重新打开京东验证”；商品任务与评论进度保存在本机，可继续。没有 Browserless Token 时，其他六个 Agent 仍可使用。

默认使用 Browserless 中国住宅出口，代理流量会消耗 Browserless 单位；可在 `.env` 中调整 `BROWSERLESS_JD_PROXY_NETWORK` 和 `BROWSERLESS_JD_PROXY_COUNTRY`。人工完成后，服务尝试保存 Browserless Authenticated Profile，关闭原云浏览器，再开启加载档案的新浏览器核验：**已登录**和**商城可访问但登录未单独确认**会分别标记。本机只保存随机档案名称和任务进度，不保存 Cookie 值；云端档案本身属于敏感认证状态。之后新会话会尝试加载档案，但京东可能再次要求验证。若页面跳到 `cfe.m.jd.com` 风险页，请在画面中亲自完成；`corporate.jd.com` 不是中国区商城。

### 百炼图片与视频

在解压目录根部自行创建 `api-key.md`，其中仅放**一个**以 `sk-` 开头的百炼 Key，及**一个**北京地域业务空间的 HTTPS 地址，路径以 `/compatible-mode/v1` 开头。示意格式：

```text
Key: <你自己的百炼 Key>
接口: <你自己业务空间的完整 compatible-mode/v1 URL>
```

然后重启服务。运行时读取此文件并通过 Python 3 调用百炼；Windows 默认使用 `py -3`，如需指定解释器可设置 `AIGC_PYTHON`。请勿把 `api-key.md`、`data/mcp-secrets.json` 或 `data/mcp-session-config/` 再次打包或上传。查看历史图片、视频及失败记录不需要 Key。

## 5. 包与验证

包由 `npm run package:public` 从原项目的白名单文件重建；原始历史文件不会改写。生成前和写入 ZIP 后都会扫描条目，发现已知密钥、常见凭据形式、认证头、本机用户路径或禁止文件即阻止发布。`DEMO-MANIFEST.json` 记录演示内容数量。

已实际验证的平台和测试见本包 `VALIDATION.md`。脚本共用同一 Node 启动逻辑；未实测的平台会在该文件中明确标注。
