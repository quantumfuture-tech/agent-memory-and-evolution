# agent-memory-and-evolution

**English** | [中文](README.zh-CN.md)

[![test](https://github.com/quantumfuture-tech/agent-memory-and-evolution/actions/workflows/test.yml/badge.svg)](https://github.com/quantumfuture-tech/agent-memory-and-evolution/actions/workflows/test.yml)

Two skills for an LLM agent that is expected to get better over time: one keeps
what happened across sessions, the other lets its own skills evolve.

They are written for DSH-style runtimes (an agent with a skills directory), but
the ideas do not depend on the runtime.

## The two problems

**Sessions are amnesiac.** A new context window starts from zero: the decisions,
the dead ends, the reason a file looks the way it does — all gone. Most "memory"
solutions dump transcripts back into the prompt, which is expensive and useless:
a transcript is not state.

**Skills never improve.** An agent that keeps making the same mistake will keep
making it forever, because nothing in the loop turns a failure into a change.

## The two skills

| Skill | Problem it solves | Core idea |
|---|---|---|
| [session-handoff/](session-handoff/) | state lost between sessions | memory as a **protocol**: a memory pack declares what counts as state, what to read on takeover, and how to write back |
| [skill-evolution/](skill-evolution/) | skills never improve | **two tracks**: the runtime skill stays one package; the *why* lives in a separate history package. Proposals are pinned to a package hash, and **you must read the history before you may change anything** |

They are designed to be used together: the evolution engine manages skills,
session-handoff is one of the skills it manages.

## Quick start

Copy a skill into your runtime's skills directory:

~~~bash
cp -r session-handoff "$DSH_HOME/skills/"
cp -r skill-evolution "$DSH_HOME/skills/"

# the engine needs Node 18+
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" init
node "$DSH_HOME/skills/skill-evolution/scripts/skillctl.js" list
~~~

## Design principles

1. **Reasons, not rules.** Every rule ships with the reason it exists, because a
   rule can only be re-derived if the reason travels with it.
2. **The machine is the only memory.** The human is replaced every session; the
   registry, the history packages and the memory pack are what actually persist.
3. **Read before write.** Changing a skill means reading its history first; the
   engine records that read. No record, no change — eligibility is a fact on disk,
   not a good intention.
4. **Writes are gated.** Skills marked write: user can only be changed by a human;
   the agent can propose, not edit.
5. **Proposals are pinned.** A proposal records the hash of the whole package it
   was written against; if the target moves, the proposal is stale and cannot be
   merged. You never approve a diff that no longer exists.
6. **Rejection is knowledge.** A rejected proposal keeps its reason — the most
   expensive thing to lose is why something was refused.

## Repository layout

~~~
session-handoff/     SKILL.md — the protocol, plus a PROTOCOL template and an example
                     README.md — the problem, a five-minute walkthrough, limits
skill-evolution/     SKILL.md + scripts/skillctl.js — the engine
                     references/authoring.md — the authoring course (read on demand)
                     README.md — concepts, commands, a full read → propose → merge flow
                     docs/DESIGN.md — the design behind v16 (implemented)
                     registry.example.yaml — an empty registry to start from
                     tests/ — 13 cases, no npm dependencies
~~~

## Status

Engine **v16** (data format v4), used daily by its author. The test suite runs
against temporary registries and never touches real data:

~~~bash
node --test skill-evolution/tests/
~~~

CI runs the same command on Node 20 and 22.

## License

MIT
