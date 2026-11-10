/**
 * lib/flow.js —— 收支口径判定：这笔钱到底是「花了/赚了」，还是「只是搬了个窝」。
 *
 * 这是个人记账里最容易错、也最影响看板可信度的一步。同一笔 ¥20,000：
 *
 *   · 工资到账                         → 收入（真赚了）
 *   · 从招行转到余额宝                  → 不计收支（钱还在你名下，只是换了个账户）
 *   · 还房贷                            → 支出（这笔钱确实花掉了，变成砖头了）
 *   · 信用卡还款                        → 不计收支（先刷了卡记过支出，还款只是清偿）
 *   · 借给朋友 / 朋友还你               → 不计收支（是债权，不是消费也不是收入）
 *   · 随口说的「帮同事垫付 500」        → 不计收支（垫付会还回来）
 *
 * 记错的结果是双重的：转 2 万到余额宝会同时虚增当月「收入 2 万」和「支出 2 万」，
 * 结余看着没变，但收入支出两个大数全错、分类饼图被「其他」撑满、预算判断失真。
 *
 * 判定策略：**先证据、后金额**。只看金额大小判断是很糟的规则（还房贷金额很大、
 * 但确实是支出），所以这里先看这笔流水「像什么」（商户/摘要/对手方），
 * 再看它是否「有对应的另一腿」，最后才用金额做兜底提示。
 *
 * 判定结果：
 *   count   计入收支（默认）
 *   exclude 不计入收支（资金搬移、清偿、借贷）
 *   review  有把握不了的地方，**计入收支但在界面上标出来让用户确认**
 *
 * @module dsh-finance/flow
 */

import { normalizeMerchant } from './domain.js';

/** 判定结果。 */
export const FLOW_VERDICTS = Object.freeze(['count', 'exclude', 'review']);

/** 为什么这样判（给界面显示一句人话，也给测试断言用）。 */
export const FLOW_REASONS = Object.freeze({
  transfer: '账户间转账，钱还在你名下',
  repayment: '信用卡/花呗还款，之前的消费已经记过',
  loan: '借贷往来，属于债权不是消费',
  investment: '理财申购/赎回，属于资金搬移',
  advance: '垫付/代付，通常会还回来',
  cashout: '提现/取现，钱还在你手里',
  refund: '退款冲抵，不是收入',
  salary: '工资/薪酬，计入收入',
  debt: '还房贷/车贷等，是真实支出',
  family: '给家人/房东的钱，是真实支出',
  normal: '日常收支',
  large: '金额较大，请确认是否算收支'
});

/**
 * 各「资金搬移」类型的识别词。
 *
 * 匹配前文本会被 `normalizeMerchant` 归一化（去空白、标点、渠道前缀、转小写），
 * 所以这里只写关键词本身，不要写带空格的短语。
 */
const FLOW_KEYWORDS = Object.freeze({
  // 账户间转账
  transfer: Object.freeze([
    '转账', '转出', '转入', '内部转账', '互转', '资金划转', '调拨', '归集',
    'zero transfer', 'transfer', 'self transfer', 'own account'
  ]),
  // 信用卡/消费信贷还款：先消费后还钱，还的时候不能再算一次支出
  repayment: Object.freeze([
    '信用卡还款', '自动还款', '最低还款', '全额还款', '还花呗', '花呗还款',
    '还呗', '白条还款', '借呗还款', '微粒贷还款', '信用卡自动扣款', '信用卡账单',
    'repayment', 'card payment', 'credit card'
  ]),
  // 真实债务支出：还房贷/车贷/学贷。这是**真支出**——钱花掉了，
  // 换来的是房子和车，不能再当成「资金搬移」排除掉。
  debt: Object.freeze([
    '房贷', '车贷', '助学贷款', '按揭', '月供', '还房贷', '还车贷', 'mortgage',
    'auto loan', 'student loan', 'loan payment'
  ]),
  // 借贷：借出/借入/收到还款，是债权债务不是收支
  loan: Object.freeze([
    '借款', '借出', '借入', '还借款', '还款给我', '收回借款', '垫付', '代付', '代付还款',
    '转给', '转账给', '借给', '还钱给', '收到还款', 'repaid',
    'loan', 'borrow', 'lend'
  ]),
  // 理财申购赎回：钱从账户进到基金，仍在净资产里
  investment: Object.freeze([
    '申购', '赎回', '买入基金', '卖出基金', '定投扣款', '基金转入', '理财转入', '理财转出',
    '余额宝转入', '余额宝转出', '零钱通转入', '零钱通转出', '存单', '国债逆回购',
    'purchase', 'redeem', 'subscription'
  ]),
  // 提现/取现：现金与账户之间的搬运
  cashout: Object.freeze([
    '提现', '取现', 'atm取款', '现金取出', '提现到', 'withdraw', 'cash withdrawal'
  ]),
  // 退款：冲抵原支出，不是一笔新收入
  refund: Object.freeze([
    '退款', '退货退款', '部分退款', '原路退回', '冲正', 'refund', 'reversal'
  ]),
  // 垫付/代付
  advance: Object.freeze([
    '代付', '垫付', '帮付', '代购', 'treat'
  ])
});

