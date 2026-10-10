# 09 · 公开工程逐文件索引

本索引以公开 ZIP／仓库的白名单内容为准。列出每个源码、脚本和配置文件的职责；会话、媒体及截图列在末尾按类型说明。文件名是构建时的建议边界，不要求不同实现逐字复制源码。原工作目录里的秘密文件、临时探针、缓存和未发布文档不属于公开工程。

## 根目录与启动

| 文件 | 职责／对应阶段 |
| --- | --- |
| `package.json` | 依赖版本、开发／构建／测试／打包命令；02、08 |
| `package-lock.json` | 锁定 npm 依赖树，保证安装复现；02 |
| `tsconfig.server.json` | 服务端及脚本 TypeScript 编译配置；02 |
| `tsconfig.web.json` | React 前端类型检查配置；02 |
| `vite.config.ts` | Vite 构建和开发代理设置；02 |
| `index.html` | Web 入口文档；02 |
| `.gitignore` | 忽略依赖、构建物、凭据与接收者新产生的数据；08 |
| `.env.example` | Browserless 环境变量占位示例，不含真实 Token；12 |
| `start.sh` | macOS／Linux 启动包装，进入共享 Node 快启；08 |
| `start.cmd` | Windows x64 启动包装，进入共享 Node 快启；08 |
| `README.md` | ZIP 中的演示说明；仓库根 README 提供在线入口；08 |
| `README.demo.md` | 公开仓库中的 ZIP 专用 README 来源，打包时写为 ZIP 根 README；08 |
| `QUICKSTART.zh-CN.md` | 中文安装、配置和体验任务；08 |
| `QUICKSTART.en.md` | 英文快速指南；08 |
| `VALIDATION.md` | 实际测试平台、模拟测试与未验证平台边界；08 |
| `DEMO-MANIFEST.json` | ZIP 中演示 Agent、Skill、存档、媒体和宣传短片的预期数量；08 |
| `docs/index.html` | 六段视频的滚动播放展示页，进入视口播放、离开暂停；08 |
| `docs/.nojekyll` | GitHub Pages 直接发布 `docs/` 静态文件；08 |
| `public/favicon.svg` | Web 页标签图标；07 |

## 共享契约与前端

| 文件 | 职责／对应阶段 |
| --- | --- |
| `shared/types.ts` | Agent、MCP、Skill、会话、事件、媒体和 API 数据类型；02–08 |
| `shared/model-selection.ts` | 根据当前账号模型清单解析新会话模型及回退记录；03、08 |
| `shared/agent-flow.ts` | 按事件、委派 ID 和产物归属生成流程节点状态；07 |
| `src/main.tsx` | 应用导航、Agent 草稿、运行台、会话／SSE、审批、存档入口；02、03、07、08 |
| `src/AgentFlow.tsx` | 配置及运行流程图的节点、连线和详情交互；07 |
| `src/McpManager.tsx` | MCP 列表、定义、校验、工具清单和装配界面；04 |
| `src/SkillManager.tsx` | Skill 列表、草稿文件树、上传、校验和发布界面；05 |
| `src/RemoteBrowser.tsx` | 京东云浏览器 iframe、人工接管按钮和状态 SSE；12 |
| `src/remote-browser.css` | 远程浏览器面板布局、固定高度视口和响应式样式；12 |
| `src/i18n.ts` | 平台 UI 的中英文文案；07 |
| `src/styles.css` | 主体布局、深色主题、运行台与装配样式；07 |
| `src/light.css` | 浅色主题变量和覆盖样式；07 |
| `src/mcp.css` | MCP 管理页面样式；04、07 |
| `src/skill.css` | Skill 管理页面样式；05、07 |

## 后端

