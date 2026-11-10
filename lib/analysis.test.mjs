/**
 * lib/analysis.test.mjs —— 看板聚合单测。
 *
 * 关注三件事：
 * 1. 返回结构与 CONTRACT「聚合契约」完全一致；
 * 2. **每个聚合数字都能和明细加总对上**（验收 S-06 数据一致性）；
 * 3. 边界情况（空库、空月份、只有收入）不崩。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { explain, financeSnapshot, summarizeSnapshot } from './analysis.js';
import { buildDemoDb, createStore, normalizeDb } from './store.js';
import { EXPENSE_CATEGORIES } from './domain.js';

const NOW = Date.parse('2026-11-09T12:00:00+08:00');

/** 手工构造的小库，数字都能口算。 */
function sampleDb() {
  return normalizeDb({
    txns: [
      { id: 'txn_a', date: '2026-11-02', amount: 3400, direction: 'expense', category: '餐饮', purpose: '生活必须', merchant: '星巴克', confidence: 'rule' },
      { id: 'txn_b', date: '2026-11-03', amount: 500, direction: 'expense', category: '交通', purpose: '生活必须', merchant: '上海地铁', confidence: 'rule' },
      { id: 'txn_c', date: '2026-11-10', amount: 3200000, direction: 'income', category: '收入', merchant: '公司', confidence: 'rule' },
      { id: 'txn_d', date: '2026-11-12', amount: 550000, direction: 'expense', category: '居家', purpose: '生活必须', merchant: '房租', confidence: 'default' },
      { id: 'txn_e', date: '2026-11-15', amount: 26800, direction: 'expense', category: '餐饮', purpose: '娱乐享受', merchant: '海底捞', confidence: 'user' },
      // 不计入收支
      { id: 'txn_f', date: '2026-11-16', amount: 200000, direction: 'expense', category: '投资', purpose: '未来保障', merchant: '天天基金', money: true },
      // 上个月
      { id: 'txn_g', date: '2026-10-05', amount: 100000, direction: 'expense', category: '购物', purpose: '生活必须', merchant: '京东' },
      { id: 'txn_h', date: '2026-10-05', amount: 3000000, direction: 'income', category: '收入', merchant: '公司' },
    ],
    assets: [
      { id: 'ast_a', name: '招行活期', kind: 'cash', value: 1000000 },
      { id: 'ast_b', name: '基金', kind: 'investment', value: 2000000 },
    ],
    liabilities: [
      { id: 'lia_a', name: '房贷', kind: 'mortgage', balance: 2500000, monthlyPayment: 120000, dueDay: 15 },
      { id: 'lia_b', name: '信用卡', kind: 'credit', balance: 300000, monthlyPayment: 300000, dueDay: 5 },
    ],
    holdings: [
      { id: 'hold_a', name: '沪深300ETF', type: 'fund', shares: 1000, costPrice: 4000, price: 4400 },
      { id: 'hold_b', name: '某股票', type: 'stock', shares: 100, costPrice: 20000, price: 18000 },
    ],
    budgets: [
      { id: 'bud_a', month: '2026-11', category: '餐饮', limit: 50000 },
      { id: 'bud_b', month: 'default', category: '餐饮', limit: 100000 },
      { id: 'bud_c', month: 'default', category: '交通', limit: 1000 },
    ],
    goals: [
      { id: 'goal_a', name: '应急金', target: 1000000, saved: 500000, deadline: '2027-05-31' },
    ],
    settings: { currency: 'CNY', emergencyMonths: 6 },
  });
}

