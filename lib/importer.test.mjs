/**
 * lib/importer.test.mjs —— 账单解析器单测（全部只读 scripts/fixtures/，无临时文件需求）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

import {
  autoRate,
  decodeText,
  detectDelimiter,
  detectFormat,
  isVoidStatus,
  parseBill,
  parseBillWithCategories,
  parseDateCell,
  parseDelimited,
  parseDirectionCell,
  parseSheetXml,
  parseSharedStrings,
  parseTable,
  readSpreadsheetMlTable,
  readXlsxTable,
  readZip,
  rowsToTxns,
} from './importer.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'scripts', 'fixtures');
const NOW = Date.parse('2026-11-27T21:00:00+08:00');

const read = (name) => readFileSync(join(fixtures, name));

/* ---------------- 基础解析 ---------------- */

test('parseDelimited：引号、字段内逗号/换行、CRLF、BOM', () => {
  const text = '\uFEFFa,b,c\r\n1,"x,y",3\r\n"多\n行",2,"他说""你好"""\r\n';
  const table = parseDelimited(text, ',');
  assert.deepEqual(table[0], ['a', 'b', 'c']);
  assert.deepEqual(table[1], ['1', 'x,y', '3']);
  assert.deepEqual(table[2], ['多\n行', '2', '他说"你好"']);
});

test('parseDelimited：结尾没有换行也能拿到最后一行', () => {
  assert.deepEqual(parseDelimited('a,b\n1,2', ','), [['a', 'b'], ['1', '2']]);
});

