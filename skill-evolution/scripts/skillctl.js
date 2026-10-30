#!/usr/bin/env node
/**
 * skillctl.js —— skill-evolution 的手（不是脑）。v15
 *
 * 五个动作：记（note）· 读（self / train）· 提（propose / supersede）· 批（merge / reject）· 扫（view / check）
 * 另有登记与巡检：list / show / add / set / promote / sync / render / roundtrip / stale / review
 *
 * 三条承重规则（理由在 SKILL.md §8）：
 *   1. 提案钉在它所提议的那个状态上（整包哈希 + registry 指纹）——目标一改，提案即 stale。
 *   2. 来源是声明的，不是推断的（write: user 只能提案，不能直接改）。
 *   3. 读过才有写权（self 留读记录；merge 前校验）——没领过，只能读、只能提。
 *
 * 退出码：0 正常；1 用法/读取错误；2 check 发现问题或 merge 被门拒绝。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// 两个版本必须分开：引擎会升版（行为变），registry 的格式未必变。
const ENGINE_VERSION = "skill-evo-v16";
const REGISTRY_SCHEMA = "skill-evo-v4";

const KINDS = ["观察", "提案"];
const STATES = ["open", "reviewed", "merged", "rejected", "superseded", "archived"];
const CAUSES = ["task", "user", "agent-class", "model", "harness"];
const TYPES = [
  "未经对账的断言",
  "覆盖即销毁",
  "本机工具约定",
  "写完没回读",
  "顺序做反",
  "定位误判",
  "验证工具本身没验",
  "交付形态未适配读者",
];
const NO_SCOPE = "无归属";

/* ------------------------------------------------------------------ 定位 */

function locate() {
  const home = process.env.DSH_HOME;
  if (!home) fail("环境变量 DSH_HOME 未设置，无法定位全局技能根。");
  const skillsRoot = path.join(home, "skills");
  const evoDir = path.join(skillsRoot, ".evolution");
  return {
    home: home,
    skillsRoot: skillsRoot,
    evoDir: evoDir,
    registryPath: path.join(evoDir, "registry.yaml"),
    catalogPath: path.join(evoDir, "catalog.md"),
    historyDir: path.join(evoDir, "history"),
    legacyDir: path.join(evoDir, "_legacy"),
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

function frictionPath(p) {
  return path.join(p.evoDir, "friction.jsonl");
}

/** 会话目录名 → 工作区路径（反查用；命名规则：-- + 路径，分隔符换成 -，非 [A-Za-z0-9._] 换 ~XXXX）。 */
function decodeSessionDir(name) {
  let s = name.replace(/^--/, "").replace(/--$/, "");
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  const parts = s.split("-");
  const drive = parts.shift();
  return drive + ":" + String.fromCharCode(92) + parts.join(String.fromCharCode(92));
}

/** 由 sessionId 反查**会话所属工作区**（不是当前 pwd）。 */
function sessionWorkspace(sessionId) {
  if (!sessionId) return null;
  const home = process.env.DSH_HOME || path.join(require("os").homedir(), ".dsh");
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const sdir = path.join(root, dir, sessionId);
    if (!fs.existsSync(sdir) || !fs.statSync(sdir).isDirectory()) continue;
    for (const name of ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl.zstd"]) {
      const file = path.join(sdir, name);
      if (!fs.existsSync(file)) continue;
      try {
        // 故意用 node 的 zstdDecompressSync：它只解首帧，而首帧恰好只有 {"type":"session",...,"cwd":...}。
        // 这不是"读了假日志"——假日志是拿它读**事件**时的症状（见 dsh-session-repair）。
        const head = require("zlib")
          .zstdDecompressSync(fs.readFileSync(file))
          .toString("utf8")
          .split("\n")[0];
        const obj = JSON.parse(head);
        if (obj && obj.cwd) return obj.cwd;
      } catch {
        /* 落到目录名反查 */
      }
    }
    return decodeSessionDir(dir);
  }
  return null;
}

/** "12-48" / "12" → [12,48]；非法返回 null（**不瞎猜**）。 */
function parseSeq(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(value).trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return [Math.min(a, b), Math.max(a, b)];
}


/* ------------------------------------------------------------ 读写 registry */

function saveRegistry(p, reg) {
  if (reg.conformsTo !== REGISTRY_SCHEMA) reg.conformsTo = REGISTRY_SCHEMA;
  const header = [
    "# registry.yaml —— skill 生命周期的「声明」",
    "# 位置：\$DSH_HOME/skills/.evolution/registry.yaml（深度 2，天然不被 skill 扫描器发现）",
    "# 写入纪律：一律经 scripts/skillctl.js，不手改 YAML（唯一例外：用户直接编辑，之后跑 check）。",
    "# 说明：name/description 以各自 SKILL.md 的 frontmatter 为准（harness 只从那里渲染目录），",
    "#       本文件不复制它们，由 check 强制对齐。沿革（观察与提案）不在本文件——它在 .evolution/history/<name>/。",
    "# 三条纪律：",
    "#   1. 提案钉着「提议时的整包哈希 + registry 指纹」——机器是唯一记忆，脱钩的提案不许批。",
    "#   2. write 是硬约束：user 表示人写的，agent 只能提案，不得直接改。",
    "#   3. 沿革条目正文不可变；状态可变。历史只追加，永不删。",
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(p.registryPath), { recursive: true });
  fs.writeFileSync(p.registryPath, header + dumpYaml(reg), "utf8");
}

function skillDirOf(p, s) { return path.join(p.skillsRoot, s.path || s.name); }
function skillFileOf(p, s) { return path.join(skillDirOf(p, s), "SKILL.md"); }

function findSkill(reg, name) {
  return reg.skills.find(function (s) { return s.name === name; });
}

function today() { return new Date().toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }
function sha256(text) { return crypto.createHash("sha256").update(text, "utf8").digest("hex"); }

/* --------------------------------------------------------------- 包哈希 */

function walkFiles(dir, base, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    if (/\.bak(-|\.|$)/.test(name)) continue;
    if (name === ".DS_Store") continue;
    const full = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) walkFiles(full, rel, out);
    else out.push(rel);
  }
  return out;
}

/**
 * 包哈希＝技能目录内所有文件（按相对路径排序）的摘要。
 * 为什么不是 SKILL.md 单文件：references/ 也是本体的一部分，改了它却不升版本，
 * 等于让"提案钉住的状态"漏掉一半。
 */
function packageHash(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = walkFiles(dir, "", []).sort();
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\u0000");
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update("\u0000");
  }
  return h.digest("hex");
}

/* ----------------------------------------------------------- 沿革包 */

function hDir(p, name) { return path.join(p.historyDir, name); }
function entriesDir(p, name) { return path.join(hDir(p, name), "entries"); }

function ensurePackage(p, name) {
  const dir = hDir(p, name);
  const ed = entriesDir(p, name);
  fs.mkdirSync(ed, { recursive: true });
  const pointer = path.join(dir, "POINTER.md");
  if (!fs.existsSync(pointer)) {
    fs.writeFileSync(pointer,
      "# POINTER（沿革包 → 运行时；单向）\n\n" +
      "本包只记**为什么是这样**；技能本体在 [" + name + "](../../" + name + "/SKILL.md)。\n" +
      "运行时那边没有指回这里的指针——治理不污染运行时。\n", "utf8");
  }
  return dir;
}

