import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanName,
  detectIntent,
  parseAsset,
  parseChineseNumber,
  parseDateText,
  parseHolding,
  parseLiability,
  parseMoneyText,
  parsePolicy,
  parsePolicyDraft,
  pickMoney,
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

test('§12 验收：保费与保额不串位', () => {
  // 这是最容易错的一条：句子里两个金额，各归各的语义
  const draft = parsePolicy('重疾险，每年4860保额50万', NOW);
  assert.equal(draft.premium, 486000, '保费 4860');
  assert.equal(draft.amount, 50000000, '保额 50 万');
  assert.equal(draft.payCycle, 'yearly');
});

test('§12 验收：日期里的数字不能当金额', () => {
  const draft = parsePolicy('平安重疾险，12月15号续保', NOW);
  assert.equal(draft.premium, null, '12 和 15 都不是保费');
  assert.equal(draft.dueDate, '2026-12-15');
  assert.equal(draft.dueDatePrecision, 'day');
});

test('§12 验收：允许只有名称的草稿，不能造出 2026 元保费', () => {
  const draft = parsePolicy('百万医疗2026版', NOW);
  assert.ok(draft !== null, '能存草稿');
  assert.equal(draft.premium, null, '2026 是版本号不是保费');
  assert.equal(draft.amount, null);
  assert.equal(draft.name, '百万医疗2026版');
  assert.ok(draft.missing.includes('premium'));
});

test('§12 验收：缺省字段是「未知」而不是默认值', () => {
  const draft = parsePolicy('给妈妈买的医疗险', NOW);
  assert.equal(draft.premium, null);
  assert.equal(draft.payCycle, null, '没提周期就是未知，不默认年缴');
  assert.equal(draft.autoRenew, null, '没提自动续保就是未知，不默认 false');
  assert.equal(draft.totalPeriods, null);
});

test('§12 验收：否定表达与月缴', () => {
  const draft = parsePolicy('不自动续保，每月300', NOW);
  assert.equal(draft.autoRenew, false, '「不自动续保」要认成 false');
  assert.equal(draft.payCycle, 'monthly');
  assert.equal(draft.premium, 30000);
});

test('§12 验收：月份精度不能被静默补成日', () => {
  const draft = parsePolicy('重疾险，2027年3月缴费', NOW);
  assert.equal(draft.dueDate, '2027-03-01');
  assert.equal(draft.dueDatePrecision, 'month', '只知道到月');
  assert.ok(draft.missing.includes('dueDatePrecision'), '要提示用户确认具体哪一天');
  assert.equal(draft.payCycle, null, '「3月缴费」不是月缴');
});

test('§12 验收：相对日期按输入基准解析', () => {
  const draft = parsePolicy('平安重疾险，每年4860，明年12月15号缴费', NOW);
  assert.equal(draft.dueDate, '2027-12-15', '2026 年输入「明年」= 2027');
  assert.equal(draft.premium, 486000);
});

test('存款理财：本金与利率分开记，到期日归到期而不是缴费日', () => {
  const draft = parsePolicy('存了10万三年定期，2027年3月到期，利率3.5', NOW);
  assert.equal(draft.kind, 'deposit');
  assert.equal(draft.amount, 10000000, '本金 10 万');
  assert.equal(draft.rate, 350);
  assert.equal(draft.maturityDate, '2027-03-01', '「到期」归到期日');
  assert.equal(draft.dueDate, '', '存款没有「下次缴费日」');
  assert.equal(draft.name, '三年定期');
});

test('中文金额边界：一万零八 ≠ 一万八，三万五千六不补千位', () => {
  assert.equal(parseChineseNumber('一万八'), 18000);
  assert.equal(parseChineseNumber('一万零八'), 10008);
  assert.equal(parseChineseNumber('三万五千六'), 35600);
  assert.equal(parseChineseNumber('五千零三十'), 5030);
});

test('金额候选排除日期、版本、编号', () => {
  assert.equal(pickMoney('12月15号'), null, '日期不是钱');
  assert.equal(pickMoney('2026版'), null, '版本号不是钱');
  assert.equal(pickMoney('P2026110800123'), null, '保单号不是钱');
  assert.equal(pickMoney('20年缴'), null, '期数不是钱');
  assert.equal(pickMoney('4860'), 486000, '裸数字仍然可作金额（在金额标签后）');
  assert.equal(pickMoney('50万'), 50000000);
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

test('没有金额也能存草稿，但缺什么要说清楚', () => {
  // §11：「允许只有名称或人员的保单草稿，不因无金额直接返回 null」
  const draft = parsePolicy('我有一份保险', NOW);
  assert.ok(draft !== null, '能存成草稿');
  assert.equal(draft.premium, null, '金额是未知，不是 0');
  assert.ok(draft.missing.includes('premium'), '告诉用户还缺保费');
  assert.equal(draft.draft, true);

  assert.equal(parsePolicy('   ', NOW), null, '空句子不建档');
  // 资产/持仓仍然要求有金额（没有金额的资产没有意义）
  assert.equal(parseAsset('我有一些钱', NOW), null);
  assert.equal(parseHolding('买了一些股票', NOW), null);
});

test('负债解析：余额与月供分开，不串位', () => {
  const draft = parseLiability('房贷还剩96万，每月还6800，15号还款');
  assert.equal(draft.kind, 'mortgage');
  assert.equal(draft.balance, 96000000, '余额 96 万');
  assert.equal(draft.monthlyPayment, 680000, '月供 6800');
  assert.equal(draft.dueDay, 15);
  assert.equal(draft.name, '房贷');
});

test('负债解析：裸数字也能认出（信用卡欠了12000）', () => {
  const draft = parseLiability('信用卡欠了12000');
  assert.equal(draft.kind, 'credit');
  assert.equal(draft.balance, 1200000);
  assert.equal(draft.monthlyPayment, null, '没提月供就是未知');
  assert.equal(draft.name, '信用卡');
});

test('负债意图：描述欠款走建档，还了钱走流水', () => {
  assert.equal(detectIntent('房贷还剩96万'), 'liability');
  assert.equal(detectIntent('车贷8万月供2200'), 'liability');
  assert.equal(detectIntent('信用卡欠了12000'), 'liability');
  // 「还了6800房贷」是这个月真的花出去了，必须记成流水
  assert.equal(detectIntent('还了6800房贷'), 'txn');
  assert.equal(detectIntent('付了车贷2200'), 'txn');
});