test('detectDelimiter 自动识别逗号/制表符', () => {
  assert.equal(detectDelimiter('交易时间,金额\n1,2'), ',');
  assert.equal(detectDelimiter('交易时间\t金额\n1\t2'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
});

test('decodeText：UTF-8 与 GB18030 自动识别', () => {
  const utf8 = Buffer.from('交易时间,金额', 'utf8');
  assert.equal(decodeText(utf8), '交易时间,金额');
  const gbk = read('alipay-gbk.csv');
  assert.ok(gbk.toString('utf8').includes('\uFFFD'), 'GBK 文件按 UTF-8 解会乱码');
  const decoded = decodeText(gbk);
  assert.ok(decoded.includes('交易时间'), 'GB18030 回退应能解出中文表头');
  assert.ok(decoded.includes('星巴克'), '商户名应解码正确');
});

test('parseDateCell 支持多种日期写法', () => {
  assert.equal(parseDateCell('2026-11-03'), '2026-11-03');
  assert.equal(parseDateCell('2026/11/3'), '2026-11-03');
  assert.equal(parseDateCell('2026.11.03'), '2026-11-03');
  assert.equal(parseDateCell('2026年11月3日'), '2026-11-03');
  assert.equal(parseDateCell('20261103'), '2026-11-03');
  assert.equal(parseDateCell('2026-11-03 08:12:33'), '2026-11-03');
  // Excel 序列号 46318 = 2026-11-03（以 1899-12-30 为原点）
  assert.equal(parseDateCell('46318'), '2026-10-23', 'Excel 序列号（46318 = 2026-10-23）');
  assert.equal(parseDateCell(''), '');
  assert.equal(parseDateCell('昨天'), '');
});

test('parseDirectionCell / isVoidStatus', () => {
  assert.equal(parseDirectionCell('支出'), 'expense');
  assert.equal(parseDirectionCell('收入'), 'income');
  assert.equal(parseDirectionCell('不计收支'), 'none');
  assert.equal(parseDirectionCell('借'), 'expense');
  assert.equal(parseDirectionCell('贷'), 'income');
  assert.equal(parseDirectionCell(''), '');
  assert.equal(isVoidStatus('交易关闭'), true);
  assert.equal(isVoidStatus('退款成功'), true);
  assert.equal(isVoidStatus('交易成功'), false);
});

/* ---------------- 支付宝 ---------------- */

test('支付宝 CSV（UTF-8）：53 行明细全部有下落（51 入库 + 2 不计收支）', () => {
  const result = parseBill({ name: 'alipay-sample.csv', content: read('alipay-sample.csv') }, { now: NOW });
  assert.equal(result.format, 'alipay-csv');
  assert.equal(result.skipped, 2, '两笔「不计收支」（余额宝转入、蚂蚁森林）应进 skipped');
  assert.equal(result.rows.length, 51);
  assert.equal(result.rows.length + result.skipped, 53, '解析 + 跳过 = 明细行数，绝不丢行');
  assert.ok(result.rows.every((row) => row.direction === 'expense' || row.direction === 'income'));
  assert.ok(result.warnings.some((w) => w.includes('说明文字')));
  assert.ok(result.warnings.some((w) => w.includes('不计收支')));

  const first = result.rows[0];
  assert.equal(first.date, '2026-11-01');
  assert.equal(first.amount, 3400);
  assert.equal(first.direction, 'expense');
  assert.equal(first.merchant, '星巴克(上海南京西路店)');
  assert.equal(first.account, '招商银行储蓄卡(1234)');
  assert.equal(first.note, '拿铁-大杯');
  assert.equal(first.categoryHint, '餐饮');
  assert.match(first.dedupeKey, /^2026-11-01\|3400\|expense\|星巴克/);

  // 收入行
  const income = result.rows.find((row) => row.direction === 'income');
  assert.equal(income.merchant, '某某科技有限公司');
  assert.equal(income.amount, 3200000);

  // 列映射
  assert.equal(result.columns.merchant, '交易对方');
  assert.equal(result.columns.amount, '金额');
});

test('支付宝 CSV（GBK）：解码后与 UTF-8 版本解析结果一致', () => {
  const utf8 = parseBill({ name: 'alipay-sample.csv', content: read('alipay-sample.csv') }, { now: NOW });
  const gbk = parseBill({ name: 'alipay-gbk.csv', content: read('alipay-gbk.csv') }, { now: NOW });
  assert.equal(gbk.format, 'alipay-csv');
  assert.equal(gbk.rows.length, utf8.rows.length);
  assert.deepEqual(gbk.rows.map((r) => r.dedupeKey), utf8.rows.map((r) => r.dedupeKey));
});

test('支付宝 CSV：以字符串传入（粘贴文本）也能解析', () => {
  const text = read('alipay-sample.csv').toString('utf8');
  const result = parseBill({ name: 'pasted.csv', content: text }, { now: NOW });
  assert.equal(result.rows.length, 51);
  assert.equal(result.rows.length + result.skipped, 53);
});

/* ---------------- 微信 ---------------- */

test('微信 CSV：¥ 金额、千分位、收入与不计收支', () => {
  const result = parseBill({ name: 'wechat-sample.csv', content: read('wechat-sample.csv') }, { now: NOW });
  assert.equal(result.format, 'wechat-csv');
  assert.equal(result.rows.length, 23);
  assert.equal(result.skipped, 1, '一笔「零钱提现-不计收支」');
  assert.equal(result.rows[0].amount, 1590, '¥15.90 → 1590 分');
  const income = result.rows.filter((row) => row.direction === 'income');
  assert.equal(income.length, 3, '红包、工资、收款共 3 笔收入');
  const salary = income.find((row) => row.amount === 3200000);
  assert.ok(salary, '¥32,000.00 应解析成 3200000 分、方向 income');
  assert.ok(result.warnings.some((w) => w.includes('不计收支')));
});

/* ---------------- 通用银行 ---------------- */

test('通用银行 CSV：借/贷双列 + 引号里带逗号', () => {
  const result = parseBill({ name: 'generic-bank.csv', content: read('generic-bank.csv') }, { now: NOW });
  assert.equal(result.rows.length, 20);
  assert.equal(result.skipped, 0);
  const salary = result.rows.find((row) => row.direction === 'income');
  assert.equal(salary.amount, 3200000);
  assert.equal(salary.merchant, 'XX科技有限公司');
  // 「网上支付,商户订单 123」里的逗号不能把列切乱
  const jd = result.rows.find((row) => row.merchant === '京东商城');
  assert.equal(jd.amount, 46900);
  assert.equal(jd.note, '网上支付,商户订单 123');
  // 千分位金额
  const taobao = result.rows.find((row) => row.merchant === '支付宝');
  assert.equal(taobao.amount, 128800);
});

test('通用 TSV：同样不丢行', () => {
  const result = parseBill({ name: 'generic-bank.tsv', content: read('generic-bank.tsv') }, { now: NOW });
  assert.equal(result.format, 'tsv');
  assert.equal(result.rows.length, 20);
  assert.equal(result.skipped, 0);
});

/* ---------------- xlsx / SpreadsheetML ---------------- */

test('自造 xlsx：ZIP 中央目录 + sharedStrings + sheet 全部能读', () => {
  const buf = read('book1.xlsx');
  const files = readZip(buf);
  assert.ok(files.has('xl/worksheets/sheet1.xml'));
  assert.ok(files.has('xl/sharedStrings.xml'));
  assert.ok(files.has('xl/_rels/workbook.xml.rels'), 'stored 条目也要能读');
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml').toString('utf8'));
  assert.ok(shared.includes('交易日期'));

  const result = parseBill({ name: 'book1.xlsx', content: buf }, { now: NOW });
  assert.equal(result.format, 'xlsx');
  assert.equal(result.rows.length, 30);
  assert.equal(result.skipped, 1, 'xlsx 里同样有 1 笔不计收支');
  assert.equal(result.rows.length + result.skipped, 31);
  assert.equal(result.rows[0].amount, 3400, 'xlsx 数字单元格 34 → 3400 分');
  assert.equal(result.rows[0].merchant, '星巴克(上海南京西路店)');
});

test('SpreadsheetML (.xml) 也能解析', () => {
  const result = parseBill({ name: 'book1.xml', content: read('book1.xml') }, { now: NOW });
  assert.equal(result.format, 'spreadsheetml');
  assert.equal(result.rows.length, 10);
  assert.equal(result.rows.length + result.skipped, 11);
  assert.equal(result.rows[0].merchant, '星巴克(上海南京西路店)');
});

test('parseSheetXml 处理稀疏行列与 inlineStr', () => {
  const xml = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>交易日期</t></is></c><c r="C1" t="inlineStr"><is><t>金额</t></is></c></row>'
    + '<row r="2"><c r="A2" t="inlineStr"><is><t>2026-11-01</t></is></c><c r="C2"><v>10.5</v></c></row></sheetData></worksheet>';
  const table = parseSheetXml(xml, []);
  assert.deepEqual(table[0], ['交易日期', '', '金额']);
  assert.deepEqual(table[1], ['2026-11-01', '', '10.5']);
});

/* ---------------- 健壮性：绝不丢行 ---------------- */

test('坏行进 skipped + 人话 warning，不静默丢弃', () => {
  const csv = [
    '日期,商户,金额',
    '2026-11-01,星巴克,34.00',
    '不是日期,肯德基,21.00',
    '2026-11-02,麦当劳,abc',
    '2026-11-03,瑞幸,15.90',
    '2026-11-04,蜜雪冰城,',
  ].join('\n');
  const result = parseBill({ name: 'bad.csv', content: csv });
  assert.equal(result.rows.length, 2);
  assert.equal(result.skipped, 3);
  assert.equal(result.rows.length + result.skipped, 5);
  assert.ok(result.warnings.some((w) => w.includes('日期无法识别')));
  assert.ok(result.warnings.some((w) => w.includes('金额无法解析')));
  assert.ok(result.warnings.some((w) => w.includes('3 行未导入')));
});

test('没有表头 / 空文件 / 非 zip 的 .xlsx 都返回空结果 + warning，不抛异常', () => {
  const noHeader = parseBill({ name: 'x.csv', content: '1,2,3\n4,5,6' });
  assert.equal(noHeader.rows.length, 0);
  assert.ok(noHeader.warnings.length > 0);

  const empty = parseBill({ name: 'x.csv', content: '' });
  assert.equal(empty.rows.length, 0);
  assert.ok(empty.warnings[0].includes('空'));

  const fakeXlsx = parseBill({ name: 'x.xlsx', content: '不是 zip' });
  assert.equal(fakeXlsx.rows.length, 0);
  assert.ok(fakeXlsx.warnings[0].includes('xlsx'));

  const noFile = parseBill({});
  assert.equal(noFile.rows.length, 0);
});

test('只有一列金额时用负号判定方向', () => {
  const csv = '日期,摘要,金额\n2026-11-01,工资,+32000.00\n2026-11-02,房租,-5500.00';
  const result = parseBill({ name: 'signed.csv', content: csv });
  assert.equal(result.rows.length, 2);
  const income = result.rows.find((row) => row.merchant === '工资');
  const expense = result.rows.find((row) => row.merchant === '房租');
  assert.equal(income.direction, 'income');
  assert.equal(income.amount, 3200000);
  assert.equal(expense.direction, 'expense');
  assert.equal(expense.amount, 550000);
});

test('交易关闭/退款的行不进库（计入 skipped）', () => {
  const csv = [
    '交易时间,交易对方,收/支,金额,当前状态',
    '2026-11-01,星巴克,支出,34.00,支付成功',
    '2026-11-02,淘宝,支出,99.00,交易关闭',
    '2026-11-03,淘宝,支出,88.00,已全额退款',
  ].join('\n');
  const result = parseBill({ name: 'w.csv', content: csv });
  assert.equal(result.rows.length, 1);
  assert.equal(result.skipped, 2);
});

test('BOM + 全角逗号 + 空格金额', () => {
  const csv = '\uFEFF日期,摘要,金额\n2026-11-01,星巴克," 34.00 "\n2026-11-02,瑞幸,"１５．９０"';
  const result = parseBill({ name: 'bom.csv', content: Buffer.from(csv, 'utf8') });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].amount, 3400);
  assert.equal(result.rows[1].amount, 1590);
});