test('返回结构与 CONTRACT 聚合契约逐字段一致', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.deepEqual(Object.keys(snap).sort(), [
    'assets', 'budgetTotal', 'budgets', 'byCategory', 'byPurpose', 'goals', 'invest',
    'liabilities', 'month', 'monthsAvailable', 'netWorth', 'netWorthTrend',
    'dataNotes', 'policies', 'summary', 'tips', 'topExpenses', 'trend', 'yearly',
  ].sort());
  // 保单/到期提醒：面板的保单页与总看板提醒卡都靠它
  assert.deepEqual(Object.keys(snap.policies).sort(), [
    'all', 'items', 'next', 'overdue', 'soon', 'totalAmount', 'totalPremium',
  ]);
  // 年度汇总：今年一共花了多少、剩多少，面板用它做「总看板」的大数
  assert.deepEqual(Object.keys(snap.yearly).sort(), [
    'avgExpense', 'avgIncome', 'balance', 'expense', 'income', 'months', 'txnCount', 'year',
  ]);
  assert.deepEqual(Object.keys(snap.summary).sort(), [
    'autoClassified', 'autoRate', 'balance', 'excludedCount', 'excludedExpense',
    'excludedIncome', 'expense', 'income', 'reviewCount', 'txnCount',
  ]);
  assert.deepEqual(Object.keys(snap.assets).sort(), ['byKind', 'items', 'total']);
  assert.deepEqual(Object.keys(snap.liabilities).sort(), ['items', 'total', 'upcoming']);
  assert.deepEqual(Object.keys(snap.invest).sort(), ['byType', 'cost', 'items', 'pnl', 'pnlRate', 'value']);
  assert.deepEqual(Object.keys(snap.budgetTotal).sort(), ['limit', 'spent', 'used']);
  for (const item of snap.byCategory) assert.deepEqual(Object.keys(item).sort(), ['amount', 'category', 'count', 'share']);
  for (const item of snap.trend) assert.deepEqual(Object.keys(item).sort(), ['balance', 'expense', 'income', 'month']);
  for (const item of snap.netWorthTrend) assert.deepEqual(Object.keys(item).sort(), ['month', 'netWorth']);
  for (const item of snap.topExpenses) assert.deepEqual(Object.keys(item).sort(), ['amount', 'category', 'date', 'id', 'merchant']);
  for (const item of snap.budgets) assert.deepEqual(Object.keys(item).sort(), ['category', 'id', 'limit', 'over', 'source', 'spent', 'used']);
  for (const tip of snap.tips) assert.deepEqual(Object.keys(tip).sort(), ['detail', 'level', 'title']);
});

test('summary：收入/支出/结余，money 标记的行不进收支', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.equal(snap.month, '2026-11');
  assert.equal(snap.summary.income, 3200000);
  assert.equal(snap.summary.expense, 3400 + 500 + 550000 + 26800);
  assert.equal(snap.summary.balance, snap.summary.income - snap.summary.expense);
  assert.equal(snap.summary.txnCount, 6, 'txnCount 含 money 行（笔数口径）');
  assert.equal(snap.summary.autoClassified, 4, 'confidence 为 rule/user 的支出+收入行');
  assert.equal(snap.summary.autoRate, Math.round((4 / 6) * 10000) / 10000);
});

test('byCategory / byPurpose：降序、share 是 0-1、加总等于总支出', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.deepEqual(snap.byCategory.map((x) => x.category), ['居家', '餐饮', '交通']);
  assert.deepEqual(snap.byCategory.map((x) => x.amount), [550000, 3400 + 26800, 500]);
  assert.deepEqual(snap.byCategory.map((x) => x.count), [1, 2, 1]);
  const sum = snap.byCategory.reduce((acc, x) => acc + x.amount, 0);
  assert.equal(sum, snap.summary.expense, '分类加总必须等于总支出');
  for (const item of snap.byCategory) {
    assert.ok(item.share > 0 && item.share <= 1);
    assert.equal(item.share, Math.round((item.amount / snap.summary.expense) * 10000) / 10000);
  }
  // 目的：生活必须 = 房租+地铁+星巴克；娱乐享受 = 海底捞
  assert.deepEqual(snap.byPurpose.map((x) => x.purpose), ['生活必须', '娱乐享受']);
  assert.equal(snap.byPurpose.reduce((acc, x) => acc + x.amount, 0), snap.summary.expense);
  assert.equal(snap.byPurpose[0].count, 3);
});

