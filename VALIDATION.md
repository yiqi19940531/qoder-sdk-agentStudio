# 发布验证 / Release validation

实际测试环境：**macOS arm64**，Node.js **24.13.1**，npm **11.8.0**，Qoder CLI **1.1.65**。SDK 锁定 **1.0.50**，自带运行时 **1.1.64**。Linux 和 Windows x64 的启动脚本使用相同的 Node 入口，但**没有在这两个系统上实际执行**。

从 ZIP 解压到全新临时目录后，`npm ci`、`npm run typecheck`、`npm run build`、`npm run test:models`、`npm run test:flow` 均通过。最终包又在第二个全新目录运行 `node scripts/quickstart.mjs`，完成自动安装、构建和本地启动。服务 API 读到 6 个 Agent、3 个 Skill、34 条只读演示会话和 4 个媒体文件；旧会话详情含事件和流程记录，直接续接返回 HTTP 409。使用同一 Agent 新建的会话采用内置 `auto` 并完成了 SDK 回复。

隔离目录中 `npm run test:mcp`、`npm run test:skills`、`npm run test:aigc` 通过。无 Apify/百炼 Key 时，`repo-facts`、Playwright、Chrome DevTools 的 MCP 连接检查分别发现 1、25、30 个工具。使用本地模拟 Bearer 服务验证了 Apify 保存 Token、连接、发现工具并装配回网页 Agent；使用本地模拟百炼接口验证了图片、视频、续查、失败和超时流程。这些测试没有调用真实 Apify 或百炼付费接口。

发布打包器会对所有白名单文件及生成后的 ZIP 条目逐项扫描；最终 ZIP 在加入用户名和业务空间地址脱敏规则后重建并复检。`npm install` 最终报告 0 个已知漏洞；使用 `shell-quote` 1.11.0+ 的覆盖配置修复了开发依赖链中此前的告警。

English: Tested on macOS arm64 with Node 24.13.1, npm 11.8.0, and Qoder CLI 1.1.65. Clean extraction passed install, typecheck, build, model/flow tests, MCP/Skill/AIGC mock tests, API archive checks, and a live built-in `auto` response. Linux and Windows x64 have shared launch logic and guides but were not run on those operating systems. No real paid Apify or Bailian call was made during validation.