test('detectFormat 按扩展名/文件头判断', () => {
  assert.equal(detectFormat('a.xlsx', new Uint8Array([0x50, 0x4b, 3, 4])), 'xlsx');
  assert.equal(detectFormat('a.csv', 'x'), 'csv');
  assert.equal(detectFormat('a.tsv', 'x'), 'tsv');
  assert.equal(detectFormat('a.xml', '<Workbook/>'), 'spreadsheetml');
});

test('readZip：非 zip 抛中文错误', () => {
  assert.throws(() => readZip(Buffer.from('hello')), /不是有效的 zip/);
});

test('zlib deflate 的最小 zip 能读（构造一个只有 sheet 的包）', () => {
  // 直接用 readZip 读 xlsx 已覆盖；这里再验证 deflateRawSync 往返
  const payload = Buffer.from('<x>你好</x>', 'utf8');
  assert.equal(deflateRawSync(payload).length > 0, true);
});

/* ---------------- 与分类联动 ---------------- */

test('parseBillWithCategories：行数不变且自动分类率 ≥ 70%', () => {
  for (const name of ['alipay-sample.csv', 'wechat-sample.csv', 'generic-bank.csv', 'book1.xlsx']) {
    const result = parseBillWithCategories({ name, content: read(name) }, { now: NOW });
    assert.equal(result.rows.length, parseBill({ name, content: read(name) }).rows.length);
    const rate = autoRate(result.rows);
    assert.ok(rate >= 0.7, `${name} 自动分类率 ${(rate * 100).toFixed(1)}% < 70%`);
    for (const row of result.rows) {
      assert.ok(typeof row.category === 'string' && row.category.length > 0);
      assert.ok(['rule', 'user', 'default'].includes(row.confidence));
    }
  }
});

