# skill-evolution

一个给 agent 用的技能治理引擎：把"这次碰壁学到的东西"变成**可审查、可回溯、可被下一个你读到**的 skill 变更，而不是停留在会话里。

它由一个纯 Node 脚本（`scripts/skillctl.js`，无第三方依赖）和一份元协议（`SKILL.md`）组成。脚本只做确定性操作与报告，不自行决定晋升或淘汰。

## 它解决什么问题

agent 会重复犯同一类错误，因为上一个会话的判断没有被任何东西留下。把经验写成 prose 也有同样的问题：写得再多，下一次可能仍然想不起来、找不到、或者被静默改掉。

这一版把"改进"拆成五段，分别对应五个动作：

1. **记**：碰壁当场留下事实与"事前该问的那一句"，并说清它归哪个技能（`scope`）、因谁而起（`cause`）、哪类失灵（`type`）。
2. **读**：要改一个技能之前，先整份读它的**沿革**（观察与提案），并留下读记录。
3. **提**：变更写成一条提案，**钉住整包哈希**；人看过再批。
4. **批**：`merge` 前校验 fresh、读记录、`check`、批准者≠作者；任一不过即拒。
5. **扫**：`view` 看分布与复发，`check` 卡格式与引用图。

## 两条道

| | 运行时 | 治理 |
|---|---|---|
| 是什么 | `skills/<name>/`：`SKILL.md` ＋ `references/` ＋ `scripts/` | `.evolution/history/<name>/`：观察与提案 |
| 服务谁 | 用它／干这类活的人 | 改它／有权改的人 |
| 怎么读 | 公告 → 加载正文 → 按需读 references | `self <name>` 整份读 |

两者之间只有一条**单向指针**。加载一个技能，不会拉进它的全部历史；要看历史，必须显式走 `self`——而走过它，就留下读记录。

## 分发图

一条知识只有在被读到时才存在。所以引擎问的不是"它多重要"，而是"它挂在哪张图的哪个节点上、谁在第几步读到它"。

- **节点**：目录行、`SKILL.md`、`references/x.md`、`AGENTS.md`、沿革条目、账本……
- **边**：一段文本让读者去打开另一个节点。**只要有文本，就能加边。**
- **根**：不需要动作就在上下文里的节点（目录行每轮、`AGENTS.md` 每会话一次）。
- **深度**：到根的最短跳数；每多一跳，多一次"读不读"的赌注和一次上下文成本。

四条边规则：**边带条件、节点与路径无关、跨包单向、不许成环**。
包内默认成树，但**允许 DAG**——一个 reference 服务多个处境是合法的，只要它自足、每条边各带条件。
所以 `check` 不卡"单亲"，只卡结构上真会坏的四种：目标存在、无孤儿、无环、深度 > 3（警告）。

**图之外还有"须知"**：图只说明到得了，不说明你为什么在这里。运行时根上的 `AGENTS.md` 负责定位——这是培训、不是岔路。
没有它，模型只会在节点间机械旅行；有了它，同一份 reference 会被当成教材来读（读全，不摘取）。

## 沿革条目：一种形态

字段：`id / at / kind / scope / cause[] / type / state / why / evidence[] / by / sessions[] / pin / legacy?`

- **kind**：`观察`（撞过的壁 ＋ 那一眼）｜`提案`（要改什么、为什么）。
- **state**：观察 `open → reviewed`；提案 `open → merged | rejected | superseded`；通用 `archived`。
- **正文不可变**：文件名 = `<日期>-<id>-<正文哈希8位>.md`，`check` 重算。要改就新开一条、旧的置 `superseded`。
- **永不删**：只追加、只改状态。被否决的理由是最贵的负向知识。

## 五个动作与命令

