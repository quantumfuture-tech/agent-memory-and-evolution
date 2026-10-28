"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "skillctl.js");
const REGISTRY = path.join("skills", ".evolution", "registry.yaml");

/** 每个测试一个临时 DSH_HOME；测试结束即删。测试进程绝不会指向真实 registry。 */
function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-skills-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

/** 统一入口：只通过 CLI 与磁盘交互，不 require 引擎（引擎在 require 时会直接跑 main）。 */
function run(home, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
  });
}

function ok(home, args) {
  const r = run(home, args);
  assert.equal(r.status, 0, "命令失败：skillctl " + args.join(" ") + "\nstdout:\n" + r.stdout + "\nstderr:\n" + r.stderr);
  return r;
}

function init(home) {
  return ok(home, ["init"]);
}

function add(home, name) {
  return ok(home, ["add", name || "demo-skill"]);
}

/** add 把草稿放在 scaffold/；提案只对 live SKILL.md 计算目标哈希，所以先搬到 skills/<name>/。 */
function activate(home, name) {
  const dir = name || "demo-skill";
  const from = path.join(home, "skills", ".evolution", "scaffold", dir);
  const to = path.join(home, "skills", dir);
  fs.renameSync(from, to);
  return to;
}

function registryText(home) {
  return fs.readFileSync(path.join(home, REGISTRY), "utf8");
}

function proposalPath(home, name) {
  return path.join(home, "skills", ".evolution", "proposals", (name || "demo-skill") + ".md");
}

test("init 建立目录与空 registry，且重复执行不覆盖已有内容", (t) => {
  const home = makeHome(t);
  const first = init(home);

  assert.match(first.stdout, /已初始化 registry/);
  for (const dir of ["skills", "skills/.evolution", "skills/.evolution/proposals", "skills/.evolution/scaffold", "skills/.evolution/archive"]) {
    assert.ok(fs.existsSync(path.join(home, dir)), "缺少目录：" + dir);
  }
  const text = registryText(home);
  assert.match(text, /^conformsTo: skill-evo-v3$/m);
  assert.match(text, /^skills: \[\]$/m);
  assert.match(text, /^proposals: \[\]$/m);
  assert.match(text, /^proposalsHistory: \[\]$/m);
  assert.match(text, /^updated: \d{4}-\d{2}-\d{2}$/m);

  const before = { text, mtimeMs: fs.statSync(path.join(home, REGISTRY)).mtimeMs };
  const second = init(home);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /registry 已存在，未改动/);
  assert.equal(registryText(home), before.text);
  assert.equal(fs.statSync(path.join(home, REGISTRY)).mtimeMs, before.mtimeMs);
});

test("a. add 建档后 list 与 show 都能读到", (t) => {
  const home = makeHome(t);
  init(home);
  const added = add(home, "demo-skill");
  assert.match(added.stdout, /已建档（draft）：demo-skill/);

  const listed = ok(home, ["list"]);
  assert.match(listed.stdout, /demo-skill/);
  assert.match(listed.stdout, /draft/);

  const shown = ok(home, ["show", "demo-skill"]);
  assert.match(shown.stdout, /name\s+demo-skill/);
  assert.match(shown.stdout, /status\s+draft\s+version 1/);
  assert.match(shown.stdout, /草稿在/);
});

test("b. propose 钉住目标哈希；目标改动后 stale；accept 过期提案被拒", (t) => {
  const home = makeHome(t);
  init(home);
  add(home, "demo-skill");
  const live = activate(home, "demo-skill");

  const proposed = ok(home, ["propose", "demo-skill", "--note", "补一个可验证的说明"]);
  assert.match(proposed.stdout, /已立提案/);
  assert.match(proposed.stdout, /skill sha256 [0-9a-f]{12}/);

  const proposal = fs.readFileSync(proposalPath(home, "demo-skill"), "utf8");
  assert.match(proposal, /^targetSkillHash: [0-9a-f]{64}$/m);
  assert.match(proposal, /^targetRegistryHash: [0-9a-f]{64}$/m);
  assert.match(proposal, /^basedOnVersion: 1$/m);
  assert.match(proposal, /^status: open$/m);

  const fresh = ok(home, ["stale"]);
  assert.match(fresh.stdout, /fresh（可批）/);

  fs.appendFileSync(path.join(live, "SKILL.md"), "\n这一行改变了目标内容。\n", "utf8");
  const stale = ok(home, ["stale"]);
  assert.match(stale.stdout, /STALE（SKILL.md 已变）/);

  const refused = run(home, ["accept", "demo-skill"]);
  assert.equal(refused.status, 2, "过期提案必须非 0 退出");
  assert.match(refused.stderr, /拒绝收编：提案已 stale/);
  const after = registryText(home);
  assert.match(after, /^  - name: demo-skill$/m);
  assert.match(after, /^    status: open$/m);
});

test("c. accept 新鲜提案成功，并写入 proposalsHistory", (t) => {
  const home = makeHome(t);
  init(home);
  add(home, "demo-skill");
  activate(home, "demo-skill");
  ok(home, ["propose", "demo-skill", "--note", "把说明补完整"]);

  const accepted = ok(home, ["accept", "demo-skill", "--by", "user"]);
  assert.match(accepted.stdout, /已收编：demo-skill → version 2/);

  const text = registryText(home);
  assert.match(text, /^proposals: \[\]$/m);
  assert.match(text, /^proposalsHistory:$/m);
  assert.match(text, /status: accepted/);
  assert.match(text, /decidedBy: user/);

  const shown = ok(home, ["show", "demo-skill"]);
  assert.match(shown.stdout, /status\s+draft\s+version 2/);
  assert.match(shown.stdout, /提案历史 proposalsHistory \(1\)/);
  assert.match(shown.stdout, /accepted/);

  const proposal = fs.readFileSync(proposalPath(home, "demo-skill"), "utf8");
  assert.match(proposal, /^status: accepted$/m);
});

