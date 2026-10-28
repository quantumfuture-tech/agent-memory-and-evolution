#!/usr/bin/env node
/**
 * skillctl.js —— skill-evolution 引擎的手（不是脑）
 * engine / registrySchema 的**当前值看本文件顶部的两个常量**（此处不抄——抄了就会过期）。
 *
 * 只做确定性操作与报告：读写唯一真源 registry.yaml、校验与实体的一致性、
 * 生成目录预览。**永不自行决定晋升/淘汰**——那是判断层（agent + 用户）的事。
 *
 *   node skillctl.js init                              # 建目录与空 registry（幂等）
 *   node skillctl.js list [--tier meta|global|project] [--status active|draft|...]
 *   node skillctl.js show <name>
 *   node skillctl.js add <name> [--tier meta|global] [--scope durable|as-needed] [--enforces text|runtime]
 *   node skillctl.js set <name> <field>=<value> [more...]   # 支持 skips+1 / openIssues+=文本
 *   node skillctl.js promote <name> <project|global|meta> [--enforces text|runtime|none]
 *   node skillctl.js propose <name> [--note 文字]           # 立提案，记录目标当前状态
 *   node skillctl.js stale                                 # 提案是否已过期（目标被改过）
 *   node skillctl.js accept <name> [--by user|agent]        # 校验未过期后收编
 *   node skillctl.js reject <name> --why 理由               # 否决，理由必须留下
 *   node skillctl.js lint
 *   node skillctl.js roundtrip
 *   node skillctl.js render
 *   node skillctl.js report
 *
 * 退出码：0 正常；1 用法/读取错误；2 lint 发现问题。
 *
 * ── 两条承重规则，以及它们凭什么承重 ────────────────────────────────
 *
 * 【一】提案必须钉在它所提议的那个状态上（哈希绑定）。
 *   为什么：里面执行的人每轮都会被换掉，什么东西都不留存。**这台电脑是唯一的记忆。**
 *   因此"一个提案"和"它所依据的那个状态"之间的关系，本身就是留存边界——
 *   提案一旦与目标脱钩，人就是在批准一个**已经不存在**的 diff。
 *   做法：propose 时记下目标 registry 条目 + SKILL.md 的哈希；accept 前重算，
 *   不一致即 stale，**拒绝收编**。这不是卫生，这是"机器是唯一记忆"的直接推论。
 *
 * 【二】来源是声明的，不是推断的（user-gated 不可被 agent 直接改）。
 *   为什么：同上——执行的人每轮被换掉，所以"这一块是谁写的"是这台机器**唯一**
 *   能区分"人的东西"和"自己的东西"的方式。若把它交给推断，人的作品会被
 *   静默改写，而且没有任何人会记得它原本长什么样。
 *   做法：registry 的 `write: user-gated` 是硬约束——set 被拒（除非 --user 在场），
 *   agent 只能 propose，不能直接改。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// 两个版本必须分开：引擎会升版（行为变），registry 的**格式**未必变。
// 混成一个戳的后果：读到一个不认识的戳，你无法判断该"升级程序"还是"该不该读"。
const ENGINE_VERSION = "skill-evo-v13";
// v3（P2）：顶层新增 `proposalsHistory:`（只追加的提案历史）。读到 v2 只提示、不拒读——
// 旧数据缺 history 只意味着"它记得比现在少"，不是"读不了"。
// ★【2026-10-13】本版引擎 v12→v13 **不动数据格式**，所以 REGISTRY_SCHEMA 仍是 v3 ✓
//   （这正是两个戳要分开的原因：行为变了，格式没变。）
const REGISTRY_SCHEMA = "skill-evo-v3";

/* ------------------------------------------------------------------ 定位 */

function locate() {
  const home = process.env.DSH_HOME;
  if (!home) fail("环境变量 DSH_HOME 未设置，无法定位全局技能根。");
  const skillsRoot = path.join(home, "skills");
  const evoDir = path.join(skillsRoot, ".evolution");
  return {
    home,
    skillsRoot,
    evoDir,
    registryPath: path.join(evoDir, "registry.yaml"),
    catalogPath: path.join(evoDir, "catalog.md"),
    proposalsDir: path.join(evoDir, "proposals"),
    scaffoldDir: path.join(evoDir, "scaffold"),
    archiveDir: path.join(evoDir, "archive"),
  };
}

function fail(msg) {
  console.error("skillctl: " + msg);
  process.exit(1);
}

/* ------------------------------------------------------------- 最小 YAML */

/**
 * 本引擎只接受自己写出的保守 YAML 子集：映射、列表、行内数组、块标量(|)。
 * 手写解析而非引入依赖——为了它在这台电脑上永远跑得起来。
 */
function tokenize(text) {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const toks = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    let body = line.trim();
    const m = /^-\s+(.*)$/.exec(body);
    if (m) body = m[1];
    const isItem = !!m;
    // 内联 flow 集合（`{...}` / `[...]`）整体当值，绝不在内部按冒号切
    const flowValue = body.startsWith("{") || body.startsWith("[");
    const ci = flowValue ? -1 : findColon(body);
    let key = null;
    let value = null;
    let block = null;
    // 列表元素何时算映射项：`- key:`（有子结构）、`- { flow map }`，或 `- key: value`（值不含 ": "）。
    // 值里带 ": " 的当纯文本——否则 `- encode: 尚未沉淀…` 这类文字会被误拆成键值对。
    let asMap = true;
    if (isItem) {
      if (body.startsWith("{")) asMap = true;
      else if (ci === -1) asMap = false;
      else {
        const rest = body.slice(ci + 1).trim();
        if (rest !== "" && rest.includes(": ")) asMap = false;
      }
    }
    if (ci !== -1 && asMap) {
      key = body.slice(0, ci).trim();
      value = body.slice(ci + 1).trim();
      if (value === "|" || value === ">") {
        const lines = [];
        let j = i + 1;
        let minIndent = Infinity;
        for (; j < raw.length; j++) {
          const l = raw[j];
          if (l.trim() === "") { lines.push(""); continue; }
          const ind = l.length - l.trimStart().length;
          if (ind <= indent) break;
          minIndent = Math.min(minIndent, ind);
          lines.push(l);
        }
        i = j - 1;
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        const rendered = lines.map((l) => (l.trim() === "" ? "" : l.slice(minIndent))).join("\n");
        block = value === ">" ? rendered.replace(/\n/g, " ") : rendered;
        value = null;
      } else {
        value = stripComment(value);
      }
    } else {
      value = stripComment(body);
    }
    toks.push({ indent, indentRaw: indent, isItem, key, value, block });
  }
  return toks;
}

function findColon(s) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ":" && !inS && !inD) {
      if (i + 1 >= s.length || s[i + 1] === " ") return i;
    }
  }
  return -1;
}

/** 双引号标量里的转义必须还原，否则 `\"` 会被当成字面反斜杠+引号累积。 */
function unescapeQuoted(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") { out += c; continue; }
    const n = s[i + 1];
    i++;
    if (n === "n") out += "\n";
    else if (n === "t") out += "\t";
    else if (n === "r") out += "\r";
    else if (n === undefined) out += "\\";
    else out += n; // \\ \" \' 以及任何未知转义：还原为字符本身
  }
  return out;
}

function stripComment(s) {
  if (s.startsWith('"') || s.startsWith("'")) return s;
  const i = s.indexOf(" #");
  return i === -1 ? s.trim() : s.slice(0, i).trim();
}

function scalar(v) {
  if (v === null) return null;
  const s = v.trim();
  if (s === "") return null;
  if (s === "[]") return [];
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) return unescapeQuoted(s.slice(1, -1));
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  if (s.toLowerCase() === "null" || s === "~") return null;
  if (s.toLowerCase() === "true") return true;
  if (s.toLowerCase() === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlow(inner).map((x) => scalar(x)).filter((x) => x !== null);
  }
  if (s.startsWith("{") && s.endsWith("}")) return parseFlowMap(s.slice(1, -1));
  return s;
}

/** 按顶层逗号切分，引号内的逗号不切。 */
function splitFlow(s) {
  const parts = [];
  let buf = "";
  let inS = false;
  let inD = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (!inS && !inD) {
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) { parts.push(buf); buf = ""; continue; }
    }
    buf += c;
  }
  if (buf.trim() !== "") parts.push(buf);
  return parts.map((x) => x.trim()).filter((x) => x !== "");
}

/** 解析内联映射 `{ k: v, k: v }`。 */
function parseFlowMap(inner) {
  const obj = {};
  for (const part of splitFlow(inner)) {
    const ci = findColon(part);
    if (ci === -1) continue;
    const k = part.slice(0, ci).trim();
    const v = part.slice(ci + 1).trim();
    if (k === "") continue;
    obj[k] = scalar(v);
  }
  return obj;
}