test('trend：最近 12 个月升序、补齐空月', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  // 12 个月是「一眼看完整年」的天然单位，柱状图用它铺满 12 根柱子
  assert.deepEqual(snap.trend.map((x) => x.month), [
    '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
    '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11',
  ]);
  const oct = snap.trend.find((x) => x.month === '2026-10');
  assert.deepEqual(oct, { month: '2026-10', income: 3000000, expense: 100000, balance: 2900000 });
  const jul = snap.trend.find((x) => x.month === '2026-07');
  assert.deepEqual(jul, { month: '2026-07', income: 0, expense: 0, balance: 0 });
  // trend 里每月结余 = income - expense
  for (const item of snap.trend) assert.equal(item.balance, item.income - item.expense);
});

test('topExpenses：本月最大 5 笔，降序', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.equal(snap.topExpenses.length, 4);
  assert.deepEqual(snap.topExpenses.map((x) => x.merchant), ['房租', '海底捞', '星巴克', '上海地铁']);
  assert.equal(snap.topExpenses[0].amount, 550000);
  // money 行不进大额榜
  assert.ok(!snap.topExpenses.some((x) => x.merchant === '天天基金'));
});

test('assets / liabilities / netWorth', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.equal(snap.assets.total, 3000000);
  assert.deepEqual(snap.assets.byKind.map((x) => x.kind), ['investment', 'cash']);
  assert.equal(snap.assets.byKind.reduce((a, x) => a + x.amount, 0), snap.assets.total);
  assert.equal(snap.assets.byKind[0].share, 0.6667);

  assert.equal(snap.liabilities.total, 2800000);
  assert.equal(snap.liabilities.items[0].name, '房贷');
  const due = snap.liabilities.items.find((x) => x.name === '房贷');
  assert.equal(due.dueInDays, 6, '今天是 11-09，15 号还款');
  assert.equal(due.dueDate, '2026-11-15');
  assert.equal(typeof due.overdue, 'boolean');

  // upcoming：未来一个自然月内要还的（房贷 15 号 6 天、信用卡 5 号 26 天）
  assert.deepEqual(snap.liabilities.upcoming.map((x) => x.name), ['房贷', '信用卡']);
  assert.equal(snap.liabilities.upcoming[0].amount, 120000);
  assert.equal(snap.liabilities.upcoming[1].amount, 300000);

  assert.equal(snap.netWorth, 3000000 - 2800000);
});

test('netWorthTrend：锚定当前净资产、按结余反推、月数与 trend 相同', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.equal(snap.netWorthTrend.length, snap.trend.length);
  assert.deepEqual(snap.netWorthTrend.map((x) => x.month), snap.trend.map((x) => x.month));
  const last = snap.netWorthTrend[snap.netWorthTrend.length - 1];
  assert.equal(last.netWorth, snap.netWorth, '最后一项就是当前净资产');
  // 上个月 = 本月 - 本月结余
  for (let i = 1; i < snap.netWorthTrend.length; i += 1) {
    assert.equal(
      snap.netWorthTrend[i - 1].netWorth,
      snap.netWorthTrend[i].netWorth - snap.trend[i].balance,
    );
  }
  const novIndex = snap.trend.findIndex((x) => x.month === '2026-11');
  assert.equal(
    snap.netWorthTrend[novIndex - 1].netWorth,
    snap.netWorth - snap.trend[novIndex].balance,
  );
});