function splitFrontmatter(text) {
  if (!text.startsWith("---")) return { fm: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: text };
  const fmText = text.slice(3, end);
  const rest = text.indexOf("\n", end + 4);
  return { fm: parseYaml(fmText) || {}, body: rest === -1 ? "" : text.slice(rest + 1) };
}

function parseEntryFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const parts = splitFrontmatter(text);
  const fm = parts.fm || {};
  const e = {
    id: fm.id ? String(fm.id) : null,
    at: fm.at ? String(fm.at) : null,
    kind: fm.kind ? String(fm.kind) : null,
    scope: fm.scope ? String(fm.scope) : null,
    cause: Array.isArray(fm.cause) ? fm.cause : (fm.cause ? [String(fm.cause)] : []),
    type: fm.type ? String(fm.type) : null,
    state: fm.state ? String(fm.state) : "open",
    by: fm.by ? String(fm.by) : null,
    author: fm.author ? String(fm.author) : (fm.by ? String(fm.by) : null),
    repeatOf: fm.repeatOf ? String(fm.repeatOf) : null,
    why: fm.why ? String(fm.why) : null,
    legacyType: fm.legacyType ? String(fm.legacyType) : null,
    legacy: fm.legacy === true,
    grandfathered: fm.grandfathered === true,
    decidedAt: fm.decidedAt ? String(fm.decidedAt) : null,
    decidedBy: fm.decidedBy ? String(fm.decidedBy) : null,
    reviewedAt: fm.reviewedAt ? String(fm.reviewedAt) : null,
    sessions: [],
    pin: null,
    evidence: Array.isArray(fm.evidence) ? fm.evidence.map(String) : [],
    file: file,
    body: parts.body,
  };
  try { if (typeof fm.sessions === "string") e.sessions = JSON.parse(fm.sessions); else if (Array.isArray(fm.sessions)) e.sessions = fm.sessions; } catch (err) { e.sessions = []; }
  try { if (typeof fm.pin === "string") e.pin = JSON.parse(fm.pin); else if (fm.pin && typeof fm.pin === "object") e.pin = fm.pin; } catch (err) { e.pin = null; }
  try {
    if (typeof fm.repeat === "string") { const r = JSON.parse(fm.repeat); if (r) { e.repeatOf = r.of; e.repeatWhy = r.why; } }
  } catch (err) { /* ignore */ }
  if (e.repeatOf && !e.repeatWhy) e.repeatWhy = "显式";
  return e;
}

function listEntries(p, name) {
  const ed = entriesDir(p, name);
  if (!fs.existsSync(ed)) return [];
  return fs.readdirSync(ed)
    .filter(function (f) { return f.endsWith(".md"); })
    .sort()
    .map(function (f) { return parseEntryFile(path.join(ed, f)); });
}

