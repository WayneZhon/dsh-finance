/**
 * lib/todos.js —— 把保单上的日期，变成「现在要做什么」。
 *
 * 保单管理最容易做成一本死档案：日期记在那儿，但没人会主动去翻。真正有用的是
 * **到点有人推你一下，而且推完你能把它划掉**。
 *
 * ## 为什么待办是「派生」的，而不是存一张表
 *
 * 如果建一张 todos 表，用户改了保单的缴费日，表里的待办就对不上了——要么
 * 留一条孤儿数据，要么写一套同步逻辑（最容易出 bug 的地方）。
 *
 * 所以这里：**待办每次从保单日期实时算出来**，只单独存「用户对它做了什么」
 * （完成 / 稍后），键是 `${policyId}:${kind}:${dueDate}`。
 * 保单日期一改，待办的键跟着变，旧状态自然失效——不会留下对不上的东西。
 *
 * ## 「提醒过了」不等于「已经缴费」
 *
 * 这是产品上最容易做错的一处：把提醒标记完成，很容易被当成钱已经交了。
 * 所以缴费类的待办有**两类证据**才可能自动完成：
 *
 *   1. 用户上传/录入的缴费记录（`payments`）匹配上这一期；
 *   2. 用户显式点「已完成」。
 *
 * 两者都没有时，待办就是没完成——哪怕提醒已经响过十次。
 *
 * @module dsh-finance/todos
 */

import { PAY_CYCLES, dayKey, daysBetween, isDateText, shiftMonth } from './domain.js';

/** 待办的紧急度分档，按「还剩几天」。 */
export const TODO_BUCKETS = Object.freeze(['overdue', 'today', 'soon', 'later']);

/**
 * 「快到期」的阈值（天）。
 *
 * 定 30 天而不是 7 天：缴费是要**提前安排钱**的事，7 天太赶；
 * 而一个月内要处理的保单事务，本来就是用户想在这一屏看完的量。
 */
const SOON_DAYS = 30;

/** 缴费周期 → 月数。`once` 不产生后续缴费。 */
const CYCLE_MONTHS = Object.freeze({
  yearly: 12,
  half_year: 6,
  quarterly: 3,
  monthly: 1,
  once: 0,
});

/**
 * 按「原始锚点日」在月份上叠加，而不是在结果上叠加。
 *
 * 这是排期最容易错的地方：1 月 31 日的年缴，如果按结果递推会变成
 * 2/28 → 3/28 → 4/28，日子越走越偏。正确做法是**永远拿原始的第 31 天**
 * 去算每个目标月，遇短月取月末，回到长月恢复 31 日。
 *
 * @param {string} anchorDate 原始日期 `YYYY-MM-DD`（锚点）
 * @param {number} months 叠加的月数
 * @returns {string} 目标月的对应日期
 */
function addMonths(anchorDate, months) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(anchorDate ?? ''));
  if (match === null || months === 0) return anchorDate;
  // 锚点日是**原始**的那一天，不随中间月份变化
  const anchorDay = Number(match[3]);
  const shifted = shiftMonth(`${match[1]}-${match[2]}`, months);
  const [nextYear, nextMonth] = shifted.split('-').map(Number);
  const lastDay = new Date(nextYear, nextMonth, 0).getDate();
  return `${String(nextYear)}-${String(nextMonth).padStart(2, '0')}-${String(Math.min(anchorDay, lastDay)).padStart(2, '0')}`;
}

/**
 * 算出一份保单「下一次缴费日」。
 *
 * 保单里记的 `dueDate` 是**下一次**的缴费日；如果它已经过去了（用户很久没更新），
 * 按缴费周期往后滚，直到落在今天或之后。趸交/已缴清的保单不产生缴费待办。
 *
 * @param {object} policy 保单
 * @param {number} now 当前时间戳
 * @returns {string} `YYYY-MM-DD`，没有缴费计划时返回 ''
 */
