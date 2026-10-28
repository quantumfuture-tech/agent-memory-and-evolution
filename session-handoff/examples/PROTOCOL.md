---
conformsTo: handoff-meta-v1
version: 1
owner: blog-search
task: 给静态博客加站内搜索
updated: 2026-10-20
maintainedBy: agent + user
记忆包Root: .handoff/blog-search
---

# PROTOCOL.md — blog-search

这是虚构示例记忆包的读取约定。它只描述结构：哪些内容算状态、接手时读什么、写回时守什么。接手后的具体行为写在 `GUIDANCE.md`，不写在这里。

## 状态模型

- **state-summary**：当前目标、已完成、未决问题、下一步。它是接手时最先要看的状态画像。
- **history**：已经发生过的改动、验证结果和被推翻的判断。只追加，不改写。
- **guidance**：接手后如何汇报、先做什么、什么不能碰。它是行为约定，不是任务状态。

## 接手必读清单

```yaml
handoffReadList:
  - STATUS.md
  - GUIDANCE.md
```

顺序即读取顺序：先看状态画像，再看行为约定。`LOG.md` 不在必读清单里，需要查来历或证据时再定点读。

## 资产组织方式

```yaml
assets:
  - path: STATUS.md
    role: state-summary
    form: sections
    schema:
      - 当前目标
      - 已完成
      - 未决问题
      - 下一步
    load: full
    writeMode: overwrite
    answers: 现在做到哪了；为什么停在这里；下一件事是什么
  - path: GUIDANCE.md
    role: guidance
    form: freeform
    load: full
    writeMode: on-change
    answers: 接手后先做什么；怎么汇报；哪些动作需要先问
  - path: LOG.md
    role: history
    form: append-log
    load: scan
    writeMode: append
    answers: 某个决定是什么时候、因为什么做出的；哪些方案已经试过
```

资产表只收本记忆包负责的三个文件。`REGISTRY.md` 与 `CHANNEL.md` 若存在，属于世界级文件，不在这里登记。

## 定点读取指引

| 需要回答的问题 | 读哪里 |
|---|---|
| 现在是什么状态、下一步做什么 | `STATUS.md` |
| 接手后应该先汇报还是先动手 | `GUIDANCE.md` |
| 某个改动为什么发生、验证过什么 | `LOG.md` 中对应日期的条目 |
| 这个记忆包是什么、读什么 | 本文件 |

## 协作规则

接手后的行为、话术、确认门和禁区，全部以 `GUIDANCE.md` 为准。本文件不预设这些内容。

## 能力1 写规则

- `STATUS.md` 覆盖写；覆盖前确认旧内容里没有未沉淀的决定，未决问题必须保留到真正解决。
- `LOG.md` 只追加；不修改旧条目，不删除失败记录。
- `GUIDANCE.md` 按需更新；改变接手行为时先经用户确认，并在本文件升 `version`、记变更。
- 每次保存后，在 `STATUS.md` 末行写 `updated`（ISO-8601，到秒），并逐文件回读。

## 变更记录

| 日期 | 版本 | 维护者 | 变更一句话 |
|---|---|---|---|
| 2026-10-18 | 1 | agent + user | 建立记忆包与三份资产 |