function allEntries(p) {
  if (!fs.existsSync(p.historyDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(p.historyDir)) {
    const dir = path.join(p.historyDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const e of listEntries(p, name)) { e.package = name; out.push(e); }
  }
  return out;
}

function nextEntryId(p) {
  let max = 0;
  for (const e of allEntries(p)) {
    const m = /^f(\d+)$/.exec(e.id || "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  const legacy = path.join(p.legacyDir);
  if (fs.existsSync(legacy)) {
    for (const f of fs.readdirSync(legacy)) {
      if (!f.endsWith(".md") && !f.endsWith(".jsonl")) continue;
      const text = fs.readFileSync(path.join(legacy, f), "utf8");
      for (const m of text.matchAll(/"id":"(f\d+)"/g)) max = Math.max(max, Number(m[1].slice(1)));
      for (const m of text.matchAll(/^##\s+(f\d+)\b/gm)) max = Math.max(max, Number(m[1].slice(1)));
    }
  }
  const old = path.join(p.evoDir, "friction.jsonl");
  if (fs.existsSync(old)) {
    const text = fs.readFileSync(old, "utf8");
    for (const m of text.matchAll(/"id":"(f\d+)"/g)) max = Math.max(max, Number(m[1].slice(1)));
  }
  return "f" + (max + 1);
}

function renderEntry(e) {
  const lines = ["---"];
  lines.push("id: " + scalarText(e.id));
  lines.push("at: " + scalarText(e.at));
  lines.push("kind: " + scalarText(e.kind));
  lines.push("scope: " + scalarText(e.scope));
  lines.push("cause: [" + (e.cause || []).join(", ") + "]");
  if (e.type) lines.push("type: " + scalarText(e.type));
  if (e.legacyType) lines.push("legacyType: " + scalarText(e.legacyType));
  lines.push("state: " + scalarText(e.state));
  lines.push("by: " + scalarText(e.by));
  if (e.author && e.author !== e.by) lines.push("author: " + scalarText(e.author));
  if (e.repeatOf) lines.push("repeatOf: " + scalarText(e.repeatOf));
  if (e.why) lines.push("why: " + scalarText(e.why));
  if (e.decidedAt) lines.push("decidedAt: " + scalarText(e.decidedAt));
  if (e.decidedBy) lines.push("decidedBy: " + scalarText(e.decidedBy));
  if (e.reviewedAt) lines.push("reviewedAt: " + scalarText(e.reviewedAt));
  if (e.legacy) lines.push("legacy: true");
  if (e.grandfathered) lines.push("grandfathered: true");
  if (e.evidence && e.evidence.length) lines.push("evidence: [" + e.evidence.join(", ") + "]");
  if (e.sessions && e.sessions.length) lines.push("sessions: " + scalarText(JSON.stringify(e.sessions)));
  if (e.pin) lines.push("pin: " + scalarText(JSON.stringify(e.pin)));
  lines.push("---");
  lines.push("");
  return lines.join("\n") + canonBody(e.body) + "\n";
}

function canonBody(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

function entryFileName(e) {
  const body = canonBody(e.body);
  const h = sha256(body).slice(0, 8);
  const day = String(e.at || nowIso()).slice(0, 10).replace(/-/g, "");
  return day + "-" + e.id + "-" + h + ".md";
}

function writeEntry(p, name, e) {
  ensurePackage(p, name);
  const file = path.join(entriesDir(p, name), entryFileName(e));
  fs.writeFileSync(file, renderEntry(e), "utf8");
  return file;
}

function rewriteEntry(p, name, e) {
  const file = e.file;
  fs.writeFileSync(file, renderEntry(e), "utf8");
  return file;
}

function appendRead(p, name, rec) {
  ensurePackage(p, name);
  fs.appendFileSync(path.join(hDir(p, name), "reads.jsonl"), JSON.stringify(rec) + "\n", "utf8");
}

function readsOf(p, name) {
  const f = path.join(hDir(p, name), "reads.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(function (l) {
    try { return JSON.parse(l); } catch (err) { return null; }
  }).filter(Boolean);
}

function findEntry(p, id) {
  for (const e of allEntries(p)) if (e.id === id) return e;
  return null;
}


/* ------------------------------------------------------------------ 小工具 */

function argVal(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
function hasFlag(args, flag) { return args.indexOf(flag) !== -1; }
function actor() {
  const sid = process.env.DSH_SESSION_ID || "";
  return sid ? "agent:" + sid.replace(/^session-/, "").slice(0, 8) : "agent:local";
}
function sessionId() { return process.env.DSH_SESSION_ID || null; }

function registryFingerprint(s) {
  return sha256(JSON.stringify({
    name: s.name, version: s.version, tier: s.tier, status: s.status,
    enforces: s.enforces, write: s.write, packageHash: s.packageHash || null,
  }));
}

function printEntry(e, full) {
  console.log("\n## " + e.id + " · " + e.kind + " · " + e.state + (e.type ? " · " + e.type : "") + " · " + (e.scope || "?"));
  console.log("   at " + (e.at || "?") + " · by " + (e.by || "?") +
    (e.legacyType ? " · legacyType " + e.legacyType : "") +
    (e.repeatOf ? " · repeat of " + e.repeatOf : ""));
  if (e.why) console.log("   why: " + e.why);
  if (full) console.log("\n" + (e.body || "").trim() + "\n");
  else console.log("   " + (e.body || "").trim().split("\n")[0].slice(0, 140));
}

/* -------------------------------------------------------------------- 记 */

function cmdNote(p, reg, args) {
  const what = argVal(args, "--what");
  const lesson = argVal(args, "--lesson");
  const scope = argVal(args, "--scope");
  const causeArg = argVal(args, "--cause");
  const type = argVal(args, "--type");

  if (!what || !lesson) {
    fail("note 必须同时给 --what（事实，原样）与 --lesson（事前该问的那一句）。\n" +
      "  没有 lesson 就不算长眼；没有 scope/cause/type 就无法归因——账本会退化成废纸。");
  }
  if (!scope) fail("note 必须给 --scope <技能名|无归属>：这堆归谁，决定谁有资格改它。");
  if (scope !== NO_SCOPE && !findSkill(reg, scope)) {
    fail("--scope 不在 registry 里：" + scope + "。要么用正确的技能名，要么写 " + NO_SCOPE + "。");
  }
  const causes = String(causeArg || "").split(/[,，\s]+/).filter(Boolean);
  if (!causes.length) fail("note 必须给 --cause <task|user|agent-class|model|harness>（可多值，逗号分隔）。");
  for (const c of causes) {
    if (!CAUSES.includes(c)) fail("--cause 不在枚举内：" + c + "。合法值：" + CAUSES.join(" / "));
  }
  if (!type) fail("note 必须给 --type（7 值封闭枚举之一）。");
  if (!TYPES.includes(type)) fail("--type 不在封闭枚举内：" + type + "\n  合法值：" + TYPES.join(" / ") +
    "\n  要加新值 → 引擎修订（慢档），不许临场造词。");

  const all = allEntries(p);
  let repeatOf = argVal(args, "--repeat") || null;
  let repeatWhy = repeatOf ? "显式指定" : "";
  if (!repeatOf) {
    const hit = all.filter(function (e) { return e.state === "open" && e.type === type && e.scope === scope; })[0];
    if (hit) { repeatOf = hit.id; repeatWhy = "同类型「" + type + "」且同 scope"; }
  }

  const sid = sessionId();
  const sessions = sid ? [{
    cwd: sessionWorkspace(sid),
    session: sid,
    seq: parseSeq(argVal(args, "--seq")),
    anchor: argVal(args, "--anchor") || null,
  }] : [];

  const e = {
    id: nextEntryId(p),
    at: nowIso(),
    kind: "观察",
    scope: scope,
    cause: causes,
    type: type,
    state: "open",
    by: argVal(args, "--by") || actor(),
    author: null,
    repeatOf: repeatOf,
    why: null,
    sessions: sessions,
    evidence: [],
    legacy: false,
    body: "**事实**：" + what + "\n\n**那一眼**：" + lesson + "\n",
  };
  const file = writeEntry(p, pkgForScope(scope), e);
  console.log("已记账：" + e.id + (repeatOf ? "（repeat of " + repeatOf + " —— " + repeatWhy + "；重复/绕 = 升级信号）" : ""));
  console.log("  scope " + scope + " · cause " + causes.join(",") + " · type " + type);
  console.log("  " + file);
  if (!sessions.length) console.log("  提醒：没有会话指针（DSH_SESSION_ID 为空）——事后无法回轨迹。");
}

/* -------------------------------------------------------------------- 读 */

function cmdSelf(p, reg, args) {
  const name = args[0];
  if (!name) fail("self 需要 <name>：整份读入这个技能的本体与沿革，并在 reads.jsonl 留痕。");
  const s = findSkill(reg, name);
  if (!s) fail("registry 里没有 " + name + "。");
  const dir = skillDirOf(p, s);
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) fail("磁盘上没有 " + file);
  const body = fs.readFileSync(file, "utf8");
  const entries = listEntries(p, name);

  console.log("# 领取：" + name + "（v" + s.version + "）");
  console.log("\n--- 本体 SKILL.md ---\n");
  console.log(body.trim());
  console.log("\n--- 沿革（" + entries.length + " 条）---");
  for (const e of entries) {
    const full = !e.legacy && e.state !== "reviewed" && e.state !== "archived";
    printEntry(e, full);
  }
  const h = packageHash(dir);
  appendRead(p, name, {
    at: nowIso(), by: actor(), session: sessionId(),
    package: h, entries: entries.length,
  });
  console.log("\n[读记录已写] package " + String(h).slice(0, 12) + " · entries " + entries.length);
}

function cmdTrain(p, reg, args) {
  const ref = args[0] || "authoring";
  if (ref !== "authoring") fail("目前只有 authoring 这一个岗位培训包。");
  const file = path.join(p.skillsRoot, "skill-evolution", "references", ref + ".md");
  if (!fs.existsSync(file)) {
    fail("培训包不存在：" + file + "\n  它应当随技能包一起分发（渐进披露的第三层）。");
  }
  const text = fs.readFileSync(file, "utf8");
  console.log(text.trim());
  appendRead(p, "skill-evolution", {
    at: nowIso(), by: actor(), session: sessionId(),
    what: "train:" + ref, sha256: sha256(text),
  });
  console.log("\n[已登记培训领取] train:" + ref + " · " + sha256(text).slice(0, 12));
}

/* -------------------------------------------------------------------- 提 */

function cmdPropose(p, reg, args) {
  const name = args[0];
  if (!name) fail("propose 需要 <name> --why 理由");
  const s = findSkill(reg, name);
  if (!s) fail("registry 里没有 " + name + "。诞生新技能走 add（需要先 train authoring）。");
  const why = argVal(args, "--why");
  if (!why) fail("propose 必须给 --why：提案的理由是一等字段，不是备注。");

  const open = allEntries(p).filter(function (e) {
    return e.kind === "提案" && e.state === "open" && e.scope === name;
  });
  if (open.length) fail("已有未结提案：" + open[0].id + "。先 merge 或 reject。");

  const dir = skillDirOf(p, s);
  const evidence = String(argVal(args, "--evidence") || "").split(/[,，\s]+/).filter(Boolean);
  for (const id of evidence) {
    if (!findEntry(p, id)) fail("--evidence 指向不存在的条目：" + id);
  }
  const pin = {
    package: packageHash(dir),
    registry: registryFingerprint(s),
    version: s.version,
  };
  const note = argVal(args, "--note") || "（待补：改什么 / 为什么这么改 / 被否决的替代方案）";
  const e = {
    id: nextEntryId(p),
    at: nowIso(),
    kind: "提案",
    scope: name,
    cause: String(argVal(args, "--cause") || "agent-class").split(/[,，\s]+/).filter(Boolean),
    type: null,
    state: "open",
    by: actor(),
    author: actor(),
    why: why,
    evidence: evidence,
    sessions: [],
    legacy: false,
    pin: pin,
    body: note + "\n",
  };
  const file = writeEntry(p, name, e);
  console.log("已立提案：" + e.id + " → " + name + "（v" + s.version + "）");
  console.log("  钉：package " + String(pin.package).slice(0, 12) + " · registry " + String(pin.registry).slice(0, 12));
  console.log("  " + file);
  console.log("  下一步：人批 → merge " + name + " --why … → 应用改动 → sync " + name);
}

/* -------------------------------------------------------------------- 批 */

function cmdMerge(p, reg, args) {
  const name = args[0];
  if (!name) fail("merge 需要 <name> --why 理由");
  const s = findSkill(reg, name);
  if (!s) fail("registry 里没有 " + name + "。");
  const dir = skillDirOf(p, s);
  const open = allEntries(p).filter(function (e) {
    return e.kind === "提案" && e.state === "open" && e.scope === name;
  });
  if (!open.length) fail("没有未结提案：先 propose " + name);
  const pr = open[0];
  const why = argVal(args, "--why") || pr.why;
  if (!why) fail("merge 必须给 --why（批准的理由同样是一等字段）。");
  const by = argVal(args, "--by") || "user";

  if (!pr.pin) fail("提案没有 pin（旧格式？）——不许批。");
  const h = packageHash(dir);
  const stale = [];
  if (pr.pin.package !== h) stale.push("包哈希");
  if (pr.pin.version !== s.version) stale.push("version（" + pr.pin.version + " → " + s.version + "）");
  if (pr.pin.registry !== registryFingerprint(s)) stale.push("registry 指纹");
  if (stale.length) {
    console.error("拒绝收编：提案已 stale（" + stale.join(" / ") + "）。");
    console.error("  理由：人批准的是此刻的 diff；目标一变，他批的就是一个已经不存在的东西。请重新 propose。");
    process.exit(2);
  }

  if (String(pr.author || "").indexOf("agent") === 0 && by === "agent") {
    console.error("拒绝收编：批准者不得是提案作者（LLM 自评不可信）。");
    process.exit(2);
  }

  const reads = readsOf(p, name);
  if (!reads.some(function (r) { return r.package === h; })) {
    console.error("拒绝收编：没有匹配当前包哈希的读记录。先跑 skillctl self " + name + "——读过才有写权。");
    process.exit(2);
  }

  const probs = checkTarget(p, reg, name);
  if (probs.length) {
    console.error("拒绝收编：check 未通过（" + probs.length + " 项）：");
    for (const m of probs) console.error("  - " + m);
    process.exit(2);
  }

  s.version = (s.version || 1) + 1;
  s.updated = today();
  s.packageHash = "pending:" + pr.id;
  s.changelog = s.changelog || [];
  s.changelog.push({ version: s.version, at: today(), by: by, entry: pr.id, what: why.slice(0, 160) });
  pr.state = "merged";
  pr.decidedAt = nowIso();
  pr.decidedBy = by;
  pr.why = why;
  rewriteEntry(p, name, pr);
  saveRegistry(p, reg);
  console.log("已收编：" + name + " → version " + s.version + "（提案 " + pr.id + "）");
  console.log("  现在应用正文改动，然后跑 skillctl sync " + name + " 把整包哈希落回 registry。");
}

function cmdReject(p, reg, args) {
  const name = args[0];
  const why = argVal(args, "--why");
  if (!name) fail("reject 需要 <name> --why 理由");
  if (!why) fail("reject 必须给理由——被否决的理由是最贵的负向知识。");
  const open = allEntries(p).filter(function (e) {
    return e.kind === "提案" && e.state === "open" && e.scope === name;
  });
  if (!open.length) fail("没有未结提案：reject " + name);
  const pr = open[0];
  pr.state = "rejected";
  pr.why = why;
  pr.decidedAt = nowIso();
  pr.decidedBy = argVal(args, "--by") || "user";
  rewriteEntry(p, name, pr);
  console.log("已否决：" + name + "（" + pr.id + "）\n理由已留下：" + why);
}

function cmdSupersede(p, reg, args) {
  const id = args[0];
  const why = argVal(args, "--why");
  if (!id) fail("supersede 需要 <id> --why 理由");
  if (!why) fail("supersede 必须给理由：被取代的旧提案要说清为什么不再适用。");
  const e = findEntry(p, id);
  if (!e) fail("找不到条目：" + id);
  if (["merged", "rejected", "superseded", "archived"].indexOf(e.state) !== -1) {
    fail(id + " 已是 " + e.state + "，不能再取代。");
  }
  e.state = "superseded";
  e.why = why;
  e.decidedAt = nowIso();
  e.decidedBy = actor();
  rewriteEntry(p, e.scope, e);
  console.log("已取代：" + id + "（正文不变，状态改为 superseded）");
}

function cmdReview(p, reg, args) {
  const ids = args.filter(function (a) { return !a.startsWith("--"); });
  if (!ids.length) fail("review 需要条目 id（可多个）：把观察从 open 置为 reviewed。");
  for (const id of ids) {
    const e = findEntry(p, id);
    if (!e) fail("找不到条目：" + id);
    if (e.kind !== "观察") fail(id + " 不是观察条目。");
    e.state = "reviewed";
    e.reviewedAt = nowIso();
    rewriteEntry(p, e.scope, e);
    console.log("已评估：" + id);
  }
}

function cmdStale(p, reg) {
  const open = allEntries(p).filter(function (e) { return e.kind === "提案" && e.state === "open"; });
  if (!open.length) { console.log("无未结提案。"); return; }
  for (const e of open) {
    const s = findSkill(reg, e.scope);
    if (!s) { console.log(e.id + " → " + e.scope + "：目标已消失（stale）"); continue; }
    const h = packageHash(skillDirOf(p, s));
    const bad = !e.pin || e.pin.package !== h || e.pin.version !== s.version;
    console.log(e.id + " → " + e.scope + (bad ? "：STALE（目标在立提案后变过）" : "：fresh"));
  }
}


/* ------------------------------------------------------------------ 扫·检查 */

function diskSkills(p) {
  if (!fs.existsSync(p.skillsRoot)) return [];
  return fs.readdirSync(p.skillsRoot).filter(function (d) {
    if (d.startsWith(".")) return false;
    const full = path.join(p.skillsRoot, d);
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "SKILL.md"));
  });
}

function refFileList(dir) {
  const refs = path.join(dir, "references");
  if (!fs.existsSync(refs)) return [];
  return walkFiles(refs, "references", []).filter(function (f) { return f.endsWith(".md"); });
}

function mentionsOf(text) {
  const out = [];
  const re = /(?:\.\/)?references\/[A-Za-z0-9_.\-\/]+\.md/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const p = m[0].replace(/^\.\//, "");
    if (/^references\/(x|<[^>]*>|\.\.\.)\.md$/.test(p)) continue; // 文档里的占位示例，不是边
    out.push(p);
  }
  return out;
}

function graphCheck(p, s) {
  const probs = [], warns = [];
  const dir = skillDirOf(p, s);
  const files = refFileList(dir);
  if (!files.length) return { problems: probs, warnings: warns };
  const allMd = ["SKILL.md"].concat(files);
  const edges = {};
  const mentioned = {};
  for (const f of allMd) {
    const full = path.join(dir, f);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, "utf8");
    const ms = mentionsOf(text).filter(function (x) { return x !== f; });
    edges[f] = Array.from(new Set(ms));
    for (const t of edges[f]) {
      if (!mentioned[t]) mentioned[t] = [];
      mentioned[t].push(f);
    }
  }
  for (const f of Object.keys(edges)) {
    for (const t of edges[f]) {
      if (!fs.existsSync(path.join(dir, t))) probs.push("指针指向不存在的文件：" + f + " → " + t);
    }
  }
  for (const f of files) {
    if (!mentioned[f]) probs.push("孤儿引用（没人指到＝永远到不了）：" + f);
  }
  // 深度：从 SKILL.md 出发的 BFS（只算 references 图）
  const depth = { "SKILL.md": 0 };
  const queue = ["SKILL.md"];
  const seen = {};
  while (queue.length) {
    const cur = queue.shift();
    if (seen[cur]) continue;
    seen[cur] = true;
    for (const t of (edges[cur] || [])) {
      if (depth[t] === undefined) depth[t] = depth[cur] + 1;
      queue.push(t);
    }
  }
  for (const f of Object.keys(depth)) {
    if (depth[f] > 3) warns.push("深度超过 3 跳：" + f + "（" + depth[f] + "）");
  }
  // 环：DFS 三色
  const color = {};
  function dfs(node, stack) {
    color[node] = 1;
    for (const t of (edges[node] || [])) {
      if (color[t] === 1) {
        probs.push("引用成环：" + stack.concat([t]).join(" → "));
      } else if (!color[t]) {
        dfs(t, stack.concat([t]));
      }
    }
    color[node] = 2;
  }
  for (const f of Object.keys(edges)) if (!color[f]) dfs(f, [f]);
  return { problems: probs, warnings: warns };
}

function check(p, reg) {
  const problems = [], warnings = [];
  function P(msg, scope) { problems.push({ m: msg, scope: scope || null }); }
  function W(msg, scope) { warnings.push({ m: msg, scope: scope || null }); }

  const names = {};
  for (const s of reg.skills) {
    if (names[s.name]) P("registry：重复条目 " + s.name, s.name);
    names[s.name] = true;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.name)) P("name 不是 kebab-case：" + s.name, s.name);
    if (["project", "global", "meta"].indexOf(s.tier) === -1) P("tier 越界：" + s.tier, s.name);
    if (["draft", "active", "superseded", "archived"].indexOf(s.status) === -1) P("status 越界：" + s.status, s.name);
    if (["none", "text", "runtime"].indexOf(s.enforces) === -1) P("enforces 越界：" + s.enforces, s.name);
    if (["user", "agent", "user-gated"].indexOf(s.write) === -1) P("write 越界：" + s.write, s.name);
    if (s.scope === "project") P("scope: project 不应进全局 registry", s.name);
    const dir = skillDirOf(p, s);
    const file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) { P("registry 有条目但磁盘无 SKILL.md", s.name); continue; }
    const fm = readFrontmatter(file);
    if (fm.name !== s.name) P("frontmatter name（" + fm.name + "）≠ registry name（" + s.name + "）", s.name);
    if (!fm.description) P("description 为空", s.name);
    else if (fm.description.length > 500) P("description 超长：" + fm.description.length + " > 500", s.name);
    const ph = packageHash(dir);
    if (!s.packageHash) W("registry 缺 packageHash（跑 sync）", s.name);
    else if (String(s.packageHash).indexOf("pending:") === 0) W("有未 sync 的合并：" + s.packageHash + "（应用改动后跑 sync）", s.name);
    else if (s.packageHash !== ph) P("包已变但 registry 未 sync（改了本体/references/scripts）", s.name);
    for (const k of ["mergedFrom", "supersedes", "supersededBy"]) {
      const v = (s.lineage || {})[k] || [];
      for (const r of v) if (!findSkill(reg, r)) P("lineage." + k + " 指向不存在的条目：" + r, s.name);
    }
    const g = graphCheck(p, s);
    for (const m of g.problems) P(m, s.name);
    for (const m of g.warnings) W(m, s.name);
  }
  for (const d of diskSkills(p)) if (!names[d]) P("裸 skill（磁盘有、registry 无）：" + d, d);

  const all = allEntries(p);
  const ids = {};
  for (const e of all) {
    if (ids[e.id]) P("沿革 id 重复：" + e.id, e.scope);
    ids[e.id] = true;
    if (KINDS.indexOf(e.kind) === -1) P("沿革 " + e.id + "：kind 越界 " + e.kind, e.scope);
    if (STATES.indexOf(e.state) === -1) P("沿革 " + e.id + "：state 越界 " + e.state, e.scope);
    for (const c of (e.cause || [])) if (CAUSES.indexOf(c) === -1) P("沿革 " + e.id + "：cause 越界 " + c, e.scope);
    if (e.kind === "观察" && !e.legacy && TYPES.indexOf(e.type) === -1) P("沿革 " + e.id + "：type 越界或缺失（" + e.type + "）", e.scope);
    if (!e.by) P("沿革 " + e.id + "：缺 by（谁写的）", e.scope);
    if (e.kind === "观察" && !e.legacy && !e.grandfathered && (!e.sessions || !e.sessions.length)) P("沿革 " + e.id + "：缺会话指针", e.scope);
    for (const pt of (e.sessions || [])) {
      if (!pt || !pt.session) P("沿革 " + e.id + "：指针缺 session", e.scope);
      else if (!(pt.seq && pt.seq.length) && !pt.anchor) P("沿革 " + e.id + "：指针不可定位（seq 与 anchor 至少一个）", e.scope);
    }
    const m = /-([0-9a-f]{8})\.md$/.exec(path.basename(e.file));
    if (m) {
      const body = canonBody(e.body);
      if (sha256(body).slice(0, 8) !== m[1]) P("沿革 " + e.id + "：正文被改过（文件名哈希不符）", e.scope);
    }
    if (e.kind === "提案" && e.state === "open") {
      const s = findSkill(reg, e.scope);
      if (!s) P("未结提案指向不存在的技能：" + e.id, e.scope);
      else {
        const h = packageHash(skillDirOf(p, s));
        if (!e.pin || e.pin.package !== h || e.pin.version !== s.version) P("未结提案已 stale：" + e.id, e.scope);
      }
    }
  }
  for (const e of all) {
    for (const id of (e.evidence || [])) if (!ids[id]) P("沿革 " + e.id + "：evidence 指向不存在的条目 " + id, e.scope);
  }
  return { problems: problems, warnings: warnings, entries: all };
}

