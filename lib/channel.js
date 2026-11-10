/**
 * lib/channel.js —— 支付渠道识别与跨账单去重。
 *
 * 一笔消费常常在**两三份账单**里各出现一次：
 *
 *     星巴克 ¥35（2026-11-01 08:12:33）
 *       ├─ 支付宝账单：「星巴克(南京西路)」「收/付款方式：招商银行储蓄卡(1234)」
 *       ├─ 招行信用卡账单：「星巴克」「人民币 35.00」
 *       └─ 招行储蓄卡账单：「信用卡还款 35.00」（这个月还的是上个月）
 *
 * 三份都导入，一杯咖啡会被记成 ¥105 支出。本模块解决两件事：
 *
 *   1. **识别渠道**：这笔钱实际走的是支付宝 / 微信 / 花呗 / 白条 / 美团月付 /
 *      哪张卡。渠道信息来自账单自带的「收/付款方式」「支付方式」列，以及商户名里的线索。
 *   2. **跨账单去重**：同一笔消费在不同账单里重复出现时只保留**最源头**的那一条
 *      （刷卡消费 > 还款记录），并把被合并的记录挂到 `duplicates` 里，可追溯。
 *
 * 设计原则：**宁可漏合并，不可错合并**。合并错了会让用户少记一笔真实支出，
 * 比多记一笔更难发现。所以只在「日期 + 金额 + 方向」都严格相等、且时间相差
 * 不超过 `MATCH_WINDOW_MS`、且不是两张不同银行卡时才合并。
 *
 * @module dsh-finance/channel
 */

import { normalizeMerchant } from './domain.js';

/** 渠道类型：决定「谁是最源头」。 */
export const CHANNEL_KINDS = Object.freeze(['alipay', 'wechat', 'unionpay', 'bank', 'bnpl', 'cash', 'unknown']);

/**
 * 渠道优先级：数字越小越「源头」。
 *
 * 同一天同一笔钱，如果既有「信用卡消费」又有「储蓄卡还款」，保留前者——
 * 前者才是真实消费发生的那一刻，后者只是清偿。
 */
export const CHANNEL_RANK = Object.freeze({
  bnpl: 0,      // 白条/月付：先买后付，消费事实发生在这
  unionpay: 1,  // 银联/信用卡消费
  bank: 2,      // 银行卡消费
  alipay: 3,    // 支付宝（可能是余额、也可能走卡）
  wechat: 4,    // 微信（同上）
  cash: 5,
  unknown: 6
});

/** 两个渠道是否是同一种「清偿还」关系（后一个还的可能是前一个）。 */
const REPAY_TARGETS = Object.freeze({
  // 还款记录 → 它可能在清偿哪类渠道
  credit: Object.freeze(['unionpay', 'bank', 'bnpl']),
  bank: Object.freeze(['unionpay'])
});

/**
 * 从账单的「收/付款方式」「支付方式」等列里认渠道。
 *
 * @param {string} text 支付方式文本，例如「招商银行储蓄卡(1234)」「余额宝」「花呗」
 * @returns {{ channel: string, kind: string, label: string }} 渠道信息
 */