/**
 * 「转给家人/房东」也常被账单记成「转账」，但那是**真实支出**，不是把
 * 自己的钱从一个账户挪到另一个账户。这些词命中时按支出口径计入。
 */
const FAMILY_SPEND_KEYWORDS = Object.freeze([
  '亲属卡', '房东', '房租', '租金', '水电费', '物业费', '家用', '生活费',
  '赡养', '给爸妈', '给家里',
]);

/** 明确的收入来源词：这些即使是「转账」形式也要计入收入。 */
const INCOME_KEYWORDS = Object.freeze([
  '工资', '薪', '奖金', '年终奖', '绩效', '提成', '报销', '劳务', '稿费', '兼职',
  '补贴', '津贴', '补助', '分红', '股息', '利息', '收益', '公积金提取', '社保返还',
  '退税', '租金', 'salary', 'wage', 'bonus', 'payroll', 'dividend', 'interest', 'income'
]);

/**
 * 大额判定门槛（分）。
 *
 * 这是「值得提醒用户看一眼」的线，不是「一定是转账」的线。定 ¥3,000 是因为
 * 日常单笔支出（餐饮、交通、日用品）极少到这个量级，而房租/房贷这类真支出
 * 会被 `repayment` / 商户名先认出来。
 */
export const LARGE_CENTS = 300000;

/**
 * 判断文字里是否命中某组关键词。
 * @param {string} text 已归一化的文本
 * @param {readonly string[]} words 关键词
 * @returns {boolean} 是否命中
 */
function hits(text, words) {
  if (text === '') return false;
  return words.some((word) => text.includes(word));
}

/**
 * 把一笔流水里能用来判断的文本拼起来并归一化。
 *
 * 商户名、摘要、对方账户、账单自带的交易分类都算证据——支付宝的「交易分类」
 * 那一列经常直接写着「转账」「信用还款」，比自己猜商户名可靠得多。
 *
 * @param {{ merchant?: string, note?: string, account?: string, categoryHint?: string, raw?: object }} row 行
 * @returns {string} 归一化后的证据文本
 */
export function evidenceOf(row = {}) {
  const raw = row.raw !== null && typeof row.raw === 'object' ? row.raw : {};
  const parts = [
    row.merchant,
    row.note,
    row.account,
    row.categoryHint,
    raw.category,
    raw.type,
    raw.counterparty,
    raw.remark
  ];
  return normalizeMerchant(parts.filter((part) => typeof part === 'string').join(' '));
}

/**
 * 判定一笔流水的收支口径。
 *
 * 决策顺序（每一条都是「有把握的强证据」优先，弱证据兜底）：
 *
 *  1. 明确的收入词（工资/奖金/报销…）→ **计入收入**，不管金额多大、商户名里有没有
 *     「转账」二字。这是最重要的豁免：很多银行把代发工资记成「转账」。
 *  2. 退款 → 不计收支（冲抵原支出）。
 *  3. 信用卡还款 / 借贷 / 理财申赎 / 提现 / 垫付 / 转账 → 不计收支，并给出原因。
 *  4. 都没有命中，但金额 ≥ LARGE_CENTS：
 *     - 支出方向 → `review`：**仍然计入**，但在界面上标「大额，请确认」，
 *       因为大额消费（换电脑、家电、旅行）也是真实的支出，不能一律排除。
 *     - 收入方向 → `review` 同理（可能是亲友转账，也可能是真实收入）。
 *  5. 其余 → 计入收支。
 *
 * @param {{ merchant?: string, note?: string, account?: string, categoryHint?: string,
 *          direction?: string, amount?: number, raw?: object }} row 流水或导入行
 * @param {{ largeCents?: number }} [options] 覆盖大额门槛（测试注入）
 * @returns {{ verdict: string, reason: string, detail: string, matched: string }} 判定结果
 *   verdict 见 FLOW_VERDICTS；reason 是 FLOW_REASONS 的键；detail 是一句人话
 */