function checkTarget(p, reg, name) {
  const r = check(p, reg);
  return r.problems.filter(function (x) { return x.scope === name; }).map(function (x) { return x.m; });
}

function cmdCheck(p, reg) {
  const r = check(p, reg);
  console.log("skillctl " + ENGINE_VERSION + " · registry " + (reg.conformsTo || "?") + " · 条目 " + r.entries.length);
  if (r.problems.length) {
    console.log("\n问题（" + r.problems.length + "）：");
    for (const x of r.problems) console.log("  x " + (x.scope ? "[" + x.scope + "] " : "") + x.m);
  }
  if (r.warnings.length) {
    console.log("\n警告（" + r.warnings.length + "）：");
    for (const x of r.warnings) console.log("  ! " + (x.scope ? "[" + x.scope + "] " : "") + x.m);
  }
  if (!r.problems.length) console.log("\ncheck 通过" + (r.warnings.length ? "（有警告）" : "") + "。");
  else console.log("\ncheck 只报不改。修完再跑一次。");
  if (r.problems.length) process.exit(2);
}

function cmdView(p, reg, args) {
  const all = allEntries(p);
  const byState = {}, byType = {}, byScope = {}, byCause = {};
  for (const e of all) {
    byState[e.state] = (byState[e.state] || 0) + 1;
    if (e.type) byType[e.type] = (byType[e.type] || 0) + 1;
    byScope[e.scope] = (byScope[e.scope] || 0) + 1;
    for (const c of (e.cause || [])) byCause[c] = (byCause[c] || 0) + 1;
  }
  console.log("沿革 " + all.length + " 条 · 状态 " + JSON.stringify(byState));
  console.log("按 scope：" + Object.entries(byScope).sort(function (a, b) { return b[1] - a[1]; })
    .map(function (x) { return x[0] + "=" + x[1]; }).join("  "));
  console.log("按 cause：" + Object.entries(byCause).map(function (x) { return x[0] + "=" + x[1]; }).join("  "));
  const repeats = all.filter(function (e) { return e.repeatOf; });
  console.log("复发（repeatOf）" + repeats.length + " 条：" + repeats.map(function (e) { return e.id + "→" + e.repeatOf; }).join(" "));
  const open = all.filter(function (e) { return e.kind === "提案" && e.state === "open"; });
  console.log("未结提案 " + open.length + "：" + open.map(function (e) { return e.id + "→" + e.scope; }).join(" "));
  const orphans = all.filter(function (e) { return !e.scope || (e.scope !== NO_SCOPE && !findSkill(reg, e.scope)); });
  console.log("孤儿（无主或指向已消失的技能）" + orphans.length + "：" + orphans.map(function (e) { return e.id; }).join(" "));
  console.log("\n每技能的领取次数（分母：收敛 vs 休眠）：");
  for (const s of reg.skills) {
    const reads = readsOf(p, s.name);
    const mine = all.filter(function (e) { return e.scope === s.name; });
    const openObs = mine.filter(function (e) { return e.kind === "观察" && e.state === "open"; }).length;
    console.log("  " + s.name + "：读 " + reads.filter(function (r) { return !r.what; }).length +
      " · 沿革 " + mine.length + " · 待评估 " + openObs + " · v" + s.version);
  }
  for (const t of TYPES) {
    if ((byType[t] || 0) >= 2) console.log("  [复发类] " + t + "：" + byType[t] + " 次 → 按 §2 该考虑下沉到机器层");
  }
}


