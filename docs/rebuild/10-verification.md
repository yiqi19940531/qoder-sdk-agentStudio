# 10 · 分阶段验收与发布核对

本表把“能编译”“模拟服务通过”和“真实 SDK／外部服务通过”分开。复建者应在每阶段记录日期、系统、Node、SDK 与系统 CLI 版本，不要把测试名当作实际调用证明。

| 阶段 | 最小验收 | 证据 |
| --- | --- | --- |
| 02 基础 | Agent 保存、刷新、删除；独立人格／规则／记忆不串写 | API 响应与磁盘文件 |
| 03 运行时 | 当前账号只读查询、真实子 Agent 委派、两轮会话、审批、中断／重启、模型回退 | SDK 初始化／工具／模型／轮次事件；`test:models` |
| 04 MCP | 无密钥内置工具发现；模拟 stdio/HTTP/SSE、认证、超时和脱敏 | `test:mcp` 与检查结果；真实网页需另测 |
| 05 Skill | 三个已发布 Skill 发现；草稿、ZIP 拒绝规则、发布和装配 | `test:skills`、SDK 发现清单 |
| 06 AIGC | 模拟图片、视频提交／轮询／恢复、失败与本地媒体 | `test:aigc`；真实百炼调用另列 |
| 07 界面 | 未调用子 Agent 不亮线；实际委派和产物归属正确；轮次切换、双语和主题 | `test:flow`、页面人工核对 |
| 08 公开 | 干净目录安装／启动；6 Agent、3 Skill、34 存档、4 成功媒体；存档不可续接；全包扫描 | `package:public`、解压目录 API 与 ZIP 条目检查 |

## 建议命令

在**隔离副本**中执行会写入测试数据的集成测试，避免改变已公开演示夹具。

```sh
npm ci
npm run typecheck
npm run build
npm run test:models
npm run test:flow
```

在另一个终端运行 `npm start`，等待本地 API 就绪，再回到隔离副本执行以下集成测试；测试会调用该服务并写入临时数据。

```sh
npm run test:mcp
npm run test:skills
npm run test:aigc
npm run package:public
```

然后在新临时目录解压 ZIP，运行 `node scripts/quickstart.mjs`。通过 `GET /api/bootstrap`、`GET /api/conversations` 和媒体接口核对数量。抽看几条会话的消息、事件、Agent 图及产物；`POST /api/conversations/:id/messages` 对演示存档应返回 HTTP 409，历史页输入新问题应产生新会话 ID。

## 安全核对

1. 检查所有新增文档、提示词和截图：只出现相对路径、服务示例及占位符，不含任何原作者 Key、Token、认证头、完整私人 URL 参数或本机用户路径。
2. 确认 ZIP 路径和解压内容中没有凭据文件、MCP 私有连接快照、`node_modules`、构建缓存或临时浏览器资料。打包器应对每个压缩前文件和解压后的 ZIP 条目再扫描。
3. 逐张查看新增图片／视频可见画面。自动字节扫描不能代替画面检查。
4. 从公开 GitHub 仓库重新下载 ZIP，核对它与本地待发布包的 SHA-256、文件数量和 `docs/rebuild/` 文档链接。

## 当前版本已有证据与限制

原演示包在 macOS arm64 上完成干净目录安装、构建、启动、内置 `auto` 真实回复、无密钥 MCP 连接、Skill 发现，以及隔离环境中的 MCP／Skill／AIGC 模拟测试。Linux 和 Windows x64 的脚本存在，但此前未在这些系统实机运行；不要在新增文档中把“提供脚本”写成“已跨平台验证”。自动记忆写入只观察到 SDK 事件，没有稳定的成功写入证据。详见公开版 [VALIDATION.md](../../VALIDATION.md)。

文档发布本身的完成条件还包括：所有内部链接可打开；[逐文件索引](09-file-map.md)覆盖公开源码／脚本／配置；原工程、GitHub 仓库和 ZIP 的文档内容一致；README 均有入口；公开包扫描通过。
