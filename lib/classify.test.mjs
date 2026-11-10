/**
 * lib/classify.test.mjs —— 规则分类单测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATEGORY_KEYWORDS,
  CATEGORY_PURPOSE,
  autoRateOf,
  classify,
  classifyRows,
  keywordStats,
  mapCategoryHint,
  matchCategoryByKeyword,
  suggestPurpose,
} from './classify.js';
import { parseBill } from './importer.js';
import { EXPENSE_CATEGORIES, PURPOSES, normalizeMerchant } from './domain.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'scripts', 'fixtures');

test('关键词表 ≥ 60 个商户，且覆盖 CONTRACT 要求的类目', () => {
  const stats = keywordStats();
  assert.ok(stats.keywords >= 60, `关键词只有 ${stats.keywords} 个`);
  assert.equal(stats.categories, 14, '13 个支出分类 + 收入');
  assert.ok(Object.keys(CATEGORY_KEYWORDS).length >= 13);
  // 每一类都要有词
  for (const category of EXPENSE_CATEGORIES) {
    assert.ok((CATEGORY_KEYWORDS[category] || []).length >= 3, `${category} 关键词太少`);
  }
});

test('必需品牌都能命中正确分类', () => {
  const cases = [
    ['星巴克', '餐饮'], ['瑞幸', '餐饮'], ['麦当劳', '餐饮'], ['肯德基', '餐饮'],
    ['海底捞', '餐饮'], ['蜜雪冰城', '餐饮'], ['瑞幸咖啡', '餐饮'],
    ['滴滴出行', '交通'], ['上海地铁', '交通'], ['公交', '交通'], ['12306', '交通'],
    ['中国石化', '交通'], ['加油', '交通'],
    ['淘宝', '购物'], ['天猫', '购物'], ['京东', '购物'], ['拼多多', '购物'],
    ['盒马鲜生', '购物'], ['名创优品', '购物'], ['永辉超市', '购物'],
    ['房租', '居家'], ['物业费', '居家'], ['水费', '居家'], ['电费', '居家'],
    ['燃气费', '居家'], ['国家电网', '居家'],
    ['瑞金医院', '医疗'], ['药房', '医疗'], ['卫生院', '医疗'], ['叮当快药', '医疗'],
    ['学费', '教育'], ['新东方', '教育'], ['当当网', '教育'], ['图书', '教育'],
    ['万达影城', '娱乐'], ['网易云音乐', '娱乐'], ['爱奇艺', '娱乐'], ['Steam', '娱乐'],
    ['中国移动', '通讯'], ['中国联通', '通讯'], ['中国电信', '通讯'], ['话费', '通讯'],
    ['微信红包', '人情往来'], ['份子钱', '人情往来'],
    ['平安保险', '保险'], ['重疾险', '保险'],
    ['信用卡还款', '还贷'], ['花呗', '还贷'],
    ['天天基金', '投资'], ['证券', '投资'], ['基金定投', '投资'],
  ];
  for (const [text, expected] of cases) {
    const got = classify({ merchant: text, direction: 'expense' });
    assert.equal(got.category, expected, `「${text}」应归「${expected}」，实际「${got.category}」`);
    assert.equal(got.confidence, 'rule');
  }
});

test('英文与别名也能识别（大小写不敏感）', () => {
  assert.equal(classify({ merchant: 'STARBUCKS COFFEE', direction: 'expense' }).category, '餐饮');
  assert.equal(classify({ merchant: 'McDonalds', direction: 'expense' }).category, '餐饮');
  assert.equal(classify({ merchant: 'JD.com', direction: 'expense' }).category, '购物');
  assert.equal(classify({ merchant: 'Netflix' , direction: 'expense' }).category, '其他');
});

test('收入方向固定「收入」，目的为空，置信度 rule', () => {
  const result = classify({ merchant: '某某科技有限公司', note: '工资', direction: 'income' });
  assert.deepEqual(result, { category: '收入', purpose: '', confidence: 'rule' });
  // 即使商户像餐饮也按方向走
  assert.equal(classify({ merchant: '星巴克', direction: 'income' }).category, '收入');
});

test('认不出来的商户兜底「其他」，置信度 default', () => {
  const result = classify({ merchant: 'zq1x9v', note: '', direction: 'expense' });
  assert.equal(result.category, '其他');
  assert.equal(result.confidence, 'default');
  assert.equal(result.purpose, '生活必须');
});

test('用户修正记忆优先（confidence: user）', () => {
  const rules = { 星巴克: { category: '娱乐', purpose: '娱乐享受' } };
  const result = classify({ merchant: '星巴克(上海店)', direction: 'expense' }, rules);
  assert.deepEqual(result, { category: '娱乐', purpose: '娱乐享受', confidence: 'user' });
  // key 是归一化后的商户名
  assert.ok(normalizeMerchant('星巴克(上海店)') in rules);
});

test('行内自带分类（支付宝交易分类列）优先于关键词', () => {
  const result = classify({ merchant: '张三', direction: 'expense', category: '人情往来' });
  assert.deepEqual(result, { category: '人情往来', purpose: '人情社交', confidence: 'rule' });
});

test('商户优先于备注：备注里的干扰词不会改写分类', () => {
  // 备注里出现「地铁」，但商户是星巴克，应归餐饮
  const result = classify({ merchant: '星巴克', note: '地铁口那家', direction: 'expense' });
  assert.equal(result.category, '餐饮');
});

test('商户识别不了时用备注兜底', () => {
  const result = classify({ merchant: 'A公司', note: '美团外卖订单', direction: 'expense' });
  assert.equal(result.category, '餐饮');
});

test('suggestPurpose 覆盖所有分类', () => {
  for (const category of EXPENSE_CATEGORIES) {
    const purpose = suggestPurpose(category);
    assert.ok(PURPOSES.includes(purpose), `${category} 的目的「${purpose}」不在 PURPOSES 里`);
    assert.equal(purpose, CATEGORY_PURPOSE[category]);
  }
  assert.equal(suggestPurpose('收入'), '');
  assert.equal(suggestPurpose('不存在'), '');
  assert.equal(suggestPurpose(), '');
});

test('mapCategoryHint 把支付宝分类文案映射到我们的分类', () => {
  assert.equal(mapCategoryHint('餐饮美食'), '餐饮');
  assert.equal(mapCategoryHint('交通出行'), '交通');
  assert.equal(mapCategoryHint('日用百货'), '购物');
  assert.equal(mapCategoryHint('缴费充值'), '通讯');
  assert.equal(mapCategoryHint('信用还款'), '还贷');
  assert.equal(mapCategoryHint('投资理财'), '投资');
  assert.equal(mapCategoryHint('转账'), '其他', '转账既不是收入也不是明确类目，归「其他」');
  assert.equal(mapCategoryHint('随便什么', 'income'), '收入');
});

test('classifyRows / autoRateOf', () => {
  const rows = [
    { merchant: '星巴克', direction: 'expense' },
    { merchant: 'zq1x9v', direction: 'expense' },
    { merchant: '工资', direction: 'income' },
    { merchant: '滴滴出行', direction: 'expense' },
  ];
  const classified = classifyRows(rows);
  assert.equal(classified.length, 4);
  assert.equal(classified[0].category, '餐饮');
  assert.equal(classified[1].category, '其他');
  assert.equal(classified[3].category, '交通');
  assert.equal(autoRateOf(classified), 0.75);
  assert.equal(autoRateOf([]), 0);
  assert.equal(classified.length, rows.length, '不能丢行');
});

test('matchCategoryByKeyword 返回命中的关键词', () => {
  const hit = matchCategoryByKeyword(normalizeMerchant('星巴克(上海南京西路店)'));
  assert.deepEqual(hit, { category: '餐饮', keyword: '星巴克' });
  assert.equal(matchCategoryByKeyword('zq1x9v'), null);
  assert.equal(matchCategoryByKeyword(''), null);
});

test('真实账单样例：行数不丢 + 自动分类率 ≥ 70%', () => {
  const cases = [
    ['alipay-sample.csv', 51],
    ['wechat-sample.csv', 23],
    ['generic-bank.csv', 20],
    ['book1.xlsx', 30],
  ];
  for (const [name, expectedRows] of cases) {
    const content = readFileSync(join(fixtures, name));
    const parsed = parseBill({ name, content });
    assert.equal(parsed.rows.length, expectedRows, `${name} 行数不对`);
    const classified = classifyRows(parsed.rows);
    assert.equal(classified.length, parsed.rows.length, `${name} 分类后行数变了`);
    const rate = autoRateOf(classified);
    assert.ok(rate >= 0.7, `${name} 自动分类率只有 ${(rate * 100).toFixed(1)}%`);
    for (const row of classified) {
      assert.ok(EXPENSE_CATEGORIES.includes(row.category) || row.category === '收入', `非法分类 ${row.category}`);
    }
  }
});

test('用户记忆能提升分类率（模拟反复修正后）', () => {
  // 真实样例里识别不出的商户（转账对象、公司名等）
  const content = readFileSync(join(fixtures, 'alipay-sample.csv'));
  const rows = parseBill({ name: 'alipay-sample.csv', content }).rows;
  const before = autoRateOf(classifyRows(rows));

  // 额外加一笔完全认不出的商户（真实用户会遇到：转账给个人、公司名）
  const unknown = { merchant: 'zq9x7k', note: '', direction: 'expense', amount: 6600, dedupeKey: 'k' };
  const withUnknown = classifyRows([...rows, unknown]);
  const baseRate = autoRateOf(withUnknown);
  assert.ok(baseRate < 1, '这一笔应当识别不出');

  const rules = { zq9x7k: { category: '人情往来', purpose: '人情社交' } };
  const after = autoRateOf(classifyRows([...rows, unknown], rules));
  assert.ok(after > baseRate, `记忆后分类率应从 ${baseRate} 提升，实际 ${after}`);
  assert.equal(after, 1);
  assert.equal(before, 1, '真实样例本身已经 100% 命中规则表');
  // 记忆命中后 confidence 应为 user
  const sample = classify({ merchant: Object.keys(rules)[0], direction: 'expense' }, rules);
  assert.deepEqual(sample, { category: '人情往来', purpose: '人情社交', confidence: 'user' });
});
test('行内自带的「其他」不当作有效命中（让 AI 兜底能挑出来）', () => {
  // 账单自带的「其他」= 没信息 → confidence 必须是 default，而不是 rule
  const bare = classify({ merchant: '张三', direction: 'expense', category: '其他' });
  assert.equal(bare.category, '其他');
  assert.equal(bare.confidence, 'default', '「其他」自带分类不能让 AI 兜底误以为已分类');

  const noHint = classify({ merchant: '张三', direction: 'expense' });
  assert.equal(noHint.confidence, 'default');

  // 但自带「其他」时仍然继续走关键词表，能救回来就救
  const rescued = classify({ merchant: '某商户', note: '美团外卖', direction: 'expense', category: '其他' });
  assert.equal(rescued.category, '餐饮');
  assert.equal(rescued.confidence, 'rule');

  // 其它非「其他」的自带分类仍然直接生效
  const hint = classify({ merchant: '张三', direction: 'expense', category: '人情往来' });
  assert.deepEqual(hint, { category: '人情往来', purpose: '人情社交', confidence: 'rule' });
});

test('关键词真的命中「其他」类时仍然是 rule（ATM/转账等确实属于其他）', () => {
  const atm = classify({ merchant: 'ATM取现', direction: 'expense' });
  assert.equal(atm.category, '其他');
  assert.equal(atm.confidence, 'rule', '关键词明确命中「其他」类算有效判定');
});