export function nextPremiumDate(policy, now = Date.now()) {
  if (policy === null || typeof policy !== 'object') return '';
  if (policy.payCycle === 'once') return '';
  const months = CYCLE_MONTHS[policy.payCycle];
  if (!(months > 0)) return '';
  // 已缴满期数 → 不再有缴费
  if (policy.totalPeriods > 0 && policy.paidPeriods >= policy.totalPeriods) return '';
  let date = isDateText(policy.dueDate) ? policy.dueDate : '';
  if (date === '') return '';
  const today = dayKey(now);
  // 最多滚 100 期，防止脏数据把循环拖爆
  for (let guard = 0; guard < 100; guard += 1) {
    if (daysBetween(today, date) >= -31) return date;
    date = addMonths(date, months);
    if (date === '') return '';
  }
  return date;
}

/**
 * 判断某一期缴费是否有缴费记录作为证据。
 *
 * 允许 ±15 天的误差：实际扣款日与合同约定的应交日经常差几天。
 *
 * @param {object} policy 保单
 * @param {string} dueDate 应交日
 * @param {object[]} payments 该保单的缴费记录
 * @returns {object|null} 匹配到的缴费记录，没有则 null
 */
function paymentEvidence(policy, dueDate, payments) {
  if (!isDateText(dueDate)) return null;
  for (const payment of payments) {
    if (payment.policyId !== policy.id) continue;
    const diff = daysBetween(dueDate, payment.date);
    if (Math.abs(diff) <= 15) return payment;
  }
  return null;
}

/**
 * 从保单派生出一条缴费待办。
 *
 * @param {object} policy 保单
 * @param {object[]} payments 该保单的缴费记录
 * @param {object} state 用户处理状态
 * @param {number} now 当前时间戳
 * @returns {object|null} 待办，或 null
 */
function premiumTodo(policy, payments, state, now) {
  const dueDate = nextPremiumDate(policy, now);
  if (dueDate === '') return null;
  const evidence = paymentEvidence(policy, dueDate, payments);
  const key = `${policy.id}:premium:${dueDate}`;
  const override = state[key];
  // 有缴费记录 = 这期已经交了，不用提醒（但保留记录可查）
  if (evidence !== null && (override === undefined || override.status === 'pending')) return null;
  return {
    key,
    policyId: policy.id,
    kind: 'premium',
    title: `${policy.name} 续期缴费`,
    detail: policy.payCycle === 'monthly' ? '月缴' : policy.payCycle === 'quarterly' ? '季缴' : '年缴',
    dueDate,
    amount: policy.premium,
    memberId: policy.memberId,
    evidence: evidence === null ? null : { id: evidence.id, date: evidence.date, amount: evidence.amount },
  };
}

/**
 * 从保单派生出「保障到期」待办。
 *
 * @param {object} policy 保单
 * @param {object} state 用户处理状态
 * @param {number} now 当前时间戳
 * @returns {object|null} 待办，或 null
 */
function maturityTodo(policy, state, now) {
  const date = isDateText(policy.maturityDate) ? policy.maturityDate : '';
  if (date === '') return null;
  const days = daysBetween(dayKey(now), date);
  // 到期超过 90 天就不必再提醒了，避免历史保单一直挂在待办里
  if (days < -90) return null;
  const key = `${policy.id}:maturity:${date}`;
  void state[key];
  return {
    key,
    policyId: policy.id,
    kind: 'maturity',
    title: `${policy.name} 到期`,
    detail: policy.kind === 'insurance' ? '保障期满，看看要不要续保或转换' : '到期需处理：取出或续投',
    dueDate: date,
    amount: policy.kind === 'insurance' ? 0 : policy.amount,
    memberId: policy.memberId,
    evidence: null,
  };
}

/**
 * 派生「等待期结束」待办。
 *
 * 等待期内出险通常不赔，所以「等待期何时结束」是有实际意义的日子——
 * 很多人不知道自己刚买的保险头 90 天是空的。
 *
 * @param {object} policy 保单
 * @param {number} now 当前时间戳
 * @returns {object|null} 待办，或 null
 */