test('invest：成本/市值/盈亏/收益率/配置比例，逐笔盈亏可加总', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.equal(snap.invest.cost, 1000 * 4000 + 100 * 20000);
  assert.equal(snap.invest.value, 1000 * 4400 + 100 * 18000);
  assert.equal(snap.invest.pnl, snap.invest.value - snap.invest.cost);
  assert.equal(snap.invest.pnlRate, Math.round((snap.invest.pnl / snap.invest.cost) * 10000) / 10000);
  assert.equal(snap.invest.items.reduce((a, x) => a + x.pnl, 0), snap.invest.pnl);
  assert.deepEqual(snap.invest.byType.map((x) => x.type), ['fund', 'stock']);
  assert.equal(snap.invest.byType.reduce((a, x) => a + x.share, 0), 1);
  const stock = snap.invest.items.find((x) => x.name === '某股票');
  assert.equal(stock.pnl, -200000);
  assert.equal(stock.pnlRate, -0.1);
});

test('budgets：当月优先于 default，spent 是当月该分类支出', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  const food = snap.budgets.find((b) => b.category === '餐饮');
  assert.equal(food.limit, 50000, '当月预算优先');
  assert.equal(food.source, 'month');
  assert.equal(food.spent, 3400 + 26800);
  assert.equal(food.over, false);
  const traffic = snap.budgets.find((b) => b.category === '交通');
  assert.equal(traffic.limit, 1000, '没有当月预算用 default');
  assert.equal(traffic.source, 'default');
  assert.equal(traffic.spent, 500);
  assert.equal(traffic.over, false);
  // budgetTotal 等于各项加总
  assert.equal(snap.budgetTotal.limit, snap.budgets.reduce((a, b) => a + b.limit, 0));
  assert.equal(snap.budgetTotal.spent, snap.budgets.reduce((a, b) => a + b.spent, 0));
});

test('budgets：超支标记', () => {
  const db = sampleDb();
  db.budgets.find((b) => b.id === 'bud_a').limit = 1000; // 餐饮当月预算设成 10 元
  const snap = financeSnapshot(db, { month: '2026-11', now: NOW });
  const food = snap.budgets.find((b) => b.category === '餐饮');
  assert.equal(food.over, true);
  assert.ok(food.used > 1);
  assert.ok(snap.tips.some((tip) => tip.level === 'warn' && tip.title.includes('超出预算')));
});

test('goals：progress / remainingMonths / monthlyNeeded', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  const goal = snap.goals[0];
  assert.equal(goal.progress, 0.5);
  assert.equal(goal.remaining, 500000);
  assert.ok(goal.remainingMonths > 5 && goal.remainingMonths < 8, `剩余月数异常：${goal.remainingMonths}`);
  assert.equal(goal.monthlyNeeded, Math.ceil(goal.remaining / goal.remainingMonths));
  // 原字段保留
  assert.equal(goal.name, '应急金');
  assert.equal(goal.target, 1000000);
});

test('goals：没有截止日期时 remainingMonths 为 0，monthlyNeeded = 剩余', () => {
  const db = sampleDb();
  db.goals[0].deadline = '';
  const snap = financeSnapshot(db, { month: '2026-11', now: NOW });
  assert.equal(snap.goals[0].remainingMonths, 0);
  assert.equal(snap.goals[0].monthlyNeeded, 500000);
});

test('tips：只讲通用事实，绝不推荐买卖', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.ok(snap.tips.length >= 3);
  const banned = ['买入', '卖出', '加仓', '减仓', '抄底', '清仓', '推荐购买', '建议买', '建议卖', '止盈', '止损'];
  for (const tip of snap.tips) {
    assert.ok(['info', 'warn', 'good'].includes(tip.level), `非法 level ${tip.level}`);
    assert.ok(tip.title.length > 0 && tip.detail.length > 0);
    const text = `${tip.title}${tip.detail}`;
    for (const word of banned) {
      assert.ok(!text.includes(word), `提示里出现了投资建议：「${text}」`);
    }
  }
  // 应该有应急金 / 负债率 / 结余率这类通用提示
  const titles = snap.tips.map((t) => t.title).join('|');
  assert.ok(titles.includes('应急金'));
  assert.ok(titles.includes('负债率') || titles.includes('资产'));
});

