#!/usr/bin/env node
/**
 * 跨半边集成测试：把 `lib/` 里的 Host 模块按 `index.js` 的方式接起来，
 * 用假模型 + 真实 HTTP handler，跑通用户真正会走的那条路。
 *
 * 单测各自证明半边；这一个证明**接缝**：
 * 导入（支付宝 52 笔）→ 预览自动分类率 → 确认入库 → 三个数一致 →
 * 改一笔分类 → rules 记住 → 手动补记一笔现金 → snapshot 更新 →
 * 九个工具都能 execute → AI 不可用时 insight 降级为 rules。
 *
 * 另外还覆盖：信任栅栏、预算/目标/资产负债/持仓、导出、备份恢复、
 * 示例数据只在空库上写入、AI 可用时 insight 走 ai。
 *
 * 跑法：node --test scripts/test-integration.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createStore } from "../lib/store.js";
import { registerRoutes, rejectionOf, ROUTE_PREFIX } from "../lib/routes.js";
import { createAiBridge } from "../lib/ai.js";
import { buildToolDefinitions, TOOL_NAMES } from "../lib/tools.js";
import { CATEGORIES, formatCents } from "../lib/domain.js";
import { financeSnapshot } from "../lib/analysis.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", name);

const tmp = mkdtempSync(join(tmpdir(), "dsh-finance-it-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

/** 每个用例一个独立临时目录。 */
let counter = 0;
const freshStore = () => {
  counter += 1;
  return createStore({ file: join(tmp, `finance-${String(counter)}.json`) });
};

/** 假模型：按提示词里出现的关键字回不同答案。 */
const fakeModel = (overrides = {}) => {
  const calls = [];
  const streamText = async (request) => {
    calls.push(request);
    if (overrides.error !== undefined) throw new Error(overrides.error);
    if (overrides.raw !== undefined) return overrides.raw;
    const user = request.user;
    if (user.includes("商户列表")) {
      // 给每个商户打「其他」以外的分类，证明 AI 兜底生效
      return JSON.stringify({
        商户: {
          "ZZQX Tech": { category: "餐饮", purpose: "娱乐享受" },
          "YYVB Labs": { category: "娱乐", purpose: "自我实现" }
        }
      });
    }
    if (user.includes("理财看板快照")) {
      return JSON.stringify(["本月餐饮是最大支出项。", "结余率为正，收支平稳。", "建议把应急金补足到 6 个月开支。"]);
    }
    return "{}";
  };
  return { calls, streamText };
};

/**
 * 造一个假的宿主 web 上下文 + 假的 req/res。
 *
 * @param {{ store?: object, model?: object, useAi?: boolean, rejection?: number }} [options]
 * @returns {object} 可调用的测试床。
 */
const mount = ({ store = freshStore(), model = fakeModel(), useAi = true, rejection = 0 } = {}) => {
  const selection = useAi ? () => ({ provider: "fake", model: "m-1" }) : () => null;
  const ai = createAiBridge({ selection, streamText: model.streamText, timeoutMs: 2000 });
  let route = null;
  const webCtx = {
    get: (key) => (key === "connection" ? { requestRejection: () => rejection } : undefined),
    webServer: {
      register: (registered) => {
        route = registered;
        return () => {
          route = null;
        };
      }
    }
  };
  const dispose = registerRoutes(webCtx, { store, ai });

  /**
   * 发一次请求，返回 `{ status, body }`。
   * @param {string} method HTTP 方法。
   * @param {string} path 路径（不带前缀）。
   * @param {unknown} [body] JSON 体。
   */
  const call = async (method, path, body) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = (async function* () {
      if (payload !== "") yield Buffer.from(payload, "utf8");
    })();
    req.method = method;
    req.url = `${ROUTE_PREFIX}${path}`;
    req.socket = { remoteAddress: "127.0.0.1" };
    let status = 0;
    let value = null;
    const res = {
      writeHead(code) {
        status = code;
        return this;
      },
      end(text) {
        value = JSON.parse(text);
      }
    };
    await route.handler(req, res);
    return { status, body: value };
  };

  return { store, ai, model, call, dispose, routeOf: () => route };
};

/** 支付宝样例账单的文本内容（52 笔）。 */
const alipayText = () => readFileSync(fixture("alipay-sample.csv"), "utf8");

/** 测试里用的月份（样例账单都是 2026-11 的）。 */
const MONTH = "2026-11";

/** 把金额（分）格式化成「元」。 */
const yuan = (cents) => formatCents(cents, { symbol: false });

// ── 主链路 ───────────────────────────────────────────────────────────────