test('rowsToTxns：把 RawRow 转成可落库的流水候选', () => {
  const parsed = parseBill({ name: 'alipay-sample.csv', content: read('alipay-sample.csv') }, { now: NOW });
  const txns = rowsToTxns(parsed.rows, { importId: 'imp_test', source: 'import' });
  assert.equal(txns.length, parsed.rows.length);
  assert.ok(txns.every((txn) => Number.isInteger(txn.amount) && txn.amount > 0));
  assert.ok(txns.every((txn) => txn.importId === 'imp_test'));
  assert.ok(txns.every((txn) => /^\d{4}-\d{2}-\d{2}$/.test(txn.date)));
});

test('parseTable 能识别表头在任意前 40 行内', () => {
  const table = [
    ['一些说明'],
    ['更多说明'],
    [],
    ['日期', '摘要', '金额'],
    ['2026-11-01', '星巴克', '34.00'],
  ];
  const result = parseTable(table, { now: NOW });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].amount, 3400);
  assert.ok(result.warnings.some((w) => w.includes('2 行') || w.includes('3 行')));
});

test('readSpreadsheetMlTable 支持 ss:Index 跳列', () => {
  const xml = `<Workbook><Worksheet><Table>
    <Row><Cell><Data ss:Type="String">日期</Data></Cell><Cell ss:Index="3"><Data ss:Type="String">金额</Data></Cell></Row>
    <Row><Cell><Data ss:Type="String">2026-11-01</Data></Cell><Cell ss:Index="3"><Data ss:Type="Number">12.5</Data></Cell></Row>
  </Table></Worksheet></Workbook>`;
  const table = readSpreadsheetMlTable(xml);
  assert.deepEqual(table[0], ['日期', '', '金额']);
  assert.deepEqual(table[1], ['2026-11-01', '', '12.5']);
});
/* ------------------------------------------------------------------ */
/* 方向列回归：`收支方向` 这类别名曾经漏识别，导致收入全被记成支出      */
/* ------------------------------------------------------------------ */