export function judgeFlow(row = {}, options = {}) {
  const text = evidenceOf(row);
  const direction = row.direction === 'income' ? 'income' : 'expense';
  const amount = Math.abs(Math.round(Number(row.amount) || 0));
  const largeCents = Number.isFinite(options.largeCents) ? options.largeCents : LARGE_CENTS;

  // 1. 明确收入词优先：代发工资常常写成「转账」，不能被后面的转账规则吃掉。
  if (hits(text, INCOME_KEYWORDS)) {
    return { verdict: 'count', reason: 'salary', detail: FLOW_REASONS.salary, matched: 'income-keyword' };
  }

  // 2. 亲属卡/房东/家用：账单里写成「转账」，但这是真实支出。
  //    判在转账规则之前，否则给妈妈的生活费会被当成「资金搬移」排除掉。
  if (hits(text, FAMILY_SPEND_KEYWORDS)) {
    return { verdict: 'count', reason: 'family', detail: FLOW_REASONS.family, matched: 'family' };
  }

  // 3. 退款：不是新收入，冲抵原支出即可（原支出已经记过了）。
  if (hits(text, FLOW_KEYWORDS.refund)) {
    return { verdict: 'exclude', reason: 'refund', detail: FLOW_REASONS.refund, matched: 'refund' };
  }

  // 3. 信用卡/花呗还款先认：这是清偿，绝对不能算支出。它比「房贷车贷」更
  //    容易被误判（几乎每份账单都有），所以放在 debt 之前。
  if (hits(text, FLOW_KEYWORDS.repayment) && !hits(text, FLOW_KEYWORDS.debt)) {
    return { verdict: 'exclude', reason: 'repayment', detail: FLOW_REASONS.repayment, matched: 'repayment' };
  }

  // 4. 真实债务支出（房贷/车贷）：它是支出，不是清偿。
  if (hits(text, FLOW_KEYWORDS.debt)) {
    return { verdict: 'count', reason: 'debt', detail: FLOW_REASONS.debt, matched: 'debt' };
  }

  // 5. 已经被归类为「家庭」的流水（分类阶段认出是给家人/房东的钱），
  //    即使是「转账」形态也按真实支出计入。分类与口径两个模块各管一段，
  //    这里用分类结果兜住「商户名里没有家庭线索、但分类阶段已经认出」的情况。
  if (row.category === '家庭') {
    return { verdict: 'count', reason: 'family', detail: FLOW_REASONS.family, matched: 'category' };
  }

  // 6. 资金搬移 / 借贷：按可信度从强到弱依次判断。
  const ordered = [
    ['loan', 'loan'],
    ['investment', 'investment'],
    ['cashout', 'cashout'],
    ['advance', 'advance'],
    ['transfer', 'transfer']
  ];
  for (const [key, reason] of ordered) {
    if (hits(text, FLOW_KEYWORDS[key])) {
      return { verdict: 'exclude', reason, detail: FLOW_REASONS[reason], matched: key };
    }
  }

  // 7. 大额且没有证据指向资金搬移：仍然计入，但标出来让用户确认。
  if (amount >= largeCents) {
    return { verdict: 'review', reason: 'large', detail: FLOW_REASONS.large, matched: 'amount' };
  }

  // 8. 默认：普通收支。
  return { verdict: 'count', reason: 'normal', detail: FLOW_REASONS.normal, matched: 'default' };
}

/**
 * 给一批导入行补上收支口径判定。
 *
 * 判定结果写进 `row.flow`（`{ verdict, reason, detail }`），
 * `exclude` 的行把 `row.money = true`，让 store 与分析层都按「不计入收支」处理。
 *
 * @param {Array<object>} rows 导入行
 * @param {{ largeCents?: number }} [options] 选项
 * @returns {Array<object>} 同一批行（就地补充字段，方便链式调用）
 */
export function judgeRows(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue;
    const judged = judgeFlow(row, options);
    row.flow = judged;
    // `exclude` 才真正不计入收支；`review` 仍计入，只是界面上标出来。
    row.money = judged.verdict === 'exclude';
  }
  return list;
}

/**
 * 汇总一批行的判定情况（面板的导入预览用它显示「其中 N 笔不计收支」）。
 *
 * @param {Array<{ flow?: { verdict: string } }>} rows 已判定的行
 * @returns {{ count: number, exclude: number, review: number, total: number }} 统计
 */
export function flowSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const totals = { count: 0, exclude: 0, review: 0, total: list.length };
  for (const row of list) {
    const verdict = row?.flow?.verdict;
    if (verdict === 'exclude') totals.exclude += 1;
    else if (verdict === 'review') totals.review += 1;
    else totals.count += 1;
  }
  return totals;
}