test("导入支付宝账单：预览不落库，自动分类率达标，确认后三个数对得上", async () => {
  const store = freshStore();
  const { call } = mount({ store });
  const before = await call("GET", `/snapshot?month=${MONTH}`);
  assert.equal(before.status, 200);
  assert.equal(before.body.value.summary.txnCount, 0, "空库的当月笔数为 0");

  const preview = await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const value = preview.body.value;
  assert.ok(Array.isArray(value.rows), "预览带 rows");
  assert.ok(value.rows.length >= 50, `样例账单至少 50 行，实际 ${value.rows.length}`);
  assert.ok(value.autoRate >= 0.7, `自动分类率应 ≥ 70%，实际 ${(value.autoRate * 100).toFixed(1)}%`);
  assert.equal(value.format, "alipay-csv", "识别成支付宝格式");
  assert.equal(value.preview, true);
  assert.ok(Array.isArray(value.warnings));
  // 预览绝不落库
  const afterPreview = await call("GET", `/snapshot?month=${MONTH}`);
  assert.equal(afterPreview.body.value.summary.txnCount, 0, "预览不落库");
  // 每一行都有分类
  for (const row of value.rows) {
    assert.ok(CATEGORIES.includes(row.category), `分类「${row.category}」必须在领域常量里`);
  }

  const confirmed = await call("POST", "/import/confirm", {
    name: "alipay-sample.csv",
    format: value.format,
    rows: value.rows
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.value.added, value.rows.length, "第一次导入全部新增");
  assert.equal(confirmed.body.value.duplicates, 0, "空库导入没有重复");
  const snap = confirmed.body.value.snapshot;
  assert.equal(snap.month, MONTH);
  assert.equal(snap.summary.txnCount, value.rows.length, "snapshot 的笔数与导入行数一致");

  // 三个数一致：收入 - 支出 = 结余
  assert.equal(snap.summary.income - snap.summary.expense, snap.summary.balance, "收入 - 支出 = 结余");
  // 分类占比加起来等于支出（分单位，允许 0 误差因为都是整数分）
  const categorySum = snap.byCategory.reduce((acc, row) => acc + row.amount, 0);
  assert.equal(categorySum, snap.summary.expense, "分类金额加总 = 支出总额");
  // 趋势里本月的数也要一样
  const thisTrend = snap.trend.find((row) => row.month === MONTH);
  assert.ok(thisTrend !== undefined, "趋势里含本月");
  assert.equal(thisTrend.expense, snap.summary.expense, "趋势本月支出 = 汇总支出");
  assert.equal(thisTrend.income, snap.summary.income, "趋势本月收入 = 汇总收入");

  // 再导一次：全部是重复
  const again = await call("POST", "/import/confirm", { name: "alipay-sample.csv", format: value.format, rows: value.rows });
  assert.equal(again.status, 200);
  assert.equal(again.body.value.added, 0, "第二次导入新增 0");
  assert.equal(again.body.value.duplicates, value.rows.length, "第二次全部算重复");
});

test("改一笔分类 → rules 记住 → 再导入同商户自动命中", async () => {
  const store = freshStore();
  const { call } = mount({ store });
  const preview = await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() });
  await call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: preview.body.value.rows });

  const listed = await call("GET", `/txns?month=${MONTH}&limit=200`);
  assert.equal(listed.status, 200);
  const target = listed.body.value.txns.find((txn) => txn.direction === "expense" && txn.merchant !== "");
  assert.ok(target !== undefined, "找到一笔支出");
  const newCategory = target.category === "购物" ? "娱乐" : "购物";

  const updated = await call("POST", "/txns", { op: "update", month: MONTH, id: target.id, category: newCategory });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.value.txn.category, newCategory, "分类改成功");

  // rules 记住了这个商户（key 是归一化商户名）
  const rules = store.getRules();
  const recorded = Object.values(rules).find((rule) => rule.category === newCategory);
  assert.ok(recorded !== undefined, "rules 记下了新分类");

  // 新导入一笔同商户的账，应直接命中 rules（而不是回到规则表原判）
  const row = {
    date: "2026-11-05",
    amount: 1234,
    direction: "expense",
    merchant: target.merchant,
    account: "支付宝",
    note: ""
  };
  const imported = await call("POST", "/import/confirm", { name: "more.csv", format: "csv", rows: [row] });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.value.added, 1, "新的一笔入库（金额不同不算重复）");
  const stored = store.getDb().txns.find((txn) => txn.date === "2026-11-05" && txn.amount === 1234);
  assert.ok(stored !== undefined, "找到刚导入的那笔");
  assert.equal(stored.category, newCategory, "同商户自动套用用户修正过的分类（rules 记忆生效）");
});

