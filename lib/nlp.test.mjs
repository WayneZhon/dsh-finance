import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanName,
  detectIntent,
  parseAsset,
  parseChineseNumber,
  parseDateText,
  parseHolding,
  parseMoneyText,
  parsePolicy,
  parseSentence,
} from './nlp.js';

/** 固定「现在」为 2026-11-10，让日期断言稳定。 */
const NOW = new Date(2026, 10, 10).getTime();

test('金额：中文口语的万/千/块/角都能解析', () => {
  // 返回单位是「分」
  const cases = [
    ['10万', 10000000],
    ['1.8万', 1800000],
    ['12万8', 12800000], // 12.8 万
    ['18万5', 18500000], // 18.5 万
    ['4860', 486000],
    ['34.5', 3450],
    ['34块5', 3450], // 34.5 元
    ['两千', 200000],
    ['一万八', 1800000],
  ];
  for (const [text, cents] of cases) {
    assert.equal(parseMoneyText(text), cents, `${text} 应解析为 ${cents} 分`);
  }
  assert.equal(parseMoneyText('没有数字'), null);
  assert.equal(parseMoneyText(''), null);
});

test('中文数字：一万八 = 18000，不是 10008', () => {
  assert.equal(parseChineseNumber('一万八'), 18000);
  assert.equal(parseChineseNumber('两千'), 2000);
  assert.equal(parseChineseNumber('三万五千'), 35000);
  assert.equal(parseChineseNumber('十'), 10);
  assert.equal(parseChineseNumber('没有数字'), null);
});

test('日期：明年/月日/完整年份/N 年后 都能认', () => {
  assert.equal(parseDateText('2027年3月15日', NOW), '2027-03-15');
  assert.equal(parseDateText('明年12月15号', NOW), '2027-12-15');
  assert.equal(parseDateText('12月15', NOW), '2026-12-15');
  assert.equal(parseDateText('12月', NOW), '2026-12-01');
  assert.equal(parseDateText('2027年3月', NOW), '2027-03-01');
  assert.equal(parseDateText('3年后', NOW), '2029-11-10');
  assert.equal(parseDateText('没有日期', NOW), '');
});

test('意图识别：保单 / 持仓 / 资产 / 流水 分得开', () => {
  assert.equal(detectIntent('平安重疾险，每年4860，明年12月续保'), 'policy');
  assert.equal(detectIntent('存了10万三年定期，2027年3月到期'), 'policy');
  assert.equal(detectIntent('买了1000股招商银行，成本34块5'), 'holding');
  assert.equal(detectIntent('招行活期有18万5'), 'asset');
  assert.equal(detectIntent('35 咖啡'), 'txn');
});

test('「交了多少保费」是流水，不是保单', () => {
  // 同样是「保费」两个字，但一个是建档、一个是花钱，必须分清
  assert.equal(detectIntent('今天交了保费 4860'), 'txn');
  assert.equal(detectIntent('重疾险保额50万'), 'policy');
});

test('解析保单：名称、年缴保费、续保日', () => {
  const policy = parsePolicy('平安重疾险，每年4860，明年12月15号续保', NOW);
  assert.equal(policy.kind, 'insurance');
  assert.equal(policy.name, '平安重疾险');
  assert.equal(policy.premium, 486000);
  assert.equal(policy.dueDate, '2027-12-15');
  assert.equal(policy.type, 'critical');
  assert.equal(policy.payCycle, 'yearly');
});

test('解析保单：保额与保费分开，别把 50 万当保费', () => {
  const policy = parsePolicy('百万医疗险，保额300万，每年1200，明年6月1号', NOW);
  assert.equal(policy.kind, 'insurance');
  assert.equal(policy.amount, 300000000, '300 万保额');
  assert.equal(policy.premium, 120000, '每年 1200 保费');
});

test('解析存款：本金、到期日、年化利率', () => {
  const policy = parsePolicy('存了10万三年定期，2027年3月到期，利率3.5', NOW);
  assert.equal(policy.kind, 'deposit');
  assert.equal(policy.amount, 10000000);
  assert.equal(policy.rate, 350, '3.5% → 万分比 350');
  assert.equal(policy.dueDate, '2027-03-01');
  assert.equal(policy.payCycle, 'once', '存款是一次性存入');
});

test('解析持仓：份额、成本价、现价', () => {
  const holding = parseHolding('买了1000股招商银行，成本34块5，现在38', NOW);
  assert.equal(holding.shares, 1000);
  assert.equal(holding.costPrice, 3450);
  assert.equal(holding.price, 3800);
  assert.equal(holding.name, '招商银行');
  assert.equal(holding.type, 'stock');
});

test('解析资产：金额与类型', () => {
  const asset = parseAsset('招行活期有18万5', NOW);
  assert.equal(asset.value, 18500000);
  assert.equal(asset.kind, 'cash');
  assert.equal(asset.name, '招行活期');

  const house = parseAsset('房产估值300万', NOW);
  assert.equal(house.kind, 'property');
  assert.equal(house.value, 300000000, '300 万元 = 3 亿分');
});

test('名称提取不残留数字与日期碎片', () => {
  assert.equal(cleanName('平安重疾险，每年4860，明年12月15号续保'), '平安重疾险');
  assert.equal(cleanName('买了1000股招商银行，成本34块5'), '招商银行');
  assert.equal(cleanName('存了10万三年定期，2027年3月到期'), '三年定期');
  // 名称里不该出现数字
  for (const text of ['平安重疾险，每年4860', '1000股招商银行', '存了10万三年定期']) {
    assert.ok(!/\d/u.test(cleanName(text)), `${text} 的名称不该含数字`);
  }
});

test('parseSentence 把一句话派发给正确的解析器', () => {
  assert.equal(parseSentence('平安重疾险，每年4860', NOW).intent, 'policy');
  assert.equal(parseSentence('买了1000股招商银行', NOW).intent, 'holding');
  assert.equal(parseSentence('招行活期有18万5', NOW).intent, 'asset');
  assert.equal(parseSentence('35 咖啡', NOW).intent, 'txn');
  assert.equal(parseSentence('35 咖啡', NOW).value, null, '流水交给面板自己的解析器');
});

test('认不出的句子不返回半截数据', () => {
  // 没有任何金额 → 不允许返回一个金额为 0 的保单
  assert.equal(parsePolicy('我有一份保险', NOW), null);
  assert.equal(parseAsset('我有一些钱', NOW), null);
  assert.equal(parseHolding('买了一些股票', NOW), null);
});