function parseYaml(text) {
  const toks = tokenize(text);
  const { value, next } = parseBlock(toks, 0, -1);
  if (next !== toks.length) fail("registry 解析未消费全部内容（缩进可疑），已中止以免写坏唯一真源。");
  return value;
}

function parseBlock(toks, i, parentIndent) {
  if (i >= toks.length) return { value: null, next: i };
  const first = toks[i];
  if (first.indent <= parentIndent) return { value: null, next: i };

  // 列表：同级、标记为 item 的连续行
  if (first.isItem) {
    const arr = [];
    let k = i;
    while (k < toks.length && toks[k].indent === first.indent && toks[k].isItem) {
      const t = toks[k];
      k++;
      const flowMap = typeof t.value === "string" && t.value.startsWith("{");
      const isMapEntry = t.key !== null;
      if (!isMapEntry) {
        // 标量元素（哪怕文本里含 ": "），或块标量
        if (t.key === null && t.value !== null && !flowMap) {
          arr.push(t.block !== null ? t.block : scalar(t.value));
        } else if (t.block !== null && t.key === null) {
          arr.push(t.block);
        } else {
          // 含 ": " 的裸文本元素：还原整行原文
          const raw = t.key !== null && t.value !== null ? `${t.key}: ${t.value}` : String(t.value ?? t.key ?? "");
          arr.push(t.block !== null ? t.block : scalar(raw));
        }
        // 若其后还有更深缩进，那是非法的混合写法——忽略并交由 lint 暴露
        while (k < toks.length && toks[k].indent > t.indent) k++;
        continue;
      }
      // 映射元素：`- key:` 或 `- { flow map }`
      let sub = { value: null, next: k };
      if (k < toks.length && toks[k].indent > t.indent) sub = parseBlock(toks, k, t.indent);
      k = sub.next;
      let base;
      if (flowMap) base = scalar(t.value);
      else base = { [t.key]: t.block !== null ? t.block : scalar(t.value) };
      arr.push(sub.value && typeof sub.value === "object" && !Array.isArray(sub.value)
        ? { ...base, ...sub.value }
        : base);
    }
    return { value: arr, next: k };
  }

  // 映射：同级、非 item 的连续行
  const obj = {};
  let k = i;
  while (k < toks.length && toks[k].indent === first.indent && !toks[k].isItem) {
    const t = toks[k];
    if (t.block !== null) {
      obj[t.key] = t.block;
      k++;
      continue;
    }
    if (t.value !== null && t.value !== "") {
      obj[t.key] = scalar(t.value);
      k++;
      continue;
    }
    // 值是嵌套结构，或是行内空数组 `[]`
    const inlineEmpty = t.value === "[]" ? [] : null;
    if (inlineEmpty) {
      obj[t.key] = inlineEmpty;
      k++;
      continue;
    }
    const sub = parseBlock(toks, k + 1, t.indent);
    obj[t.key] = sub.value === null ? null : sub.value;
    k = sub.value === null ? k + 1 : sub.next;
  }
  return { value: obj, next: k };
}

function dumpYaml(obj, indent = 0) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    lines.push(...dumpEntry(pad, key, val));
  }
  return lines.join("\n") + "\n";
}

function dumpEntry(pad, key, val) {
  if (val === null || val === undefined) return [`${pad}${key}: null`];
  if (Array.isArray(val)) {
    if (val.length === 0) return [`${pad}${key}: []`];
    if (val.every((x) => typeof x !== "object" || x === null)) {
      return [`${pad}${key}: [${val.map(scalarText).join(", ")}]`];
    }
    const out = [`${pad}${key}:`];
    for (const item of val) {
      const sub = dumpYaml(item, 0).trimEnd().split("\n");
      out.push(`${pad}  - ${sub[0]}`);
      for (const l of sub.slice(1)) out.push(`${pad}    ${l}`);
    }
    return out;
  }
  if (typeof val === "object") {
    const out = [`${pad}${key}:`];
    out.push(dumpYaml(val, pad.length + 2).trimEnd());
    return out;
  }
  if (typeof val === "string" && val.includes("\n")) {
    const out = [`${pad}${key}: |`];
    for (const l of val.split("\n")) out.push(`${pad}  ${l}`);
    return out;
  }
  return [`${pad}${key}: ${scalarText(val)}`];
}