test("手动补记一笔现金 → snapshot 立刻更新，且分类与目的自动补齐", async () => {
  const store = freshStore();
  const { call } = mount({ store });
  await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() }).then((result) =>
    call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: result.body.value.rows })
  );
  const before = (await call("GET", `/snapshot?month=${MONTH}`)).body.value;

  const added = await call("POST", "/txns", {
    op: "add",
    month: MONTH,
    date: "2026-11-20",
    amount: 3550,
    direction: "expense",
    merchant: "星巴克",
    account: "现金",
    note: "下午咖啡"
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const txn = added.body.value.txn;
  assert.equal(txn.amount, 3550, "金额按分存");
  assert.equal(txn.category, "餐饮", "商户名让规则认得出来");
  assert.ok(txn.purpose !== "", "目的自动补上");
  assert.equal(txn.account, "现金");
  assert.equal(txn.source, "manual");

  const after = (await call("GET", `/snapshot?month=${MONTH}`)).body.value;
  assert.equal(after.summary.txnCount, before.summary.txnCount + 1, "多了一笔");
  assert.equal(after.summary.expense, before.summary.expense + 3550, "支出多了 35.50 元");

  // 金额不合法要被 400 拒绝，而不是写脏数据
  const bad = await call("POST", "/txns", { op: "add", month: MONTH, date: "2026-11-20", amount: 0, merchant: "x" });
  assert.equal(bad.status, 400, "金额为 0 被拒");
  assert.equal(bad.body.ok, false);
  assert.equal(typeof bad.body.error.message, "string");
});

// ── 工具 ─────────────────────────────────────────────────────────────────