test('tips：结余为负时给出 warn', () => {
  const db = normalizeDb({
    txns: [
      { date: '2026-11-02', amount: 100000, direction: 'income', merchant: '兼职' },
      { date: '2026-11-03', amount: 500000, direction: 'expense', merchant: '房租' },
    ],
    assets: [{ name: '现金', kind: 'cash', value: 50000 }],
  });
  const snap = financeSnapshot(db, { month: '2026-11', now: NOW });
  assert.ok(snap.tips.some((tip) => tip.level === 'warn' && tip.title.includes('支出超过收入')));
});

test('空库不崩：所有数组为空、数字为 0', () => {
  const snap = financeSnapshot({}, { now: NOW });
  assert.equal(snap.summary.income, 0);
  assert.equal(snap.summary.expense, 0);
  assert.equal(snap.summary.balance, 0);
  assert.equal(snap.summary.autoRate, 0);
  assert.deepEqual(snap.byCategory, []);
  assert.deepEqual(snap.byPurpose, []);
  assert.deepEqual(snap.topExpenses, []);
  assert.equal(snap.trend.length, 12);
  assert.equal(snap.assets.total, 0);
  assert.equal(snap.liabilities.total, 0);
  assert.equal(snap.netWorth, 0);
  assert.equal(snap.invest.pnlRate, 0, '成本为 0 时收益率不能是 NaN');
  assert.equal(snap.budgetTotal.used, 0);
  assert.deepEqual(snap.goals, []);
  assert.ok(snap.tips.length >= 1);
});

test('undefined / null 输入不崩', () => {
  assert.doesNotThrow(() => financeSnapshot(undefined));
  assert.doesNotThrow(() => financeSnapshot(null));
});

test('monthsAvailable：倒序的唯一月份列表', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.deepEqual(snap.monthsAvailable, ['2026-11', '2026-10']);
});

test('缺省 month 取最新有数据的月份', () => {
  const snap = financeSnapshot(sampleDb(), { now: NOW });
  assert.equal(snap.month, '2026-11');
  const onlyOld = normalizeDb({ txns: [{ date: '2026-03-01', amount: 100, merchant: 'x' }] });
  assert.equal(financeSnapshot(onlyOld, { now: NOW }).month, '2026-03');
  // 完全空库 → 当前月
  assert.equal(financeSnapshot({}, { now: NOW }).month, '2026-11');
});

test('月度切换：换 month 后数字跟着变', () => {
  const db = sampleDb();
  const nov = financeSnapshot(db, { month: '2026-11', now: NOW });
  const oct = financeSnapshot(db, { month: '2026-10', now: NOW });
  assert.notEqual(nov.summary.expense, oct.summary.expense);
  assert.equal(oct.summary.expense, 100000);
  assert.equal(oct.summary.income, 3000000);
  // 空月份也是合法结果
  const sep = financeSnapshot(db, { month: '2026-09', now: NOW });
  assert.equal(sep.summary.txnCount, 0);
  assert.equal(sep.summary.expense, 0);
  assert.equal(sep.netWorth, nov.netWorth, '净资产不随所选月份变化');
});

