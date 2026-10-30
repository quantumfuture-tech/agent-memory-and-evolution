"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "skillctl.js");
const SKILL_SRC = path.resolve(__dirname, "..");
const REGISTRY = path.join("skills", ".evolution", "registry.yaml");
const HISTORY = path.join("skills", ".evolution", "history");

/** 每个用例一个临时 DSH_HOME；结束即删。测试进程绝不指向真实 registry。 */
function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-skills-test-"));
  t.after(function () { fs.rmSync(home, { recursive: true, force: true }); });
  // 把引擎自身放进 skills/，否则 train authoring / self 找不到培训包与本体
  const dest = path.join(home, "skills", "skill-evolution");
  fs.mkdirSync(dest, { recursive: true });
  for (const item of ["SKILL.md", "scripts", "references"]) {
    fs.cpSync(path.join(SKILL_SRC, item), path.join(dest, item), { recursive: true });
  }
  return home;
}

function run(home, args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), {
    cwd: home,
    env: Object.assign({}, process.env, { DSH_HOME: home, DSH_SESSION_ID: "session-test" }),
    encoding: "utf8",
  });
}

function ok(home, args) {
  const r = run(home, args);
  assert.equal(r.status, 0, "命令失败：skillctl " + args.join(" ") + "\nstdout:\n" + r.stdout + "\nstderr:\n" + r.stderr);
  return r;
}

function fail(home, args, code) {
  const r = run(home, args);
  assert.equal(r.status, code || 1, "期望退出码 " + (code || 1) + "，实际 " + r.status + "\nstdout:\n" + r.stdout + "\nstderr:\n" + r.stderr);
  return r;
}

function setup(t) {
  const home = makeHome(t);
  ok(home, ["init"]);
  ok(home, ["train", "authoring"]);
  ok(home, ["add", "skill-evolution", "--tier", "meta"]);
  ok(home, ["sync", "skill-evolution"]);
  return home;
}

function newSkill(home, name) {
  ok(home, ["add", name]);
  const from = path.join(home, "skills", ".evolution", "scaffold", name);
  const to = path.join(home, "skills", name);
  fs.renameSync(from, to);
  ok(home, ["set", name, "status=active"]);
  ok(home, ["sync", name]);
  return to;
}

function note(home, extra) {
  return ok(home, ["note", "--what", "测试事实", "--lesson", "事前该问的那一句", "--scope", "无归属",
    "--cause", "model", "--type", "顺序做反", "--seq", "12-20"].concat(extra || []));
}

function entriesOf(home, pkg) {
  const dir = path.join(home, HISTORY, pkg, "entries");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (f) { return f.endsWith(".md"); });
}

test("init：建目录与空 registry，重复执行不改动", function (t) {
  const home = makeHome(t);
  const first = ok(home, ["init"]);
  assert.match(first.stdout, /已初始化 registry/);
  for (const d of ["skills", "skills/.evolution", "skills/.evolution/history", "skills/.evolution/scaffold", "skills/.evolution/archive"]) {
    assert.ok(fs.existsSync(path.join(home, d)), "缺少目录：" + d);
  }
  const text = fs.readFileSync(path.join(home, REGISTRY), "utf8");
  assert.match(text, /^conformsTo: skill-evo-v4$/m);
  assert.match(text, /^skills: \[\]$/m);

  const before = fs.statSync(path.join(home, REGISTRY)).mtimeMs;
  const second = ok(home, ["init"]);
  assert.match(second.stdout, /registry 已存在，未改动/);
  assert.equal(fs.statSync(path.join(home, REGISTRY)).mtimeMs, before);
});

test("add 之前必须 train authoring（上岗资格）", function (t) {
  const home = makeHome(t);
  ok(home, ["init"]);
  const denied = fail(home, ["add", "demo-skill"]);
  assert.match(denied.stderr, /train authoring/);

  ok(home, ["train", "authoring"]);
  const added = ok(home, ["add", "demo-skill"]);
  assert.match(added.stdout, /已建档：demo-skill/);
  assert.ok(fs.existsSync(path.join(home, "skills", ".evolution", "scaffold", "demo-skill", "SKILL.md")));
});

test("note 三字段必填：缺 scope / 越界 type 都拒；合法则落一条带正文哈希的条目", function (t) {
  const home = setup(t);
  fail(home, ["note", "--what", "x", "--lesson", "y", "--cause", "model", "--type", "顺序做反"]);
  fail(home, ["note", "--what", "x", "--lesson", "y", "--scope", "无归属", "--cause", "model", "--type", "不存在的类型"]);

  note(home);
  const files = entriesOf(home, "_unowned");
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}-f\d+-[0-9a-f]{8}\.md$/);

  const view = ok(home, ["view"]);
  assert.match(view.stdout, /沿革 1 条/);
});

test("note：同 type 同 scope 自动判 repeat", function (t) {
  const home = setup(t);
  const first = note(home);
  assert.doesNotMatch(first.stdout, /repeat of/);
  const second = note(home);
  assert.match(second.stdout, /repeat of f/);
});

