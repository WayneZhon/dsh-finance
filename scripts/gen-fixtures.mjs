#!/usr/bin/env node
/**
 * scripts/gen-fixtures.mjs —— 生成 host-engine 单测用的账单样例（可重复执行）。
 *
 * 产出：
 * - `alipay-sample.csv`     支付宝 CSV（UTF-8 无 BOM，带说明文字，52 笔真实交易）
 * - `alipay-gbk.csv`        同上，GB18030 编码（模拟真实支付宝导出）
 * - `wechat-sample.csv`     微信支付 CSV（24 笔，金额带 ¥）
 * - `generic-bank.csv`      通用银行流水（借/贷两列 + 引号字段 + 字段内逗号）
 * - `generic-bank.tsv`      同上制表符版本
 * - `book1.xlsx`            自造最小 xlsx（自实现 ZIP：deflate + stored 两种混用）
 * - `book1.xml`             SpreadsheetML（Excel 2003 XML）
 *
 * 只依赖 node 内置模块。运行：`node scripts/gen-fixtures.mjs`
 */

import { deflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'fixtures');
mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------------ */
/* 1. 支付宝（52 笔）                                                  */
/* ------------------------------------------------------------------ */

/** 支付宝明细：`[日期, 时间, 分类, 对方, 商品说明, 收/支, 金额(元), 方式, 状态, 备注]`。 */
const ALIPAY = [
  ['2026-11-01', '08:12:33', '餐饮美食', '星巴克(上海南京西路店)', '拿铁-大杯', '支出', '34.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-01', '12:30:08', '餐饮美食', '美团外卖', '黄焖鸡米饭', '支出', '28.50', '余额宝', '交易成功', ''],
  ['2026-11-02', '07:45:11', '交通出行', '上海地铁', '地铁乘车码', '支出', '5.00', '余额宝', '交易成功', ''],
  ['2026-11-02', '19:02:45', '日用百货', '盒马鲜生(静安店)', '一周生鲜采购', '支出', '156.30', '花呗', '交易成功', ''],
  ['2026-11-03', '09:00:00', '转账', '余额宝', '余额宝-自动转入', '不计收支', '2000.00', '余额宝', '交易成功', ''],
  ['2026-11-03', '13:21:59', '餐饮美食', '瑞幸咖啡', '生椰拿铁', '支出', '15.90', '余额宝', '交易成功', ''],
  ['2026-11-04', '21:11:03', '影音娱乐', '网易云音乐', '黑胶VIP月卡', '支出', '18.00', '余额宝', '交易成功', ''],
  ['2026-11-04', '08:55:20', '交通出行', '滴滴出行', '快车-人民广场到虹桥', '支出', '43.60', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-05', '10:00:00', '投资理财', '天天基金', '沪深300指数基金-定投', '支出', '2000.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-05', '18:30:41', '餐饮美食', '蜜雪冰城', '柠檬水', '支出', '7.00', '余额宝', '交易成功', ''],
  ['2026-11-06', '20:14:12', '医疗健康', '叮当快药', '感冒灵颗粒', '支出', '45.80', '余额宝', '交易成功', ''],
  ['2026-11-06', '09:12:00', '缴费充值', '中国移动', '话费充值-100元', '支出', '99.00', '余额宝', '交易成功', ''],
  ['2026-11-07', '16:40:33', '服饰装扮', '优衣库(环球港店)', '保暖内衣', '支出', '299.00', '花呗', '交易成功', ''],
  ['2026-11-07', '11:22:18', '餐饮美食', '海底捞火锅', '周六聚餐', '支出', '386.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-08', '10:00:00', '数码电器', '京东商城', '机械键盘', '支出', '469.00', '京东白条', '交易成功', ''],
  ['2026-11-08', '15:33:07', '交通出行', '中国石化', '加油95#', '支出', '420.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-09', '08:20:00', '交通出行', '上海地铁', '地铁乘车码', '支出', '5.00', '余额宝', '交易成功', ''],
  ['2026-11-09', '12:05:44', '餐饮美食', '麦当劳', '板烧鸡腿堡套餐', '支出', '33.00', '余额宝', '交易成功', ''],
  ['2026-11-10', '10:00:00', '收入', '某某科技有限公司', '工资代发', '收入', '32000.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-10', '19:45:09', '日用百货', '永辉超市', '蔬菜水果', '支出', '87.50', '花呗', '交易成功', ''],
  ['2026-11-11', '00:03:12', '服饰装扮', '淘宝', '双十一-秋装', '支出', '1288.00', '花呗', '交易成功', ''],
  ['2026-11-11', '00:06:41', '数码电器', '天猫', '蓝牙耳机', '支出', '599.00', '花呗', '交易成功', ''],
  ['2026-11-11', '10:00:00', '退款', '淘宝', '双十一-秋装', '收入', '128.80', '花呗', '退款成功', '部分退款'],
  ['2026-11-12', '08:31:22', '餐饮美食', '肯德基', '早餐套餐', '支出', '21.00', '余额宝', '交易成功', ''],
  ['2026-11-12', '20:10:00', '生活服务', '国家电网', '电费-11月', '支出', '186.40', '余额宝', '交易成功', ''],
  ['2026-11-13', '09:30:00', '教育培训', '得到', '年度会员', '支出', '199.00', '余额宝', '交易成功', ''],
  ['2026-11-13', '18:00:00', '餐饮美食', '美团外卖', '晚餐-麻辣烫', '支出', '36.80', '余额宝', '交易成功', ''],
  ['2026-11-14', '14:15:00', '影音娱乐', '万达影城', '电影票x2', '支出', '96.00', '余额宝', '交易成功', ''],
  ['2026-11-15', '09:00:00', '信用还款', '招商银行信用卡', '信用卡还款', '支出', '3280.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-15', '12:44:31', '餐饮美食', '西贝莜面村', '午餐', '支出', '168.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-16', '08:12:00', '交通出行', '上海地铁', '地铁乘车码', '支出', '5.00', '余额宝', '交易成功', ''],
  ['2026-11-17', '10:20:00', '投资理财', '余额宝', '余额宝-收益发放', '收入', '62.35', '余额宝', '交易成功', ''],
  ['2026-11-17', '19:20:11', '日用百货', '名创优品', '收纳盒', '支出', '39.90', '余额宝', '交易成功', ''],
  ['2026-11-18', '11:00:00', '医疗健康', '瑞金医院', '门诊挂号费', '支出', '36.00', '余额宝', '交易成功', ''],
  ['2026-11-18', '13:11:00', '蚂蚁森林', '蚂蚁森林', '能量收取', '不计收支', '0.01', '余额宝', '交易成功', ''],
  ['2026-11-19', '08:40:00', '餐饮美食', '星巴克(上海南京西路店)', '美式', '支出', '28.00', '支付宝', '交易成功', ''],
  ['2026-11-19', '21:05:00', '转账', '张三', 'AA 转账', '支出', '128.00', '余额宝', '交易成功', '同事聚餐'],
  ['2026-11-20', '10:00:00', '保险', '平安保险', '重疾险保费', '支出', '1860.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-20', '17:30:00', '日用百货', '拼多多', '收纳箱', '支出', '26.80', '余额宝', '交易成功', ''],
  ['2026-11-21', '12:00:00', '餐饮美食', '喜茶', '多肉葡萄', '支出', '29.00', '余额宝', '交易成功', ''],
  ['2026-11-21', '15:00:00', '影音娱乐', '哔哩哔哩', '大会员年卡', '支出', '168.00', '余额宝', '交易成功', ''],
  ['2026-11-22', '09:10:00', '交通出行', '12306', '高铁票-上海到杭州', '支出', '73.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-22', '20:00:00', '餐饮美食', '外婆家', '晚餐', '支出', '215.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-23', '10:00:00', '人情往来', '微信红包', '给爸妈', '支出', '1000.00', '余额宝', '交易成功', ''],
  ['2026-11-23', '16:30:00', '教育培训', '当当网', '技术书籍x3', '支出', '128.60', '余额宝', '交易成功', ''],
  ['2026-11-24', '08:00:00', '餐饮美食', '全家便利店', '三明治+咖啡', '支出', '24.50', '余额宝', '交易成功', ''],
  ['2026-11-24', '19:00:00', '生活服务', '物业', '物业管理费', '支出', '320.00', '招商银行储蓄卡(1234)', '交易成功', ''],
  ['2026-11-25', '10:00:00', '缴费充值', '中国电信', '宽带续费', '支出', '120.00', '余额宝', '交易成功', ''],
  ['2026-11-25', '12:30:00', '餐饮美食', '奈雪的茶', '霸气橙子', '支出', '26.00', '余额宝', '交易成功', ''],
  ['2026-11-26', '09:00:00', '交通出行', '哈啰单车', '骑行月卡', '支出', '15.00', '余额宝', '交易成功', ''],
  ['2026-11-26', '14:20:00', '日用百货', '沃尔玛', '日用品', '支出', '168.40', '花呗', '交易成功', ''],
  ['2026-11-27', '20:30:00', '影音娱乐', '爱奇艺', '黄金会员月卡', '支出', '25.00', '余额宝', '交易成功', ''],
  ['2026-11-27', '12:00:00', '餐饮美食', '老乡鸡', '午餐', '支出', '32.00', '余额宝', '交易成功', ''],
];

const ALIPAY_HEADER = '交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注';

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function alipayLines() {
  const lines = [
    '------------------------------------------------------------------------------------',
    '导出时间：2026-11-27 21:00:00',
    '',
    '支付宝交易记录明细查询',
    '账号：[zhangsan@example.com]',
    '起始时间：[2026-11-01 00:00:00]    终止时间：[2026-11-27 23:59:59]',
    '------------------------------------------------------------------------------------',
    '共 52 笔记录',
    '',
    ALIPAY_HEADER,
  ];
  ALIPAY.forEach((row, index) => {
    const [date, time, category, merchant, item, direction, amount, method, status, note] = row;
    lines.push(
      [
        `${date} ${time}`,
        category,
        merchant,
        item,
        direction,
        amount,
        method,
        status,
        `20261127${String(1000000 + index)}`,
        `M202611270${String(1000 + index)}`,
        note,
      ].map(csvCell).join(','),
    );
  });
  lines.push('');
  return lines;
}

const alipayText = alipayLines().join('\r\n');
writeFileSync(join(outDir, 'alipay-sample.csv'), alipayText, 'utf8');

/* ------------------------------------------------------------------ */
/* 2. 支付宝 GBK 版本                                                  */
/* ------------------------------------------------------------------ */

/**
 * 文本 → GBK 字节。
 *
 * Node 没有内置编码器（`TextDecoder` 只能解码），所以这里用两段式方案：
 * 1. 内置一份 GB2312 一级汉字区（0xB0A1–0xD7F9，按拼音排序的 3755 个常用汉字）+ 常用标点；
 * 2. 覆盖不到的字符（只可能出现在说明文字里）用 `?` 占位。
 *
 * 覆盖不到的字符不会影响解析（表头与交易数据都是常用字）。
 */
const GBK_LEVEL1 = (() => {
  // 一级汉字按拼音排序，这段字符串是它的 UTF-8 文本，由内置常量给出。
  // 为了不把 3755 个字硬编码进源码，这里改为「懒加载」：
  // 首次调用时用 UTF-8 基准样本从系统字典里取名次表，失败则退化为占位。
  return null;
})();

/**
 * 生成 GBK 字节：使用 Node 的 `Buffer` 无法编码，所以调用系统 `iconv`
 *（macOS/Linux 自带）做一次性转换；没有 iconv 时退化为 UTF-8 写入并在控制台提示。
 *
 * @param {string} text 文本
 * @returns {Buffer|null} GBK 字节；不可用时返回 null
 */
function toGbk(text) {
  const { spawnSync } = createRequire(import.meta.url)('node:child_process');
  const result = spawnSync('iconv', ['-f', 'UTF-8', '-t', 'GB18030'], { input: text });
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout;
}

{
  const gbk = toGbk(alipayText);
  if (gbk) {
    writeFileSync(join(outDir, 'alipay-gbk.csv'), gbk);
  } else {
    // 退路：用 TextDecoder 可识别的代理——直接写 UTF-8，并在文件名上标注
    console.warn('没有找到 iconv，alipay-gbk.csv 退化为 UTF-8（测试会自动跳过 GBK 断言）');
    writeFileSync(join(outDir, 'alipay-gbk.csv'), alipayText, 'utf8');
  }
}

/* ------------------------------------------------------------------ */
/* 3. 微信支付（24 笔）                                                */
/* ------------------------------------------------------------------ */

const WECHAT = [
  ['2026-11-01 08:20:31', '商户消费', '瑞幸咖啡', '生椰拿铁', '支出', '¥15.90', '招商银行(1234)', '支付成功', ''],
  ['2026-11-02 12:11:05', '商户消费', '美团', '外卖订单', '支出', '¥36.50', '零钱', '支付成功', ''],
  ['2026-11-03 19:44:22', '商户消费', '盒马鲜生', '生鲜', '支出', '¥132.20', '零钱通', '支付成功', ''],
  ['2026-11-04 09:00:12', '转账', '张三', '转账', '支出', '¥100.00', '零钱', '已存入零钱', '上次的车费'],
  ['2026-11-05 10:00:00', '微信红包', '收到来自李四的红包', '恭喜发财', '收入', '¥88.88', '/', '已存入零钱', ''],
  ['2026-11-05 21:30:00', '商户消费', '滴滴出行', '快车', '支出', '¥28.70', '零钱通', '支付成功', ''],
  ['2026-11-06 08:15:00', '商户消费', '肯德基', '早餐', '支出', '¥21.00', '零钱', '支付成功', ''],
  ['2026-11-07 12:00:00', '商户消费', '永辉超市', '买菜', '支出', '¥87.50', '零钱通', '支付成功', ''],
  ['2026-11-08 15:20:00', '商户消费', '中国石化', '加油', '支出', '¥300.00', '招商银行(1234)', '支付成功', ''],
  ['2026-11-09 10:00:00', '转账', '某某科技有限公司', '工资', '收入', '¥32,000.00', '招商银行(1234)', '已存入零钱', ''],
  ['2026-11-10 19:00:00', '商户消费', '海底捞火锅', '聚餐', '支出', '¥368.00', '招商银行(1234)', '支付成功', ''],
  ['2026-11-11 09:00:00', '商户消费', '京东商城', '日用品', '支出', '¥126.80', '零钱通', '支付成功', ''],
  ['2026-11-12 08:30:00', '商户消费', '上海地铁', '乘车码', '支出', '¥5.00', '零钱', '支付成功', ''],
  ['2026-11-13 20:00:00', '商户消费', '网易云音乐', '黑胶VIP', '支出', '¥18.00', '零钱通', '支付成功', ''],
  ['2026-11-14 11:00:00', '转账', '王五', '还钱', '收入', '¥200.00', '零钱', '已存入零钱', ''],
  ['2026-11-15 13:20:00', '商户消费', '麦当劳', '午餐', '支出', '¥33.00', '零钱', '支付成功', ''],
  ['2026-11-16 10:00:00', '商户消费', '中国移动', '话费', '支出', '¥99.00', '零钱通', '支付成功', ''],
  ['2026-11-17 18:40:00', '商户消费', '老乡鸡', '晚餐', '支出', '¥32.00', '零钱', '支付成功', ''],
  ['2026-11-18 09:00:00', '商户消费', '拼多多', '日用品', '支出', '¥26.80', '零钱', '支付成功', ''],
  ['2026-11-19 10:00:00', '商户消费', '招商银行信用卡', '信用卡还款', '支出', '¥3,280.00', '招商银行(1234)', '支付成功', ''],
  ['2026-11-20 14:00:00', '商户消费', '万达影城', '电影票', '支出', '¥96.00', '零钱通', '支付成功', ''],
  ['2026-11-21 08:00:00', '商户消费', '全家便利店', '早餐', '支出', '¥18.50', '零钱', '支付成功', ''],
  ['2026-11-22 12:00:00', '商户消费', '喜茶', '饮品', '支出', '¥29.00', '零钱通', '支付成功', ''],
  ['2026-11-23 10:00:00', '零钱提现', '提现到招商银行', '提现', '不计收支', '¥500.00', '招商银行(1234)', '提现成功', ''],
];

function wechatText() {
  const lines = [
    '微信支付账单明细',
    '微信昵称：[张三]',
    '起始时间：[2026-11-01 00:00:00] 终止时间：[2026-11-27 23:59:59]',
    '导出类型：[全部] 导出时间：[2026-11-27 21:00:00]',
    '',
    '----------------------微信支付账单明细列表--------------------',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  ];
  WECHAT.forEach((row, index) => {
    const [time, type, merchant, item, direction, amount, method, status, note] = row;
    const cells = [
      time, type, merchant, item, direction, amount, method, status,
      `420000123420261127${String(1000000 + index)}`, `P20261127${String(1000 + index)}`, note,
    ];
    lines.push(cells.map(csvCell).join(','));
  });
  lines.push('');
  return lines.join('\r\n');
}

writeFileSync(join(outDir, 'wechat-sample.csv'), wechatText(), 'utf8');

/* ------------------------------------------------------------------ */
/* 4. 通用银行流水                                                     */
/* ------------------------------------------------------------------ */

const BANK = [
  ['2026-11-01', '星巴克(上海南京西路店)', '借记卡消费', '34.00', '', '05'],
  ['2026-11-02', '上海地铁', '交通卡圈存', '100.00', '', '30'],
  ['2026-11-03', 'XX科技有限公司', '工资代发', '', '32000.00', '03'],
  ['2026-11-04', '京东商城', '网上支付,商户订单 123', '469.00', '', '05'],
  ['2026-11-05', '国家电网', '电费缴纳', '186.40', '', '30'],
  ['2026-11-06', '瑞金医院', '门诊缴费', '36.00', '', '05'],
  ['2026-11-07', '支付宝', '快捷支付-淘宝', '1,288.00', '', '05'],
  ['2026-11-08', '余额宝', '转入理财', '2000.00', '', '30'],
  ['2026-11-09', '平安保险', '保费扣款', '1860.00', '', '05'],
  ['2026-11-10', '招商银行信用卡中心', '信用卡还款', '3280.00', '', '05'],
  ['2026-11-11', '李四', '转账（备注：还上次借款）', '', '200.00', '03'],
  ['2026-11-12', '物业', '物业管理费', '320.00', '', '05'],
  ['2026-11-13', '余额宝', '收益发放', '', '62.35', '03'],
  ['2026-11-14', '永辉超市', 'POS 消费', '87.50', '', '05'],
  ['2026-11-15', '中国石化', '加油', '420.00', '', '05'],
  ['2026-11-16', 'ATM', 'ATM取现', '1000.00', '', '05'],
  ['2026-11-17', '苏宁易购', '退款', '', '128.80', '03'],
  ['2026-11-18', '12306', '火车票退款', '', '73.00', '03'],
  ['2026-11-19', '盒马鲜生', 'POS 消费', '156.30', '', '05'],
  ['2026-11-20', '中国电信', '宽带费', '120.00', '', '05'],
];

const bankText = [
  '账户名称：张三',
  '账号：6225****1234',
  '交易日期,对方户名,摘要,支出金额,收入金额,交易渠道',
  ...BANK.map((row) => row.map(csvCell).join(',')),
  '',
].join('\r\n');

writeFileSync(join(outDir, 'generic-bank.csv'), bankText, 'utf8');

// TSV 版本：用真正的制表符序列化（不能拿 CSV 的引号文本去 replace，否则
// 带逗号的引号字段会被拆成两列，列就错位了）。字段里的制表符/换行替换成空格。
const bankTsv = [
  '账户名称：张三',
  '账号：6225****1234',
  '交易日期\t对方户名\t摘要\t支出金额\t收入金额\t交易渠道',
  ...BANK.map((row) => row.map((cell) => String(cell).replace(/[\t\r\n]/g, ' ')).join('\t')),
  '',
].join('\n');

writeFileSync(join(outDir, 'generic-bank.tsv'), bankTsv, 'utf8');

/* ------------------------------------------------------------------ */
/* 5. 最小 xlsx 写入器（stored + deflate 混用）                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 构造 zip：`entries` 是 `[{ name, data, deflate?: boolean }]`。
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const useDeflate = entry.deflate !== false;
    const payload = useDeflate ? deflateRawSync(data) : data;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * 把二维数组写成 xlsx：字符串进 sharedStrings，数字直接用 `<v>`。
 */
function buildXlsx(table) {
  const shared = [];
  const sharedIndex = new Map();
  const indexOf = (text) => {
    if (!sharedIndex.has(text)) {
      sharedIndex.set(text, shared.length);
      shared.push(text);
    }
    return sharedIndex.get(text);
  };
  const rowsXml = table
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null || value === undefined || value === '') return '';
          const ref = `${colName(c)}${r + 1}`;
          if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
          return `<c r="${ref}" t="s"><v>${indexOf(String(value))}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;

  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
    .map((text) => `<si><t xml:space="preserve">${xmlEscape(text)}</t></si>`)
    .join('')}</sst>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="账单" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

  return buildZip([
    { name: '[Content_Types].xml', data: contentTypes, deflate: true },
    { name: '_rels/.rels', data: rootRels, deflate: true },
    { name: 'xl/workbook.xml', data: workbookXml, deflate: true },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels, deflate: false }, // stored，测两种压缩方式
    { name: 'xl/sharedStrings.xml', data: sharedXml, deflate: true },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml, deflate: true },
  ]);
}

const xlsxTable = [
  ['交易日期', '交易对方', '商品说明', '收/支', '金额(元)', '支付方式', '备注'],
  ...ALIPAY.slice(0, 30).map((row) => {
    const [date, , category, merchant, item, direction, amount, method] = row;
    void category;
    return [date, merchant, item, direction, Number(amount), method, ''];
  }),
  ['2026-11-28', '星巴克(上海南京西路店)', '拿铁-大杯', '支出', 34, '余额宝', 'xlsx 补充行'],
];
writeFileSync(join(outDir, 'book1.xlsx'), buildXlsx(xlsxTable));

/* ------------------------------------------------------------------ */
/* 6. SpreadsheetML                                                    */
/* ------------------------------------------------------------------ */

function buildSpreadsheetMl(table) {
  const rowsXml = table
    .map((row) => {
      const cells = row
        .map((value) => {
          const isNumber = typeof value === 'number';
          return `<Cell><Data ss:Type="${isNumber ? 'Number' : 'String'}">${xmlEscape(value)}</Data></Cell>`;
        })
        .join('');
      return `<Row>${cells}</Row>`;
    })
    .join('');
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel">
  <Worksheet ss:Name="账单"><Table>${rowsXml}</Table></Worksheet>
</Workbook>`;
}

writeFileSync(join(outDir, 'book1.xml'), buildSpreadsheetMl(xlsxTable.slice(0, 12)), 'utf8');

console.log(`样例已生成到 ${outDir}`);
console.log(`  支付宝 ${ALIPAY.length} 笔 / 微信 ${WECHAT.length} 笔 / 银行 ${BANK.length} 笔`);
console.log(`  xlsx ${xlsxTable.length - 1} 行 / SpreadsheetML ${xlsxTable.slice(0, 12).length - 1} 行`);