function scalarText(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  if (s === "") return '""';
  if (/^[A-Za-z0-9_./@+-]+$/.test(s) && !/^\d+$/.test(s) && !["null", "true", "false"].includes(s.toLowerCase())) return s;
  // 单引号风格：反斜杠无特殊含义，只需把单引号翻倍——往返无损，且比双引号转义安全。
  return "'" + s.replace(/'/g, "''") + "'";
}

/* --------------------------------------------------- SKILL.md frontmatter */

function readFrontmatter(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) return { name: null, description: null, whenToUse: null, raw: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { name: null, description: null, whenToUse: null, raw: text };
  const block = text.slice(3, end);
  const fm = parseYaml(block);
  return {
    name: fm && fm.name ? String(fm.name) : null,
    description: fm && fm.description ? String(fm.description) : null,
    whenToUse: fm && fm.whenToUse ? String(fm.whenToUse) : null,
    raw: text,
  };
}

/**
 * 读**整块** frontmatter（任意键），给"要校 status 这类非 skill 字段"的地方用。
 * `readFrontmatter` 只挑 name/description/whenToUse——拿它去读 `status` 永远是 undefined，
 * 而 undefined 与"真的不一致"长得一模一样（沙箱实测撞到过：归档校验报 `status "undefined" ≠ accepted`）。
 */
function readFrontmatterBlock(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  return parseYaml(text.slice(3, end)) || {};
}

/* ------------------------------------------------------------ 读写 registry */

function loadRegistry(p) {
  if (!fs.existsSync(p.registryPath)) fail(`registry 不存在：${p.registryPath}`);
  const reg = parseYaml(fs.readFileSync(p.registryPath, "utf8"));
  if (!reg || !Array.isArray(reg.skills)) fail("registry 结构异常：缺少 skills 列表。");
  return reg;
}

function saveRegistry(p, reg) {
  // 让数据戳跟上格式（读到旧戳只提示、不拒读；见 cmdLint）。只在真正要写时对账，
  // 所以"只读命令"不会因为戳旧而改写真源。
  if (reg.conformsTo !== REGISTRY_SCHEMA) reg.conformsTo = REGISTRY_SCHEMA;
  const header = [
    "# registry.yaml —— skill 生命周期的「唯一真源」",
    "# 位置：$DSH_HOME/skills/.evolution/registry.yaml（深度 2，天然不被 skill 扫描器发现）",
    "# 写入纪律：一律经本引擎的 scripts/skillctl.js，不手改 YAML。",
    "#   唯一例外：用户直接编辑；之后必须跑一次 `node skillctl.js lint`。",
    "# 说明：skill 的 name/description/whenToUse 以各自 SKILL.md 的 frontmatter 为准",
    "#   （harness 只从那里渲染 <available_skills> 目录）。本文件不复制它们，由 lint 强制对齐。",
    "#",
    "# 三条纪律（理由，不是规则本身；理由才可被重新演绎）：",
    "#   1. proposals[] 里的每条提案都钉着「提议时的目标哈希」——因为执行的人每轮被换掉，",
    "#      机器是唯一记忆；提案与目标一旦脱钩，人批准的就是一个已不存在的 diff。",
    "#   2. 条目的 write 字段是硬约束：user-gated 表示人写的，agent 只能提案不能直接改——",
    "#      因为「来源是声明的，不是推断的」，这是机器唯一能区分人与自己的东西的方式。",
    "#   3. proposals[] 只放**未结案**的提案（一个 name 一条，供 accept/reject/stale 一眼判断）；",
    "#      一结案就移入 proposalsHistory[]——**只追加、永不删**。理由：否决理由是最贵的负向",
    "#      知识，而『每个 name 一条记录 + 整体重写』会让 propose 这种『看起来只是新增』的动作",
    "#      天然变成销毁动作（f17/f21）。历史一旦进了历史区，谁也不许删。",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(p.registryPath), { recursive: true });
  fs.writeFileSync(p.registryPath, header + dumpYaml(reg), "utf8");
}

function findSkill(reg, name) {
  return reg.skills.find((s) => s.name === name);
}

/** 找提案（顶层 proposals[]——**只放未结案的**；历史见 proposalsHistory）。 */
function findProposal(reg, name) {
  return (reg.proposals || []).find((x) => x.name === name);
}

/**
 * 把一条提案记录移入 `proposalsHistory`（**只追加**），并从活账本移除。
 * P2 的核心：记录的**历史**没有回滚面——git 只保护"提交过的中间态"，而被否决那一刻
 * 恰恰最没人提交（`f21` 实证：A 的 `why` 在 git 全历史里搜不到），所以只能靠"永不删"。
 *
 * **刻意不做去重**：起初想用 `name+openedAt+decidedAt` 防重复追加，沙箱实测发现那个键
 * 认不出"同一天结案的两条不同提案"——刚被 accept 的新记录会被当成重复**静默丢掉**
 * （正是 P2 要消灭的那种"看起来没事、实际丢了"）。宁可有重复的冗余，不可有静默的丢失；
 * 真正的重复清理只在**迁移**那一步做，且要逐条核对（那一处由人来判）。
 */
function retireProposal(reg, pr) {
  if (!pr) return;
  reg.proposalsHistory = reg.proposalsHistory || [];
  reg.proposalsHistory.push(pr);
  reg.proposals = (reg.proposals || []).filter((x) => x !== pr);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------- 提案：哈希绑定与来源判定 */

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function skillDirOf(p, s) {
  return path.join(p.skillsRoot, s.path || s.name);
}

function skillFileOf(p, s) {
  return path.join(skillDirOf(p, s), "SKILL.md");
}

/** 一个条目 + 其 SKILL.md 的当前状态指纹。提案就是钉在这个值上。 */
function targetHashes(p, s) {
  const file = skillFileOf(p, s);
  return {
    registry: sha256(JSON.stringify({ name: s.name, version: s.version, tier: s.tier, status: s.status, enforces: s.enforces })),
    skill: fs.existsSync(file) ? sha256(fs.readFileSync(file, "utf8")) : "missing",
  };
}

function cmdPropose(p, reg, args) {
  const name = args[0];
  if (!name) fail("propose 需要 <name>");
  const s = findSkill(reg, name);
  if (!s) fail(`registry 无此条目：${name}`);
  const existing = findProposal(reg, name);
  if (existing && existing.status === "open") fail(`已有未结提案：${name}。先 accept 或 reject。`);
  // 旧的活记录先退场（P2）：**它不再被新记录挤掉**，而是移入 `proposalsHistory`——只追加、永不删。
  // 老数据（旧 schema）里那唯一一条可能是已结案的：照样退场，这等于当场完成迁移。
  if (existing) {
    retireProposal(reg, existing);
    console.log(
      existing.status === "open"
        ? `（已把上一条记录（${existing.status}）移入 proposalsHistory）`
        : `（已把上一条记录（${existing.status}${existing.why ? "，含否决理由" : ""}）移入 proposalsHistory——理由不再被覆盖）`
    );
  }
  const note = argVal(args, "--note") || "";
  const h = targetHashes(p, s);

  fs.mkdirSync(p.proposalsDir, { recursive: true });
  const file = path.join(p.proposalsDir, `${name}.md`);
  // 覆盖前先归档（f17：`propose` 会覆盖同名提案文件；源码里那句"已结案的历史由提案文件自身保留"
  // 是**假的**——被否决的理由因此丢过一次。同一条规矩工作区在 f6 就学过，引擎自己一直没实现。）
  if (fs.existsSync(file)) {
    const prevText = fs.readFileSync(file, "utf8");
    const prevStatus = (prevText.match(/^status:\s*(\S+)/m) || [])[1] || "unknown";
    const archDir = path.join(p.proposalsDir, "archive");
    fs.mkdirSync(archDir, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hms = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const archFile = path.join(archDir, `${name}.${prevStatus}.${day}.${hms}.md`);
    // **原样复制**，不加任何字段：归档副本的意义就是"它被覆盖前的样子"（逐字），
    // 加一个 `archivedAt` 就等于改写了原件。归档时刻在文件名里（`.<日期>.<时刻>.md`），
    // 判断时刻在 registry 的 `decidedAt` 里——两处都够了，不需要动正文。
    fs.writeFileSync(archFile, prevText, "utf8");
    console.log(`（覆盖前先归档旧提案 → ${path.relative(p.evoDir, archFile).replace(/\\/g, "/")}）`);
  }
  const body = [
    "---",
    `name: ${name}`,
    `openedAt: ${today()}`,
    `write: ${s.write}`,
    `basedOnVersion: ${s.version}`,
    `targetSkillHash: ${h.skill}`,
    `targetRegistryHash: ${h.registry}`,
    "status: open",
    "---",
    "",
    `# 提案：${name}`,
    "",
    `> 本提案钉在 \`${name}\` 于 ${today()} 的状态上（SKILL.md sha256 \`${h.skill.slice(0, 12)}…\`）。`,
    "> 若目标在此之后被改过，`skillctl accept` 会**拒绝收编**并报 stale——",
    "> 因为那时你要批的是一个已经不存在的东西。",
    "",
    "## 为什么要改（理由，不是结论）",
    note || "<填：这条摩擦是什么、为什么值得沉淀、为什么停在这一层>",
    "",
    "## 打算怎么改",
    "<填：diff 或改写要点>",
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf8");

  reg.proposals = reg.proposals || [];
  const fresh = {
    name,
    openedAt: today(),
    status: "open",
    by: "agent",
    write: s.write || "user",
    basedOnVersion: s.version,
    targetSkillHash: h.skill,
    targetRegistryHash: h.registry,
    note: note || "",
    path: path.relative(p.evoDir, file).replace(/\\/g, "/"),
    decidedAt: null,
    decidedBy: null,
    why: "",
  };
  const idx = reg.proposals.findIndex((x) => x.name === name);
  if (idx === -1) reg.proposals.push(fresh);
  else reg.proposals[idx] = fresh;
  saveRegistry(p, reg);
  console.log(`已立提案：${file}`);
  console.log(`钉在：version ${s.version} / skill sha256 ${h.skill.slice(0, 12)}…`);
  console.log(`来源：write=${s.write || "user-gated"}${s.write === "user-gated" ? "（人写的，agent 不得直接改；只能提案）" : ""}`);
  console.log("下一步：写提案正文 → 给人审 → `skillctl accept` 或 `skillctl reject --why ...`");
}

function cmdStale(p, reg, args) {
  const only = args[0];
  const list = (reg.proposals || []).filter((pr) => !only || pr.name === only);
  if (!list.length) {
    // 活账本里没有（未结案的）——P2 之后结案记录都在 proposalsHistory 里。历史只作参考显示，
    // **不参与 fresh/stale 判断**（判断是给"要不要批"用的，历史已经判完了）。
    const hist = (reg.proposalsHistory || []).filter((h) => !only || h.name === only);
    if (hist.length) {
      console.log(`（${only || "全部"}：活账本无未结提案；历史 ${hist.length} 条，仅供参考）`);
      for (const h of hist.slice(-5)) {
        console.log(`  ${String(h.name).padEnd(24)} ${String(h.status).padEnd(9)} ${h.decidedAt || h.openedAt || "?"}${h.why ? "　why: " + String(h.why).slice(0, 60) + "…" : ""}`);
      }
    } else {
      console.log("（无提案）");
    }
    return;
  }
  let staleCount = 0;
  for (const pr of list) {
    const s = findSkill(reg, pr.name);
    let verdict = "open";
    if (pr.status !== "open") verdict = pr.status;
    else if (!s) verdict = "STALE（目标条目已消失）";
    else {
      const h = targetHashes(p, s);
      if (h.skill !== pr.targetSkillHash) verdict = "STALE（SKILL.md 已变）";
      else if (h.registry !== pr.targetRegistryHash) verdict = "STALE（registry 条目已变）";
      else if (s.version !== pr.basedOnVersion) verdict = "STALE（version 已推进）";
      else verdict = "fresh（可批）";
    }
    if (String(verdict).startsWith("STALE")) staleCount++;
    console.log(`${pr.name.padEnd(24)} ${String(pr.status).padEnd(9)} ${verdict}`);
  }
  if (staleCount) {
    console.log(`\n${staleCount} 条已过期：**不要收编**，重新 propose（目标已不是提案所依据的那个状态）。`);
  }
}

function cmdAccept(p, reg, args) {
  const name = args[0];
  const by = argVal(args, "--by") || "user";
  if (!name) fail("accept 需要 <name>");
  const pr = findProposal(reg, name);
  if (!pr) fail(`无此提案：${name}`);
  if (pr.status !== "open") fail(`提案状态为 ${pr.status}，不能收编。`);
  const s = findSkill(reg, name);
  if (!s) fail(`目标条目已消失：${name}`);

  const h = targetHashes(p, s);
  const drift = [];
  if (h.skill !== pr.targetSkillHash) drift.push("SKILL.md");
  if (h.registry !== pr.targetRegistryHash) drift.push("registry 条目");
  if (s.version !== pr.basedOnVersion) drift.push(`version ${pr.basedOnVersion} → ${s.version}`);
  if (drift.length) {
    console.error(`拒绝收编：提案已 stale（${drift.join(" / ")} 在立提案之后变过）。`);
    console.error("理由：执行的人每轮被换掉，机器是唯一记忆——批准一个与当前目标不符的 diff，");
    console.error("      等于批准一个已经不存在的东西。请重新 propose。");
    process.exit(2);
  }

  s.version = (s.version || 1) + 1;
  s.updated = today();
  s.changelog = s.changelog || [];
  s.changelog.push({ version: s.version, at: today(), by, what: pr.note || `收编提案 ${name}` });
  pr.status = "accepted";
  pr.decidedAt = today();
  pr.decidedBy = by;
  retireProposal(reg, pr); // 结案即入史（P2）：活账本只留未结案的
  const file = path.join(p.evoDir, pr.path);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8").replace(/^status: open$/m, "status: accepted");
    fs.writeFileSync(file, text, "utf8");
  }
  saveRegistry(p, reg);
  console.log(`已收编：${name} → version ${s.version}（by ${by}）`);
  console.log("提醒：跑 `skillctl lint`，并按纪律提交一次 git（历史不可悄悄改写）。");
}

function cmdReject(p, reg, args) {
  const name = args[0];
  const why = argVal(args, "--why");
  if (!name) fail("reject 需要 <name> --why 理由");
  if (!why) fail("reject 必须给理由：--why \"...\"（被否决的理由是最贵的负向知识，不许丢）");
  const pr = findProposal(reg, name);
  if (!pr) fail(`无此提案：${name}`);
  pr.status = "rejected";
  pr.decidedAt = today();
  pr.decidedBy = argVal(args, "--by") || "user";
  pr.why = why;
  retireProposal(reg, pr); // 结案即入史（P2）——**否决理由从此不再被下一次 propose 覆盖**
  const file = path.join(p.evoDir, pr.path);
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8")
      .replace(/^status: open$/m, "status: rejected")
      .replace(/^# 提案/m, `# 提案（已否决）\n\n> **否决理由（必须留下）**：${why}\n\n#`);
    fs.writeFileSync(file, text, "utf8");
  }
  saveRegistry(p, reg);
  console.log(`已否决：${name}`);
  console.log(`理由已留下：${why}`);
}

/* ------------------------------------------------------------------ lint */

const TIERS = ["project", "global", "meta"];
const STATUSES = ["draft", "active", "superseded", "archived"];
const ENFORCES = ["none", "text", "runtime"];
const SCOPES = ["durable", "as-needed", "transient"];
const WRITES = ["user", "agent", "user-gated"];
const DESC_MAX = 500;

function lint(p, reg) {
  const problems = [];
  const warnings = [];
  const names = new Set(reg.skills.map((s) => s.name));
  const onDisk = fs.existsSync(p.skillsRoot)
    ? fs.readdirSync(p.skillsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
    : [];

  for (const s of reg.skills) {
    const where = `registry:${s.name}`;
    if (!s.name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(s.name))) {
      problems.push(`${where}: name 缺失或非 kebab-case`);
      continue;
    }
    if (!TIERS.includes(s.tier)) problems.push(`${where}: tier "${s.tier}" 越界（${TIERS.join("|")}）`);
    if (!STATUSES.includes(s.status)) problems.push(`${where}: status "${s.status}" 越界（${STATUSES.join("|")}）`);
    if (!ENFORCES.includes(s.enforces)) problems.push(`${where}: enforces "${s.enforces}" 越界（${ENFORCES.join("|")}）`);
    if (!SCOPES.includes(s.scope)) problems.push(`${where}: scope "${s.scope}" 越界（${SCOPES.join("|")}）`);
    if (!WRITES.includes(s.write)) problems.push(`${where}: write "${s.write}" 越界（${WRITES.join("|")}）——来源必须是声明的`);
    if (s.tier === "project") problems.push(`${where}: tier=project 不应登记进全局 registry（决策点 5）`);

    // 野字段：条目顶层多出来的键（多由早前版本写错路径留下），防止真源悄悄膨胀
    const KNOWN = ["name","tier","scope","status","version","enforces","write","path","bornFrom","provenance","lineage","deliver","usage","changelog","updated"];
    for (const key of Object.keys(s)) {
      if (!KNOWN.includes(key)) problems.push(`${where}: 顶层野字段 "${key}"（不在 registry 允许键内）`);
    }

    const dir = path.join(p.skillsRoot, s.path || s.name);
    const skillFile = path.join(dir, "SKILL.md");
    // 尚未生效的提案稿住在 scaffold/ 里，不算悬空
    const scaffoldFile = path.join(p.scaffoldDir, s.path || s.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      if (s.status === "archived") continue;
      if (s.status === "draft" && fs.existsSync(scaffoldFile)) {
        warnings.push(`registry:${s.name}: draft，正文尚在 scaffold/，未生效（正确状态）`);
        continue;
      }
      problems.push(`${where}: 磁盘上无 ${path.relative(p.skillsRoot, skillFile)}（悬空条目）`);
      continue;
    }

    const fm = readFrontmatter(skillFile);
    if (fm.name !== s.name) problems.push(`${where}: frontmatter name "${fm.name}" ≠ 目录/条目名 "${s.name}"`);
    if (!fm.description || !String(fm.description).trim()) {
      problems.push(`${where}: SKILL.md 缺 description（目录将无法渲染这一条）`);
    } else {
      const n = String(fm.description).replace(/\s+/g, " ").trim().length;
      if (n > DESC_MAX) problems.push(`${where}: description ${n} 字符 > ${DESC_MAX}，会被 harness 截断`);
      else if (n > DESC_MAX * 0.9) warnings.push(`${where}: description ${n} 字符，接近 ${DESC_MAX} 上限`);
    }
    if (s.scope === "project") problems.push(`${where}: scope=project 不应登记`);
  }

  for (const d of onDisk) {
    if (!names.has(d)) problems.push(`磁盘:${d}: 存在 skill 目录但 registry 无条目（裸 skill）`);
  }

  for (const s of reg.skills) {
    const lin = s.lineage || {};
    for (const key of ["mergedFrom", "supersedes", "supersededBy"]) {
      const arr = lin[key];
      if (!arr) continue;
      for (const ref of Array.isArray(arr) ? arr : [arr]) {
        if (ref && !names.has(ref)) problems.push(`registry:${s.name}: lineage.${key} 指向不存在的条目 "${ref}"`);
      }
    }
  }

  // 提案：哈希绑定是否还成立 + 被拒的理由是否留下
  const proposals = reg.proposals || [];
  for (const pr of proposals) {
    const where = `proposal:${pr.name}`;
    if (!["open", "accepted", "rejected", "superseded"].includes(pr.status)) {
      problems.push(`${where}: status "${pr.status}" 越界（open|accepted|rejected|superseded）`);
      continue;
    }
    const s = findSkill(reg, pr.name);
    if (!s) {
      problems.push(`${where}: 指向不存在的条目（悬空提案）`);
      continue;
    }
    if (pr.status !== "open") {
      if (pr.status === "rejected" && !pr.why) problems.push(`${where}: 已否决但没有理由——被拒的理由是最贵的负向知识，不许丢`);
      continue;
    }
    const h = targetHashes(p, s);
    const drift = [];
    if (h.skill !== pr.targetSkillHash) drift.push("SKILL.md");
    if (h.registry !== pr.targetRegistryHash) drift.push("registry 条目");
    if (s.version !== pr.basedOnVersion) drift.push(`version ${pr.basedOnVersion}→${s.version}`);
    if (drift.length) {
      problems.push(`${where}: 已 stale（${drift.join(" / ")} 在立提案后变过），不得收编；请重新 propose`);
    }
  }

  // 活账本不变量：**一个 name 只能有一条**（`findProposal` 按名字找一条，多于一条意味着判断失准）
  {
    const seen = new Map();
    for (const pr of proposals) {
      if (seen.has(pr.name)) problems.push(`proposal:${pr.name}: 活账本里同一 name 出现多条——一个 name 只该有一条未结提案`);
      seen.set(pr.name, true);
    }
  }

  // 提案历史（**只追加、永不删**）：结案必须留下判断与理由
  for (const [i, h] of (reg.proposalsHistory || []).entries()) {
    const where = `proposalsHistory[${i}]:${h.name}`;
    if (!["open", "accepted", "rejected", "superseded"].includes(h.status)) {
      problems.push(`${where}: status "${h.status}" 越界（open|accepted|rejected|superseded）`);
      continue;
    }
    if ((h.status === "rejected" || h.status === "superseded") && !h.why) {
      problems.push(`${where}: ${h.status} 但历史里没有理由——被拒的理由是最贵的负向知识，不许丢`);
    }
    if (h.status !== "open" && (!h.decidedAt || !h.decidedBy)) {
      problems.push(`${where}: ${h.status} 但缺 decidedAt／decidedBy——结案必须留下"谁在什么时候判的"`);
    }
  }

  // 归档目录不变量：文件名里的 `<name>.<旧状态>` 必须与 frontmatter 的 name／status 一致。
  // 起因：`f17` 那次手工抄的归档副本文件名写 `open`、内容却是被否决那一版——**没有校验器看着**，
  // 于是"归档"这种东西自己会悄悄烂掉。归档文件名由 propose 自动生成，所以它本来就该校得上。
  {
    const archProposals = path.join(p.proposalsDir, "archive");
    if (fs.existsSync(archProposals)) {
      for (const fn of fs.readdirSync(archProposals)) {
        if (!fn.endsWith(".md")) continue;
        const m = /^(.+?)\.(open|accepted|rejected)\.\d{4}-\d{2}-\d{2}\.\d{6}\.md$/.exec(fn);
        if (!m) {
          warnings.push(`proposals/archive/${fn}: 文件名不匹配 <name>.<旧状态>.<日期>.<时刻>.md，已跳过校验`);
          continue;
        }
        const fm = readFrontmatterBlock(path.join(archProposals, fn));
        if (fm.name !== m[1]) problems.push(`proposals/archive/${fn}: frontmatter name "${fm.name}" ≠ 文件名里的 "${m[1]}"`);
        if (fm.status !== m[2]) problems.push(`proposals/archive/${fn}: frontmatter status "${fm.status}" ≠ 文件名里的 "${m[2]}"`);
      }
    }
  }

  // 摩擦力：只要记了就必须有"心眼"；没有 lesson 的记录是事故台账，不是学习
  const fList = loadFriction(p);
  const fPend = pendingFriction(fList);
  for (const e of fList) {
    if (e.unparsable) { problems.push(`friction: 有一行无法解析：${String(e.unparsable).slice(0, 60)}`); continue; }
    if (!e.what || !e.lesson) problems.push(`friction:${e.id}: 缺 --what 或 --lesson（没有"事前该问的那句"就不算长眼）`);
    if (e.type !== undefined && e.type !== null && (typeof e.type !== "string" || !e.type.trim())) {
      problems.push(`friction:${e.id}: type 必须是非空字符串（类型是**声明**的失败类型，不是工具猜的）`);
    }
    if (e.repeatOf && !fList.some((x) => x.id === e.repeatOf)) problems.push(`friction:${e.id}: repeatOf 指向不存在的 ${e.repeatOf}`);
  }

  // 不变量：**账本 ∪ 归档里的 id 必须唯一**（f14：清空账本后 id 从 f1 重开、与归档撞号，而当时 lint 是绿的
  // ——因为这条不变量从来没被任何地方声明过。不变量该由校验器守着，不该只靠一处实现碰巧写对。）
  {
    const ids = fList.map((e) => e.id).filter(Boolean);
    const arch = path.join(p.evoDir, "friction-reviewed.md");
    if (fs.existsSync(arch)) {
      for (const m of fs.readFileSync(arch, "utf8").matchAll(/^##\s+(f\d+)\b/gm)) ids.push(m[1]);
    }
    const seen = new Set();
    const dup = new Set();
    for (const id of ids) {
      if (seen.has(id)) dup.add(id);
      else seen.add(id);
    }
    if (dup.size) problems.push(`friction: id 重复：${[...dup].join(", ")}（账本 ∪ 归档里的 id 必须唯一）`);
  }

  return { problems, warnings, onDisk, friction: { total: fList.length, pending: fPend.length, repeats: fPend.filter((e) => e.repeatOf).length } };
}

/* ---------------------------------------------------------------- report */

function report(p, reg) {
  const notes = [];
  for (const s of reg.skills) {
    const dir = path.join(p.skillsRoot, s.path || s.name);
    const fm = readFrontmatter(path.join(dir, "SKILL.md"));
    const desc = fm && fm.description ? String(fm.description) : "";
    const triggerLen = fm && fm.whenToUse ? String(fm.whenToUse).length : 0;

    if (desc && desc.length > 0 && !/当|用于|如果|when|use when|触发/i.test(desc)) {
      notes.push(`[入口] ${s.name}: description 里看不出"何时该想起来"——meta skill 最常见的死法。`);
    }
    if (s.enforces === "text" && s.status === "active" && desc) {
      notes.push(`[下沉候选] ${s.name}: 目前停在"解释强制"。若它描述的是重复、确定的动作，考虑下沉一格（脚本）。`);
    }
    if ((s.usage && s.usage.skips || 0) >= 3) {
      notes.push(`[触发失败] ${s.name}: skips=${s.usage.skips}。问题多半在 description，不在正文。`);
    }
    if (s.usage && Array.isArray(s.usage.openIssues) && s.usage.openIssues.length) {
      notes.push(`[悬空] ${s.name}: ${s.usage.openIssues.length} 条 openIssues 未解决。`);
    }
    if (s.status === "draft") {
      notes.push(`[未生效] ${s.name}: status=draft（改完记得 propose → 用户确认 → 转 active）。`);
    }
    if (triggerLen > 400) {
      notes.push(`[越权] ${s.name}: whenToUse ${triggerLen} 字符，正在挤占常驻预算。`);
    }
  }

  const actives = reg.skills.filter((s) => s.status === "active");
  const byTier = {};
  for (const s of actives) byTier[s.tier] = (byTier[s.tier] || 0) + 1;
  console.log(`active ${actives.length} 条  ` + TIERS.map((t) => `${t}:${byTier[t] || 0}`).join("  "));
  console.log("（只报告，不决定。晋升/淘汰由判断层显式调用 promote/set。）\n");
  for (const n of notes) console.log("  " + n);
  if (!notes.length) console.log("  无候选。");
}

/* ---------------------------------------------------------------- render */

function render(p, reg) {
  const rows = [];
  rows.push("# catalog.md —— 目录预览（由 `skillctl render` 生成，**不是真源**，不参与运行）");
  rows.push("");
  rows.push("> 真正的目录由 harness 从各 skill 的 `description` 自动渲染并注入上下文。");
  rows.push("> 本文件只为**人**提供一份可审阅的投影；改动它不会影响任何行为。");
  rows.push("");
  rows.push(`registrySchema: ${reg.conformsTo || REGISTRY_SCHEMA}　engine: ${ENGINE_VERSION}　updated: ${today()}`);
  rows.push("");
  for (const tier of TIERS) {
    const list = reg.skills.filter((s) => s.tier === tier);
    if (!list.length) continue;
    rows.push(`## ${tier}（${list.length}）`);
    rows.push("");
    rows.push("| skill | 状态 | 强制 | version | 何时该想起来 |");
    rows.push("|---|---|---|---|---|");
    for (const s of list) {
      const dir = path.join(p.skillsRoot, s.path || s.name);
      const fm = readFrontmatter(path.join(dir, "SKILL.md"));
      const trig = fm && fm.whenToUse ? String(fm.whenToUse).replace(/\s+/g, " ").slice(0, 90) : "（见 description）";
      rows.push(`| \`${s.name}\` | ${s.status} | ${s.enforces} | ${s.version} | ${trig} |`);
    }
    rows.push("");
  }
  fs.mkdirSync(p.evoDir, { recursive: true });
  fs.writeFileSync(p.catalogPath, rows.join("\n"), "utf8");
  console.log(`已写出目录预览：${p.catalogPath}`);
}

/* ------------------------------------------------------------------ 命令 */

function cmdInit(p) {
  // 唯一的引导入口：registry 缺失时，其余命令都会在 loadRegistry 处直接失败，
  // 新机器因此无法从零开始。这里只做"建目录 + 写空 registry"，不触碰任何已有文件；
  // 重复执行是幂等的——现有 registry 一个字节都不改。
  for (const dir of [p.skillsRoot, p.evoDir, p.proposalsDir, p.scaffoldDir, p.archiveDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(p.registryPath)) {
    console.log(`registry 已存在，未改动：${p.registryPath}`);
    return;
  }
  const body = [
    "# registry.yaml —— skill 生命周期的「唯一真源」",
    "# 由 `skillctl init` 从零建立；此后一律经本引擎写入，不手改 YAML。",
    "#",
    "# conformsTo       数据格式戳（与程序认识的那一版对齐）。",
    "# updated          最后一次写入日期（YYYY-MM-DD）。",
    "# skills           技能条目列表；空 registry 为 []。",
    "# proposals        未结案提案；结案后移入 proposalsHistory。",
    "# proposalsHistory 已结案提案历史；只追加、永不删。",
    "conformsTo: " + REGISTRY_SCHEMA,
    "updated: " + today(),
    "skills: []",
    "proposals: []",
    "proposalsHistory: []",
    "",
  ].join("\n");
  fs.writeFileSync(p.registryPath, body, "utf8");
  console.log(`已初始化 registry：${p.registryPath}`);
}

function cmdList(p, reg, args) {
  const tier = argVal(args, "--tier");
  const status = argVal(args, "--status");
  let list = reg.skills;
  if (tier) list = list.filter((s) => s.tier === tier);
  if (status) list = list.filter((s) => s.status === status);
  if (!list.length) return console.log("（无匹配条目）");
  const w = Math.max(...list.map((s) => s.name.length), 12);
  console.log(`${"name".padEnd(w)}  ${"tier".padEnd(7)} ${"status".padEnd(10)} ${"enforce".padEnd(8)} v  skips`);
  for (const s of list) {
    console.log(
      `${s.name.padEnd(w)}  ${String(s.tier).padEnd(7)} ${String(s.status).padEnd(10)} ${String(s.enforces).padEnd(8)} ${String(s.version).padEnd(2)} ${(s.usage && s.usage.skips) || 0}`
    );
  }
  console.log(`\n（${list.length} 条。详情：skillctl show <name>；候选：skillctl report）`);
}

function cmdShow(p, reg, args) {
  const name = args[0];
  if (!name) fail("show 需要 <name>");
  const s = findSkill(reg, name);
  if (!s) fail(`registry 无此条目：${name}`);
  const dir = path.join(p.skillsRoot, s.path || s.name);
  const fm = readFrontmatter(path.join(dir, "SKILL.md"));
  console.log(`name      ${s.name}`);
  console.log(`tier      ${s.tier}   scope ${s.scope}   enforces ${s.enforces}   write ${s.write}`);
  console.log(`status    ${s.status}   version ${s.version}`);
  console.log(`path      ${dir}`);
  console.log(`bornFrom  ${s.bornFrom}`);
  console.log(`provenance ${String(s.provenance || "").replace(/\s+/g, " ").trim()}`);
  console.log(`deliver   ${String(s.deliver || "").replace(/\s+/g, " ").trim()}`);
  console.log(`lineage   ${JSON.stringify(s.lineage || {})}`);
  console.log(`usage     lastUsedAt=${s.usage && s.usage.lastUsedAt}  skips=${(s.usage && s.usage.skips) || 0}`);
  const oi = (s.usage && s.usage.openIssues) || [];
  console.log(`openIssues (${oi.length})`);
  for (const x of oi) console.log(`  - ${issueText(x)}`);
  console.log(`changelog (${(s.changelog || []).length})`);
  for (const c of s.changelog || []) {
    if (c && typeof c === "object") {
      console.log(`  - v${c.version ?? "?"} ${c.at ?? "?"} ${c.by ?? "?"}: ${c.what ?? ""}`);
    } else {
      console.log(`  - ${c}`);
    }
  }
  console.log(`\n提案：${findProposal(reg, name) ? "有未结提案（见 registry.proposals）" : "无未结提案"}`);
  const hist = (reg.proposalsHistory || []).filter((h) => h.name === name);
  console.log(`提案历史 proposalsHistory (${hist.length})${hist.length ? "——只追加，被否决的理由就在这儿" : ""}`);
  for (const h of hist) {
    console.log(`  - ${h.status} ${h.decidedAt || h.openedAt || "?"} by ${h.decidedBy || h.by || "?"}${h.why ? `　why: ${String(h.why)}` : ""}`);
  }
  // ★【2026-10-13 修】草稿还在 scaffold/ 时 `readFrontmatter` 返回 null ——
  //   下一行给 `.description` 加了保护，却没给 `fm` 本身加 ✗ 于是 `show <草稿>` 直接崩：
  //     TypeError: Cannot read properties of null (reading 'description')
  //   （实测：`show claim-evidence` 在它还是 draft 时崩了。这和 f22 是同一片区域——
  //     f22 记住的是"别把 readFrontmatter 当成会返回全部字段"，这次是"它还可能整个返回 null"。）
  if (!fm) {
    console.log(`\n--- 常驻目录那一行 ---`);
    console.log("（还没成为 live SKILL.md：草稿在 .evolution/scaffold/ 下，或 frontmatter 解析不出来）");
    return;
  }
  console.log(`\n--- 常驻目录那一行（harness 从 description 渲染，当前 ${fm.description ? fm.description.length : 0} 字）---`);
  console.log(fm.description || "（缺 description！）");
}

function cmdAdd(p, reg, args) {
  const name = args[0];
  if (!name) fail("add 需要 <name>");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) fail(`name 必须是 kebab-case：${name}`);
  if (findSkill(reg, name)) fail(`registry 已有条目：${name}`);
  const tier = argVal(args, "--tier") || "global";
  const scope = argVal(args, "--scope") || "durable";
  const enforces = argVal(args, "--enforces") || "text";
  if (!TIERS.includes(tier)) fail(`tier 越界：${tier}`);
  if (tier === "project") fail("tier=project 不进全局 registry（决策点 5）。");

  const dir = path.join(p.scaffoldDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const skillFile = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    fs.writeFileSync(
      skillFile,
      `---\nname: ${name}\ndescription: <能力声明：这是什么 + 何时该想起来（用户会说的原话 / 你会感觉到的症状）>\n---\n\n# ${name}\n\n<冷启动可重建：这是什么、何时用、怎么用>\n`,
      "utf8"
    );
  }
  reg.skills.push({
    name,
    tier,
    scope,
    status: "draft",
    version: 1,
    enforces,
    write: "user-gated",
    path: name,
    bornFrom: "friction",
    provenance: "",
    lineage: { mergedFrom: [], supersedes: [], supersededBy: [] },
    deliver: "",
    usage: { lastUsedAt: null, skips: 0, openIssues: [] },
    changelog: [{ version: 1, at: today(), by: "agent", what: "建档（draft）" }],
  });
  saveRegistry(p, reg);
  console.log(`已建档（draft）：${name}`);
  console.log(`草稿位置：${skillFile}`);
  console.log("下一步：写正文 → 提议给用户 → approve 后 `set " + name + " status=active` 并把目录移入 skills/ 根。");
}

function cmdSet(p, reg, args) {
  const name = args[0];
  const rest = args.slice(1);
  // 收集赋值对，并跳过 `--flag value` 的取值位置
  const pairs = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) { i++; continue; }
    pairs.push(a);
  }
  if (!name || !pairs.length) fail("set 需要 <name> <field>=<value> ...（或 skips+1 / openIssues+=文本）");
  const s = findSkill(reg, name);
  if (!s) fail(`registry 无此条目：${name}`);
  for (const pair of pairs) {
    let [k, v] = splitPair(pair);
    // 支持 `key=+1` / `key=+文本` 与 `key+N` / `key+=文本`：把末尾的 `+` 归一到 v 的前缀
    let plus = false;
    if (v !== undefined) {
      if (v.startsWith("+")) { plus = true; v = v.slice(1); }
      else if (k.endsWith("+")) { plus = true; k = k.slice(0, -1); }
    }
    // CLI 便捷键 → registry 真实路径
    const ALIAS = { skips: "usage.skips", openIssues: "usage.openIssues", lastUsedAt: "usage.lastUsedAt" };
    if (ALIAS[k]) k = ALIAS[k];
    if (plus) v = "+" + (v === "" ? "1" : v);
    if (v === undefined) {
      if (/^[A-Za-z_][\w.]*\+\d*$/.test(pair)) {
        const bare = pair.replace(/\+.*$/, "");
        k = ALIAS[bare] || bare;
        v = "+" + ((pair.match(/\+(\d*)$/) || [])[1] || "1");
      } else fail(`参数格式应为 field=value（或 skips+1 / openIssues+=文本）：${pair}`);
    }
    if (k === "usage.skips" && /^\+/.test(v)) {
      s.usage.skips = (s.usage.skips || 0) + Number(v.slice(1) || 1);
      console.log(`  usage.skips → ${s.usage.skips}`);
      continue;
    }
    if (k === "usage.openIssues" && /^\+/.test(v)) {
      s.usage.openIssues = s.usage.openIssues || [];
      s.usage.openIssues.push(v.slice(1));
      console.log(`  openIssues += ${v.slice(1)}`);
      continue;
    }
    if (k === "openIssues-") {
      const idx = Number(v);
      s.usage.openIssues.splice(idx, 1);
      console.log(`  openIssues -= [${idx}]`);
      continue;
    }
    const cur = getPath(s, k);
    // 【来源判定】write 是「谁写的」，不是工作流状态：
    //   user  = 人写的 → agent 一律不得直接改，只能提案（因为来源是声明的，不是推断的）
    //   agent = agent 自己写的 → 可自行 refine
    //   user-gated = 待定（在 scaffold 里，尚未成为 live SKILL.md）
    //  理由：执行的人每轮被换掉，来源是这台机器唯一能区分「人的东西」与「自己的东西」的方式。
    const isUser = args.includes("--user");
    const contentFields = ["provenance", "deliver", "bornFrom", "path", "version", "status", "tier", "enforces", "scope"];
    if (s.write === "user" && contentFields.includes(k) && !isUser) {
      fail(
        `${name} 的 write=user（人写的），agent 不得直接改其 ${k}。\n` +
        `  正确路径：skillctl propose ${name} --note "为什么要改" → 人审 → skillctl accept ${name}\n` +
        `  （确属用户本人在改？加 --user）`
      );
    }
    if (k === "version") {
      s.version = Number(v);
    } else if (k === "tier" && v === "project") {
      fail("tier=project 不应登记进全局 registry。");
    } else if (k === "scope" && v === "project") {
      fail("scope=project 不应登记。");
    } else if (k === "status" && !STATUSES.includes(v)) {
      fail(`status 越界：${v}`);
    } else if (k === "enforces" && !ENFORCES.includes(v)) {
      fail(`enforces 越界：${v}`);
    } else if (k === "tier" && !TIERS.includes(v)) {
      fail(`tier 越界：${v}`);
    } else if (typeof cur === "number" || k === "usage.skips") {
      setPath(s, k, Number(v));
    } else {
      setPath(s, k, v);
    }
    console.log(`  ${k}: ${JSON.stringify(cur)} → ${JSON.stringify(getPath(s, k))}`);
  }
  s.usage.lastUsedAt = today();
  s.updated = today();
  saveRegistry(p, reg);
  console.log(`已写入 registry（${name}）。跑一次 lint 确认没漂移。`);
}

function cmdPromote(p, reg, args) {
  const name = args[0];
  const to = args[1];
  if (!name || !to) fail("promote 需要 <name> <project|global|meta> [--enforces ...]");
  if (!TIERS.includes(to)) fail(`tier 越界：${to}`);
  const s = findSkill(reg, name);
  if (!s) fail(`registry 无此条目：${name}`);
  const from = s.tier;
  const fi = TIERS.indexOf(from);
  const ti = TIERS.indexOf(to);
  if (fi === ti) fail(`已在 ${to} 层。`);
  if (fi === -1) fail(`当前 tier 非法：${from}`);
  const enforces = argVal(args, "--enforces");
  s.tier = to;
  if (enforces) {
    if (!ENFORCES.includes(enforces)) fail(`enforces 越界：${enforces}`);
    s.enforces = enforces;
  }
  s.version = (s.version || 1) + 1;
  s.updated = today();
  s.changelog = s.changelog || [];
  s.changelog.push({
    version: s.version,
    at: today(),
    by: "agent",
    what: `沿深度轴移动：tier ${from} → ${to}${enforces ? `，enforces → ${enforces}` : ""}`,
  });
  saveRegistry(p, reg);
  console.log(`${name}: tier ${from} → ${to}${enforces ? `, enforces → ${enforces}` : ""}（version ${s.version}）`);
  console.log("提醒：移动 tier 只是记录判断；若同时要下沉到脚本/强制层，那是另一次改动。");
}

function cmdLint(p, reg) {
  const { problems, warnings, onDisk, friction } = lint(p, reg);
  if (reg.conformsTo && reg.conformsTo !== REGISTRY_SCHEMA) {
    warnings.push(`registry 的格式戳是 ${reg.conformsTo}，本程序按 ${REGISTRY_SCHEMA} 解析——可能读漏字段（先确认该升级程序还是该拒绝读）`);
  }
  console.log(`skillctl ${ENGINE_VERSION} · registry schema ${REGISTRY_SCHEMA} · 数据戳 ${reg.conformsTo || "(缺)"}`);
  console.log(`扫描：registry ${reg.skills.length} 条，磁盘 ${onDisk.length} 个技能目录，提案 ${(reg.proposals || []).length} 条（历史 ${(reg.proposalsHistory || []).length} 条），摩擦 ${friction.total} 条（待评估 ${friction.pending}，其中 repeat ${friction.repeats}）。`);
  if (warnings.length) {
    console.log(`\n警告（${warnings.length}）：`);
    for (const w of warnings) console.log("  ! " + w);
  }
  if (problems.length) {
    console.log(`\n问题（${problems.length}）：`);
    for (const x of problems) console.log("  x " + x);
    console.log("\nlint 只报不改。修完再跑一次。");
    process.exit(2);
  }
  console.log("\n无漂移。");
}

function cmdRoundtrip(p, reg) {
  const a = dumpYaml(reg);
  const b = dumpYaml(parseYaml(a));
  if (a === b) {
    console.log("往返无损：dump → parse → dump 完全一致。");
    return;
  }
  console.error("往返有损！唯一真源可能被悄悄改写。首个差异：");
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      console.error(`  行 ${i + 1}`);
      console.error(`    第一次: ${la[i]}`);
      console.error(`    第二次: ${lb[i]}`);
      break;
    }
  }
  process.exit(2);
}

/* ------------------------------------------------------- 摩擦力记录（append-only） */

/**
 * 摩擦力：主 agent 唯一的"快门"。
 *
 * 判据（用户定，别改）：**碰一次壁就要长一次眼**——撞墙本身不算账，撞完说不出
 * "事前该问哪一句"才算。因此每条记录**必须**带 lesson（那句心眼），没有就不许记。
 *
 * **重复和绕是升级信号**：不是"又一个类型"，而是"连怎么错的都没学会"——
 * 它证明上一次没修好，所以标 repeat 的条目**优先**进入事后评估。
 *
 * 为什么用 append-only 而不是写进 registry：registry 会被 skillctl 整体重写，
 * 一份会被重写的记录等于随时可能丢；而摩擦力是**原始观察**，它必须最抗丢。
 * 且本文件只存症状，不存诊断——分类与模式由事后评估的子 agent 去做。
 */
function frictionPath(p) {
  return path.join(p.evoDir, "friction.jsonl");
}

function loadFriction(p) {
  const f = frictionPath(p);
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try { return JSON.parse(l); } catch { return { unparsable: l }; }
    });
}