test('示例数据：所有聚合数字与明细一致（数据一致性验收）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-analysis-'));
  try {
    const store = createStore({ file: join(dir, 'finance.json') });
    await store.seedDemo(NOW);
    const db = store.snapshot();
    const snap = financeSnapshot(db, { month: snapMonthIn(db), now: NOW });

    // 1) 收入/支出与逐笔加总一致
    const monthTxns = db.txns.filter((t) => t.date.startsWith(snap.month) && !t.money);
    const income = monthTxns.filter((t) => t.direction === 'income').reduce((a, t) => a + t.amount, 0);
    const expense = monthTxns.filter((t) => t.direction === 'expense').reduce((a, t) => a + t.amount, 0);
    assert.equal(snap.summary.income, income);
    assert.equal(snap.summary.expense, expense);

    // 2) 分类 / 目的加总一致
    assert.equal(snap.byCategory.reduce((a, x) => a + x.amount, 0), expense);
    assert.equal(snap.byPurpose.reduce((a, x) => a + x.amount, 0), expense);
    for (const item of snap.byCategory) {
      const direct = monthTxns
        .filter((t) => t.direction === 'expense' && t.category === item.category)
        .reduce((a, t) => a + t.amount, 0);
      assert.equal(item.amount, direct, `${item.category} 分类金额与明细不一致`);
      assert.equal(item.count, monthTxns.filter((t) => t.direction === 'expense' && t.category === item.category).length);
    }

    // 3) 资产 / 负债 / 净资产
    assert.equal(snap.assets.total, db.assets.reduce((a, x) => a + x.value, 0));
    assert.equal(snap.liabilities.total, db.liabilities.reduce((a, x) => a + x.balance, 0));
    assert.equal(snap.netWorth, snap.assets.total - snap.liabilities.total);

    // 4) 预算 spent 与明细一致
    for (const budget of snap.budgets) {
      const direct = monthTxns
        .filter((t) => t.direction === 'expense' && t.category === budget.category)
        .reduce((a, t) => a + t.amount, 0);
      assert.equal(budget.spent, direct, `${budget.category} 预算花费与明细不一致`);
    }

    // 5) 持仓盈亏加总
    assert.equal(snap.invest.items.reduce((a, x) => a + x.pnl, 0), snap.invest.pnl);

    // 6) 所有金额都是整数分
    const integers = [
      snap.summary.income, snap.summary.expense, snap.summary.balance,
      snap.assets.total, snap.liabilities.total, snap.netWorth,
      snap.invest.cost, snap.invest.value, snap.invest.pnl,
      ...snap.trend.flatMap((x) => [x.income, x.expense, x.balance]),
      ...snap.netWorthTrend.map((x) => x.netWorth),
      ...snap.byCategory.map((x) => x.amount),
      ...snap.budgets.flatMap((x) => [x.limit, x.spent]),
    ];
    for (const value of integers) assert.ok(Number.isInteger(value), `不是整数分：${value}`);

    // 7) 分类都在合法集合里
    for (const item of snap.byCategory) {
      assert.ok(EXPENSE_CATEGORIES.includes(item.category), `非法分类 ${item.category}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 取库里最新月份。 */
function snapMonthIn(db) {
  return db.txns.map((t) => t.date.slice(0, 7)).sort().pop();
}

test('演示数据在最近半年每个月都能出快照', () => {
  const db = normalizeDb(buildDemoDb(NOW), { now: NOW });
  for (const month of ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']) {
    const snap = financeSnapshot(db, { month, now: NOW });
    assert.equal(snap.month, month);
    assert.ok(snap.summary.txnCount > 0, `${month} 没有流水`);
    assert.ok(snap.summary.expense > 0, `${month} 没有支出`);
    assert.equal(snap.byCategory.reduce((a, x) => a + x.amount, 0), snap.summary.expense);
  }
});

test('explain：按路径取快照值（调试用）', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.equal(explain(snap, 'summary.expense'), snap.summary.expense);
  assert.equal(explain(snap, 'byCategory[0].category'), '居家');
  assert.equal(explain(snap, 'trend[11].month'), '2026-11');
  assert.equal(explain(snap, '不存在的路径'), undefined);
  assert.equal(explain(snap, ''), snap);
});

test('summarizeSnapshot：给模型看的纯文本摘要', () => {
  const snap = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  const text = summarizeSnapshot(snap);
  assert.ok(text.includes('2026-11'));
  assert.ok(text.includes('收入'));
  assert.ok(text.includes('支出'));
  assert.equal(summarizeSnapshot({}), '还没有可用的财务数据。');
});

test('month 参数非法时回退到最新月份', () => {
  const db = sampleDb();
  assert.equal(financeSnapshot(db, { month: '2026-13', now: NOW }).month, '2026-11');
  assert.equal(financeSnapshot(db, { month: 'abc', now: NOW }).month, '2026-11');
});
/* ------------------------------------------------------------------ */
/* 端到端：样例账单 → 导入 → 分类 → 聚合                                  */
/* ------------------------------------------------------------------ */

test('端到端：导入支付宝样例 51 笔，快照数字与原始账单金额一致', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { parseBillWithCategories } = await import('./importer.js');

  const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'fixtures');
  const parsed = parseBillWithCategories({ name: 'alipay-sample.csv', content: readFileSync(join(fixtures, 'alipay-sample.csv')) });
  assert.ok(parsed.rows.length >= 50, '样例应 ≥50 行');

  const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-e2e-'));
  try {
    const store = createStore({ file: join(dir, 'finance.json') });
    const result = await store.importRows({ name: 'alipay-sample.csv', rows: parsed.rows, format: parsed.format });
    assert.equal(result.added, parsed.rows.length);
    assert.equal(result.duplicates, 0);

    const snap = financeSnapshot(store.snapshot(), { month: '2026-11', now: NOW });
    // 与解析结果直接加总比对。注意：被判定为「不计收支」的行（转账、信用卡还款）
    // 不出现在收支大数里，但仍计入 txnCount 与 excludedCount。
    const countable = parsed.rows.filter((r) => r.money !== true);
    const expense = countable.filter((r) => r.direction === 'expense').reduce((a, r) => a + r.amount, 0);
    const income = countable.filter((r) => r.direction === 'income').reduce((a, r) => a + r.amount, 0);
    assert.equal(snap.summary.expense, expense, '支出 = 计入收支的支出之和');
    assert.equal(snap.summary.income, income, '收入 = 计入收支的收入之和');
    assert.equal(snap.summary.txnCount, parsed.rows.length, '流水总数含不计收支的行');
    // 被排除的行数与金额要对得上，面板据此显示「另有 N 笔转账未计入」
    const excluded = parsed.rows.filter((r) => r.money === true);
    assert.equal(snap.summary.excludedCount, excluded.length);
    assert.ok(excluded.length > 0, '这份样例里应有信用卡还款/转账被排除');
    assert.equal(
      snap.summary.excludedExpense,
      excluded.filter((r) => r.direction === 'expense').reduce((a, r) => a + r.amount, 0),
    );
    // 自动分类率 ≥ 70%
    assert.ok(snap.summary.autoRate >= 0.7, `自动分类率 ${snap.summary.autoRate}`);
    // 二次导入全部去重
    const again = await store.importRows({ name: 'alipay-sample.csv', rows: parsed.rows, format: parsed.format });
    assert.equal(again.added, 0);
    assert.equal(again.duplicates, parsed.rows.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('只有支出没有收入时，年结余会被标注为数据可能不完整', () => {
  // 真实场景：只导了微信账单（几乎不含工资），年结余会显示成巨额负数。
  // 这时候必须说清楚「收入账单可能没导」，而不是让用户以为自己花超了。
  const db = sampleDb();
  db.txns = db.txns.filter((txn) => txn.direction !== 'income');
  const snap = financeSnapshot(db, { month: '2026-11', now: NOW });
  assert.ok(snap.dataNotes.length > 0, '应给出数据完整性提醒');
  assert.equal(snap.dataNotes[0].level, 'warn');
  assert.match(snap.dataNotes[0].title, /收入/u);

  // 收支正常的账本不该打扰
  const healthy = financeSnapshot(sampleDb(), { month: '2026-11', now: NOW });
  assert.deepEqual(healthy.dataNotes, []);
});
