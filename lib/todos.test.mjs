import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveTodos,
  familyOverview,
  nextPremiumDate,
  premiumCalendar,
} from './todos.js';

const NOW = new Date(2026, 10, 10).getTime();

/** 一份年缴保单的骨架。 */
const policy = (patch = {}) => ({
  id: 'p1',
  kind: 'insurance',
  name: '平安福',
  premium: 486000,
  payCycle: 'yearly',
  dueDate: '2026-11-20',
  effectiveDate: '2021-12-15',
  maturityDate: '',
  totalPeriods: 20,
  paidPeriods: 3,
  memberId: '',
  duties: [],
  customTodos: [],
  ...patch,
});

test('续期缴费：按下次缴费日派生，周期正确', () => {
  const todos = deriveTodos([policy()], [], {}, NOW);
  const premium = todos.find((todo) => todo.kind === 'premium');
  assert.ok(premium !== undefined);
  assert.equal(premium.dueDate, '2026-11-20');
  assert.equal(premium.days, 10);
  assert.equal(premium.amount, 486000);
});

test('月末锚点：1 月 31 日的年缴不会越走越偏', () => {
  // 从 2025-01-31 递推，2027 年那次必须还是 31 日，不能变成 28 日
  const anchored = policy({ dueDate: '2025-01-31' });
  assert.equal(nextPremiumDate(anchored, NOW), '2027-01-31');
  // 月缴：上个月 30 号那期已经过了 11 天，仍要显示（逾期未缴才是最该看到的）
  const monthly = policy({ payCycle: 'monthly', dueDate: '2026-09-30' });
  assert.equal(nextPremiumDate(monthly, NOW), '2026-10-30');
  // 再往前滚一期就必须恢复 30 号，不能漂成 28
  const later = policy({ payCycle: 'monthly', dueDate: '2026-07-30' });
  assert.equal(nextPremiumDate(later, NOW), '2026-10-30');
});

test('趸交与已缴清不再产生缴费待办', () => {
  assert.equal(nextPremiumDate(policy({ payCycle: 'once' }), NOW), '');
  assert.equal(nextPremiumDate(policy({ totalPeriods: 20, paidPeriods: 20 }), NOW), '');
  const todos = deriveTodos([policy({ payCycle: 'once' })], [], {}, NOW);
  assert.equal(todos.filter((todo) => todo.kind === 'premium').length, 0);
});

test('「提醒过了」不等于「已经缴费」：只有缴费记录才算', () => {
  const target = policy();
  // 没有任何缴费记录 → 待办仍在
  assert.equal(deriveTodos([target], [], {}, NOW).some((todo) => todo.kind === 'premium'), true);

  // 有对应日期的缴费记录 → 该期视为已缴，待办消失
  const paid = [{ id: 'pay1', policyId: 'p1', date: '2026-11-18', amount: 486000 }];
  assert.equal(deriveTodos([target], paid, {}, NOW).some((todo) => todo.kind === 'premium'), false);

  // 日期差得太远（超过 15 天）不算同一期
  const farOff = [{ id: 'pay2', policyId: 'p1', date: '2026-09-01', amount: 486000 }];
  assert.equal(deriveTodos([target], farOff, {}, NOW).some((todo) => todo.kind === 'premium'), true);
});

test('用户完成/稍后：完成即消失，稍后只改提醒日期', () => {
  const target = policy();
  const done = { 'p1:premium:2026-11-20': { status: 'done', doneAt: NOW } };
  assert.equal(deriveTodos([target], [], done, NOW).some((todo) => todo.kind === 'premium'), false);

  const snoozed = { 'p1:premium:2026-11-20': { status: 'snoozed', snoozeUntil: '2026-12-01' } };
  const todos = deriveTodos([target], [], snoozed, NOW);
  const premium = todos.find((todo) => todo.kind === 'premium');
  assert.ok(premium !== undefined, '稍后不是完成，仍然在列表里');
  assert.equal(premium.dueDate, '2026-12-01', '提醒日期被推迟');
  assert.equal(premium.originalDueDate, '2026-11-20', '合同日期不变');
});