function waitingTodo(policy, now) {
  if (policy.kind !== 'insurance' || !isDateText(policy.effectiveDate)) return null;
  const maxWaiting = Math.max(0, ...policy.duties.map((duty) => Number(duty.waitingDays) || 0));
  if (maxWaiting <= 0) return null;
  const start = new Date(`${policy.effectiveDate}T00:00:00`);
  start.setDate(start.getDate() + maxWaiting);
  const date = dayKey(start);
  const days = daysBetween(dayKey(now), date);
  // 只提醒还没结束的
  if (days < 0) return null;
  return {
    key: `${policy.id}:waiting:${date}`,
    policyId: policy.id,
    kind: 'waiting',
    title: `${policy.name} 等待期结束`,
    detail: `共 ${String(maxWaiting)} 天，结束后保障才完整生效`,
    dueDate: date,
    amount: 0,
    memberId: policy.memberId,
    evidence: null,
  };
}

/**
 * 派生「犹豫期结束」待办。
 *
 * 长期险一般有 15 天犹豫期，期内退保可以全额退。过了就按现金价值算，
 * 差别很大——所以这是个真正「错过了就没了」的日子。
 *
 * @param {object} policy 保单
 * @param {number} now 当前时间戳
 * @returns {object|null} 待办，或 null
 */
function graceTodo(policy, now) {
  if (policy.kind !== 'insurance' || !isDateText(policy.effectiveDate)) return null;
  const start = new Date(`${policy.effectiveDate}T00:00:00`);
  start.setDate(start.getDate() + 15);
  const date = dayKey(start);
  const days = daysBetween(dayKey(now), date);
  if (days < 0) return null;
  return {
    key: `${policy.id}:grace:${date}`,
    policyId: policy.id,
    kind: 'grace',
    title: `${policy.name} 犹豫期结束`,
    detail: '犹豫期内退保全额退，之后按现金价值',
    dueDate: date,
    amount: 0,
    memberId: policy.memberId,
    evidence: null,
  };
}

/**
 * 把一批保单派生为待办列表，并套用用户的完成/稍后状态。
 *
 * @param {object[]} policies 保单
 * @param {object[]} payments 缴费记录
 * @param {object} state 用户处理状态 `{ [key]: { status, snoozeUntil, doneAt, note } }`
 * @param {number} now 当前时间戳
 * @returns {object[]} 待办，按日期升序
 */
export function deriveTodos(policies, payments, state, now = Date.now()) {
  const list = Array.isArray(policies) ? policies : [];
  const paymentList = Array.isArray(payments) ? payments : [];
  const overrides = state !== null && typeof state === 'object' ? state : {};
  const today = dayKey(now);
  const todos = [];

  for (const policy of list) {
    // 用户自己加的检查日 / 理赔跟进（存在保单的 customTodos 上）
    for (const custom of Array.isArray(policy.customTodos) ? policy.customTodos : []) {
      if (!isDateText(custom?.dueDate)) continue;
      todos.push({
        key: `${policy.id}:${custom.kind ?? 'checkup'}:${custom.dueDate}`,
        policyId: policy.id,
        kind: custom.kind ?? 'checkup',
        title: custom.title || `${policy.name} 检查`,
        detail: String(custom.detail ?? ''),
        dueDate: custom.dueDate,
        amount: 0,
        memberId: policy.memberId,
        evidence: null,
      });
    }
    for (const todo of [premiumTodo(policy, paymentList, overrides, now), maturityTodo(policy, overrides, now), waitingTodo(policy, now), graceTodo(policy, now)]) {
      if (todo !== null) todos.push(todo);
    }
  }

  // 套用用户状态：完成的不再出现（除非用户把它重新打开），稍后的改日期
  const resolved = [];
  for (const todo of todos) {
    const override = overrides[todo.key];
    const status = override?.status ?? 'pending';
    if (status === 'done') continue;
    let dueDate = todo.dueDate;
    if (status === 'snoozed' && isDateText(override.snoozeUntil)) dueDate = override.snoozeUntil;
    const days = daysBetween(today, dueDate);
    resolved.push({
      ...todo,
      dueDate,
      originalDueDate: todo.dueDate,
      days,
      bucket: days < 0 ? 'overdue' : days === 0 ? 'today' : days <= SOON_DAYS ? 'soon' : 'later',
      status,
      // 完成时用的时间，界面上显示「什么时候处理的」
      doneAt: status === 'done' ? override.doneAt : 0,
      note: override?.note ?? '',
    });
  }

  return resolved.sort((a, b) => {
    // 已逾期的最前，然后按日期
    if (a.bucket !== b.bucket) {
      const order = { overdue: 0, today: 1, soon: 2, later: 3 };
      return order[a.bucket] - order[b.bucket];
    }
    return a.dueDate.localeCompare(b.dueDate);
  });
}

