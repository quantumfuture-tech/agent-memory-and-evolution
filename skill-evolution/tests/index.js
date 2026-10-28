"use strict";

// Node 20–24 的 `node --test <目录>` 会把目录当模块解析，而不是自动发现目录内的
// `*.test.js`。这个入口让 README / CI 里那条单行命令成立：
//   node --test skill-evolution/tests/
// 直接跑 `node --test` 时，测试运行器发现的是 skillctl.test.js，不会经过这里。
require("./skillctl.test.js");