/* ------------------------------------------------------- 登记与巡检 */

function cmdInit(p) {
  for (const d of [p.skillsRoot, p.evoDir, p.historyDir, p.legacyDir, p.scaffoldDir, p.archiveDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (fs.existsSync(p.registryPath)) {
    console.log("registry 已存在，未改动：" + p.registryPath);
    return;
  }
  saveRegistry(p, { conformsTo: REGISTRY_SCHEMA, updated: today(), skills: [] });
  console.log("已初始化 registry：" + p.registryPath);
}

function cmdList(p, reg, args) {
  const tier = argVal(args, "--tier");
  const status = argVal(args, "--status");
  let list = reg.skills.filter(function (s) { return s.status !== "archived"; });
  if (tier) list = list.filter(function (s) { return s.tier === tier; });
  if (status) list = list.filter(function (s) { return s.status === status; });
  for (const s of list) {
    const fm = readFrontmatter(path.join(skillDirOf(p, s), "SKILL.md"));
    console.log((s.tier + "        ").slice(0, 10) + (s.name + "                    ").slice(0, 22) +
      "v" + s.version + "  " + s.status + "  " + (s.write || "?"));
    if (fm && fm.description) console.log("           " + fm.description.slice(0, 90));
  }
}

function cmdShow(p, reg, args) {
  const name = args[0];
  if (!name) fail("show 需要 <name>");
  const s = findSkill(reg, name);
  if (!s) fail("registry 里没有 " + name);
  const fm = readFrontmatter(path.join(skillDirOf(p, s), "SKILL.md"));
  console.log(JSON.stringify(s, null, 2));
  if (fm) console.log("\nfrontmatter.description:\n  " + fm.description);
  const entries = listEntries(p, name);
  const open = entries.filter(function (e) { return e.state === "open"; });
  console.log("\n沿革 " + entries.length + " 条 · 未结 " + open.length);
  for (const e of entries.slice(-3)) printEntry(e, false);
}

function cmdAdd(p, reg, args) {
  const name = args[0];
  if (!name) fail("add 需要 <name>");
  const reads = readsOf(p, "skill-evolution");
  if (!reads.some(function (r) { return r.what === "train:authoring"; })) {
    fail("诞生新技能之前先领培训包：skillctl train authoring。\n" +
      "  这是岗位资格，不是建议——没领过作者培训，add 会拒。");
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) fail("name 必须是 kebab-case");
  if (findSkill(reg, name)) fail("registry 已有 " + name);
  const tier = argVal(args, "--tier") || "global";
  const s = {
    name: name, tier: tier, scope: "durable", status: "draft", version: 1,
    enforces: "text", write: "user", path: name, bornFrom: "friction",
    provenance: "", lineage: { mergedFrom: [], supersedes: [], supersededBy: [] },
    deliver: "", usage: { lastUsedAt: today(), skips: 0, openIssues: [] },
    packageHash: null, changelog: [{ version: 1, at: today(), by: actor(), what: "建档" }],
    updated: today(),
  };
  reg.skills.push(s);
  const dir = path.join(p.scaffoldDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const sk = path.join(dir, "SKILL.md");
  if (!fs.existsSync(sk)) {
    fs.writeFileSync(sk, "---\nname: " + name + "\ndescription: （待写：我覆盖什么、什么症状该查我）\n---\n\n# " + name + "\n\n（正文：怎么做。渐进披露：references/ 里按处境分岔，正文指路。）\n", "utf8");
  }
  saveRegistry(p, reg);
  console.log("已建档：" + name + "（draft，落在 scaffold/" + name + "/）");
}

function cmdSet(p, reg, args) {
  const name = args[0];
  if (!name) fail("set 需要 <name> k=v ...");
  const s = findSkill(reg, name);
  if (!s) fail("registry 里没有 " + name);
  const pairs = args.slice(1).filter(function (a) { return a.indexOf("=") !== -1 || a.indexOf("+") !== -1; });
  if (!pairs.length) fail("set 需要至少一个 k=v");
  for (const pair of pairs) {
    if (pair === "skips+1") { s.usage = s.usage || {}; s.usage.skips = (s.usage.skips || 0) + 1; continue; }
    if (pair.indexOf("openIssues+=") === 0) {
      s.usage = s.usage || {};
      s.usage.openIssues = s.usage.openIssues || [];
      s.usage.openIssues.push(pair.slice("openIssues+=".length));
      continue;
    }
    const i = pair.indexOf("=");
    if (i === -1) fail("无法解析：" + pair);
    const k = pair.slice(0, i);
    let v = pair.slice(i + 1);
    if (v === "true") v = true; else if (v === "false") v = false;
    else if (/^\d+$/.test(v)) v = Number(v);
    if (k === "openIssues") v = String(v).split("|");
    s[k] = v;
  }
  s.updated = today();
  saveRegistry(p, reg);
  console.log("已更新：" + name);
}

function cmdPromote(p, reg, args) {
  const name = args[0];
  const tier = args[1];
  if (!name || !tier) fail("promote 需要 <name> <project|global|meta>");
  if (["project", "global", "meta"].indexOf(tier) === -1) fail("tier 越界：" + tier);
  const s = findSkill(reg, name);
  if (!s) fail("registry 里没有 " + name);
  s.tier = tier;
  const en = argVal(args, "--enforces");
  if (en) s.enforces = en;
  s.updated = today();
  saveRegistry(p, reg);
  console.log("已移层：" + name + " → " + tier + (en ? "（enforces " + en + "）" : ""));
}

function cmdSync(p, reg, args) {
  const name = args[0];
  if (!name) fail("sync 需要 <name>：把整包当前哈希落回 registry（merge 并应用改动之后跑）。");
  const s = findSkill(reg, name);
  if (!s) fail("registry 里没有 " + name);
  const h = packageHash(skillDirOf(p, s));
  s.packageHash = h;
  s.updated = today();
  saveRegistry(p, reg);
  console.log("已同步：" + name + " · package " + String(h).slice(0, 12));
}

function cmdRender(p, reg) {
  const lines = ["# .evolution/catalog.md（投影，可删可重建）", "",
    "> 由 skillctl render 从 registry + SKILL.md frontmatter 生成。别手改。", ""];
  for (const s of reg.skills) {
    const fm = readFrontmatter(path.join(skillDirOf(p, s), "SKILL.md"));
    lines.push("## " + s.name + "（" + s.tier + " · v" + s.version + " · " + s.status + "）");
    lines.push("");
    lines.push(fm && fm.description ? fm.description : "（无 description）");
    lines.push("");
  }
  fs.writeFileSync(p.catalogPath, lines.join("\n"), "utf8");
  console.log("已生成 " + p.catalogPath);
}

function cmdRoundtrip(p, reg) {
  const a = JSON.stringify(reg);
  const back = parseYaml(dumpYaml(reg));
  const b = JSON.stringify(back);
  if (a !== b) {
    console.error("roundtrip 失败：registry 读写往返有损。");
    process.exit(2);
  }
  console.log("roundtrip 通过：registry 读写无损。");
}


/* ------------------------------------------------------------- 迁移 v15 */

const MIGRATE_MAP = {
  f88:  { scope: "skill-evolution", cause: ["model"],               type: "未经对账的断言" },
  f89:  { scope: "skill-evolution", cause: ["model", "harness"],    type: "验证工具本身没验" },
  f90:  { scope: "skill-evolution", cause: ["model"],               type: "未经对账的断言" },
  f91:  { scope: "skill-evolution", cause: ["agent-class"],         type: "未经对账的断言" },
  f92:  { scope: "skill-evolution", cause: ["model"],               type: "定位误判" },
  f93:  { scope: "skill-evolution", cause: ["model"],               type: "交付形态未适配读者" },
  f94:  { scope: "skill-evolution", cause: ["model"],               type: "定位误判" },
  f95:  { scope: "skill-evolution", cause: ["model"],               type: "验证工具本身没验" },
  f96:  { scope: "skill-evolution", cause: ["model"],               type: "验证工具本身没验" },
  f97:  { scope: "wechat-messages", cause: ["harness"],             type: "本机工具约定" },
  f98:  { scope: "wechat-messages", cause: ["harness"],             type: "本机工具约定" },
  f99:  { scope: "wechat-messages", cause: ["task"],                type: "定位误判" },
  f100: { scope: "无归属",          cause: ["agent-class"],         type: "顺序做反" },
  f101: { scope: "无归属",          cause: ["model"],               type: "顺序做反" },
  f102: { scope: "skill-evolution", cause: ["agent-class"],         type: "定位误判" },
  f103: { scope: "无归属",          cause: ["model"],               type: "定位误判" },
  f104: { scope: "skill-evolution", cause: ["agent-class"],         type: "顺序做反" },
  f105: { scope: "skill-evolution", cause: ["harness"],             type: "本机工具约定" },
  f106: { scope: "skill-evolution", cause: ["harness", "model"],    type: "本机工具约定" },
  f107: { scope: "skill-evolution", cause: ["agent-class"],         type: "顺序做反" },
};

function pkgForScope(scope) { return scope === NO_SCOPE ? "_unowned" : scope; }

function cmdMigrate(p, reg) {
  const bak = path.join(p.legacyDir, "backup-v15");
  fs.mkdirSync(bak, { recursive: true });
  for (const f of ["friction.jsonl", "friction-reviewed.md", "registry.yaml"]) {
    const src = path.join(p.evoDir, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(bak, f));
  }
  const pj = path.join(p.evoDir, "proposals");
  if (fs.existsSync(pj)) fs.cpSync(pj, path.join(bak, "proposals"), { recursive: true });

  let n = 0;
  const fj = path.join(p.evoDir, "friction.jsonl");
  if (fs.existsSync(fj)) {
    const rows = fs.readFileSync(fj, "utf8").split("\n").filter(Boolean).map(function (l) { return JSON.parse(l); });
    for (const r of rows) {
      const mp = MIGRATE_MAP[r.id] || { scope: "无归属", cause: ["model"], type: "定位误判" };
      const e = {
        id: r.id,
        at: r.at,
        kind: "观察",
        scope: mp.scope,
        cause: mp.cause,
        type: mp.type,
        legacyType: r.type || null,
        state: r.reviewedAt ? "reviewed" : "open",
        by: "agent:legacy",
        repeatOf: r.repeatOf || null,
        sessions: r.sessions || [],
        evidence: [],
        legacy: false,
        grandfathered: !!r.grandfathered,
        body: "**事实**：" + r.what + "\n\n**那一眼**：" + r.lesson + "\n",
      };
      writeEntry(p, pkgForScope(mp.scope), e);
      n++;
    }
  }

  let pi = 0;
  const hist = reg.proposalsHistory || [];
  for (const pr of hist) {
    pi++;
    const st = pr.status === "accepted" ? "merged" : pr.status;
    const e = {
      id: "p" + pi,
      at: pr.openedAt ? pr.openedAt + "T00:00:00+08:00" : nowIso(),
      kind: "提案",
      scope: pr.name,
      cause: ["agent-class"],
      type: null,
      state: ["merged", "rejected", "superseded"].indexOf(st) === -1 ? "open" : st,
      by: pr.by || "agent",
      author: pr.by || "agent",
      why: pr.why || "",
      decidedAt: pr.decidedAt || null,
      decidedBy: pr.decidedBy || null,
      evidence: [],
      sessions: [],
      legacy: false,
      body: "**决定**：" + (pr.note || "（原件见 _legacy/proposals/）") + "\n\n**理由**：" + (pr.why || "（旧 schema 未记录）") + "\n",
    };
    writeEntry(p, pr.name, e);
  }

  // v15 自己的决策条目（本次升级不是"偷偷改"，它有一条可核对的沿革）
  pi++;
  const decision = {
    id: "p" + pi,
    at: nowIso(),
    kind: "提案",
    scope: "skill-evolution",
    cause: ["user", "agent-class"],
    type: null,
    state: "merged",
    by: "agent",
    author: "agent",
    why: "用户 2026-10-30 批：把已定稿的设计全部落地——沿革包（两条道）、分类三维、资格门、分发图（边/节点/根/深度）、作者培训进 references/。",
    decidedAt: nowIso(),
    decidedBy: "user",
    evidence: [],
    sessions: [],
    legacy: false,
    body: "v14 → v15。核心变化：观察与提案统一为沿革条目（一条一 md，正文不可变）；" +
      "摩擦账本退役为 _legacy/；改技能前必须 self（留读记录）；造技能前必须 train authoring；" +
      "check 卡在 merge 路径上；提案钉整包哈希。设计来源：DESIGN.md v1.5 + 本次原始对话（discussions/2026-10-30-技能分发图-原始对话.md）。\n",
  };
  writeEntry(p, "skill-evolution", decision);

  // 退役旧账本
  for (const f of ["friction.jsonl", "friction-reviewed.md"]) {
    const src = path.join(p.evoDir, f);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(p.legacyDir, f));
  }
  if (pj && fs.existsSync(pj)) fs.renameSync(pj, path.join(p.legacyDir, "proposals"));

  // registry：去掉提案字段，补 packageHash，记 v15
  delete reg.proposals;
  delete reg.proposalsHistory;
  for (const s of reg.skills) {
    s.packageHash = packageHash(skillDirOf(p, s));
    s.updated = s.updated || today();
  }
  const se = findSkill(reg, "skill-evolution");
  if (se) {
    se.version = 15;
    se.updated = today();
    se.changelog = se.changelog || [];
    se.changelog.push({ version: 15, at: today(), by: "user", entry: decision.id, what: "v15：两条道 + 分类三维 + 资格门 + 分发图" });
  }
  saveRegistry(p, reg);
  console.log("迁移完成：摩擦 " + n + " 条 → 沿革条目；提案史 " + hist.length + " 条 → 条目；旧账本移入 _legacy/。");
  console.log("备份： " + bak);
}


/* ------------------------------------------------------------------ help */

function help() {
  console.log("skillctl —— skill-evolution 的手（不是脑）。engine " + ENGINE_VERSION + " / registry " + REGISTRY_SCHEMA);
  console.log("");
  console.log("五个动作：");
  console.log("  记  note --what 事实 --lesson 那一眼 --scope <技能|无归属> --cause <5值> --type <枚举> [--seq a-b] [--anchor 原文]");
  console.log("  读  self <name>        整份读入本体＋沿革，并写读记录（读过才有写权）");
  console.log("      train authoring    领取作者培训包（造技能前的岗位资格）");
  console.log("  提  propose <name> --why 理由 [--note 正文] [--evidence f88,f91]");
  console.log("      supersede <id> --why 理由");
  console.log("  批  merge <name> --why 理由 [--by user|agent]   校验 fresh / 读记录 / check / 批准者≠作者");
  console.log("      reject <name> --why 理由");
  console.log("  扫  view                分布、复发、孤儿、未结提案、领取次数（分母）");
  console.log("      check               格式门（registry + 沿革 + 引用图），只报不改；退出码 2");
  console.log("");
  console.log("登记与巡检：init / list / show <name> / add <name> / set <name> k=v / promote <name> <tier>");
  console.log("           sync <name>（merge 并应用改动后，把整包哈希落回 registry）/ render / roundtrip / stale / review <id…>");
  console.log("");
  console.log("别名：friction add → note；friction list → view；friction clear → review；accept → merge；lint → check；report → view");
  console.log("");
  console.log("三条承重规则：");
  console.log("  · 提案钉在它所提议的那个状态上（整包哈希）——目标一改，提案即 stale。");
  console.log("  · 来源是声明的，不是推断的——write: user 只能提案，不能直接改。");
  console.log("  · 读过才有写权——没领过，只能读、只能提。");
}

/* ------------------------------------------------------------------ main */

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = argv.slice(1);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return help();
  const p = locate();
  if (cmd === "init") return cmdInit(p);
  const reg = loadRegistry(p);

  switch (cmd) {
    case "note": return cmdNote(p, reg, args);
    case "friction": {
      const sub = args[0];
      if (sub === "add") return cmdNote(p, reg, args.slice(1));
      if (sub === "list") return cmdView(p, reg, args.slice(1));
      if (sub === "clear") return cmdReview(p, reg, args.slice(1));
      return fail("friction 只剩 add/list/clear 三个别名；新面见 note / view / review。");
    }
    case "self": return cmdSelf(p, reg, args);
    case "train": return cmdTrain(p, reg, args);
    case "propose": return cmdPropose(p, reg, args);
    case "supersede": return cmdSupersede(p, reg, args);
    case "merge": return cmdMerge(p, reg, args);
    case "accept": return cmdMerge(p, reg, args);
    case "reject": return cmdReject(p, reg, args);
    case "review": return cmdReview(p, reg, args);
    case "stale": return cmdStale(p, reg);
    case "check": return cmdCheck(p, reg);
    case "lint": return cmdCheck(p, reg);
    case "view": return cmdView(p, reg, args);
    case "report": return cmdView(p, reg, args);
    case "list": return cmdList(p, reg, args);
    case "show": return cmdShow(p, reg, args);
    case "add": return cmdAdd(p, reg, args);
    case "set": return cmdSet(p, reg, args);
    case "promote": return cmdPromote(p, reg, args);
    case "sync": return cmdSync(p, reg, args);
    case "render": return cmdRender(p, reg);
    case "roundtrip": return cmdRoundtrip(p, reg);
    case "migrate-v15": return cmdMigrate(p, reg);
    default:
      console.error('skillctl: 未知命令 "' + cmd + '"');
      help();
      process.exit(1);
  }
}

main();