test('等待期与犹豫期：只在还没结束时提醒', () => {
  const fresh = policy({ effectiveDate: '2026-11-05', duties: [{ name: '重疾', waitingDays: 90 }], dueDate: '2026-11-15' });
  const todos = deriveTodos([fresh], [], {}, NOW);
  assert.equal(todos.some((todo) => todo.kind === 'grace'), true, '还能退保');
  assert.equal(todos.some((todo) => todo.kind === 'waiting'), true, '等待期还没过');

  // 老保单：都过去了，不再打扰
  const old = policy({ effectiveDate: '2021-12-15', duties: [{ name: '重疾', waitingDays: 90 }] });
  const oldTodos = deriveTodos([old], [], {}, NOW);
  assert.equal(oldTodos.some((todo) => todo.kind === 'grace'), false);
  assert.equal(oldTodos.some((todo) => todo.kind === 'waiting'), false);
});

test('到期提醒：超过 90 天的旧保单不再挂待办', () => {
  const expired = policy({ maturityDate: '2026-01-01', dueDate: '' });
  assert.equal(deriveTodos([expired], [], {}, NOW).some((todo) => todo.kind === 'maturity'), false);
  const upcoming = policy({ maturityDate: '2026-12-31', dueDate: '' });
  assert.equal(deriveTodos([upcoming], [], {}, NOW).some((todo) => todo.kind === 'maturity'), true);
});

test('紧急度分档：逾期 / 今天 / 30 天内 / 更远', () => {
  const todos = deriveTodos(
    [
      policy({ id: 'a', dueDate: '2026-11-01' }),
      policy({ id: 'b', dueDate: '2026-11-10' }),
      policy({ id: 'c', dueDate: '2026-12-05' }),
      policy({ id: 'd', dueDate: '2027-06-01' }),
    ],
    [],
    {},
    NOW,
  );
  const bucket = (id) => todos.find((todo) => todo.policyId === id)?.bucket;
  assert.equal(bucket('a'), 'overdue');
  assert.equal(bucket('b'), 'today');
  assert.equal(bucket('c'), 'soon');
  assert.equal(bucket('d'), 'later');
  // 逾期的排最前
  assert.equal(todos[0].bucket, 'overdue');
});

test('年度缴费日历：把周期摊到未来 12 个月', () => {
  const calendar = premiumCalendar([policy({ payCycle: 'monthly', dueDate: '2026-11-20' })], NOW);
  assert.equal(calendar.length, 12);
  assert.equal(calendar[0].month, '2026-11');
  // 月缴 4860 → 每个月都有
  assert.ok(calendar.every((entry) => entry.amount === 486000), '月缴每月都有');
  // 年缴 → 只有一个月有
  const yearly = premiumCalendar([policy()], NOW);
  assert.equal(yearly.filter((entry) => entry.amount > 0).length, 1);
});

test('家庭概览：按成员分组并汇总', () => {
  const members = [
    { id: 'm1', name: '我', relation: 'self' },
    { id: 'm2', name: '老婆', relation: 'spouse' },
  ];
  const list = [
    policy({ id: 'a', memberId: 'm1', premium: 486000 }),
    policy({ id: 'b', memberId: 'm1', premium: 120000 }),
    policy({ id: 'c', memberId: 'm2', premium: 300000 }),
    policy({ id: 'd', memberId: '' }),
  ];
  const family = familyOverview(members, list);
  assert.equal(family.total, 4);
  assert.equal(family.byMember[0].count, 2);
  assert.equal(family.byMember[0].annualPremium, 606000);
  assert.equal(family.byMember[1].count, 1);
  assert.equal(family.unassigned.length, 1, '没归属的保单单独列');
});
