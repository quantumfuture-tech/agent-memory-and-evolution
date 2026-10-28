# skill-evolution

一个给 agent 用的技能治理引擎：把“这次碰壁学到的东西”变成可审查、可回溯的 skill 变更，而不是停留在会话里。

它由一个纯 Node 脚本（`scripts/skillctl.js`，无第三方依赖）和一份元协议（`SKILL.md`）组成。脚本只做确定性操作与报告，不自行决定晋升或淘汰。

## 它解决什么问题

agent 会重复犯同一类错误，因为上一个会话的判断没有被任何东西留下。把经验写成 prose 也有同样的问题：写得再多，下一次可能仍然想不起来、找不到、或者被静默改掉。

这个 skill 把“改进”拆成三段：

1. **摩擦先记账。** 每次碰壁留下两条：发生了什么，以及“事前该问的那一句”。没有后者不算长眼。
2. **变更先提案。** 提案钉在目标当前的内容哈希上，人看过之后再收编。
3. **状态有唯一真源。** 生命周期写在 registry；正文仍在各 skill 的 `SKILL.md`。

registry 记录“这个 skill 是谁写的、现在什么状态、被谁改过、有哪些未结提案”。它不复制正文。

## registry 是唯一真源

`$DSH_HOME/skills/.evolution/registry.yaml` 是生命周期决策的唯一真源。它记录每个条目的层（`tier`）、范围（`scope`）、状态、版本、强制方式、来源（`write`）、血缘、使用信号和提案历史。

`name` / `description` / `whenToUse` 的真源不是 registry，而是各自的 `SKILL.md` frontmatter。运行时目录直接从那里渲染，registry 复制一份只会漂移。`lint` 负责强制两边对齐：

- registry 有条目但磁盘没有 `SKILL.md` → 悬空条目；
- 磁盘有 skill 目录但 registry 没有条目 → 裸 skill；
- frontmatter 的 `name` 与目录/条目不一致，或 `description` 为空、超长；
- 提案已经 stale，或已否决提案缺理由；
- 活账本里同一个 name 出现多条。

`lint` 只报不改，发现问题时退出码为 2。

## 提案为什么要钉哈希

`propose` 会记录目标 registry 条目和 `SKILL.md` 的 sha256。`accept` 前重新计算；只要目标变过，就判 `stale` 并拒绝收编（退出码 2）。

原因不是洁癖：执行体每轮都会被换掉，机器是唯一能记住“当时的那个状态”的东西。提案一旦和它依据的状态脱钩，人批准的就是一个已经不存在的东西。重新 `propose` 的成本，远小于批错一次的成本。

## `write: user` 是什么

每个条目有一个 `write` 字段，声明“这块是谁写的”：

- `user`：人写的。agent 不得直接改，只能走 `propose`；用户本人可以用 `--user` 旁路。
- `agent`：agent 自己写的，可以自行 refine。
- `user-gated`：还在 `scaffold/` 里，尚未成为 live skill。

`skillctl set` 会拦下对 `write: user` 条目的内容字段修改。注意这是**入口处的程序约束，不是文件系统沙箱**：直接编辑 `SKILL.md` 仍然可能发生，`lint` 也不能证明某次正文修改经过了确认门。这个边界应在使用前就知道。

## 命令一览

下面是 `node skill-evolution/scripts/skillctl.js --help` 的真实输出（本仓库当前版本）：

```text
skillctl —— skill-evolution 的手（不是脑）。engine skill-evo-v13 / registry schema skill-evo-v3

  init                             建目录与空 registry（幂等；从零开始的第一步）
  list [--tier T] [--status S]      按层/状态列出
  show <name>                       单条完整条目 + 常驻目录那一行
  add <name> [--tier T] [...]       建档（draft，落在 .evolution/scaffold/）
  set <name> k=v [k=v ...]          改字段；支持 skips+1 / openIssues+=文本
  promote <name> <tier> [--enforces]  沿深度轴移动（判断已由人做出后调用）
  propose <name> [--note 文字]      立提案，**钉住目标当前哈希**（目标一改即 stale）；旧记录→proposalsHistory、旧文件→archive
  stale [name]                      查提案是否已过期（过期者不得收编）；无未结提案时显示历史供参考
  accept <name> [--by user|agent]   校验未过期后收编（过期则拒绝，退出码 2）；结案记录入 proposalsHistory
  reject <name> --why 理由          否决，**理由必须留下**（被拒的理由是最贵的负向知识）；结案记录入 proposalsHistory
  friction add --what 事实 --lesson 心眼 [--type 类型]
                                    记一次碰壁（**没有"事前该问的那句"就不许记**）；
                                    --type 是**声明**的失败类型（不推断）：同类型的待评估条目自动判 repeat
  friction list                     看待评估的摩擦账本（重复/绕标 repeat，优先）
  friction clear [--batch 类型摘要] [--layer 选层结论]
                                    把已评估的移入归档（append-only，不丢）；
                                    给 --batch 时写一条**批次头**（类型 + 条目 id + 选层结论）——否则 fork 的分类结论无处可落
  lint                              校验 registry ↔ 磁盘 + 提案新鲜度（只报不改，退出码 2）
  roundtrip                         证明注册表读写往返无损（唯一真源的完整性自检）
  render                            生成 .evolution/catalog.md（给人看的目录预览）
  report                            报告晋升/淘汰/触发失败候选（只报告，不决定）
```