test("八个工具都能 execute，且返回人话文本", async () => {
  const store = freshStore();
  // 先用接口灌一笔数据，让工具有的可说
  const bed = mount({ store });
  const preview = await bed.call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() });
  await bed.call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: preview.body.value.rows });
  await store.addAsset({ name: "招行活期", kind: "cash", value: 5_000_00, account: "招商银行" });
  await store.addLiability({ name: "房贷", kind: "mortgage", balance: 3_000_00, monthlyPayment: 1200_00, dueDay: 15 });
  await store.addHolding({ name: "沪深300ETF", code: "510300", type: "fund", shares: 1000, costPrice: 4120, price: 4350 });
  await store.setBudget(MONTH, "餐饮", 2000_00);

  // 假 fs 服务：readBytes 直接回样例账单
  const bytes = readFileSync(fixture("alipay-sample.csv"));
  const written = [];
  const fakeFs = {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    readBytes: async () => new Uint8Array(bytes),
    readText: async () => bytes.toString("utf8"),
    writeText: async (target, content) => {
      written.push({ path: target.displayPath, content });
      return { operation: "create", after: content };
    },
    processPath: (target) => target.displayPath
  };

  const definitions = buildToolDefinitions({
    store,
    ai: createAiBridge({ selection: () => null, streamText: async () => "" }),
    fs: fakeFs,
    cwd: tmp,
    now: () => new Date(2026, 10, 27, 12, 0, 0).getTime()
  });
  assert.equal(definitions.length, 9, "九个工具");
  assert.deepEqual(
    definitions.map((tool) => tool.name),
    [...TOOL_NAMES],
    "名字与顺序固定"
  );

  // 注册形状：宿主写的接口都齐
  for (const tool of definitions) {
    assert.equal(typeof tool.name, "string");
    assert.ok(tool.description.length > 20, `${tool.name} 的描述要够模型看懂`);
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name} 的 additionalProperties 必须是 false`);
    assert.equal(tool.output.schema.type, "string");
    assert.equal(typeof tool.isConcurrencySafe, "function");
    assert.equal(typeof tool.presentCall, "function");
    const call = tool.presentCall({});
    assert.equal(call.card, "generic");
    assert.ok(call.title.length > 0);
  }

  const run = async (name, args) => {
    const tool = definitions.find((entry) => entry.name === name);
    const value = await tool.execute(args, {});
    assert.equal(typeof value, "string", `${name} 应返回字符串`);
    assert.ok(value.trim().length > 0, `${name} 返回了空文本`);
    // render 的形状
    const blocks = tool.output.render(args, value);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.equal(blocks[0].text, value);
    return value;
  };

  const overview = await run("finance_overview", { month: MONTH });
  assert.match(overview, /收入/u, "概况写了收入");
  assert.match(overview, /支出/u, "概况写了支出");

  const added = await run("finance_add_txn", { amount: 35, merchant: "咖啡", note: "记一笔咖啡" });
  assert.match(added, /已记一笔/u);
  assert.match(added, /35\.00/u, "金额按元显示");

  const queried = await run("finance_query_txns", { month: MONTH, limit: 5 });
  assert.match(queried, /共 \d+ 笔/u, "查询说了总笔数");

  const imported = await run("finance_import_bill", { path: "/Users/x/支付宝账单.csv" });
  assert.match(imported, /读了 \d+ 笔/u, "导入说了读了几笔");
  assert.match(imported, /自动归类/u);
  assert.match(imported, /还没有入库/u, "默认只预览");

  const netWorth = await run("finance_net_worth", {});
  assert.match(netWorth, /净资产/u);
  // 回归：还款明细的金额字段是 `amount`（由 monthlyPayment 推导），早期版本
  // 误读 `monthlyPayment` 导致「近 30 天要还」全是 ¥0。
  if (/近 30 天要还/u.test(netWorth)) {
    const sum = /近 30 天要还 ¥([\d,]+\.\d{2})/u.exec(netWorth);
    assert.ok(sum !== null, "要还金额可解析");
    assert.notEqual(sum[1], "0.00", "近 30 天要还的钱不能是 0");
  }

  const invest = await run("finance_investments", {});
  assert.match(invest, /市值/u);
  assert.match(invest, /不构成任何投资建议/u, "投资工具必须声明不给建议");

  const budget = await run("finance_budget", { op: "view", month: MONTH });
  assert.match(budget, /预算/u);

  const csvPath = join(tmp, "export.csv");
  const exported = await run("finance_export", { month: MONTH, format: "csv", path: csvPath });
  assert.match(exported, /已导出/u);
  assert.ok(written.length >= 1, "通过 fs 服务写盘");
  assert.match(written[0].content, /日期,方向,金额/u, "CSV 有表头");

  // 预算：设一条、删一条
  const setBudget = await run("finance_budget", { op: "set_budget", month: MONTH, category: "交通", limit: 300 });
  assert.match(setBudget, /已设置/u);
  const removeBudget = await run("finance_budget", { op: "remove_budget", month: MONTH, category: "交通" });
  assert.match(removeBudget, /已删掉/u);

  // 目标：新建、存钱
  const goalText = await run("finance_budget", { op: "add_goal", name: "应急金", target: 50000, saved: 10000 });
  assert.match(goalText, /已新建存钱目标/u);
  const goal = store.listGoals()[0];
  const contribute = await run("finance_budget", { op: "contribute_goal", goalId: goal.id, amount: 5000 });
  assert.match(contribute, /已存入/u);
  assert.equal(store.listGoals()[0].saved, 15000_00, "目标里存进了 5000 元");
});

test("工具失败不拖垮其他：坏参数返回人话，其余工具照常", async () => {
  const store = freshStore();
  const definitions = buildToolDefinitions({ store, fs: null, cwd: tmp, now: () => Date.now() });
  const add = definitions.find((tool) => tool.name === "finance_add_txn");
  const bad = await add.execute({ amount: -5 }, {});
  assert.equal(typeof bad, "string");
  assert.match(bad, /操作没成功/u, "失败也返回字符串而不是抛出");
  // 别的工具仍然可用
  const overview = definitions.find((tool) => tool.name === "finance_overview");
  const text = await overview.execute({}, {});
  assert.match(text, /还没有流水记录/u);
  // 文件不存在时 import_bill 给出人话
  const importTool = definitions.find((tool) => tool.name === "finance_import_bill");
  const missing = await importTool.execute({ path: join(tmp, "根本不存在.csv") }, {});
  assert.match(missing, /读不到/u);
});

test("registerTools 收集九个定义，单个注册失败不影响其余", async () => {
  const store = freshStore();
  const registered = [];
  const ctx = {
    tools: {
      register: (definition) => {
        if (definition.name === "finance_query_txns") throw new Error("模拟撞名");
        registered.push(definition.name);
        return () => {};
      }
    }
  };
  const { registerTools } = await import("../lib/tools.js");
  const disposers = registerTools(ctx, { store, fs: null, cwd: tmp, log: () => {} });
  assert.equal(registered.length, 8, "九个里有一个撞名失败，其余八个成功");
  assert.equal(disposers.length, 8);
  assert.ok(!registered.includes("finance_query_txns"));
  for (const dispose of disposers) dispose();
});

// ── AI ───────────────────────────────────────────────────────────────────

test("AI 不可用时 insight 降级为规则 tips，且诚实标注 source:rules", async () => {
  const store = freshStore();
  const { call } = mount({ store, useAi: false });
  const preview = await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() });
  await call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: preview.body.value.rows });

  const status = await call("GET", "/ai/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.value.available, false);
  assert.equal(status.body.value.reason, "no-model");

  const insight = await call("POST", "/ai/insight", { month: MONTH });
  assert.equal(insight.status, 200, "AI 不可用不是错误响应");
  assert.equal(insight.body.value.source, "rules", "如实标注来源是规则");
  assert.equal(typeof insight.body.value.text, "string");
  assert.ok(insight.body.value.text.length > 0, "降级也要有话可说");
  assert.ok(Array.isArray(insight.body.value.tips), "带上规则 tips");
  assert.ok(insight.body.value.error?.code === "no-model", "带上失败原因");
});

test("AI 调用失败（超时/报错）同样降级，不会 500", async () => {
  const store = freshStore();
  const { call } = mount({ store, model: fakeModel({ error: "quota exceeded" }) });
  const preview = await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() });
  await call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: preview.body.value.rows });
  const insight = await call("POST", "/ai/insight", { month: MONTH });
  assert.equal(insight.status, 200);
  assert.equal(insight.body.value.source, "rules");
  assert.ok(insight.body.value.text.length > 0);
});

test("AI 可用时 insight 走 ai，returns source:ai", async () => {
  const store = freshStore();
  const { call } = mount({ store });
  const preview = await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() });
  await call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: preview.body.value.rows });
  const insight = await call("POST", "/ai/insight", { month: MONTH });
  assert.equal(insight.status, 200);
  assert.equal(insight.body.value.source, "ai");
  assert.match(insight.body.value.text, /餐饮/u, "把 AI 写的洞察文本带回来");
  assert.ok(Array.isArray(insight.body.value.insights));
});

test("insight 的提示词里写死了「不许推荐买卖」", async () => {
  const model = fakeModel();
  const store = freshStore();
  const { call } = mount({ store, model });
  await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() }).then((result) =>
    call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: result.body.value.rows })
  );
  await call("POST", "/ai/insight", { month: MONTH });
  const insightCall = model.calls.find((request) => request.user.includes("理财看板快照"));
  assert.ok(insightCall !== undefined, "确实调了模型");
  assert.match(insightCall.user, /不得推荐或暗示买卖/u);
  assert.match(insightCall.system, /不要推荐具体买卖/u);
});

test("导入预览时 AI 兜底那些规则没命中的商户", async () => {
  const store = freshStore();
  const { call, model } = mount({ store });
  // 用规则表绝对认不出的英文商户名，保证它们落进「其他」（confidence: default）
  const csv = [
    "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注",
    "2026-11-01 10:00:00,其他,ZZQX Tech,thing,支出,32.00,支付宝,交易成功,1,1,",
    "2026-11-02 10:00:00,其他,YYVB Labs,item,支出,199.00,支付宝,交易成功,2,2,",
    "2026-11-03 10:00:00,餐饮,星巴克,拿铁,支出,34.00,支付宝,交易成功,3,3,"
  ].join("\n");
  const preview = await call("POST", "/import", { name: "odd.csv", content: csv });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(model.calls.some((request) => request.user.includes("商户列表")), "确实问了 AI");
  const rows = preview.body.value.rows;
  const odd = rows.find((row) => row.merchant === "ZZQX Tech");
  assert.ok(odd !== undefined, "规则认不出的那一行在");
  assert.equal(odd.confidence, "ai", "标注为 AI 补的");
  assert.equal(odd.category, "餐饮", "AI 给出了分类");
  // 规则本来就认得的那行不该被 AI 改写
  const starbucks = rows.find((row) => row.merchant === "星巴克");
  assert.equal(starbucks.confidence, "rule", "规则命中行保持 rule");
});

test("needsAiOf：只有「真没信息」的支出行才值得再问一次 AI", async () => {
  const { needsAiOf } = await import("../lib/ai.js");
  // 规则完全没命中 → 问
  assert.equal(needsAiOf({ direction: "expense", confidence: "default", category: "其他" }), true);
  // 关键词真命中「其他」（ATM/转账/手续费）→ 也问，因为对用户等于没分类
  assert.equal(needsAiOf({ direction: "expense", confidence: "rule", category: "其他" }), true);
  // 规则给出了有用的分类 → 不问
  assert.equal(needsAiOf({ direction: "expense", confidence: "rule", category: "餐饮" }), false);
  assert.equal(needsAiOf({ direction: "expense", confidence: "user", category: "人情往来" }), false);
  // 收入行永远不问（分类固定「收入」）
  assert.equal(needsAiOf({ direction: "income", confidence: "default", category: "其他" }), false);
  // 脏输入不炸
  assert.equal(needsAiOf(null), false);
  assert.equal(needsAiOf(undefined), false);
});

test("账单自带「其他」但关键词能救回来的行，不白跑一轮 AI", async () => {
  const store = freshStore();
  const { call, model } = mount({ store });
  // 交易分类列写的是「其他」，但商户名星巴克能命中餐饮关键词：
  // classify 现在会继续走关键词表并给出 rule，这行不该被送给 AI。
  const csv = [
    "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注",
    "2026-11-01 10:00:00,其他,星巴克,拿铁,支出,34.00,支付宝,交易成功,1,1,",
    "2026-11-02 10:00:00,其他,ZZQX Tech,thing,支出,32.00,支付宝,交易成功,2,2,"
  ].join("\n");
  const preview = await call("POST", "/import", { name: "mixed.csv", content: csv });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const rows = preview.body.value.rows;
  const starbucks = rows.find((row) => row.merchant === "星巴克");
  assert.equal(starbucks.category, "餐饮", "关键词把自带「其他」救回了餐饮");
  assert.equal(starbucks.confidence, "rule", "救回来的行是规则判定");
  // 只看「商户列表」这一段（提示词末尾的示例 JSON 里本来就有「星巴克」三个字，
  // 对整段提示词做 includes 会误判）。
  const classifyCall = model.calls.find((request) => request.user.includes("商户列表"));
  assert.ok(classifyCall !== undefined, "确实问了 AI（为了 ZZQX Tech）");
  const askedSection = classifyCall.user.split("商户列表：")[1].split("只返回 JSON")[0];
  assert.ok(!askedSection.includes("星巴克"), "规则已救回的行没有浪费 AI 配额");
  assert.ok(askedSection.includes("ZZQX Tech"), "只问了真正没信息的行");
});

// ── 信任栅栏 ─────────────────────────────────────────────────────────────

test("connection 服务说不许，就在读任何字节之前拒绝", async () => {
  const store = freshStore();
  const { call } = mount({ store, rejection: 401 });
  const denied = await call("GET", `/snapshot?month=${MONTH}`);
  assert.equal(denied.status, 401, "未认证的浏览器调用被拒");
  assert.equal(denied.body.ok, false);
  const deniedImport = await call("POST", "/import", { name: "a.csv", content: alipayText() });
  assert.equal(deniedImport.status, 401);
  assert.equal(store.getDb().txns.length, 0, "没有被写入任何数据");
});

test("没有 connection 服务时只放行 loopback", () => {
  const req = (remote) => ({ socket: { remoteAddress: remote } });
  const bare = { get: () => undefined };
  assert.equal(rejectionOf(bare, req("127.0.0.1")), 0, "本机放行");
  assert.equal(rejectionOf(bare, req("::1")), 0, "IPv6 本机放行");
  assert.equal(rejectionOf(bare, req("::ffff:127.0.0.1")), 0, "IPv4-mapped 本机放行");
  assert.equal(rejectionOf(bare, req("192.168.1.9")), 403, "局域网拒绝");
  assert.equal(rejectionOf(bare, req("8.8.8.8")), 403, "公网拒绝");
  // 有 connection 服务时以它为准
  assert.equal(rejectionOf({ get: () => ({ requestRejection: () => 403 }) }, req("127.0.0.1")), 403);
  assert.equal(rejectionOf({ get: () => ({ requestRejection: () => 0 }) }, req("8.8.8.8")), 0);
});

// ── 资产 / 负债 / 持仓 / 预算 / 目标 / 设置 ──────────────────────────────

test("资产、负债、持仓、预算、目标、设置都能通过接口增删改", async () => {
  const store = freshStore();
  const { call } = mount({ store });

  const asset = await call("POST", "/assets", { op: "add", name: "招行活期", kind: "cash", valueYuan: 12345.67 });
  assert.equal(asset.status, 200, JSON.stringify(asset.body));
  assert.equal(asset.body.value.item.value, 1234567, "valueYuan 换成元");
  const assetId = asset.body.value.item.id;
  const assetUpdated = await call("POST", "/assets", { op: "update", id: assetId, valueYuan: 20000 });
  assert.equal(assetUpdated.body.value.item.value, 2000000);
  assert.equal(assetUpdated.body.value.snapshot.assets.total, 2000000);

  const liab = await call("POST", "/liabilities", { op: "add", name: "房贷", kind: "mortgage", balanceYuan: 1000000, monthlyPaymentYuan: 5000, dueDay: 15 });
  assert.equal(liab.status, 200, JSON.stringify(liab.body));
  assert.equal(liab.body.value.snapshot.liabilities.total, 100000000);
  assert.equal(liab.body.value.snapshot.netWorth, 2000000 - 100000000);

  const holding = await call("POST", "/holdings", { op: "add", name: "沪深300ETF", code: "510300", type: "fund", shares: 1000, costPriceYuan: 4.12, priceYuan: 4.35 });
  assert.equal(holding.status, 200, JSON.stringify(holding.body));
  const invest = holding.body.value.snapshot.invest;
  assert.equal(invest.cost, 412000);
  assert.equal(invest.value, 435000);
  assert.equal(invest.pnl, 23000);

  const budget = await call("POST", "/budgets", { op: "set", month: MONTH, category: "餐饮", limitYuan: 2000 });
  assert.equal(budget.status, 200, JSON.stringify(budget.body));
  assert.equal(budget.body.value.budget.limit, 200000);
  const budgetRemoved = await call("POST", "/budgets", { op: "remove", month: MONTH, category: "餐饮" });
  assert.equal(budgetRemoved.status, 200);
  assert.equal(budgetRemoved.body.value.snapshot.budgets.length, 0);

  const goal = await call("POST", "/goals", { op: "add", name: "应急金", targetYuan: 50000, deadline: "2027-06-30" });
  assert.equal(goal.status, 200, JSON.stringify(goal.body));
  const goalId = goal.body.value.goal.id;
  const contributed = await call("POST", "/goals", { op: "contribute", id: goalId, amountYuan: 10000 });
  assert.equal(contributed.body.value.goal.saved, 1000000, "存入 1 万元");
  const goalUpdated = await call("POST", "/goals", { op: "update", id: goalId, targetYuan: 60000 });
  assert.equal(goalUpdated.body.value.goal.target, 6000000);

  const settings = await call("POST", "/settings", { emergencyMonths: 9, currency: "CNY" });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  assert.equal(settings.body.value.settings.emergencyMonths, 9);

  // 删除
  assert.equal((await call("POST", "/goals", { op: "remove", id: goalId })).status, 200);
  assert.equal((await call("POST", "/holdings", { op: "remove", id: holding.body.value.item.id })).status, 200);
  assert.equal((await call("POST", "/liabilities", { op: "remove", id: liab.body.value.item.id })).status, 200);
  assert.equal((await call("POST", "/assets", { op: "remove", id: assetId })).status, 200);
  assert.equal(store.getDb().assets.length, 0);
});

// ── 备份 / 恢复 / 示例 ───────────────────────────────────────────────────

test("导出整库、恢复到另一个库、示例数据只对空库开放", async () => {
  const store = freshStore();
  const { call } = mount({ store });
  const preview = await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() });
  await call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: preview.body.value.rows });

  const exported = await call("GET", "/export");
  assert.equal(exported.status, 200);
  assert.ok(exported.body.value.db.txns.length >= 50);
  assert.equal(typeof exported.body.value.exportedAt, "number");

  const other = freshStore();
  const otherBed = mount({ store: other });
  const restored = await otherBed.call("POST", "/import-db", { data: exported.body.value.db });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(other.getDb().txns.length, exported.body.value.db.txns.length, "恢复后笔数一致");

  // 非空库不允许写示例数据
  const demoBusy = await call("POST", "/demo", {});
  assert.equal(demoBusy.status, 500, "非空库拒绝示例数据");
  assert.equal(demoBusy.body.ok, false);

  // 空库可以
  const empty = mount({ store: freshStore() });
  const demo = await empty.call("POST", "/demo", {});
  assert.equal(demo.status, 200, JSON.stringify(demo.body));
  assert.ok(demo.body.value.snapshot.monthsAvailable.length > 0, "示例数据跨好几个月");
});

// ── 错误处理 ─────────────────────────────────────────────────────────────

test("错误都转成人话的 400/404/413，不是裸异常", async () => {
  const store = freshStore();
  const { call } = mount({ store });
  assert.equal((await call("GET", "/nope")).status, 404);
  assert.equal((await call("POST", "/txns", { op: "explode" })).status, 400);
  const noId = await call("POST", "/txns", { op: "remove" });
  assert.equal(noId.status, 400);
  assert.match(noId.body.error.message, /id/u);
  const missingTxn = await call("POST", "/txns", { op: "remove", id: "txn_nope" });
  assert.equal(missingTxn.status, 400, "找不到的流水是 400 不是 500");
  assert.match(missingTxn.body.error.message, /找不到/u);
  assert.equal((await call("POST", "/budgets", { op: "set", category: "不存在", limitYuan: 1 })).status, 400);
  assert.equal((await call("POST", "/import", { name: "x.csv" })).status, 400, "空文件内容");

  // 非法 JSON
  const req = (async function* () {
    yield Buffer.from("{not json", "utf8");
  })();
  req.method = "POST";
  req.url = `${ROUTE_PREFIX}/txns`;
  req.socket = { remoteAddress: "127.0.0.1" };
  let status = 0;
  let payload = null;
  const res = {
    writeHead(code) {
      status = code;
    },
    end(text) {
      payload = JSON.parse(text);
    }
  };
  await mount({ store }).routeOf().handler(req, res);
  assert.equal(status, 400);
  assert.equal(payload.error.code, "invalid_json");
});

test("snapshot 的月份参数不合法时退回当前月而不是报错", async () => {
  const store = freshStore();
  const { call } = mount({ store });
  const result = await call("GET", "/snapshot?month=不是月份");
  assert.equal(result.status, 200);
  assert.match(result.body.value.month, /^\d{4}-\d{2}$/u);
});

// ── 与 store 的一致性 ────────────────────────────────────────────────────

test("接口算出来的快照与直接调 analysis 的结果一致", async () => {
  const store = freshStore();
  const { call } = mount({ store });
  const preview = await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() });
  await call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: preview.body.value.rows });
  const viaRoute = (await call("GET", `/snapshot?month=${MONTH}`)).body.value;
  const direct = financeSnapshot(store.getDb(), { month: MONTH, now: Date.now() });
  assert.equal(viaRoute.summary.expense, direct.summary.expense, "支出一致");
  assert.equal(viaRoute.summary.income, direct.summary.income, "收入一致");
  assert.equal(viaRoute.byCategory.length, direct.byCategory.length, "分类数一致");
  for (const row of viaRoute.byCategory) {
    const other = direct.byCategory.find((entry) => entry.category === row.category);
    assert.ok(other !== undefined, `${row.category} 在直调结果里也有`);
    assert.equal(row.amount, other.amount, `${row.category} 金额一致`);
  }
});

test("导入的金额以分存储，展示时按元", async () => {
  const store = freshStore();
  const { call } = mount({ store });
  const preview = await call("POST", "/import", { name: "alipay-sample.csv", content: alipayText() });
  const first = preview.body.value.rows[0];
  assert.ok(Number.isInteger(first.amount), "金额是整数（分）");
  await call("POST", "/import/confirm", { name: "a.csv", format: "alipay-csv", rows: preview.body.value.rows });
  const stored = store.getDb().txns.find((txn) => txn.date === first.date && txn.amount === first.amount);
  assert.ok(stored !== undefined, "按分精确保存");
  assert.equal(yuan(stored.amount), formatCents(stored.amount, { symbol: false }));
});
// ── 一句话录入与保单 ─────────────────────────────────────────────────────
test("POST /parse 只解析不写库，面板据此给预览", async () => {
  const t = mount();
  try {
    const before = t.store.getDb().policies?.length ?? 0;
    const res = await t.call("POST", "/parse", { text: "平安重疾险，每年4860，明年12月15号续保" });
    assert.equal(res.status, 200);
    assert.equal(res.body.value.intent, "policy");
    assert.equal(res.body.value.value.premium, 486000);
    assert.equal(res.body.value.value.dueDate, "2027-12-15");
    assert.equal(t.store.getDb().policies?.length ?? 0, before, "解析不落库");
  } finally {
    t.dispose();
  }
});

test("POST /parse/commit 把解析结果写进对应的表", async () => {
  const t = mount();
  try {
    const policyRes = await t.call("POST", "/parse/commit", {
      intent: "policy",
      value: { kind: "deposit", name: "三年定期", amount: 10000000, rate: 350, dueDate: "2027-03-01", payCycle: "once" }
    });
    assert.equal(policyRes.status, 200);
    assert.equal(policyRes.body.value.snapshot.policies.all.length, 1);
    assert.equal(policyRes.body.value.snapshot.policies.items.length, 1, "设了日期就要进提醒");

    const assetRes = await t.call("POST", "/parse/commit", {
      intent: "asset",
      value: { name: "招行活期", kind: "cash", value: 18500000 }
    });
    assert.equal(assetRes.body.value.snapshot.assets.items.length, 1, "资产写进 assets");

    const bad = await t.call("POST", "/parse/commit", { intent: "nope", value: {} });
    assert.equal(bad.status, 400);
  } finally {
    t.dispose();
  }
});

test("保单接口：增删改，且到期提醒带天数与紧急度", async () => {
  const t = mount();
  try {
    const created = await t.call("POST", "/policies", {
      op: "add",
      kind: "insurance",
      name: "百万医疗",
      amount: 30000000,
      premium: 120000,
      payCycle: "yearly",
      dueDate: "2026-12-10"
    });
    assert.equal(created.status, 200);
    const reminder = created.body.value.snapshot.policies.items[0];
    assert.equal(reminder.name, "百万医疗");
    assert.equal(reminder.bucket, "soon", "12-10 在 30 天内");
    assert.ok(reminder.days > 0);

    const removed = await t.call("POST", "/policies", {
      op: "remove",
      id: reminder.id
    });
    assert.equal(removed.body.value.snapshot.policies.all.length, 0);
  } finally {
    t.dispose();
  }
});
