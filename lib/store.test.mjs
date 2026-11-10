/**
 * lib/store.test.mjs —— 存储层单测（全部使用 mkdtempSync 临时目录）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDemoDb,
  createStore,
  defaultDataFile,
  normalizeDb,
  nextDue,
} from './store.js';
import { DB_VERSION, dedupeKeyOf } from './domain.js';

/** 每个测试一个独立的临时目录。 */
function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-store-'));
  const file = join(dir, 'finance.json');
  const logs = [];
  const store = createStore({ file, log: (event) => logs.push(event) });
  return { dir, file, store, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('默认路径是 ~/.dsh/dsh-finance/finance.json', () => {
  assert.ok(defaultDataFile().endsWith(join('.dsh', 'dsh-finance', 'finance.json')));
  const t = tempStore();
  try {
    assert.equal(t.store.path(), t.file);
    assert.equal(t.store.describeStorage().persist, 'atomic-tmp-rename');
  } finally {
    t.cleanup();
  }
});

test('构造阶段不抛异常；空库快照结构完整', async () => {
  const t = tempStore();
  try {
    await t.store.ready();
    const snap = t.store.snapshot();
    assert.equal(snap.version, DB_VERSION);
    assert.deepEqual(snap.txns, []);
    assert.deepEqual(snap.settings, { currency: 'CNY', emergencyMonths: 6 });
    assert.equal(t.store.describeStorage().exists, false);
  } finally {
    t.cleanup();
  }
});

test('路径不可写时也只是降级，不抛异常（构造阶段）', () => {
  // 指向一个不存在的深层路径不会抛；指向文件名的父级是文件则会写失败
  const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-store-'));
  const blocker = join(dir, 'not-a-dir');
  writeFileSync(blocker, 'x');
  const store = createStore({ file: join(blocker, 'finance.json') });
  assert.doesNotThrow(() => store.snapshot());
  assert.equal(store.describeStorage().exists, false);
  rmSync(dir, { recursive: true, force: true });
});

test('addTxn：自动补分类/目的/去重键，并原子落盘', async () => {
  const t = tempStore();
  try {
    const { txn, snapshot } = await t.store.addTxn({ date: '2026-11-03', amount: 3400, direction: 'expense', merchant: '星巴克' });
    assert.match(txn.id, /^txn_[a-z0-9]{8}$/);
    assert.equal(txn.category, '餐饮');
    assert.equal(txn.purpose, '生活必须');
    assert.equal(txn.source, 'manual');
    assert.equal(txn.amount, 3400);
    assert.equal(txn.dedupeKey, dedupeKeyOf({ date: '2026-11-03', amount: 3400, direction: 'expense', merchant: '星巴克' }));
    assert.equal(snapshot.txns.length, 1);

    // 落盘：真文件里能读到
    const onDisk = JSON.parse(readFileSync(t.file, 'utf8'));
    assert.equal(onDisk.txns.length, 1);
    assert.equal(onDisk.txns[0].merchant, '星巴克');
    // 没有残留 tmp 文件
    assert.deepEqual(readdirSync(t.dir), ['finance.json']);

    // 重新打开能读回
    const store2 = createStore({ file: t.file });
    await store2.ready();
    assert.equal(store2.snapshot().txns.length, 1);
    assert.equal(store2.snapshot().txns[0].category, '餐饮');
  } finally {
    t.cleanup();
  }
});

test('addTxn：非法金额/重复记账报中文错误', async () => {
  const t = tempStore();
  try {
    await assert.rejects(() => t.store.addTxn({ date: '2026-11-03', amount: 0, merchant: 'x' }), /金额不能为 0/);
    await t.store.addTxn({ date: '2026-11-03', amount: 3400, merchant: '星巴克' });
    await assert.rejects(
      () => t.store.addTxn({ date: '2026-11-03', amount: 3400, merchant: '星巴克' }),
      /重复/,
    );
    // 明确允许重复时可以再记一笔
    const dup = await t.store.addTxn({ date: '2026-11-03', amount: 3400, merchant: '星巴克', allowDuplicate: true });
    assert.ok(dup.txn.id);
  } finally {
    t.cleanup();
  }
});

test('updateTxn：改分类会写进用户修正记忆 rules，下次自动命中', async () => {
  const t = tempStore();
  try {
    const { txn } = await t.store.addTxn({ date: '2026-11-03', amount: 3400, merchant: '星巴克' });
    const { txn: updated, snapshot } = await t.store.updateTxn(txn.id, { category: '娱乐', purpose: '娱乐享受' });
    assert.equal(updated.category, '娱乐');
    assert.deepEqual(snapshot.rules.星巴克, { category: '娱乐', purpose: '娱乐享受' });

    // 再记一笔同名商户 → 自动套用修正
    const { txn: next } = await t.store.addTxn({ date: '2026-11-04', amount: 2800, merchant: ' 星巴克(南京西路店) ' });
    assert.equal(next.category, '娱乐');
    assert.equal(next.purpose, '娱乐享受');

    // 改金额不该污染 rules
    await t.store.updateTxn(txn.id, { amount: 4000 });
    const rules = t.store.getRules();
    assert.deepEqual(rules, { 星巴克: { category: '娱乐', purpose: '娱乐享受' } });
  } finally {
    t.cleanup();
  }
});

test('updateTxn / removeTxn：找不到时报中文错误', async () => {
  const t = tempStore();
  try {
    await assert.rejects(() => t.store.updateTxn('txn_nope', { amount: 100 }), /找不到这笔账/);
    await assert.rejects(() => t.store.removeTxn('txn_nope'), /找不到这笔账/);
  } finally {
    t.cleanup();
  }
});

test('removeTxn 删除并落盘', async () => {
  const t = tempStore();
  try {
    const { txn } = await t.store.addTxn({ date: '2026-11-03', amount: 3400, merchant: '星巴克' });
    const { removed, snapshot } = await t.store.removeTxn(txn.id);
    assert.equal(removed.id, txn.id);
    assert.equal(snapshot.txns.length, 0);
    assert.equal(JSON.parse(readFileSync(t.file, 'utf8')).txns.length, 0);
  } finally {
    t.cleanup();
  }
});

test('listTxns：按月份/分类/关键词/方向过滤', async () => {
  const t = tempStore();
  try {
    await t.store.addTxn({ date: '2026-10-03', amount: 3400, merchant: '星巴克', category: '餐饮' });
    await t.store.addTxn({ date: '2026-11-03', amount: 500, merchant: '上海地铁', category: '交通' });
    await t.store.addTxn({ date: '2026-11-10', amount: 3200000, merchant: '公司', direction: 'income' });
    await t.store.addTxn({ date: '2026-11-12', amount: 1590, merchant: '瑞幸咖啡', category: '餐饮' });

    assert.equal(t.store.listTxns({ month: '2026-11' }).total, 3);
    assert.equal(t.store.listTxns({ month: '2026-10' }).total, 1);
    assert.equal(t.store.listTxns({ category: '餐饮' }).total, 2);
    assert.equal(t.store.listTxns({ q: '咖啡' }).total, 1);
    assert.equal(t.store.listTxns({ direction: 'income' }).total, 1);
    assert.equal(t.store.listTxns({ month: '2026-11', limit: 2 }).txns.length, 2);
    assert.equal(t.store.listTxns({ month: '2026-11', limit: 2 }).total, 3, 'total 不受 limit 影响');
    // 按日期倒序
    const list = t.store.listTxns({ month: '2026-11' }).txns;
    assert.deepEqual(list.map((x) => x.date), ['2026-11-12', '2026-11-10', '2026-11-03']);
  } finally {
    t.cleanup();
  }
});

test('importRows：按 dedupeKey 去重，并记录导入批次', async () => {
  const t = tempStore();
  try {
    const rows = [
      { date: '2026-11-01', amount: 3400, direction: 'expense', merchant: '星巴克', note: '拿铁' },
      { date: '2026-11-01', amount: 3400, direction: 'expense', merchant: ' 星巴克 ', note: '重复行' },
      { date: '2026-11-02', amount: 500, direction: 'expense', merchant: '上海地铁' },
      { date: '2026-11-03', amount: 3200000, direction: 'income', merchant: '公司' },
    ];
    const result = await t.store.importRows({ name: 'alipay.csv', rows, format: 'alipay-csv' });
    assert.equal(result.added, 3);
    assert.equal(result.duplicates, 1);
    assert.match(result.importId, /^imp_[a-z0-9]{8}$/);
    assert.equal(result.snapshot.txns.length, 3);
    assert.equal(result.snapshot.imports[0].file, 'alipay.csv');
    assert.equal(result.snapshot.imports[0].rows, 4);
    assert.equal(result.snapshot.imports[0].dup, 1);

    // 再导一次同样的 → 全部重复
    const again = await t.store.importRows({ name: 'alipay.csv', rows, format: 'alipay-csv' });
    assert.equal(again.added, 0);
    assert.equal(again.duplicates, 4, '同批次内的重复行再次导入时仍然算重复');
    assert.equal(t.store.snapshot().txns.length, 3);

    // 收入行分类固定
    const income = t.store.listTxns({ direction: 'income' }).txns[0];
    assert.equal(income.category, '收入');
  } finally {
    t.cleanup();
  }
});

test('importRows：空数组报错，坏行计入 invalid 不中断', async () => {
  const t = tempStore();
  try {
    await assert.rejects(() => t.store.importRows({ rows: [] }), /没有可导入的行/);
    const good = { date: '2026-11-01', amount: 3400, direction: 'expense', merchant: '星巴克' };
    const result = await t.store.importRows({ rows: [good, { date: '', amount: '', merchant: '坏行' }] });
    assert.equal(result.added, 1);
    assert.equal(result.invalid, 1);
    assert.ok(result.message.includes('1 行'));
  } finally {
    t.cleanup();
  }
});

test('资产 / 负债 / 持仓 CRUD', async () => {
  const t = tempStore();
  try {
    const { asset } = await t.store.addAsset({ name: '招行活期', kind: 'cash', value: 1000000, account: '招商银行' });
    assert.match(asset.id, /^ast_[a-z0-9]{8}$/);
    await assert.rejects(() => t.store.addAsset({ name: '招行活期', kind: 'cash', value: 1 }), /同名同类型/);
    await assert.rejects(() => t.store.addAsset({ name: '', value: 1 }), /名称不能为空/);
    const { asset: updated } = await t.store.updateAsset(asset.id, { value: 2000000 });
    assert.equal(updated.value, 2000000);
    assert.equal(t.store.listAssets().length, 1);
    await t.store.removeAsset(asset.id);
    assert.equal(t.store.listAssets().length, 0);

    const { liability } = await t.store.addLiability({ name: '房贷', kind: 'mortgage', balance: 8600000, monthlyPayment: 780000, dueDay: 15 });
    assert.match(liability.id, /^lia_[a-z0-9]{8}$/);
    assert.equal(liability.dueDay, 15);
    await t.store.updateLiability(liability.id, { dueDay: 99 });
    assert.equal(t.store.listLiabilities()[0].dueDay, 31, 'dueDay 越界要钳制');
    await t.store.removeLiability(liability.id);
    assert.equal(t.store.listLiabilities().length, 0);

    const { holding } = await t.store.addHolding({ name: '沪深300ETF', code: '510300', type: 'fund', shares: 1000, costPrice: 4120, price: 4350 });
    assert.match(holding.id, /^hold_[a-z0-9]{8}$/);
    await t.store.updateHolding(holding.id, { price: 4400 });
    assert.equal(t.store.listHoldings()[0].price, 4400);
    await t.store.removeHolding(holding.id);
    assert.equal(t.store.listHoldings().length, 0);
  } finally {
    t.cleanup();
  }
});

test('预算：set/remove、当月优先于 default', async () => {
  const t = tempStore();
  try {
    const { budget } = await t.store.setBudget('2026-11', '餐饮', 220000);
    assert.match(budget.id, /^bud_[a-z0-9]{8}$/);
    await t.store.setBudget('2026-11', '餐饮', 250000); // 覆盖
    assert.equal(t.store.listBudgets().filter((b) => b.month === '2026-11').length, 1);
    assert.equal(t.store.listBudgets().find((b) => b.month === '2026-11').limit, 250000);
    await t.store.setBudget('default', '餐饮', 300000);
    assert.equal(t.store.listBudgets().length, 2);
    await assert.rejects(() => t.store.setBudget('2026-11', '不存在的分类', 100), /预算分类不对/);
    await assert.rejects(() => t.store.setBudget('2026-11', '餐饮', 0), /大于 0/);
    await t.store.removeBudget(budget.id);
    assert.equal(t.store.listBudgets().length, 1);
  } finally {
    t.cleanup();
  }
});

test('目标：add / contribute / update / remove', async () => {
  const t = tempStore();
  try {
    const { goal } = await t.store.addGoal({ name: '应急金', target: 5000000, saved: 1000000, deadline: '2027-06-30' });
    assert.match(goal.id, /^goal_[a-z0-9]{8}$/);
    const { goal: afterSave } = await t.store.contributeGoal(goal.id, 500000);
    assert.equal(afterSave.saved, 1500000);
    const { goal: capped } = await t.store.contributeGoal(goal.id, 99000000);
    assert.equal(capped.saved, 5000000, '超过目标要封顶');
    const { goal: negative } = await t.store.contributeGoal(goal.id, -100000);
    assert.equal(negative.saved, 4900000);
    await t.store.updateGoal(goal.id, { name: '家庭应急金' });
    assert.equal(t.store.listGoals()[0].name, '家庭应急金');
    await assert.rejects(() => t.store.addGoal({ name: '', target: 100 }), /名称不能为空/);
    await assert.rejects(() => t.store.addGoal({ name: 'x', target: 0 }), /目标金额必须大于 0/);
    await t.store.removeGoal(goal.id);
    assert.equal(t.store.listGoals().length, 0);
  } finally {
    t.cleanup();
  }
});

test('设置与用户规则', async () => {
  const t = tempStore();
  try {
    assert.deepEqual(t.store.getSettings(), { currency: 'CNY', emergencyMonths: 6, demo: false, demoOffered: false });
    await t.store.updateSettings({ emergencyMonths: 9 });
    assert.equal(t.store.getSettings().emergencyMonths, 9);
    await assert.rejects(() => t.store.rememberRule('', { category: '餐饮' }), /商户名为空/);
    await assert.rejects(() => t.store.rememberRule('美团', {}), /至少要给分类或目的/);
    const { key, rule } = await t.store.rememberRule('美团外卖', { category: '餐饮' });
    assert.equal(key, '美团外卖');
    assert.deepEqual(rule, { category: '餐饮', purpose: '生活必须' });
    assert.deepEqual(t.store.getRules(), { 美团外卖: { category: '餐饮', purpose: '生活必须' } });
  } finally {
    t.cleanup();
  }
});

test('getDb 是浅拷贝：改它不会影响库', async () => {
  const t = tempStore();
  try {
    await t.store.addTxn({ date: '2026-11-03', amount: 3400, merchant: '星巴克' });
    const db = t.store.getDb();
    db.txns.push({ id: 'hack' });
    db.settings.currency = 'USD';
    assert.equal(t.store.snapshot().txns.length, 1);
    assert.equal(t.store.getSettings().currency, 'CNY');
  } finally {
    t.cleanup();
  }
});

test('exportJson / replaceDb / clearAll', async () => {
  const t = tempStore();
  try {
    await t.store.addTxn({ date: '2026-11-03', amount: 3400, merchant: '星巴克' });
    await t.store.addAsset({ name: '现金', value: 100000 });
    const exported = t.store.exportJson();
    assert.equal(exported.txns.length, 1);
    assert.equal(exported.assets.length, 1);

    await t.store.clearAll();
    assert.equal(t.store.snapshot().txns.length, 0);
    assert.equal(t.store.snapshot().assets.length, 0);

    const { snapshot } = await t.store.replaceDb(exported);
    assert.equal(snapshot.txns.length, 1);
    assert.equal(snapshot.assets.length, 1);
    assert.equal(t.store.snapshot().txns[0].category, '餐饮', '分类在归一化时保留');
  } finally {
    t.cleanup();
  }
});

test('replaceDb 容忍脏数据（丢弃坏行而不是整库失败）', async () => {
  const t = tempStore();
  try {
    const { snapshot } = await t.store.replaceDb({
      txns: [
        { date: '2026-11-03', amount: 3400, merchant: '星巴克' },
        { date: 'bad', amount: 100, merchant: '坏行' },
        { amount: 0, merchant: '零金额' },
      ],
      assets: [{ name: '' }, { name: '现金', value: 100 }],
      rules: { 星巴克: { category: '餐饮', purpose: '娱乐享受' }, 坏: { category: '不存在' } },
    });
    assert.equal(snapshot.txns.length, 1);
    assert.equal(snapshot.assets.length, 1);
    assert.deepEqual(snapshot.rules, { 星巴克: { category: '餐饮', purpose: '娱乐享受' } });
  } finally {
    t.cleanup();
  }
});

test('坏文件：备份成 .corrupt-<ts>，从空库开始，describeStorage 说明原因', async () => {
  const t = tempStore();
  try {
    writeFileSync(t.file, '{ 这不是 JSON', 'utf8');
    const store = createStore({ file: t.file });
    await store.ready();
    const desc = store.describeStorage();
    assert.ok(desc.corruptBackup.includes('.corrupt-'));
    assert.ok(existsSync(desc.corruptBackup));
    assert.equal(readFileSync(desc.corruptBackup, 'utf8'), '{ 这不是 JSON');
    assert.ok(desc.notes.some((note) => note.includes('数据文件损坏')));
    assert.equal(store.snapshot().txns.length, 0);
    // 之后还能正常写
    await store.addTxn({ date: '2026-11-03', amount: 3400, merchant: '星巴克' });
    assert.equal(store.snapshot().txns.length, 1);
  } finally {
    t.cleanup();
  }
});

test('写操作串行：并发 30 笔全部落盘且不丢', async () => {
  const t = tempStore();
  try {
    const jobs = [];
    for (let i = 0; i < 30; i += 1) {
      jobs.push(t.store.addTxn({ date: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`, amount: 100 + i, merchant: `商户${i}` }));
    }
    const results = await Promise.all(jobs);
    assert.equal(results.length, 30);
    assert.equal(t.store.snapshot().txns.length, 30);
    const onDisk = JSON.parse(readFileSync(t.file, 'utf8'));
    assert.equal(onDisk.txns.length, 30);
    // 单次写失败不会打断队列
    await assert.rejects(() => t.store.updateTxn('nope', {}));
    await t.store.addTxn({ date: '2026-11-29', amount: 999, merchant: '串行校验' });
    assert.equal(t.store.snapshot().txns.length, 31);
    assert.equal(t.store.describeStorage().writes, 31);
  } finally {
    t.cleanup();
  }
});

test('seedDemo：空库写入 12 个月、真实质感的演示账本；非空库拒绝', async () => {
  const t = tempStore();
  try {
    const now = Date.parse('2026-11-09T12:00:00+08:00');
    const { snapshot } = await t.store.seedDemo(now);
    assert.ok(snapshot.txns.length >= 400, `演示流水只有 ${snapshot.txns.length} 笔`);
    const months = new Set(snapshot.txns.map((txn) => txn.date.slice(0, 7)));
    assert.equal(months.size, 12, '应覆盖 12 个月');
    assert.ok(snapshot.txns.every((txn) => txn.amount > 0 && Number.isInteger(txn.amount)));
    assert.ok(snapshot.txns.filter((txn) => txn.direction === 'income').length >= 12);
    assert.ok(snapshot.assets.length >= 4);
    assert.ok(snapshot.liabilities.length >= 1);
    assert.ok(snapshot.holdings.length >= 3);
    assert.ok(snapshot.budgets.length >= 2);
    assert.ok(snapshot.goals.length >= 1);
    assert.deepEqual(Object.keys(snapshot.rules).length >= 1, true);
    // 演示数据没有重复键
    assert.equal(new Set(snapshot.txns.map((txn) => txn.dedupeKey)).size, snapshot.txns.length);
    // 每月都有收入也有支出
    for (const month of months) {
      const list = snapshot.txns.filter((txn) => txn.date.startsWith(month));
      assert.ok(list.some((txn) => txn.direction === 'income'), `${month} 没有收入`);
      assert.ok(list.some((txn) => txn.direction === 'expense'), `${month} 没有支出`);
    }
    // 打工人的账本不该只有单一分类：演示数据要能撑起一张有层次的饼图
    assert.ok(new Set(snapshot.txns.map((txn) => txn.category)).size >= 8, '分类层次不够');
    // 演示账本带 demo 标记，面板据它显示「这是演示数据」提示条
    assert.equal(snapshot.settings.demo, true);
    // 不会把未来的日子记成账
    const latest = snapshot.txns.reduce((max, txn) => (txn.date > max ? txn.date : max), '');
    assert.ok(latest <= '2026-11-09', `出现了未来日期 ${latest}`);
    await assert.rejects(() => t.store.seedDemo(now), /已经有数据/);
  } finally {
    t.cleanup();
  }
});

test('seedDemoIfEmpty：只给空库铺一次；清空后不再自动复活', async () => {
  const t = tempStore();
  try {
    await t.store.ready();
    const now = Date.parse('2026-11-09T12:00:00+08:00');
    assert.equal(await t.store.seedDemoIfEmpty({ now }), true, '空库应铺演示数据');
    assert.ok(t.store.getDb().txns.length > 0);
    // 已经有数据时不再铺
    assert.equal(await t.store.seedDemoIfEmpty({ now }), false);
    // 用户清空后（resetToEmpty 把 demo 标回 false），不该再自动铺回来
    await t.store.resetToEmpty();
    assert.equal(t.store.getDb().txns.length, 0);
    assert.equal(t.store.getDb().settings.demo, false, '清空后 demo 标记应归 false');
    assert.equal(await t.store.seedDemoIfEmpty({ now }), false, '用户清空后不该再铺回去');
  } finally {
    t.cleanup();
  }
});

test('buildDemoDb 纯函数：不改传入时间、可重复生成同样结构', () => {
  const now = Date.parse('2026-11-09T12:00:00+08:00');
  const a = buildDemoDb(now);
  const b = buildDemoDb(now);
  assert.deepEqual(a.txns.map((x) => x.date), b.txns.map((x) => x.date));
  assert.equal(a.txns.length, b.txns.length);
});

test('normalizeDb：数字一律按分，字符串按元（手工编辑 JSON 的容错）', () => {
  const db = normalizeDb({
    txns: [
      { date: '2026-11-01', amount: 3400, direction: 'expense', merchant: '星巴克' },
      { date: '2026-11-02', amount: '15.90', direction: 'expense', merchant: '瑞幸咖啡' },
    ],
    assets: [{ name: '现金', value: '100.00' }],
  });
  assert.equal(db.txns[0].amount, 3400);
  assert.equal(db.txns[1].amount, 1590);
  assert.equal(db.assets[0].value, 10000);
  assert.equal(db.version, DB_VERSION);
});

test('nextDue：本月已过则顺延到下月', () => {
  const today = '2026-11-09';
  assert.deepEqual(nextDue({ dueDay: 15 }, today), { dueInDays: 6, overdue: false, dueDate: '2026-11-15' });
  assert.deepEqual(nextDue({ dueDay: 8 }, today), { dueInDays: 29, overdue: false, dueDate: '2026-12-08' });
  assert.equal(nextDue({ dueDay: 31 }, '2026-11-15').dueDate, '2026-11-30');
});
test('importRows 自带兜底：行里没有 category 时自动走关键词规则 + 用户记忆', async () => {
  const t = tempStore();
  try {
    // 用户先修正过某个商户
    await t.store.rememberRule('张三家的小店', { category: '人情往来', purpose: '人情社交' });
    // 「裸调用」：不预先分类，行里不带 category —— 也要有正确分类
    const result = await t.store.importRows({
      name: 'raw.csv',
      rows: [
        { date: '2026-11-01', amount: 3400, direction: 'expense', merchant: '星巴克' },
        { date: '2026-11-02', amount: 10000, direction: 'expense', merchant: '张三家的小店' },
        { date: '2026-11-03', amount: 500, direction: 'expense', merchant: 'zq9x7k' },
        { date: '2026-11-04', amount: 3200000, direction: 'income', merchant: '公司' },
      ],
    });
    const byMerchant = Object.fromEntries(result.txns.map((txn) => [txn.merchant, txn]));
    assert.equal(byMerchant.星巴克.category, '餐饮', '关键词规则应生效');
    assert.equal(byMerchant['张三家的小店'].category, '人情往来', '用户记忆应生效');
    assert.equal(byMerchant['张三家的小店'].purpose, '人情社交');
    assert.equal(byMerchant.zq9x7k.category, '其他', '真认不出才兜到其他');
    assert.equal(byMerchant.公司.category, '收入');
    assert.equal(byMerchant.公司.purpose, '');
  } finally {
    t.cleanup();
  }
});

test('保单：增删改 + 落盘重启后仍在', async () => {
  const t = tempStore();
  try {
    await t.store.ready();
    const { policy } = await t.store.addPolicy({
      kind: 'insurance',
      name: '平安重疾险',
      issuer: '平安保险',
      type: 'critical',
      amount: 50000000,
      premium: 486000,
      payCycle: 'yearly',
      dueDate: '2027-12-15',
      paidPeriods: 3,
      totalPeriods: 20
    });
    assert.equal(policy.name, '平安重疾险');
    assert.equal(policy.premium, 486000);
    assert.equal(policy.dueDate, '2027-12-15');

    const updated = await t.store.updatePolicy(policy.id, { premium: 520000 });
    assert.equal(updated.policy.premium, 520000);

    // 重新打开同一个文件：保单要还在（normalizeDb 必须认识 policies）
    const again = createStore({ file: t.store.path() });
    await again.ready();
    assert.equal(again.getDb().policies.length, 1);
    assert.equal(again.getDb().policies[0].premium, 520000);

    await t.store.removePolicy(policy.id);
    assert.equal(t.store.getDb().policies.length, 0);
  } finally {
    t.cleanup();
  }
});

test('保单：名称必填，缺名称要报人话', async () => {
  const t = tempStore();
  try {
    await t.store.ready();
    await assert.rejects(() => t.store.addPolicy({ kind: 'insurance' }), /名称不能为空/);
    await assert.rejects(() => t.store.removePolicy('pol_nope'), /找不到/);
  } finally {
    t.cleanup();
  }
});
