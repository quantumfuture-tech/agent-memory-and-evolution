# agent-memory-and-evolution

[English](README.md) | **中文**

[![test](https://github.com/quantumfuture-tech/agent-memory-and-evolution/actions/workflows/test.yml/badge.svg)](https://github.com/quantumfuture-tech/agent-memory-and-evolution/actions/workflows/test.yml)

两个给 LLM agent 用的技能：一个让它跨会话记得住，一个让它的技能能演化。

它们是为「带技能目录的 agent 运行时」（例如 DSH）写的，但里面的想法不依赖具体运行时。

## 两个真问题

**会话是失忆的。** 新开一个上下文窗口，一切从零：做过的决定、走过的弯路、某个文件为什么长成现在这样——全没了。大多数「记忆」方案是把聊天记录再塞回提示词，既贵又没用：**记录不是状态。**

**技能不会自己变好。** 一个总在同一类错误上摔倒的 agent，会永远摔下去，因为回路里没有任何一环把「这次失败」变成「一次改动」。

## 两个技能

| 技能 | 解决的问题 | 核心想法 |
|---|---|---|
| [session-handoff/](session-handoff/) | 跨会话丢状态 | 把记忆当**协议**：一个记忆包自己声明「什么算状态、接手时读什么、怎么写回去」 |
| [skill-evolution/](skill-evolution/) | 技能不进化 | **两条道**：运行时技能是一个包，*为什么是这样* 住在另一个沿革包。提案钉在**整包哈希**上，而且**没读过沿革就不许改** |

两者是配套设计的：进化引擎管理技能，而 session-handoff 正是它管理的技能之一。

## 快速开始

把技能目录拷进运行时的技能根：

~~~bash
cp -r session-handoff "$DSH_HOME/skills/"
cp -r skill-evolution "$DSH_HOME/skills/"

# 引擎需要 Node 18+
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" init
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" list
~~~

## 设计原则

1. **带理由，不带走规则。** 每条规则都随它存在的理由一起发布——理由一起走，规则才能被重新演绎。
2. **机器才是唯一的记忆。** 人每轮都会被换掉；真正留下来的，是 registry、沿革包和记忆包。
3. **读过才有写权。** 改一个技能之前必须先读它的沿革，引擎会记下这次读。没有记录就不能改——资格是盘上的事实，不是好意。
4. **写入要挂门。** 标了 write: user 的条目只能由人改；agent 只能提案，不能编辑。
5. **提案钉在状态上。** 提案记录它依据的**整包**哈希；目标一动，提案即过期，不许收编。你永远不会批准一个已经不存在的 diff。
6. **否决也是知识。** 被拒的提案连理由一起留着——最贵的损失，是「当初为什么不要它」。

## 仓库结构

~~~
session-handoff/      SKILL.md（协议）、README、PROTOCOL 模板与一个虚构示例
skill-evolution/      SKILL.md（元协议）+ scripts/skillctl.js（引擎，无第三方依赖）
                      references/authoring.md（作者培训包，按需领取）
                      README（概念、命令、一次完整的 读→提→批 流程）
                      docs/DESIGN.md（v16 的设计，已实现）
                      registry.example.yaml、脱敏示例
                      tests/（13 个用例，全部跑在临时 DSH_HOME 上）
~~~

## 状态

引擎 **v16**（数据格式 v4），作者日常在用。测试跑在临时 registry 上，不碰真实数据：

~~~bash
node --test skill-evolution/tests/
~~~

CI 在 Ubuntu 上用 Node 20 与 22 跑同一条命令。

## 许可

MIT
