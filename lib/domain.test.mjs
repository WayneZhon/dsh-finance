/**
 * lib/domain.test.mjs —— 领域层纯函数单测。
 * 运行：`node --test lib/`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIES,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORY,
  PURPOSES,
  ASSET_KINDS,
  LIABILITY_KINDS,
  HOLDING_TYPES,
  SOURCE_KINDS,
  clamp,
  currentMonth,
  dateInMonth,
  dayKey,
  daysBetween,
  daysInMonth,
  dedupeKeyOf,
  emptyDb,
  formatCents,
  isDateText,
  isMonthText,
  monthKey,
  monthRange,
  newId,
  normalizeMerchant,
  normalizeSettings,
  parseAmountToCents,
  safeAdd,
  shiftMonth,
} from './domain.js';

test('分类与目的常量与 CONTRACT 一致', () => {
  assert.deepEqual([...EXPENSE_CATEGORIES], [
    '餐饮', '交通', '购物', '居家', '医疗', '教育', '娱乐', '通讯', '人情往来', '保险', '还贷', '投资', '其他',
  ]);
  assert.equal(INCOME_CATEGORY, '收入');
  assert.deepEqual([...CATEGORIES], [...EXPENSE_CATEGORIES, '收入']);
  assert.deepEqual([...PURPOSES], ['生活必须', '娱乐享受', '未来保障', '人情社交', '自我实现']);
  assert.deepEqual([...ASSET_KINDS], ['cash', 'investment', 'property', 'other']);
  assert.deepEqual([...LIABILITY_KINDS], ['mortgage', 'car', 'credit', 'consumer', 'other']);
  assert.deepEqual([...HOLDING_TYPES], ['fund', 'stock', 'bond', 'other']);
  assert.deepEqual([...SOURCE_KINDS], ['import', 'manual', 'agent']);
});

test('parseAmountToCents：字符串按元→分，覆盖货币符号/千分位/全角/负号', () => {
  assert.equal(parseAmountToCents('12.34'), 1234);
  assert.equal(parseAmountToCents('¥1,234.56'), 123456);
  assert.equal(parseAmountToCents('￥12'), 1200);
  assert.equal(parseAmountToCents('+35.00'), 3500);
  assert.equal(parseAmountToCents('-8.5'), -850);
  assert.equal(parseAmountToCents('12元'), 1200);
  assert.equal(parseAmountToCents('１，２３４．５６'), 123456);
  assert.equal(parseAmountToCents('1 234.5'), 123450);
  assert.equal(parseAmountToCents('100.00-'), -10000);
  assert.equal(parseAmountToCents('(123.00)'), -12300);
  assert.equal(parseAmountToCents('.5'), 50);
  assert.equal(parseAmountToCents('0.005'), 1); // 四舍五入到分
});

test('parseAmountToCents：数字视为元（外部输入），无法解析返回 null', () => {
  assert.equal(parseAmountToCents(12.34), 1234);
  assert.equal(parseAmountToCents(0), 0);
  assert.equal(parseAmountToCents('abc'), null);
  assert.equal(parseAmountToCents(''), null);
  assert.equal(parseAmountToCents(null), null);
  assert.equal(parseAmountToCents(undefined), null);
  assert.equal(parseAmountToCents(NaN), null);
});

test('parseAmountToCents 没有浮点误差', () => {
  // 0.1+0.2 的经典问题
  const sum = parseAmountToCents('0.1') + parseAmountToCents('0.2');
  assert.equal(sum, 30);
  assert.equal(parseAmountToCents('123456789.99'), 12345678999);
});

test('formatCents：千分位、符号、整数', () => {
  assert.equal(formatCents(123456), '¥1,234.56');
  assert.equal(formatCents(-1234), '-¥12.34');
  assert.equal(formatCents(1234, { sign: true }), '+¥12.34');
  assert.equal(formatCents(1234, { symbol: false }), '12.34');
  assert.equal(formatCents(100000000), '¥1,000,000.00');
  assert.equal(formatCents(100000000, { group: false }), '¥1000000.00');
  assert.equal(formatCents(1234, { decimals: 0 }), '¥12');
  assert.equal(formatCents(0), '¥0.00');
});

test('safeAdd 忽略非法值并支持数组', () => {
  assert.equal(safeAdd(1, 2, 3), 6);
  assert.equal(safeAdd(1, null, 2, undefined, NaN, 'x'), 3);
  assert.equal(safeAdd([1, 2], 3), 6);
  assert.equal(safeAdd(), 0);
});

test('clamp', () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(clamp('abc', 3, 10), 3);
});

test('月份工具：monthKey / monthRange / shiftMonth / daysInMonth', () => {
  assert.equal(monthKey('2026-11-03'), '2026-11');
  assert.equal(monthKey('2026/1/3'), '2026-01');
  assert.equal(monthKey(new Date(2026, 0, 5)), '2026-01');
  assert.equal(monthKey('garbage'), '');
  assert.equal(currentMonth(new Date(2026, 10, 9)), '2026-11');
  assert.equal(dayKey('2026-11-03 08:00:00'), '2026-11-03');
  assert.equal(isDateText('2026-11-03'), true);
  assert.equal(isDateText('2026-02-30'), false);
  assert.equal(isDateText('2026-13-01'), false);
  assert.equal(isMonthText('2026-02'), true);
  assert.equal(isMonthText('2026-13'), false);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(shiftMonth('2026-11', -5), '2026-06');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.deepEqual(monthRange('2026-11', 6), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(monthRange('2026-02', 3), ['2025-12', '2026-01', '2026-02']);
  assert.equal(daysBetween('2026-11-01', '2026-11-15'), 14);
  assert.equal(daysBetween('2026-11-15', '2026-11-01'), -14);
  assert.equal(dateInMonth('2026-02', 31), '2026-02-28');
  assert.equal(dateInMonth('2026-11', 15), '2026-11-15');
});

test('newId 前缀 + 8 位可复现', () => {
  let seq = 0;
  const random = () => {
    seq += 1;
    return (seq % 10) / 10;
  };
  const id = newId('txn', random);
  assert.match(id, /^txn_[a-z0-9]{8}$/);
  const a = newId('bud', () => 0);
  const b = newId('bud', () => 0);
  assert.equal(a, b);
  assert.match(newId('goal'), /^goal_[a-z0-9]{8}$/);
  assert.match(newId(''), /^id_[a-z0-9]{8}$/);
});

test('normalizeMerchant 去掉渠道前缀、括号、空白并转小写', () => {
  assert.equal(normalizeMerchant('支付宝-星巴克(上海店)'), '星巴克');
  assert.equal(normalizeMerchant('  星巴克  '), '星巴克');
  assert.equal(normalizeMerchant('StarBucks'), 'starbucks');
  assert.equal(normalizeMerchant('京东 JD.COM'), '京东jdcom', '点号属于标点，会被去掉');
  assert.equal(normalizeMerchant(null), '');
  assert.equal(normalizeMerchant('（特约）美团'), '美团');
});

test('dedupeKeyOf 同一天同金额同商户同方向视为同一笔', () => {
  const a = dedupeKeyOf({ date: '2026-11-03', amount: 1234, direction: 'expense', merchant: '星巴克(上海店)' });
  const b = dedupeKeyOf({ date: '2026-11-03 08:00', amount: 1234, direction: 'expense', merchant: ' 星巴克 ' });
  assert.equal(a, b);
  const c = dedupeKeyOf({ date: '2026-11-03', amount: 1234, direction: 'income', merchant: '星巴克' });
  assert.notEqual(a, c);
});

test('emptyDb 每次返回独立对象', () => {
  const a = emptyDb();
  const b = emptyDb();
  a.txns.push({ id: 'x' });
  assert.equal(b.txns.length, 0);
  assert.equal(a.version, 1);
  assert.deepEqual(a.settings, { currency: 'CNY', emergencyMonths: 6 });
});

test('normalizeSettings 纠正非法值', () => {
  const off = { demo: false, demoOffered: false };
  assert.deepEqual(normalizeSettings({}), { currency: 'CNY', emergencyMonths: 6, ...off });
  assert.deepEqual(normalizeSettings({ currency: 'usd', emergencyMonths: 99 }), { currency: 'USD', emergencyMonths: 36, ...off });
  assert.deepEqual(normalizeSettings({ emergencyMonths: -3 }), { currency: 'CNY', emergencyMonths: 1, ...off });
  assert.deepEqual(normalizeSettings({ emergencyMonths: 'abc' }), { currency: 'CNY', emergencyMonths: 1, ...off });
  // 演示标记：真值才认，且「送过演示数据」一旦为真就不会被旧账本抹掉
  assert.deepEqual(normalizeSettings({ demo: true }), { currency: 'CNY', emergencyMonths: 6, demo: true, demoOffered: true });
  assert.equal(normalizeSettings({ demo: 'yes' }).demo, false);
  assert.equal(normalizeSettings({ demoOffered: true }).demoOffered, true);
});