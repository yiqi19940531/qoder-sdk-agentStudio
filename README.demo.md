# Qoder Agent Workbench 演示包 / Demo package

从 [中文快速指南](QUICKSTART.zh-CN.md) 或 [English quick start](QUICKSTART.en.md) 开始。本包包含 7 个 Agent、3 个 Skill、无需凭据的 MCP、34 条只读演示会话，以及先前生成的图片和视频。京东商城研究 Agent 需要接收者自己的 Browserless Token：先后台搜索商品，只有京东要求登录或风险验证时才显示可交互浏览器。其他核心演示不依赖它。演示会话中的提问会使用你自己的 Qoder 账号创建新会话。

要理解工程的构建过程并从空目录构建，请阅读 [Agent Hub 构建指南](docs/rebuild/README.md)：每阶段都给出目标、技术栈、模块文件架构、实施任务、可复制提示词及校验逻辑。

[京东洗发水远程浏览器案例](docs/cases/jd-shampoo-remote-browser.md)记录 Agent 与云浏览器共享会话、按需人工接管和认证档案恢复的实现及实际验证边界。

另有 [六段功能演示](artifacts/promo-videos/README.md)，分别介绍主子 Agent、MCP、Skill 与权限控制；打开 [滚动播放展示页](docs/index.html) 可逐段观看。

Start with the [Chinese guide](QUICKSTART.zh-CN.md) or [English guide](QUICKSTART.en.md). The archive includes seven Agents, three Skills, keyless MCP definitions, 34 read-only conversations, and generated media. The optional JD mall research Agent needs your own Browserless token; it browses in the background and requests human control only when JD requires it. New questions use your own Qoder account in a new session.

For a staged spec-driven build with architecture constraints, file ownership, implementation tasks and copyable prompts, see the [build guide](docs/rebuild/README.md) (Chinese, with English navigation).

The [JD shampoo remote-browser case](docs/cases/jd-shampoo-remote-browser.md) explains the shared browser session, human handoff, saved login state, and current test limits.

Explore the [six feature demos](artifacts/promo-videos/README.md) for Agent delegation, MCP, Skills, and permissions, or open the [scroll-to-play gallery](docs/index.html).