function appendFriction(p, entry) {
  fs.mkdirSync(p.evoDir, { recursive: true });
  fs.appendFileSync(frictionPath(p), JSON.stringify(entry) + "\n", "utf8");
}

/** 粗糙但够用的相似度：用于自动判定"这是不是又犯了同一个"。 */
function looksSame(a, b) {
  const norm = (s) => String(s).replace(/[\s，。、；：""''（）()【】\[\]—…,.!?！？]/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length < 6) return false;
  // 子串包含，或逐字命中率高
  if (long.includes(short)) return true;
  const set = new Set(long.split(""));
  let hit = 0;
  for (const ch of new Set(short.split(""))) if (set.has(ch)) hit++;
  return hit / new Set(short.split("")).size >= 0.8;
}

function nextFrictionId(list, p) {
  let max = 0;
  for (const e of list) {
    const m = /^f(\d+)$/.exec(e.id || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  // **归档也要算**：`clear` 会把条目搬进 friction-reviewed.md；若只数活账本，清空之后 id 会
  // 从 f1 重开、与归档里的 f1 撞号，`repeatOf` 立刻变得有歧义。
  // （2026-09-30 实测：clear 之后新条目拿到了早已用过的 f1。）
  if (p && p.evoDir) {
    const arch = path.join(p.evoDir, "friction-reviewed.md");
    if (fs.existsSync(arch)) {
      const text = fs.readFileSync(arch, "utf8");
      for (const m of text.matchAll(/^##\s+(f\d+)\b/gm)) {
        max = Math.max(max, Number(m[1].slice(1)));
      }
    }
  }
  return "f" + (max + 1);
}

function pendingFriction(list) {
  return list.filter((e) => !e.reviewedAt && !e.unparsable);
}

function cmdFriction(p, reg, args) {
  const sub = args[0];
  const list = loadFriction(p);

  if (sub === "add") {
    const rest = args.slice(1);
    const incident = argVal(rest, "--what");
    const lesson = argVal(rest, "--lesson");
    const type = argVal(rest, "--type");
    const repeatOf = argVal(rest, "--repeat");
    if (!incident || !lesson) {
      fail(
        "friction add 必须同时给 --what（事实，原样）与 --lesson（事前该问的那一句）。\n" +
        "  没有 lesson 就不算「长眼」，那条摩擦不许入库——判据是「碰一次壁就要长一次眼」。\n" +
        '  例：friction add --what "把解析失败当成文件被写坏" --lesson "断言它坏之前，验过数据吗？"'
      );
    }
    const pend = pendingFriction(list);
    let repeat = null;
    let repeatWhy = "";
    if (repeatOf) {
      const target = list.find((e) => e.id === repeatOf);
      if (!target) fail(`--repeat 指向不存在的记录：${repeatOf}`);
      repeat = repeatOf;
      repeatWhy = "显式指定";
    } else if (type) {
      // 同「声明的类型」即同族。类型是人给的，不是工具猜的（§8.2：来源是声明的，不是推断的）。
      const hit = pend.find((e) => e.type === type);
      if (hit) {
        repeat = hit.id;
        repeatWhy = `同类型「${type}」`;
      }
    }
    if (!repeat) {
      const hit = pend.find((e) => looksSame(e.what, incident)) || list.find((e) => looksSame(e.what, incident));
      if (hit) {
        repeat = hit.id;
        repeatWhy = "字面相似";
      }
    }
    const entry = {
      id: nextFrictionId(list, p),
      at: new Date().toISOString(),
      what: incident,
      lesson,
      type: type || null,
      repeatOf: repeat,
      reviewedAt: null,
      reviewBatch: null,
    };
    appendFriction(p, entry);
    console.log(`已记账：${entry.id}${repeat ? `（repeat of ${repeat} —— ${repeatWhy}；**重复/绕 = 升级信号**）` : ""}`);
    console.log(`  事实：${incident}`);
    console.log(`  心眼：${lesson}`);
    if (type) console.log(`  类型：${type}（声明）`);
    else console.log("  提示：没给 --type。类型是**声明**的——同一失败类型换个措辞就会漏掉 repeat（本账本已有一次 7 条同族全漏的案例）。");
    const after = pendingFriction([...list, entry]);
    console.log(`\n待评估 ${after.length} 条${after.some((e) => e.repeatOf) ? "（含 repeat，优先）" : ""}。`);
    console.log(`够 5 条、或有 repeat 时：开一个全新子 agent，把本文件 + 本次上下文交给它去反省沉淀。`);
    return;
  }

  if (sub === "list" || sub === undefined) {
    const pend = pendingFriction(list);
    const done = list.length - pend.length;
    if (!list.length) return console.log("（摩擦账本为空）");
    for (const e of pend) {
      const tag = e.repeatOf ? ` [repeat of ${e.repeatOf}]` : "";
      console.log(`${e.id}${tag}${e.type ? ` {${e.type}}` : ""}  ${e.what}`);
      console.log(`      心眼: ${e.lesson}`);
    }
    const repeats = pend.filter((e) => e.repeatOf);
    console.log(`\n待评估 ${pend.length} 条，已评估 ${done} 条。`);
    if (repeats.length) console.log(`**${repeats.length} 条 repeat —— 重复/绕，优先送事后评估。**`);
    else if (pend.length >= 5) console.log("**已够 5 条 —— 该开事后评估了。**");
    else console.log(`（距 5 条还差 ${5 - pend.length} 条；出现 repeat 则立刻触发）`);
    return;
  }

  if (sub === "clear") {
    const pend = pendingFriction(list);
    if (!pend.length) return console.log("（没有待评估条目）");
    // --batch：把**评估者产出的分类与选层结论**一起写进归档。
    // 理由：clear 原本只搬原条目，评估结论没有任何落点——下一个 fork 会把同一批重做一遍。
    const batch = argVal(args, "--batch");
    const layer = argVal(args, "--layer");
    const ids = new Set(pend.map((e) => e.id));
    const now = new Date().toISOString();
    const kept = [];
    const moved = [];
    for (const e of list) {
      if (ids.has(e.id)) moved.push({ ...e, reviewedAt: now, reviewBatch: batch || e.reviewBatch || null });
      else kept.push(e);
    }
    fs.writeFileSync(
      frictionPath(p),
      kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""),
      "utf8"
    );
    const arch = path.join(p.evoDir, "friction-reviewed.md");
    const head = fs.existsSync(arch) ? "" : "# 已评估的摩擦力（append-only 归档，不参与运行）\n\n";
    const batchHead = batch
      ? `## 批次 ${now} — 类型：${batch}\n` +
        `- 条目：${moved.map((e) => e.id).join(", ")}（${moved.length} 条）\n` +
        (layer ? `- 选层结论：${layer}\n` : "") +
        "\n"
      : "";
    const body = moved
      .map((e) => `## ${e.id} ${e.at}\n- 事实：${e.what}\n- 心眼：${e.lesson}${e.type ? `\n- 类型：${e.type}` : ""}${e.repeatOf ? `\n- repeat of：${e.repeatOf}` : ""}${batch ? `\n- reviewBatch：${batch}` : ""}\n`)
      .join("\n");
    fs.appendFileSync(arch, head + batchHead + body, "utf8");
    console.log(`已把 ${moved.length} 条移入归档：${arch}${batch ? `（批次类型：${batch}）` : ""}`);
    if (!batch) {
      console.log("提示：没给 `--batch`。**评估者产出的分类结论会随这次会话一起死**——下次 fork 看不到它，会重做一遍。");
    }
    console.log("账本里只剩未评估项；archived 记录不会被覆盖丢失。");
    return;
  }

  fail(`未知子命令：friction ${sub}（可用：add / list / clear）`);
}

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1] || null;
}