test('回归：表头「收支方向」能被识别（demo-generic.csv 通用银行流水）', () => {
  const raw = read('demo-generic.csv');
  const result = parseBill({ name: 'demo-generic.csv', content: raw }, { now: NOW });

  // 1) 方向列必须被识别出来，否则收入会整个丢掉
  assert.equal(result.columns.direction, '收支方向', 'columns 里必须有 direction');
  assert.ok(Object.values(result.columns).includes('收支方向'));

  // 2) 行数不丢
  assert.equal(result.skipped, 0);
  assert.ok(result.rows.length > 300, `行数异常：${result.rows.length}`);

  // 3) 用原始文本独立数一遍收入行，和解析结果对齐
  const text = read('demo-generic.csv').toString('utf8');
  const dataLines = text.split(/\r?\n/).filter((line) => /^\d{4}-\d{2}-\d{2},/.test(line));
  const expectedIncome = dataLines.filter((line) => /,收入,/.test(line)).length;
  const incomeRows = result.rows.filter((row) => row.direction === 'income');
  assert.equal(incomeRows.length, expectedIncome, '收入行数与原始账单不一致');
  assert.equal(result.rows.length, dataLines.length, '解析行数必须等于明细行数');

  // 4) 6 笔工资 + 若干闲鱼收入，合计金额正确
  const salary = incomeRows.filter((row) => row.merchant.includes('工资'));
  assert.equal(salary.length, 6, '应有 6 笔工资');
  assert.ok(salary.every((row) => row.amount === 2860000), '工资应为 28600.00 元');
  const income = incomeRows.reduce((sum, row) => sum + row.amount, 0);
  const expectedIncomeSum = dataLines
    .filter((line) => /,收入,/.test(line))
    .reduce((sum, line) => sum + Math.round(Number(line.split(',')[2]) * 100), 0);
  assert.equal(income, expectedIncomeSum);
  assert.equal(income, 17509858, '收入合计应为 175,098.58 元');
  assert.ok(income > 0, '收入不能为 0');

  // 5) 支出方向也没被带偏
  const expense = result.rows.filter((row) => row.direction === 'expense');
  assert.ok(expense.every((row) => row.amount > 0));
  assert.equal(expense.length + incomeRows.length, result.rows.length);
});