| 文件 | 职责／对应阶段 |
| --- | --- |
| `server/index.ts` | Express 启动、输入验证、Agent／MCP／Skill／会话／产物 API；02–08 |
| `server/storage.ts` | 工作目录、Agent 配置、人格、规则、记忆的初始化及文件读写；02、03 |
| `server/config-catalog.ts` | 从各配置来源生成可核对的清单；02 |
| `server/runtime.ts` | Qoder SDK 发现、工具名与 MCP 构造、子 Agent 定义、旧运行接口；03、04、06 |
| `server/conversations.ts` | 多轮 SDK 查询、会话持久化、SSE、决策、恢复与中断；03、07、08 |
| `server/agent-policy.ts` | Agent 默认工具和路径授权、子 Agent 调用者识别；03 |
| `server/permissions.ts` | 全局工具授权、操作类别及持久化；03 |
| `server/mcp-registry.ts` | 内置／自定义 MCP 定义、秘密值分离、会话连接快照与脱敏；04 |
| `server/mcp-check.ts` | MCP 连接、工具发现、超时和 OAuth 流程；04 |
| `server/skills.ts` | 已发布 Skill 的解析、列举、保存和删除；05 |
| `server/skill-drafts.ts` | 草稿目录、ZIP 解压限制、格式／SDK 发现校验、版本控制和发布；05 |
| `server/aigc.ts` | 可选凭据状态、媒体任务、Python 调用、下载、持久化与恢复；06 |
| `server/browser-service.ts` | Browserless CDP 会话、Live URL、控制权、超时和清理；12 |
| `server/jd-login.ts` | 京东官方登录入口及保守的账户页核验规则；12 |

## 构建、探针和测试脚本

| 文件 | 职责／对应阶段 |
| --- | --- |
| `scripts/quickstart.mjs` | 环境检查、必要时安装、构建并启动本地服务；08 |
| `scripts/package-public.mjs` | 白名单复制、脱敏、双重扫描和演示 ZIP 生成；08 |
| `scripts/model-selection-test.ts` | 可用／不可用模型、无自定义模型及不改原配置测试；03、08 |
| `scripts/browser-integration-test.ts` | 用模拟 CDP 验证同页接管、核验、保留会话与脱敏事件；12 |
| `scripts/agent-flow-test.ts` | 配置图和真实／历史事件归属测试；07 |
| `scripts/mcp-integration-test.mjs` | MCP 传输、认证、超时、脱敏及装配测试；04 |
| `scripts/mock-mcp.mjs` | MCP 集成测试的本地模拟服务；04 |
| `scripts/skill-integration-test.ts` | Skill 导入、ZIP 安全、SDK 发现、版本冲突及装配测试；05 |
| `scripts/aigc-integration-test.ts` | 图片／视频、失败、轮询、恢复和媒体 API 的模拟测试；06 |
| `scripts/aigc-mock-server.ts` | AIGC 测试使用的本地模拟接口；06 |
| `scripts/apify-verification.ts` | Apify 连接的可选人工验证脚本，运行需接收者自行配置；04 |
| `scripts/memory-probe.ts` | SDK 自动记忆实验脚本，可能产生真实模型调用，不是默认验收；03 |

## 插件、示例仓库与配置

| 文件 | 职责／对应阶段 |
| --- | --- |
| `plugins/workbench/.qoder-plugin/plugin.json` | 本地 workbench 插件标识；05 |
| `plugins/workbench/skills/repo-review/SKILL.md` | 仓库审查指令；03、05 |
| `plugins/workbench/skills/bailian-image/SKILL.md` | 图片生成子 Agent 的操作指令；06 |
| `plugins/workbench/skills/bailian-image/generate.py` | 图片服务 HTTP 调用脚本；06 |
| `plugins/workbench/skills/bailian-video/SKILL.md` | 视频生成子 Agent 的操作指令；06 |
| `plugins/workbench/skills/bailian-video/generate.py` | 视频任务提交与查询脚本；06 |
| `data/agents.json` | 七个演示 Agent 的元数据与装配关系；02–08、12 |
| `data/demo-archive-index.json` | 固定 34 条可公开演示会话的 ID，打包时排除后来产生的私人登录对话；08、12 |
| `data/mcp-servers.json` | 无凭据 MCP 定义与初始未测试状态；04、08 |
| `data/permission-settings.json` | 全局工具允许列表，公开版为空；03、08 |
| `data/aigc-settings.json` | 图片／视频模型和规格，不含 Key；06 |
| `data/example-repo/calculator.ts` | 仓库阅读、审查与审批任务的样例代码；02、03 |
| `data/example-repo/AGENTS.md` | 中性的示例仓库说明，不充当所有 Agent 的专属规则；02、03 |

