# agent-memory-and-evolution

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
| [skill-evolution/](skill-evolution/) | skills never improve | a **registry** as the single source of truth, proposals pinned to a content hash, and human-gated writes |

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

1. **Reasons, not rules.** Every rule in these skills ships with the reason it
   exists, because a rule can only be re-derived if the reason travels with it.
2. **The machine is the only memory.** The human is replaced every session; the
   registry and the memory pack are what actually persist.
3. **Writes are gated.** Skills marked write: user can only be changed by a
   human; the agent can propose, not edit.
4. **Proposals are pinned.** A proposal records the hash of the state it was
   written against; if the target moves, the proposal is stale and cannot be
   accepted. You never approve a diff that no longer exists.
5. **Rejection is knowledge.** A rejected proposal keeps its reason — the most
   expensive thing to lose is why something was refused.

## Repository layout

~~~
session-handoff/     SKILL.md — the protocol, plus a PROTOCOL template and an example
                     README.md — the problem, a five-minute walkthrough, limits
skill-evolution/     SKILL.md + scripts/skillctl.js — the engine
                     README.md — concepts, commands, a full add → propose → accept flow
                     registry.example.yaml — an empty registry to start from
~~~

## Status

Used daily by its author for about a month; the engine has a test suite that
runs against a temporary registry. The design of the next major version is
documented in [skill-evolution/docs/DESIGN-v2.md](skill-evolution/docs/DESIGN-v2.md) and is **not implemented** —
this repository ships the working v13 engine.

## License

MIT