| 动作 | 命令 |
|---|---|
| 记 | `note --what 事实 --lesson 那一眼 --scope <技能\|无归属> --cause <5值> --type <枚举>` |
| 读 | `self <name>`（改之前）／`train authoring`（造之前） |
| 提 | `propose <name> --why 理由`／`supersede <id> --why 理由` |
| 批 | `merge <name> --why 理由`／`reject <name> --why 理由` |
| 扫 | `view`／`check` |

登记与巡检：`init`／`list`／`show`／`add`／`set`／`promote`／`sync`／`render`／`roundtrip`／`stale`／`review`。
旧名保留为别名：`friction add` → `note`、`accept` → `merge`、`lint` → `check`、`report` → `view`。

## 一次完整流程

以下命令假设 `DSH_HOME` 已指向运行时的技能根，引擎在 `$DSH_HOME/skills/skill-evolution/`。

~~~bash
S="$DSH_HOME/skills/skill-evolution/scripts/skillctl.js"

node "$S" init
node "$S" train authoring          # 造技能前的岗位培训（没有它 add 会拒）
node "$S" add blog-search --tier global
# 编辑 .evolution/scaffold/blog-search/SKILL.md，再移入 $DSH_HOME/skills/blog-search/
node "$S" set blog-search status=active
node "$S" sync blog-search

node "$S" self blog-search         # 留下读记录（资格）
node "$S" propose blog-search --why "补上验证步骤" --note "改什么 / 为什么 / 否决了什么"
node "$S" merge blog-search --why "用户批准" --by user
# 应用正文改动，然后
node "$S" sync blog-search
node "$S" check
~~~

**顺序不能反**：先改文件再 `merge`，等于把自己批准的东西变成 stale（提案钉的是改前的哈希）。
`merge` 只登记收编、升版本、写 changelog，不替你改正文；应用完记得 `sync`，把整包哈希落回 registry。

## check 抓什么

`check` 是格式门，只报不改，有问题时退出码 2。它抓：

- registry ↔ 磁盘不一致（悬空条目、裸 skill、name 不一致、description 为空或超长）；
- 沿革条目 schema（kind/state/cause/type/scope/by）、**文件名哈希与正文不符**（正文被改过）、evidence 悬空；
- 未结提案 stale、被否决的提案缺理由；
- 引用图：指针指向不存在的文件、**孤儿引用**、**成环**、深度 > 3（警告）；
- **包哈希漂移**（改了本体/references/scripts 却没 `sync`）。

## 测试怎么跑

需要 Node 18 或更高版本。仓库不安装任何 npm 依赖。

~~~bash
node --test skill-evolution/tests/
~~~

每个用例创建临时目录并通过 `DSH_HOME` 指过去，结束时删除；不会读写真实 registry。
当前 13 个用例覆盖：init 幂等；add 的培训门；note 的字段与 repeat；self 读记录；merge 的四道门（读记录／stale／批准者≠作者）；
check 的四类结构错；reject 保留理由；review；render。CI 在 Ubuntu 上用 Node 20 与 22 跑同一条命令。

## 已知限制

- **registry 仍是声明真源。** 计划改为"声明随自我、registry 做投影"，还没做。
- **`merge` 不应用正文。** 它登记收编；正文应用是另一个动作，需要人完成，再 `sync`。
- **没有运行时拦截。** 读记录与 merge 门都在 CLI 里；直接改文件仍可能发生，只能事后对账。
- **没有文件锁。** 假定同一时刻只有一个写者。
- **YAML 是保守子集。** 只接受引擎自己写出的映射、列表、行内数组和 `|` 块标量。
- **没有 hit 统计。** `skips` 是唯一负向信号。

## 文件结构

~~~
SKILL.md                 元协议：锚点、分发图、五个动作、三条承重规则
references/authoring.md  作者培训包（造/重写技能前领取；不随正文加载）
scripts/skillctl.js      引擎（无第三方依赖）
registry.example.yaml    空 registry 模板
examples/                脱敏的单条目示例与配套桩文件
docs/DESIGN.md           设计（v16，已实现）
tests/                   node:test 用例
~~~