test("self 留读记录（资格门的事实依据）", function (t) {
  const home = setup(t);
  const out = ok(home, ["self", "skill-evolution"]);
  assert.match(out.stdout, /# 领取：skill-evolution/);
  const reads = fs.readFileSync(path.join(home, HISTORY, "skill-evolution", "reads.jsonl"), "utf8").trim().split("\n").map(function (l) { return JSON.parse(l); });
  const selfReads = reads.filter(function (r) { return !r.what; });
  assert.equal(selfReads.length, 1);
  const rec = selfReads[0];
  assert.match(rec.package, /^[0-9a-f]{64}$/);
});

test("merge 四道门之一：没有读记录 → 拒（退出码 2）", function (t) {
  const home = setup(t);
  ok(home, ["propose", "skill-evolution", "--why", "测试提案"]);
  const denied = fail(home, ["merge", "skill-evolution", "--why", "批准"], 2);
  assert.match(denied.stderr, /读记录/);
});

test("merge 成功：version+1，packageHash 置 pending；sync 后 check 干净", function (t) {
  const home = setup(t);
  ok(home, ["self", "skill-evolution"]);
  ok(home, ["propose", "skill-evolution", "--why", "测试提案"]);
  const merged = ok(home, ["merge", "skill-evolution", "--why", "用户批准", "--by", "user"]);
  assert.match(merged.stdout, /version 2/);

  const reg = fs.readFileSync(path.join(home, REGISTRY), "utf8");
  assert.match(reg, /version: 2/);
  assert.match(reg, /packageHash: 'pending:f/);

  ok(home, ["sync", "skill-evolution"]);
  const chk = ok(home, ["check"]);
  assert.match(chk.stdout, /check 通过/);
});

test("merge 四道门之二：提案立后目标变过 → stale，拒", function (t) {
  const home = setup(t);
  ok(home, ["self", "skill-evolution"]);
  ok(home, ["propose", "skill-evolution", "--why", "测试提案"]);
  fs.appendFileSync(path.join(home, "skills", "skill-evolution", "SKILL.md"), "\n<!-- drift -->\n");
  const denied = fail(home, ["merge", "skill-evolution", "--why", "批准"], 2);
  assert.match(denied.stderr, /stale/);
});

test("merge 四道门之三：批准者不得是作者", function (t) {
  const home = setup(t);
  ok(home, ["self", "skill-evolution"]);
  ok(home, ["propose", "skill-evolution", "--why", "测试提案"]);
  const denied = fail(home, ["merge", "skill-evolution", "--why", "自批", "--by", "agent"], 2);
  assert.match(denied.stderr, /批准者/);
});

test("check：裸 skill / 孤儿引用 / 引用成环 / 包哈希漂移", function (t) {
  const home = setup(t);

  // 裸 skill：磁盘有、registry 无
  fs.mkdirSync(path.join(home, "skills", "bare-skill"), { recursive: true });
  fs.writeFileSync(path.join(home, "skills", "bare-skill", "SKILL.md"), "---\nname: bare-skill\ndescription: x\n---\n");
  let r = fail(home, ["check"], 2);
  assert.match(r.stdout, /裸 skill/);

  // 孤儿引用：references 里有文件，但没人指到
  const demo = newSkill(home, "demo-skill");
  fs.mkdirSync(path.join(demo, "references"), { recursive: true });
  fs.writeFileSync(path.join(demo, "references", "orphan.md"), "# orphan\n");
  r = fail(home, ["check"], 2);
  assert.match(r.stdout, /孤儿引用/);

  // 成环：SKILL.md → a.md → b.md → a.md
  fs.writeFileSync(path.join(demo, "references", "a.md"), "# a\n见 references/b.md\n");
  fs.writeFileSync(path.join(demo, "references", "b.md"), "# b\n见 references/a.md\n");
  fs.appendFileSync(path.join(demo, "SKILL.md"), "\n见 references/a.md\n");
  r = fail(home, ["check"], 2);
  assert.match(r.stdout, /成环/);

  // 哈希漂移：sync 之后又改了本体
  ok(home, ["sync", "demo-skill"]);
  fs.appendFileSync(path.join(demo, "SKILL.md"), "\n<!-- drift -->\n");
  r = fail(home, ["check"], 2);
  assert.match(r.stdout, /包已变/);
});

test("reject 保留理由；supersede 改状态且正文不变", function (t) {
  const home = setup(t);
  ok(home, ["self", "skill-evolution"]);
  ok(home, ["propose", "skill-evolution", "--why", "提案一"]);
  const rej = ok(home, ["reject", "skill-evolution", "--why", "理由必须留下"]);
  assert.match(rej.stdout, /理由已留下/);

  const files = entriesOf(home, "skill-evolution");
  const text = files.map(function (f) { return fs.readFileSync(path.join(home, HISTORY, "skill-evolution", "entries", f), "utf8"); }).join("\n");
  assert.match(text, /state: rejected/);
  assert.match(text, /理由必须留下/);
});

test("review 把观察从 open 置为 reviewed", function (t) {
  const home = setup(t);
  note(home);
  const files = entriesOf(home, "_unowned");
  const id = /-f(\d+)-/.exec(files[0]);
  const reviewed = ok(home, ["review", "f" + id[1]]);
  assert.match(reviewed.stdout, /已评估：f/);
  const text = fs.readFileSync(path.join(home, HISTORY, "_unowned", "entries", files[0]), "utf8");
  assert.match(text, /state: reviewed/);
});

test("render 生成 catalog 投影", function (t) {
  const home = setup(t);
  ok(home, ["render"]);
  const cat = fs.readFileSync(path.join(home, "skills", ".evolution", "catalog.md"), "utf8");
  assert.match(cat, /## skill-evolution/);
  assert.match(cat, /投影/);
});