test("d. reject 必须带理由，理由写进历史并保留在提案文件里", (t) => {
  const home = makeHome(t);
  init(home);
  add(home, "demo-skill");
  activate(home, "demo-skill");
  ok(home, ["propose", "demo-skill", "--note", "试一试"]);

  const noWhy = run(home, ["reject", "demo-skill"]);
  assert.equal(noWhy.status, 1);
  assert.match(noWhy.stderr, /reject 必须给理由/);
  assert.match(fs.readFileSync(proposalPath(home, "demo-skill"), "utf8"), /^status: open$/m);

  const why = "离线场景没有覆盖，先不改";
  const rejected = ok(home, ["reject", "demo-skill", "--why", why]);
  assert.match(rejected.stdout, /理由已留下/);

  const text = registryText(home);
  assert.match(text, /status: rejected/);
  assert.ok(text.includes(why), "registry 历史里应保留否决理由");
  assert.match(text, /decidedAt: \d{4}-\d{2}-\d{2}/);
  assert.match(text, /decidedBy: user/);

  const proposal = fs.readFileSync(proposalPath(home, "demo-skill"), "utf8");
  assert.match(proposal, /^status: rejected$/m);
  assert.ok(proposal.includes(why), "提案文件里应保留否决理由");
});

test("e. write: user 的条目默认拒绝 set，带 --user 才允许", (t) => {
  const home = makeHome(t);
  init(home);
  add(home, "demo-skill");
  ok(home, ["set", "demo-skill", "write=user"]);

  const refused = run(home, ["set", "demo-skill", "status=active"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /write=user（人写的），agent 不得直接改其 status/);
  assert.match(registryText(home), /status: draft/);

  const allowed = ok(home, ["set", "demo-skill", "status=active", "--user"]);
  assert.match(allowed.stdout, /status/);
  assert.match(registryText(home), /status: active/);
});

test("f. friction 缺 lesson 被拒；list 可见；clear 后不再待评估", (t) => {
  const home = makeHome(t);
  init(home);

  const refused = run(home, ["friction", "add", "--what", "把解析失败当成文件损坏"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /必须同时给 --what/);
  assert.ok(!fs.existsSync(path.join(home, "skills", ".evolution", "friction.jsonl")));

  const fact = "把一次解析失败当成文件已损坏";
  const lesson = "断言它坏之前，验过原始字节吗？";
  const added = ok(home, ["friction", "add", "--what", fact, "--lesson", lesson, "--type", "误判"]);
  assert.match(added.stdout, /已记账：f1/);
  assert.match(added.stdout, /待评估 1 条/);

  const listed = ok(home, ["friction", "list"]);
  assert.ok(listed.stdout.includes(fact));
  assert.ok(listed.stdout.includes(lesson));
  assert.match(listed.stdout, /待评估 1 条/);

  const cleared = ok(home, ["friction", "clear", "--batch", "误判"]);
  assert.match(cleared.stdout, /已把 1 条移入归档/);

  const after = ok(home, ["friction", "list"]);
  assert.ok(!after.stdout.includes(fact), "已归档的事实不应再出现在待评估列表里");
  assert.match(after.stdout, /摩擦账本为空/);
  const archive = fs.readFileSync(path.join(home, "skills", ".evolution", "friction-reviewed.md"), "utf8");
  assert.ok(archive.includes(fact));
  assert.ok(archive.includes(lesson));
});

test("g. lint 在 registry 与磁盘不一致时报错并非 0 退出", (t) => {
  const home = makeHome(t);
  init(home);
  add(home, "demo-skill");
  fs.rmSync(path.join(home, "skills", ".evolution", "scaffold", "demo-skill"), { recursive: true, force: true });

  const lint = run(home, ["lint"]);
  assert.equal(lint.status, 2);
  assert.match(lint.stdout, /问题（1）/);
  assert.match(lint.stdout, /磁盘上无 demo-skill/);
  assert.match(lint.stdout, /SKILL\.md（悬空条目）/);
});

test("h. registry roundtrip 无损", (t) => {
  const home = makeHome(t);
  init(home);
  add(home, "demo-skill");
  ok(home, ["set", "demo-skill", "provenance=来自一次虚构的接入实验：a,b / c"]);
  ok(home, ["friction", "add", "--what", "测试往返", "--lesson", "先跑 roundtrip 再改 schema"]);

  const roundtrip = ok(home, ["roundtrip"]);
  assert.match(roundtrip.stdout, /往返无损/);
});

test("i. render 生成的 catalog 包含条目名", (t) => {
  const home = makeHome(t);
  init(home);
  add(home, "demo-skill");
  activate(home, "demo-skill");

  const rendered = ok(home, ["render"]);
  assert.match(rendered.stdout, /已写出目录预览/);
  const catalog = fs.readFileSync(path.join(home, "skills", ".evolution", "catalog.md"), "utf8");
  assert.match(catalog, /demo-skill/);
});

test("未知命令仍然非 0 退出（确保入口没有吞掉错误）", (t) => {
  const home = makeHome(t);
  init(home);
  const unknown = run(home, ["not-a-command"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /未知命令/);
});