/**
 * 年度缴费日历：未来 12 个月，每个月计划要缴多少钱。
 *
 * 用来安排资金——「明年 3 月要交 1 万 2」这种信息，比一堆散落的日期有用。
 *
 * @param {object[]} policies 保单
 * @param {number} now 当前时间戳
 * @returns {Array<{ month: string, amount: number, items: object[] }>} 12 个月
 */
export function premiumCalendar(policies, now = Date.now()) {
  const list = Array.isArray(policies) ? policies : [];
  const today = new Date(now);
  const months = [];
  for (let offset = 0; offset < 12; offset += 1) {
    const date = new Date(today.getFullYear(), today.getMonth() + offset, 1);
    months.push({ month: `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}`, amount: 0, items: [] });
  }
  const index = new Map(months.map((entry) => [entry.month, entry]));
  const horizon = months[months.length - 1].month;

  for (const policy of list) {
    if (!(policy.premium > 0)) continue;
    const monthsPerCycle = CYCLE_MONTHS[policy.payCycle];
    if (!(monthsPerCycle > 0)) continue;
    const anchor = isDateText(policy.dueDate) ? policy.dueDate : '';
    if (anchor === '') continue;
    // 同样从原始锚点递推，保证 31 日的保单不会越走越偏
    for (let period = 0; period < 24; period += 1) {
      const date = addMonths(anchor, monthsPerCycle * period);
      if (date === '') break;
      const month = date.slice(0, 7);
      if (month > horizon) break;
      if (month < months[0].month) continue;
      const bucket = index.get(month);
      if (bucket !== undefined) {
        bucket.amount += policy.premium;
        bucket.items.push({ policyId: policy.id, name: policy.name, date, amount: policy.premium });
      }
    }
  }
  return months;
}

/**
 * 工作台的「家庭保单概览」：每个成员各有几份保单、保障类别分布。
 *
 * @param {object[]} members 家庭成员
 * @param {object[]} policies 保单
 * @returns {{ byMember: object[], unassigned: object[], total: number }}
 */
export function familyOverview(members, policies) {
  const memberList = Array.isArray(members) ? members : [];
  const policyList = Array.isArray(policies) ? policies : [];
  const byMember = memberList.map((member) => {
    const owned = policyList.filter((policy) => policy.memberId === member.id);
    return {
      id: member.id,
      name: member.name,
      relation: member.relation,
      count: owned.length,
      insuranceCount: owned.filter((policy) => policy.kind === 'insurance').length,
      depositCount: owned.filter((policy) => policy.kind !== 'insurance').length,
      annualPremium: owned.filter((policy) => policy.kind === 'insurance').reduce((acc, policy) => acc + (policy.premium || 0), 0),
      coverage: owned.filter((policy) => policy.kind === 'insurance').reduce((acc, policy) => acc + (policy.amount || 0), 0),
      policies: owned.map((policy) => ({ id: policy.id, name: policy.name, kind: policy.kind, type: policy.type })),
    };
  });
  const unassigned = policyList.filter((policy) => policy.memberId === '' || !memberList.some((member) => member.id === policy.memberId));
  return {
    byMember,
    unassigned: unassigned.map((policy) => ({ id: policy.id, name: policy.name, kind: policy.kind })),
    total: policyList.length,
  };
}

/** 缴费周期的中文名（Host 侧给模型/文本用）。 */
export const CYCLE_LABELS = Object.freeze({
  yearly: '年缴',
  half_year: '半年缴',
  quarterly: '季缴',
  monthly: '月缴',
  once: '趸交',
});

/**
 * 这个缴费周期是否会产生后续缴费（趸交不会）。
 * @param {string} cycle 周期
 * @returns {boolean} 是否有后续缴费
 */
export function isRecurring(cycle) {
  return (CYCLE_MONTHS[cycle] ?? 0) > 0 && PAY_CYCLES.includes(cycle);
}