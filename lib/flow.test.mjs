import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LARGE_CENTS,
  evidenceOf,
  flowSummary,
  judgeFlow,
  judgeRows,
} from './flow.js';

/** 断言判定结果，失败时把整条结果打印出来便于定位。 */
const expect = (row, verdict, reason, options) => {
  const result = judgeFlow(row, options);
  assert.equal(result.verdict, verdict, `${row.merchant ?? ''} 期望 ${verdict}，实际 ${result.verdict}（${result.reason}）`);
  assert.equal(result.reason, reason, `${row.merchant ?? ''} 期望原因 ${reason}，实际 ${result.reason}`);
  return result;
};

test('收入词优先：代发工资即使被账单记成「转账」也要计入收入', () => {
  // 这是最重要的一条豁免：很多银行把工资记成「转账 某某公司」，
  // 如果先匹配「转账」就会把整月工资排除掉。
  expect({ merchant: '转账 某某科技有限公司', note: '代发工资', direction: 'income', amount: 2860000 }, 'count', 'salary');
  expect({ merchant: '转账', note: '年终奖金', direction: 'income', amount: 6800000 }, 'count', 'salary');
  expect({ merchant: '报销款', direction: 'income', amount: 120000 }, 'count', 'salary');
});

test('账户间转账不计入收支', () => {
  expect({ merchant: '转账到余额宝', direction: 'expense', amount: 2000000 }, 'exclude', 'transfer');
  expect({ merchant: '内部转账', direction: 'expense', amount: 500000 }, 'exclude', 'transfer');
  expect({ merchant: '招商银行', note: '转出到储蓄卡', direction: 'expense', amount: 300000 }, 'exclude', 'transfer');
});

test('信用卡/花呗还款是清偿，不计支出（先消费时已经记过一次）', () => {
  expect({ merchant: '信用卡', note: '信用卡还款', direction: 'expense', amount: 328000 }, 'exclude', 'repayment');
  expect({ merchant: '花呗还款', direction: 'expense', amount: 120000 }, 'exclude', 'repayment');
  expect({ merchant: '白条还款', direction: 'expense', amount: 88000 }, 'exclude', 'repayment');
});

test('房贷/车贷月供是真实支出，不能被「还款」二字带走', () => {
  // 这是最容易被写错的规则：还房贷金额大、名字里带「还」，
  // 但它确实是支出（钱变成了房子），必须计入。
  expect({ merchant: '招商银行房贷', direction: 'expense', amount: 780000 }, 'count', 'debt');
  expect({ merchant: '某某银行', note: '车贷月供', direction: 'expense', amount: 340000 }, 'count', 'debt');
  expect({ merchant: '按揭还款', direction: 'expense', amount: 500000 }, 'count', 'debt');
});

test('借贷往来不计入收支', () => {
  expect({ merchant: '转账给张三', direction: 'expense', amount: 500000 }, 'exclude', 'loan');
  expect({ merchant: '借给李四', direction: 'expense', amount: 200000 }, 'exclude', 'loan');
  expect({ merchant: '收到还款', direction: 'income', amount: 500000 }, 'exclude', 'loan');
});

test('理财申购/赎回、提现属于资金搬移', () => {
  expect({ merchant: '天天基金申购', direction: 'expense', amount: 200000 }, 'exclude', 'investment');
  expect({ merchant: '余额宝转出', direction: 'income', amount: 300000 }, 'exclude', 'investment');
  expect({ merchant: 'ATM取现', direction: 'expense', amount: 200000 }, 'exclude', 'cashout');
});

test('退款冲抵原支出，不当成收入', () => {
  expect({ merchant: '淘宝退款', direction: 'income', amount: 29900 }, 'exclude', 'refund');
});

test('大额但无资金搬移证据：计入但标记待确认', () => {
  // 换电脑、家电、旅行是真实支出，不能因为金额大就排除。
  expect({ merchant: 'Apple Store', direction: 'expense', amount: 989900 }, 'review', 'large');
  expect({ merchant: '某某电器行', direction: 'expense', amount: 420000 }, 'review', 'large');
});

test('小额日常收支直接计入', () => {
  expect({ merchant: '星巴克', direction: 'expense', amount: 3500 }, 'count', 'normal');
  expect({ merchant: '地铁', direction: 'expense', amount: 600 }, 'count', 'normal');
});

test('大额门槛可注入，默认是 ¥3,000', () => {
  assert.equal(LARGE_CENTS, 300000);
  // 把门槛调到 ¥100 后，¥200 的流水就该进入待确认
  expect({ merchant: '超市', direction: 'expense', amount: 20000 }, 'review', 'large', { largeCents: 10000 });
  // 门槛调到很高时，换电脑也只是普通收支
  expect({ merchant: 'Apple Store', direction: 'expense', amount: 989900 }, 'count', 'normal', { largeCents: 99999999 });
});

test('evidenceOf 把商户/摘要/账单分类都算作证据', () => {
  // 支付宝的「交易分类」列经常直接写着「转账」，比自己猜商户可靠
  const text = evidenceOf({ merchant: '张三', note: '付款', categoryHint: '转账' });
  assert.ok(text.includes('转账'), `证据里应包含账单分类，实际：${text}`);
  // 归一化会去掉空格和标点
  const messy = evidenceOf({ merchant: '支付宝-星巴克(上海店)' });
  assert.equal(messy, '星巴克');
});

test('judgeRows 就地补充 flow 与 money，只把 exclude 标成不计收支', () => {
  const rows = [
    { merchant: '转账到余额宝', direction: 'expense', amount: 2000000 },
    { merchant: '星巴克', direction: 'expense', amount: 3500 },
    { merchant: 'Apple Store', direction: 'expense', amount: 989900 },
  ];
  judgeRows(rows);
  assert.equal(rows[0].money, true, '转账不计收支');
  assert.equal(rows[0].flow.verdict, 'exclude');
  assert.equal(rows[1].money, false, '日常支出计入收支');
  assert.equal(rows[2].money, false, '待确认的大额仍然计入，只是标记');
  assert.equal(rows[2].flow.verdict, 'review');
});

test('flowSummary 统计三类判定', () => {
  const rows = [
    { flow: { verdict: 'exclude' } },
    { flow: { verdict: 'exclude' } },
    { flow: { verdict: 'review' } },
    { flow: { verdict: 'count' } },
    {}
  ];
  assert.deepEqual(flowSummary(rows), { count: 2, exclude: 2, review: 1, total: 5 });
});

test('空输入与异常输入不抛异常', () => {
  assert.equal(judgeFlow({}).verdict, 'count');
  assert.equal(judgeFlow({ merchant: '   ' }).verdict, 'count');
  assert.deepEqual(flowSummary(null), { count: 0, exclude: 0, review: 0, total: 0 });
  assert.deepEqual(judgeRows(null), []);
});