export function channelFromPaymentMethod(text) {
  const raw = String(text ?? '').trim();
  const key = normalizeMerchant(raw);
  if (key === '') return { channel: 'unknown', kind: 'unknown', label: '' };

  // 先买后付
  if (/(白条|京东白条|美团月付|月付|花呗|借呗|分期|放心借|金条)/u.test(key)) {
    const label = /白条/u.test(key) ? '京东白条' : /美团|月付/u.test(key) ? '美团月付' : /花呗/u.test(key) ? '花呗' : '先买后付';
    return { channel: label, kind: 'bnpl', label };
  }
  // 支付宝 / 微信钱包
  if (/(余额宝|支付宝|花呗余额)/u.test(key)) return { channel: '支付宝', kind: 'alipay', label: '支付宝' };
  if (/(零钱通|微信|微信零钱|财付通)/u.test(key)) return { channel: '微信', kind: 'wechat', label: '微信' };
  // 信用卡：卡片名里通常带「信用卡」「贷记卡」
  if (/(信用卡|贷记卡|信用付|花旗|招行卡)/u.test(key)) return { channel: raw, kind: 'unionpay', label: raw };
  // 储蓄卡 / 借记卡 / 银行名
  if (/(储蓄卡|借记卡|银行|农行|工行|建行|中行|招行|交行|邮储|浦发|中信|民生|兴业|光大|华夏|平安)/u.test(key)) {
    return { channel: raw, kind: 'bank', label: raw };
  }
  // 交通卡/公交卡：预充值是资金搬移，刷卡才是消费，归到 bank 一类处理
  if (/(交通卡|公交卡|一卡通|乘车码)/u.test(key)) return { channel: raw, kind: 'bank', label: raw };
  // 云闪付/银联：本质是银行卡通道
  if (/(云闪付|银联|unionpay)/u.test(key)) return { channel: '云闪付', kind: 'unionpay', label: '云闪付' };
  if (/现金|纸币/u.test(key)) return { channel: '现金', kind: 'cash', label: '现金' };
  return { channel: raw, kind: 'unknown', label: raw };
}

/**
 * 从商户名和备注里再补一次渠道识别（账单没有支付方式列时用）。
 *
 * 支付宝/微信账单的商户名里经常藏着渠道，例如「财付通-京东商城」表示这笔
 * 在支付宝里付给京东、但京东是用财付通收的。
 *
 * @param {{ merchant?: string, note?: string }} row 行
 * @returns {{ kind: string, label: string }} 识别结果，认不出时 kind 为 unknown
 */
export function channelHintOfMerchant(row = {}) {
  // 注意：必须先看**原始**文本。`normalizeMerchant` 会把「财付通-」「支付宝-」
  // 这类渠道前缀当作噪声剥掉，等归一化完线索就没了。
  const raw = String(`${row.merchant ?? ''} ${row.note ?? ''}`);
  const text = `${raw} ${normalizeMerchant(raw)}`.toLowerCase();
  if (/(财付通|tenpay)/u.test(text)) return { kind: 'wechat', label: '微信' };
  if (/(支付宝|alipay)/u.test(text)) return { kind: 'alipay', label: '支付宝' };
  if (/(白条|京东金融)/u.test(text)) return { kind: 'bnpl', label: '京东白条' };
  if (/(美团月付)/u.test(text)) return { kind: 'bnpl', label: '美团月付' };
  return { kind: 'unknown', label: '' };
}

/**
 * 判断两笔流水是否是「同一笔钱的两条记录」。
 *
 * 只做**保守**判断：日期、金额、方向必须完全一致；时间戳都有时相差不超过
 * `windowMs`（默认 3 分钟，跨账单的时间误差主要来自「消费时间」与「入账时间」）；
 * 且必须有一方的渠道信息能解释另一方（例如一个还另一个的款）。
 *
 * @param {object} a 流水 A
 * @param {object} b 流水 B
 * @param {{ windowMs?: number }} [options]
 * @returns {boolean} 是否同一笔
 */