function splitPair(pair) {
  const eq = pair.indexOf("=");
  if (eq === -1) return [pair, undefined];
  return [pair.slice(0, eq), pair.slice(eq + 1)];
}

function getPath(obj, k) {
  return k.split(".").reduce((o, part) => (o == null ? o : o[part]), obj);
}

/** 把 openIssues 里可能是 `{encode: "..."}` 的条目还原成可读文本。 */
function issueText(x) {
  if (x === null || x === undefined) return "";
  if (typeof x !== "object") return String(x);
  if (Array.isArray(x)) return x.map(issueText).join("；");
  const vals = Object.values(x).map((v) => (v === null || v === undefined ? "" : String(v)));
  if (vals.length === 1) return vals[0];
  return Object.entries(x)
    .map(([k, v]) => `${k}: ${v}`)
    .join("；");
}

function setPath(obj, k, v) {
  const parts = k.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = v;
}

function help() {
  console.log(`skillctl —— skill-evolution 的手（不是脑）。engine ${ENGINE_VERSION} / registry schema ${REGISTRY_SCHEMA}

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

承重规则（理由写在源码顶部与 registry 头部）：
  · 提案钉在它提议的那个状态上——人每轮被换掉，机器是唯一记忆。
  · write=user 的条目 agent 只能提案，不得直接改——来源是声明的，不是推断的。
  · 碰一次壁就要长一次眼——撞墙不算账，撞完说不出"事前该问哪一句"才算。
  · 重复和绕不是"又一个类型"，是**连怎么错的都没学会**，优先送事后评估。
`);
}

/* ------------------------------------------------------------------ main */

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return help();
  const p = locate();

  if (cmd === "init") return cmdInit(p);

  if (cmd === "add") {
    const reg = loadRegistry(p);
    return cmdAdd(p, reg, args);
  }

  const reg = loadRegistry(p);
  switch (cmd) {
    case "list": return cmdList(p, reg, args);
    case "show": return cmdShow(p, reg, args);
    case "set": return cmdSet(p, reg, args);
    case "promote": return cmdPromote(p, reg, args);
    case "propose": return cmdPropose(p, reg, args);
    case "stale": return cmdStale(p, reg, args);
    case "accept": return cmdAccept(p, reg, args);
    case "reject": return cmdReject(p, reg, args);
    case "friction": return cmdFriction(p, reg, args);
    case "lint": return cmdLint(p, reg);
    case "roundtrip": return cmdRoundtrip(p, reg);
    case "render": return render(p, reg);
    case "report": return report(p, reg);
    default:
      console.error(`skillctl: 未知命令 "${cmd}"`);
      help();
      process.exit(1);
  }
}

main();