每个活动 Agent 使用三份独立文件；下表将公开版的 **21 个配置文件逐一列出**。

| 文件 | 职责 |
| --- | --- |
| `data/profiles/repo-coordinator/persona.md` | 仓库协调主 Agent 人格 |
| `data/profiles/repo-coordinator/AGENTS.md` | 仓库协调规则 |
| `data/profiles/repo-coordinator/memory/INDEX.md` | 仓库协调显式记忆 |
| `data/profiles/code-reviewer/persona.md` | 代码审查子 Agent 人格 |
| `data/profiles/code-reviewer/AGENTS.md` | 代码审查规则 |
| `data/profiles/code-reviewer/memory/INDEX.md` | 代码审查显式记忆 |
| `data/profiles/42dd9f43-12b7-4570-af13-609ad26a24a9/persona.md` | 网页效果探索 Agent 人格 |
| `data/profiles/42dd9f43-12b7-4570-af13-609ad26a24a9/AGENTS.md` | 网页效果探索规则 |
| `data/profiles/42dd9f43-12b7-4570-af13-609ad26a24a9/memory/INDEX.md` | 网页效果探索显式记忆 |
| `data/profiles/aigc-director/persona.md` | AIGC 编排主 Agent 人格 |
| `data/profiles/aigc-director/AGENTS.md` | AIGC 编排规则 |
| `data/profiles/aigc-director/memory/INDEX.md` | AIGC 编排显式记忆 |
| `data/profiles/aigc-image/persona.md` | 图片生成子 Agent 人格 |
| `data/profiles/aigc-image/AGENTS.md` | 图片生成规则 |
| `data/profiles/aigc-image/memory/INDEX.md` | 图片生成显式记忆 |
| `data/profiles/aigc-video/persona.md` | 视频生成子 Agent 人格 |
| `data/profiles/aigc-video/AGENTS.md` | 视频生成规则 |
| `data/profiles/aigc-video/memory/INDEX.md` | 视频生成显式记忆 |
| `data/profiles/jd-login/persona.md` | 京东登录主 Agent 人格 |
| `data/profiles/jd-login/AGENTS.md` | 人工接管与保守核验规则 |
| `data/profiles/jd-login/memory/INDEX.md` | 京东登录 Agent 的独立记忆文件 |

## 演示数据与本目录

- `data/conversations/*.json`：34 条脱敏只读会话，包含成功及失败的消息、轮次、事件与创建时配置；按同一 `Conversation` 契约保存，无需为每条写不同实现说明。
- `data/generated/*.json` 与同目录媒体：生成任务状态及 2 张图片、2 段视频；成功媒体经产物 API 打开。失败记录没有对应成功媒体是正常状态。
- `data/example-repo/*.png`、`artifacts/*`、`data/mcp-ui*.png`：示例页面及配置界面的安全截图，只作演示材料，不参与 SDK 执行。
- `artifacts/promo-videos/README.md`、六段 `*.mp4`、同名 `*-poster.png` 与 `*-preview.gif`：功能短片、封面和动态预览；展示历史流程、MCP／Skill 管理及权限，不参与 SDK 执行。
- `docs/rebuild/README.md`、`00-history-and-goals.md`、`01-architecture-contract.md`、`02-foundation-and-agents.md`、`03-runtime-and-conversations.md`、`04-mcp-and-browser.md`、`05-skills.md`、`06-aigc-and-media.md`、`07-interface-and-flow.md`、`08-public-demo.md`、本文件、`10-verification.md`、`11-spec-coding-workflow.md` 与 `12-browserless-jd-login.md`：构建路线、阶段规范、Spec Coding 工作法、逐文件索引与验收；08、12。
- `downloads/qoder-agent-workbench-demo.zip` 只在公开 GitHub 仓库中作为下载物存在；它不是 ZIP 自身的输入。

接收者运行后产生的 `data/config-catalog.json`、`data/mcp-secrets.json`、`data/mcp-session-config/` 和新会话／新媒体属于本机状态，不在初始公开包中。任何凭据文件只用占位说明，不提供示例真值。