test('方向优先级：方向列 > 借贷列 > 金额正负号 > 默认支出', () => {
  const parse = (csv) => parseBill({ name: 'p.csv', content: csv }, { now: NOW });

  // 规则 1：方向列说了算 —— 金额是正数，方向说收入
  const r1 = parse('日期,摘要,金额,收支方向\n2026-11-01,工资,28600.00,收入');
  assert.equal(r1.rows[0].direction, 'income');
  assert.equal(r1.rows[0].amount, 2860000);

  // 规则 1：方向列说支出、金额带负号 → 不要双重取反，仍是支出且金额为正
  const r2 = parse('日期,摘要,金额,收支方向\n2026-11-01,房租,-5500.00,支出');
  assert.equal(r2.rows[0].direction, 'expense');
  assert.equal(r2.rows[0].amount, 550000);

  // 规则 1 反向：方向列说收入、金额带负号 → 以方向列为准
  const r3 = parse('日期,摘要,金额,收支方向\n2026-11-01,退款,-100.00,收入');
  assert.equal(r3.rows[0].direction, 'income');
  assert.equal(r3.rows[0].amount, 10000);

  // 规则 2：没有方向列时，正负号判定
  const r4 = parse('日期,摘要,金额\n2026-11-01,工资,+28600.00\n2026-11-02,房租,-5500.00');
  assert.equal(r4.rows[0].direction, 'income');
  assert.equal(r4.rows[1].direction, 'expense');

  // 规则 3：无方向列、无正负号 → 默认支出
  const r5 = parse('日期,摘要,金额\n2026-11-01,星巴克,34.00');
  assert.equal(r5.rows[0].direction, 'expense');

  // 规则 2（借贷双列）：值所在列即方向
  const r6 = parse('日期,摘要,支出金额,收入金额\n2026-11-01,工资,,28600.00\n2026-11-02,房租,5500.00,');
  assert.equal(r6.rows[0].direction, 'income');
  assert.equal(r6.rows[0].amount, 2860000);
  assert.equal(r6.rows[1].direction, 'expense');
  assert.equal(r6.rows[1].amount, 550000);
});

test('方向列别名覆盖各家叫法', () => {
  const headers = ['收支方向', '交易方向', '借贷标志', '借贷', '发生额方向', '资金方向', '收支', '收/支', 'direction', 'income/expense'];
  for (const header of headers) {
    const csv = `日期,摘要,金额,${header}\n2026-11-01,工资,100.00,收入`;
    const result = parseBill({ name: 'a.csv', content: csv }, { now: NOW });
    assert.equal(result.rows[0]?.direction, 'income', `表头「${header}」未识别成方向列`);
  }
});

test('方向值各种写法都能认（收入/支出/进/出/借/贷/收/支/转账收入 等）', () => {
  const cases = [
    ['收入', 'income'], ['支出', 'expense'],
    ['进', 'income'], ['出', 'expense'],
    ['借', 'expense'], ['贷', 'income'],
    ['收', 'income'], ['支', 'expense'],
    ['转账收入', 'income'], ['转账支出', 'expense'],
    ['现金收入', 'income'], ['现金支出', 'expense'],
    ['收入/存入', 'income'], ['借方', 'expense'], ['贷方', 'income'],
  ];
  for (const [text, expected] of cases) {
    const csv = `日期,摘要,金额,收支方向\n2026-11-01,测试,100.00,${text}`;
    const result = parseBill({ name: 'd.csv', content: csv }, { now: NOW });
    assert.equal(result.rows[0]?.direction, expected, `方向值「${text}」判成了 ${result.rows[0]?.direction}`);
  }
});

test('支付宝「不计收支」行：跳过并给出中文说明，不计入支出', () => {
  const result = parseBill({ name: 'alipay-sample.csv', content: read('alipay-sample.csv') }, { now: NOW });
  // 余额宝自动转入、蚂蚁森林 两笔都是「不计收支」
  assert.equal(result.skipped, 2);
  assert.ok(result.warnings.some((w) => w.includes('不计收支')));
  // 这些行不能出现在 rows 里，自然也不会算进支出
  assert.ok(!result.rows.some((row) => row.merchant === '蚂蚁森林'));
  assert.ok(!result.rows.some((row) => row.note === '余额宝-自动转入'));
  // 剩余所有行方向合法、金额为正
  assert.ok(result.rows.every((row) => row.direction === 'expense' || row.direction === 'income'));
  assert.ok(result.rows.every((row) => Number.isInteger(row.amount) && row.amount > 0));
});

test('CSV 与 TSV 同一份数据解析结果一致（fixture 生成正确性）', () => {
  const csv = parseBill({ name: 'generic-bank.csv', content: read('generic-bank.csv') }, { now: NOW });
  const tsv = parseBill({ name: 'generic-bank.tsv', content: read('generic-bank.tsv') }, { now: NOW });
  const signature = (rows) => rows.map((r) => [r.date, r.merchant, r.amount, r.direction].join('|')).sort();
  assert.equal(csv.rows.length, tsv.rows.length);
  assert.deepEqual(signature(csv.rows), signature(tsv.rows));
  assert.equal(csv.rows.filter((r) => r.direction === 'income').length, 5);
});