## 一次完整流程：add → propose → accept

以下命令都假设 `DSH_HOME` 已指向运行时的技能根。示例里的名字是虚构的。

```bash
# 1. 从零建立目录与空 registry（可重复执行）
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" init

# 2. 建档：条目进入 registry，正文草稿落在 .evolution/scaffold/
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" add blog-search --tier global

# 3. 编辑 scaffold/blog-search/SKILL.md，写好 name/description/whenToUse 和正文。
#    然后把它移入 live 目录；propose 只对 live 文件计算目标哈希。
mkdir -p "$DSH_HOME/skills/blog-search"
mv "$DSH_HOME/skills/.evolution/scaffold/blog-search/SKILL.md" \
   "$DSH_HOME/skills/blog-search/SKILL.md"
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" set blog-search status=active

# 4. 立提案：记录目标哈希和变更理由
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" \
  propose blog-search --note "把站点搜索的验证步骤写全，收窄触发条件"

# 5. 人查看提案与 diff，确认目标没有再变
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" stale blog-search

# 6. 收编：version+1，结案记录进入 proposalsHistory
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" accept blog-search --by user

# 7. 对账
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" lint
```

这里有一个当前版本的实际边界：`accept` **不替你应用 diff，也不修改 `SKILL.md`**。它校验提案钉住的状态仍在，然后登记收编、升版本、写 changelog。正文改动要么在 `propose` 前已经落盘，要么由人按提案应用后重新 `propose`。示例采用前一种做法。

如果目标在 `propose` 之后被改过，`accept` 会拒绝，退出码为 2；此时重新立提案，不要绕过。

## 测试怎么跑

需要 Node 18 或更高版本。仓库不安装任何 npm 依赖。

```bash
node --test skill-evolution/tests/
```

测试使用 `node:test` 与 `node:assert`，每个用例创建临时目录并通过 `DSH_HOME` 指过去，结束时删除；不会读写真实 registry。当前共有 11 个用例，覆盖：

- 初始化、目录结构、幂等性；
- add / list / show；
- 提案哈希、stale 判定、过期提案拒绝；
- accept 入 `proposalsHistory`、reject 保留理由；
- `write: user` 的 `set` 拦截与 `--user`；
- friction 的 lesson 必填、list、clear 归档；
- lint 的 registry ↔ 磁盘不一致；
- roundtrip 无损；
- render 的 catalog 条目。

CI 在 Ubuntu 上用 Node 20 与 22 跑同一条命令。

## 已知限制

- **设计 v2 未实现。** 本仓库交付的是能跑的 v13；下一版为什么重画、想解决什么、哪些结构问题还没定，见 [docs/DESIGN-v2.md](docs/DESIGN-v2.md)。
- **命令面偏大。** 18 个子命令里有一部分是历史叠加；v2 计划收成五个动作族，但还没有实现。
- **没有运行时拦截。** `write: user` 只在 `skillctl set` 入口生效；直接改文件、绕过 CLI 仍然可能。
- **没有文件锁。** 假定同一时刻只有一个写者。并发运行两个 `skillctl` 进程可能互相覆盖。
- **摩擦的 repeat 只看活账本。** 已归档条目不参与同类型判断；跨归档重复仍要人看。
- **YAML 是保守子集。** 只接受引擎自己写出的映射、列表、行内数组和 `|` 块标量；不是通用 YAML 解析器。
- **没有 hit 统计。** `skips` 是唯一负向信号，`hits` 尚未由运行时自动采集。
- **`accept` 不应用改动。** 它只登记收编；正文应用是另一个动作，当前需要人完成。

安装方式、目录锚点和完整规则看 [SKILL.md](SKILL.md)。空 registry 模板在 [registry.example.yaml](registry.example.yaml)，脱敏的单条目示例在 [examples/registry-with-one-skill.yaml](examples/registry-with-one-skill.yaml)。