export function isSamePurchase(a, b, options = {}) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a.id !== undefined && b.id !== undefined && a.id === b.id) return true;
  // 日期与金额必须严格相等
  if (String(a.date ?? '') !== String(b.date ?? '')) return false;
  if (Math.abs(Number(a.amount) || 0) !== Math.abs(Number(b.amount) || 0)) return false;
  const dirA = a.direction === 'income' ? 'income' : 'expense';
  const dirB = b.direction === 'income' ? 'income' : 'expense';
  if (dirA !== dirB) return false;

  // 时间戳：两边都有时要求靠得够近
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : 3 * 60 * 1000;
  const timeA = a.time ? Date.parse(`${a.date} ${a.time}`) : NaN;
  const timeB = b.time ? Date.parse(`${b.date} ${b.time}`) : NaN;
  if (Number.isFinite(timeA) && Number.isFinite(timeB) && Math.abs(timeA - timeB) > windowMs) return false;

  // 商户名：一致就可以认定。不一致时，必须有一方是「还款/转账」才可能相关。
  const nameA = normalizeMerchant(a.merchant);
  const nameB = normalizeMerchant(b.merchant);
  if (nameA !== '' && nameA === nameB) return true;

  // 不同名时只在「一个还另一个」的场景合并：还款记录 vs 消费记录
  const kindA = a.channelKind ?? 'unknown';
  const kindB = b.channelKind ?? 'unknown';
  const repayA = !!a.flow && a.flow.reason === 'repayment';
  const repayB = !!b.flow && b.flow.reason === 'repayment';
  if (repayA && !repayB && REPAY_TARGETS.credit.includes(kindB)) return true;
  if (repayB && !repayA && REPAY_TARGETS.credit.includes(kindA)) return true;

  return false;
}

/**
 * 在一批流水里找出重复对，并决定保留哪一条。
 *
 * 规则：**保留渠道优先级最高（最源头）的那一条**；优先级相同时保留先出现的
 * （通常是先导入的账单，也就是用户更早建立的那份）。
 *
 * @param {Array<object>} txns 候选流水（尚未入库）
 * @param {Array<object>} [existing] 已入库的流水
 * @param {{ windowMs?: number }} [options]
 * @returns {{ keep: Array<object>, merged: Array<{ dropped: object, keptBy: object }> }}
 */
export function collapseDuplicates(txns, existing = [], options = {}) {
  const survivors = [];
  const merged = [];
  // 先处理「新导入 vs 已入库」：已入库的是既成事实，新来的重复就丢掉。
  const pool = Array.isArray(existing) ? existing : [];
  const candidate = [];
  for (const txn of Array.isArray(txns) ? txns : []) {
    const hit = pool.find((item) => isSamePurchase(txn, item, options));
    if (hit !== undefined) {
      merged.push({ dropped: txn, keptBy: hit });
      continue;
    }
    candidate.push(txn);
  }
  // 再处理「本次导入内部」的重复
  for (const txn of candidate) {
    const hit = survivors.find((item) => isSamePurchase(txn, item, options));
    if (hit === undefined) {
      survivors.push(txn);
      continue;
    }
    // 谁更「源头」留谁
    const rankNew = CHANNEL_RANK[txn.channelKind ?? 'unknown'] ?? CHANNEL_RANK.unknown;
    const rankOld = CHANNEL_RANK[hit.channelKind ?? 'unknown'] ?? CHANNEL_RANK.unknown;
    if (rankNew < rankOld) {
      survivors[survivors.indexOf(hit)] = txn;
      merged.push({ dropped: hit, keptBy: txn });
    } else {
      merged.push({ dropped: txn, keptBy: hit });
    }
  }
  return { keep: survivors, merged };
}

/**
 * 给流水补上渠道字段（从 paymentMethod 与商户线索推断）。
 *
 * @param {object} row 流水或导入行
 * @returns {object} 同一对象（就地补充 channel / channelKind / channelLabel）
 */
export function attachChannel(row) {
  if (row === null || typeof row !== 'object') return row;
  const fromMethod = channelFromPaymentMethod(row.paymentMethod ?? row.account ?? '');
  if (fromMethod.kind !== 'unknown') {
    row.channel = fromMethod.channel;
    row.channelKind = fromMethod.kind;
    row.channelLabel = fromMethod.label;
    return row;
  }
  const fromMerchant = channelHintOfMerchant(row);
  row.channel = fromMerchant.label || String(row.account ?? '') || '';
  row.channelKind = fromMerchant.kind;
  row.channelLabel = fromMerchant.label;
  return row;
}