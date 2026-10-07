# 05 · Skill 发现、编辑与安全发布

## 目标与交付结果

Agent 可以装配项目插件中的 Skill；独立 Skill 页面可创建、导入、编辑、校验和发布。现有 `repo-review`、`bailian-image`、`bailian-video` 三个 Skill 保留完整目录与装配关系。

## 前置模块

完成 [04 MCP](04-mcp-and-browser.md)；至少已有可运行的 Agent、新会话及 Qoder SDK 插件加载入口。AIGC Skill 的脚本先作为文件保存，实际媒体调用在 [06](06-aigc-and-media.md) 验证。

## 技术栈规划

Skill 遵循当前 Qoder 本地插件的 `SKILL.md` 目录规范；`yaml` 解析 frontmatter，`yauzl` 以逐项流读取 ZIP，Node 文件 API 管理草稿和发布目录。SDK 的初始化发现是发布前的必要检查，不能代替脚本可信度检查。

## 相关模块文件架构

| 层 | 文件与技术 | 职责 |
| --- | --- | --- |
| 插件 | `plugins/workbench/.qoder-plugin/plugin.json`、`skills/<slug>/SKILL.md` | Qoder SDK 本地插件与 Skill 指令 |
| 解析 | `server/skills.ts`、`yaml` | 已发布内容解析、保留 YAML、列举与删除 |
| 草稿 | `server/skill-drafts.ts`、`yauzl`、Node 文件 API | ZIP 安全解压、目录编辑、版本、SDK 发现与回滚发布 |
| API | `server/index.ts` | 导入、文件操作、验证、发布、删除及错误状态 |
| UI | `src/SkillManager.tsx`、`src/skill.css` | 草稿、文件树、文本编辑、二进制预览与校验结果 |
| 测试 | `scripts/skill-integration-test.ts` | 合法导入、恶意 ZIP、冲突和装配回归 |

Skill 的身份是 `workbench:<slug>`；草稿与正式 Skill 分目录。`SkillDraftRecord.version` 用 `If-Match` 传回 API，拒绝过期编辑；发布前再次计算已发布目录版本，避免两处编辑互相覆盖。

## 需求契约

| ID | 必须成立的行为 | 失败／边界 |
| --- | --- | --- |
| SKL-01 | 三个现有 Skill 的完整目录可发现、可查看，装配不变 | 缺 `SKILL.md` 或 SDK 未发现时明确显示 |
| SKL-02 | 表单、单文件和 ZIP 均先产生草稿 | 导入不自动发布、不自动装配 |
| SKL-03 | 文本可编辑、二进制可替换；每次修改增版本 | 旧 `If-Match` 返回冲突 |
| SKL-04 | ZIP 和 Skill 内容双层校验，且校验不执行脚本 | 路径穿越、链接、超限等拒绝 |
| SKL-05 | 发布重新校验并原子替换／回滚 | 失败保留已发布版；运行中的会话不热重载 |

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

## 实现步骤（Spec Coding Tasks）

1. **SKL-T1 · 发现基线**：补齐插件清单，启动时用 SDK 初始化结果确认三个现有 Skill；Agent 保存时只接受本地存在且 SDK 已发现的名称。
2. **SKL-T2 · 草稿格式**：建立 `data/skill-drafts/<id>/files` 和元数据，支持表单创建、单 `SKILL.md` 导入、一个 Skill 的 ZIP 导入；预先确定 20／50／200／10 MiB 限制。
3. **SKL-T3 · 安全 ZIP 解析**：逐项检查绝对／相对路径、重复名、文件类型、加密、解压体积与压缩比；先在草稿目录创建安全文件，不能解压到正式插件目录。
4. **SKL-T4 · 文件编辑 API**：读取树、编辑 UTF-8、替换二进制、增删重命名；对修改请求要求 `If-Match` 版本，并阻止删除或重命名 `SKILL.md`。
5. **SKL-T5 · 内容与发现校验**：验证 YAML frontmatter、`name`、描述、正文、目录名、名称冲突；在独立临时插件上进行无任务 SDK 发现。返回包含路径和原因的错误列表，失败草稿仍保留供修复。
6. **SKL-T6 · 发布事务**：发布前重校验版本和原目录修订值；移动旧目录到备份，再安装新目录、刷新缓存和配置清单。任何中途错误回滚旧版。
7. **SKL-T7 · UI 与回归**：在独立页面展示来源、文件数、发现结果和使用它的 Agent；装配按钮只改 Agent 草稿，必须另行保存。运行集成测试，不执行媒体脚本。

## 可直接复制的构建提示词

> 在现有 Agent 工程中实现独立 Skill 管理。保留本地 workbench 插件及已发布 repo-review、bailian-image、bailian-video；Agent 继续按完整 Skill 名装配，管理移到配置页。支持表单创建、单个 SKILL.md 和单 Skill ZIP 导入；导入进入草稿目录，不直接覆盖发布内容。草稿可浏览目录树、编辑 UTF-8 文件、替换二进制资源，并用版本号防并发覆盖。严格检查 ZIP 路径、类型、重复项和体积限制；校验 YAML、目录与内容，再用隔离插件做 SDK 发现，不运行脚本。发布前重新校验，失败时保留旧版；发布后刷新发现结果与配置清单，新会话使用新版。写模拟集成测试验证导入、非法包、版本冲突、装配和删除限制，不调用付费媒体服务。

## 验收方法

运行 `npm run test:skills`、类型检查和构建。三个内置 Skill 均显示文件树；两个百炼脚本可阅读。导入一个合法 `SKILL.md` 和一个含多文件的 ZIP，再分别验证无效 YAML、路径穿越、重复文件、超限、并发旧版本和 SDK 发现失败均不能改动已发布目录。新会话查看 SDK 初始化发现清单；明确要求使用 Skill 的任务可出现 `Skill` 工具调用，但不保证模型在每次任务中都调用。

## 实现后的校验逻辑

| 对应需求 | 操作 | 通过条件 |
| --- | --- | --- |
| SKL-01 | 查询 Skill 列表与树、启动新 SDK 会话 | 三个名称、文件数和发现结果一致；已有 Agent 引用仍有效 |
| SKL-02 | 三种方式分别创建草稿，随后不发布就重启 | 草稿仍可编辑，正式 `plugins/workbench/skills` 无新目录 |
| SKL-03 | 用旧 `If-Match` 修改同一文件 | 返回 409；无版本头返回 428；新版本内容未丢 |
| SKL-04 | 导入穿越、链接、重复项、超限 ZIP 和无效 YAML | 各自带路径或原因拒绝；没有脚本被执行 |
| SKL-05 | 编辑已发布 Skill 后制造并发变化或 SDK 发现失败 | 返回冲突／错误；原目录内容及装配仍可用 |

集成测试必须针对隔离副本；测试产生的草稿和临时 Skill 应被清理。格式校验通过只证明加载条件，不证明导入脚本可信。
