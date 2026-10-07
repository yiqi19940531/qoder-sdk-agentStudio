# 05 · Skill 发现、编辑与安全发布

## 要实现的效果

Agent 可以装配项目插件中的 Skill；独立 Skill 页面可创建、导入、编辑、校验和发布。现有 `repo-review`、`bailian-image`、`bailian-video` 三个 Skill 保留完整目录与装配关系。

## 前置模块

完成 [04 MCP](04-mcp-and-browser.md)；至少已有可运行的 Agent、新会话及 Qoder SDK 插件加载入口。AIGC Skill 的脚本先作为文件保存，实际媒体调用在 [06](06-aigc-and-media.md) 验证。

## 数据与调用链

`plugins/workbench/.qoder-plugin/plugin.json` 标识本地插件；`plugins/workbench/skills/<slug>/SKILL.md` 使用 YAML frontmatter 描述 Skill，可带脚本、参考资料和二进制资源。`server/skills.ts` 解析已发布 Skill，SDK 启动时发现插件，再由 Agent 的 `skills` 列表装配。只把名字写进 Agent JSON 不足以证明 SDK 能加载。

`server/skill-drafts.ts` 将表单、新 `SKILL.md` 和 ZIP 导入的内容放进 `data/skill-drafts/`。页面通过草稿 API 查看目录树、编辑 UTF-8 文件、替换二进制文件、创建／重命名／删除条目；每次修改增加版本。校验先查 YAML、名称、描述、正文和目录，再在隔离插件中通过 SDK 发现；校验不运行上传脚本。发布时重新校验并防止旧草稿覆盖新版本，失败时保留已有发布目录。发布成功清除发现缓存、更新清单，新会话才读取新版。

## 关键文件和接口

`src/SkillManager.tsx` 是管理页面；`server/skills.ts` 是已发布目录逻辑；`server/skill-drafts.ts` 是草稿、ZIP 和发布逻辑。API 包括 `GET/POST /api/skills`、`GET/POST /api/skill-drafts`、草稿文件／条目操作、`validate` 与 `publish`。`scripts/skill-integration-test.ts` 覆盖 SDK 发现和导入流程。

## 架构约束

- 每个 ZIP 只导入一个 Skill；`SKILL.md` 位于根目录或唯一一层外壳目录。拒绝路径穿越、绝对路径、重复路径、链接、特殊文件和压缩炸弹。
- 当前实现限制：ZIP 压缩体积 20 MiB、解压总量 50 MiB、最多 200 个条目、单文件 10 MiB。改限额要同步 API 与测试。
- 文本编辑保留额外 YAML 字段；二进制资源只预览／下载／替换。发布是显式操作，导入不自动装配。
- 格式合规、SDK 可发现与脚本可信／运行成功是不同结论。删除 Skill 前先从所有 Agent 卸载；运行中的会话不热重载。

## 可直接复制的复建提示词

> 在现有 Agent 工程中实现独立 Skill 管理。保留本地 workbench 插件及已发布 repo-review、bailian-image、bailian-video；Agent 继续按完整 Skill 名装配，管理移到配置页。支持表单创建、单个 SKILL.md 和单 Skill ZIP 导入；导入进入草稿目录，不直接覆盖发布内容。草稿可浏览目录树、编辑 UTF-8 文件、替换二进制资源，并用版本号防并发覆盖。严格检查 ZIP 路径、类型、重复项和体积限制；校验 YAML、目录与内容，再用隔离插件做 SDK 发现，不运行脚本。发布前重新校验，失败时保留旧版；发布后刷新发现结果与配置清单，新会话使用新版。写模拟集成测试验证导入、非法包、版本冲突、装配和删除限制，不调用付费媒体服务。

## 验收方法

运行 `npm run test:skills`、类型检查和构建。三个内置 Skill 均显示文件树；两个百炼脚本可阅读。导入一个合法 `SKILL.md` 和一个含多文件的 ZIP，再分别验证无效 YAML、路径穿越、重复文件、超限、并发旧版本和 SDK 发现失败均不能改动已发布目录。新会话查看 SDK 初始化发现清单；明确要求使用 Skill 的任务可出现 `Skill` 工具调用，但不保证模型在每次任务中都调用。
