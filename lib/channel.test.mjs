import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNEL_RANK,
  attachChannel,
  channelFromPaymentMethod,
  channelHintOfMerchant,
  collapseDuplicates,
  isSamePurchase,
} from './channel.js';

test('渠道识别：支付宝账单里常见的「收/付款方式」都能认出类别', () => {
  const cases = [
    ['招商银行储蓄卡(1234)', 'bank'],
    ['招商银行信用卡(5678)', 'unionpay'],
    ['余额宝', 'alipay'],
    ['微信零钱', 'wechat'],
    ['花呗', 'bnpl'],
    ['京东白条', 'bnpl'],
    ['美团月付', 'bnpl'],
    ['现金', 'cash'],
    ['云闪付', 'unionpay']
  ];
  for (const [text, kind] of cases) {
    assert.equal(channelFromPaymentMethod(text).kind, kind, `${text} 应识别为 ${kind}`);
  }
  // 认不出时不能瞎猜
  assert.equal(channelFromPaymentMethod('').kind, 'unknown');
  assert.equal(channelFromPaymentMethod('某个奇怪的东西').kind, 'unknown');
});

test('渠道识别：账单没有支付方式列时从商户名找线索', () => {
  assert.equal(channelHintOfMerchant({ merchant: '财付通-京东商城' }).kind, 'wechat');
  assert.equal(channelHintOfMerchant({ merchant: '支付宝-淘宝' }).kind, 'alipay');
  assert.equal(channelHintOfMerchant({ merchant: '京东金融' }).kind, 'bnpl');
  assert.equal(channelHintOfMerchant({ merchant: '星巴克' }).kind, 'unknown');
});

test('渠道优先级：先买后付 < 信用卡 < 银行卡 < 支付宝/微信', () => {
  assert.ok(CHANNEL_RANK.bnpl < CHANNEL_RANK.unionpay);
  assert.ok(CHANNEL_RANK.unionpay < CHANNEL_RANK.bank);
  assert.ok(CHANNEL_RANK.bank < CHANNEL_RANK.alipay);
});

test('同一笔消费：同商户、同金额、同方向、时间接近 → 是同一笔', () => {
  const a = { date: '2026-11-05', time: '08:12:33', amount: 3500, merchant: '星巴克(南京西路)', direction: 'expense', channelKind: 'bank' };
  const b = { date: '2026-11-05', time: '08:13:10', amount: 3500, merchant: '星巴克()', direction: 'expense', channelKind: 'unionpay' };
  assert.equal(isSamePurchase(a, b), true);
});

test('同商户同金额但时间差太大 → 是两笔不同的消费，不能合并', () => {
  // 一天两杯同款咖啡是常见的，这必须当成两笔
  const a = { date: '2026-11-05', time: '08:00:00', amount: 3500, merchant: '瑞幸咖啡', direction: 'expense' };
  const b = { date: '2026-11-05', time: '15:30:00', amount: 3500, merchant: '瑞幸咖啡', direction: 'expense' };
  assert.equal(isSamePurchase(a, b), false);
});

test('不同商户且都不是还款 → 不能合并（宁可漏合并，不可错合并）', () => {
  const a = { date: '2026-11-05', amount: 3500, merchant: '星巴克', direction: 'expense', channelKind: 'bank' };
  const b = { date: '2026-11-05', amount: 3500, merchant: '瑞幸咖啡', direction: 'expense', channelKind: 'alipay' };
  assert.equal(isSamePurchase(a, b), false);
});

test('信用卡消费 vs 储蓄卡还款：同一笔钱的两面，要合并', () => {
  const spend = { date: '2026-11-05', amount: 3500, merchant: '星巴克', direction: 'expense', channelKind: 'unionpay' };
  const repay = { date: '2026-11-05', amount: 3500, merchant: '信用卡还款', direction: 'expense', channelKind: 'bank', flow: { reason: 'repayment' } };
  assert.equal(isSamePurchase(spend, repay), true);
  // 反过来也要成立
  assert.equal(isSamePurchase(repay, spend), true);
});

test('金额或方向不同 → 一定是两笔', () => {
  const base = { date: '2026-11-05', amount: 3500, merchant: '星巴克', direction: 'expense' };
  assert.equal(isSamePurchase(base, { ...base, amount: 3600 }), false);
  assert.equal(isSamePurchase(base, { ...base, direction: 'income' }), false);
  assert.equal(isSamePurchase(base, { ...base, date: '2026-11-06' }), false);
});

test('collapseDuplicates 保留最源头的那条（信用卡消费优先于还款）', () => {
  const repay = { id: 't1', date: '2026-11-05', amount: 3500, merchant: '信用卡还款', direction: 'expense', channelKind: 'bank', flow: { reason: 'repayment' } };
  const spend = { id: 't2', date: '2026-11-05', amount: 3500, merchant: '星巴克', direction: 'expense', channelKind: 'unionpay' };
  const { keep, merged } = collapseDuplicates([repay, spend], []);
  assert.equal(keep.length, 1);
  assert.equal(keep[0].id, 't2', '应保留信用卡消费那条，而不是还款');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].dropped.id, 't1');
});

test('collapseDuplicates 不碰已有账本里的记录，只丢弃新来的重复', () => {
  const existing = [{ id: 'old', date: '2026-11-05', amount: 3500, merchant: '星巴克', direction: 'expense' }];
  const incoming = [{ id: 'new', date: '2026-11-05', amount: 3500, merchant: '星巴克', direction: 'expense' }];
  const { keep, merged } = collapseDuplicates(incoming, existing);
  assert.equal(keep.length, 0, '已入库的是既成事实，新来的重复丢弃');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].keptBy.id, 'old');
});

test('attachChannel 就地补充渠道字段', () => {
  const row = { account: '招商银行信用卡(5678)', merchant: '星巴克' };
  attachChannel(row);
  assert.equal(row.channelKind, 'unionpay');
  assert.match(row.channelLabel, /信用卡/);
});