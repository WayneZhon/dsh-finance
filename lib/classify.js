/**
 * lib/classify.js —— 规则分类引擎。
 *
 * 只做**确定性关键词匹配**：商户/备注命中关键词表 → 给出分类与目的；
 * 再退到用户修正记忆（`rules`）；最后用分类的默认目的兜底。
 * 不含任何 AI 调用，AI 兜底由 host-surface 的 `lib/ai.js` 在规则之后叠加。
 *
 * @module dsh-finance/classify
 */

import {
  CATEGORIES,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORY,
  PURPOSES,
  normalizeMerchant,
  oneOf,
} from './domain.js';

/**
 * 分类 → 默认目的。
 * @type {Readonly<Record<string, string>>}
 */
export const CATEGORY_PURPOSE = Object.freeze({
  餐饮: '生活必须',
  交通: '生活必须',
  购物: '生活必须',
  居家: '生活必须',
  医疗: '未来保障',
  教育: '自我实现',
  娱乐: '娱乐享受',
  通讯: '生活必须',
  人情往来: '人情社交',
  保险: '未来保障',
  还贷: '未来保障',
  投资: '未来保障',
  其他: '生活必须',
  收入: '',
});

/**
 * 每个分类下的关键词（中英文、品牌别名、常见商户摘要词）。
 * 匹配方式：`normalizeMerchant` 之后做 `includes`（全角/空格/标点已经被吃掉）。
 * 命中较长关键词优先（避免「地铁卡」被「卡」类词误伤）。
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const CATEGORY_KEYWORDS = Object.freeze({
  餐饮: Object.freeze([
    // 连锁咖啡 / 茶饮
    '星巴克', 'starbucks', '瑞幸', 'luckin', '麦当劳', 'mcdonald', '肯德基', 'kfc',
    '海底捞', '蜜雪冰城', '喜茶', 'heytea', '奈雪的茶', '奈雪', '霸王茶姬', '茶百道',
    '古茗', '沪上阿姨', '书亦烧仙草', 'coco', '一点点', '茶颜悦色', 'manner',
    '库迪', 'cotti', 'tims', '汉堡王', 'burgerking', '必胜客', 'pizzahut', '德克士',
    '华莱士', '真功夫', '吉野家', 'subway', '赛百味', '塔斯汀', '老乡鸡', '西贝',
    '外婆家', '绿茶餐厅', '九毛九', '呷哺呷哺', '南城香', '杨国福', '张亮麻辣烫',
    '和府捞面', '味千拉面', '面馆', '兰州拉面', '沙县小吃', '黄焖鸡', '吉食家',
    '美团外卖', '美团', 'meituan', '饿了么', 'ele.me', '外卖', '食堂', '餐厅', '饭店', '酒楼', '火锅',
    '烧烤', '烤肉', '咖啡', '奶茶', '面包', '烘焙', '蛋糕', '甜品', '早餐', '午餐',
    '晚餐', '夜宵', '小笼包', '煎饼', '便利店', '罗森', 'lawson', '全家便利店',
    '7-11', '711', 'seveneleven', '便利蜂', '美宜佳', '快餐', '自助餐', '食堂消费',
    '餐饮', '小吃', '饮料', '水果店', 'canteen', 'restaurant', 'coffee',
  ]),
  交通: Object.freeze([
    '滴滴', 'didi', '高德打车', '曹操出行', 't3出行', 't3', '享道出行', '首汽约车',
    '出租车', '网约车', '地铁', 'metro', 'subway', '公交', '巴士', 'bus', '轨道交通',
    '一卡通', '交通卡', '12306', '铁路', '火车票', '高铁', '动车', '航空', '机票',
    '东航', '南航', '国航', '春秋航空', '携程', 'ctrip', '同程', '飞猪', '去哪儿',
    '加油', '中国石化', '中石化', 'sinopec', '中国石油', '中石油', 'petrochina',
    '壳牌', 'shell', '道达尔', 'bp加油', '充电桩', '特来电', '星星充电', '停车',
    'etc', '过路费', '高速', '洗车', '共享单车', '哈啰', '美团单车', '青桔',
    '摩拜', 'ofo', '自行车', '打的', '车费', '车辆保养', '4s店', '汽车维修',
    '洗车', '驾照', '交通罚款', '违章', '交通',
  ]),
  购物: Object.freeze([
    '淘宝', 'taobao', '天猫', 'tmall', '京东', 'jd', 'jd.com', '拼多多', 'pinduoduo',
    '唯品会', 'vip.com', '苏宁', '国美', '小米', 'huawei', '华为', '苹果',
    'apple store', '盒马', 'freshhippo', '永辉', 'yonghui', '沃尔玛', 'walmart',
    '家乐福', 'carrefour', '山姆', 'sam\'s club', 'costco', '开市客', '大润发',
    '华润万家', '物美', '全家', '便利', '名创优品', 'miniso', '优衣库', 'uniqlo',
    'zara', 'hm', 'h&m', '无印良品', 'muji', '迪卡侬', 'decathlon', '耐克', 'nike',
    '阿迪达斯', 'adidas', '安踏', '李宁', 'lululemon', '波司登', '珂拉琪',
    '丝芙兰', 'sephora', '屈臣氏', 'watsons', '屈臣', '化妆品', '天猫超市',
    '1688', '闲鱼', '得物', 'poizon', '网易严选', '小米有品', '宜家', 'ikea',
   '超市', '商场', '百货', '便利店', '杂货', '文具', '服饰', '鞋', '购物',
    'supermarket', '淘宝买菜', '叮咚买菜', '叮咚', '每日优鲜', '美团买菜',
    '多多买菜', '生鲜', '菜场', '菜市场', '超市购物', '电商',
  ]),
  居家: Object.freeze([
    '房租', '租金', '租房', 'rent', '物业', '物业费', '水费', '电费', '燃气',
    '煤气', '天然气', '供暖', '取暖费', '国家电网', '电力', '自来水', '水务',
    '燃气公司', '新奥燃气', '华润燃气', '中国燃气', '港华燃气', '水电煤',
    '家政', '保洁', '维修', '维修费', '家具', '家电', '装修', '宜家',
    '链家', '贝壳', '我爱我家', '自如', '蛋壳', '中介费', '小区', '停车费',
    '生活垃圾', '电梯费', '宽带费', '宽带', '有线电视', '电信宽带', '联通宽带',
    '物业费缴纳', '房屋', '房贷首付', '搬家', '洗涤', '洗衣', '宠物',
  ]),
  医疗: Object.freeze([
    '医院', 'hospital', '卫生院', '卫生服务中心', '诊所', 'medical', '门诊',
    '挂号', '急诊', '住院', '药房', '药店', 'pharmacy', '大药房', '益丰',
    '老百姓大药房', '国大药房', '海王星辰', '同仁堂', '叮当快药', '医药',
    '口腔', '牙科', '齿科', '眼科', '体检', '美年', '爱康', '康复', '中医',
    '按摩', '推拿', '疫苗', '核酸', '化验', '检查费', '手术费', '医疗器械',
    '保健品', '医疗', '诊所', '药', 'healthcare',
  ]),
  教育: Object.freeze([
    '学费', '培训', '教育', '课程', '补习', '辅导', '新东方', '学而思', '好未来',
    '作业帮', '猿辅导', '高途', '环球雅思', '雅思', '托福', 'gre', '考研',
    '考公', '公务员', '驾校', '图书', '当当', 'dangdang', '书店', 'xinhua',
    '新华书店', '文具', '教材', '买书', 'kindle', '得到', '知乎盐选', '慕课',
    '网易公开课', 'udemy', 'coursera', '知识付费', '学院', '学校', '幼儿园',
    '托育', '留学', 'education', 'certification', '考试费', '报名费', '网课',
  ]),
  娱乐: Object.freeze([
    '电影', 'cinema', '影城', '万达影城', 'cgv', '大地影院', '猫眼', '淘票票',
    '演出', '音乐会', '话剧', '大麦', 'damai', '音乐节', 'ktv', '棋牌', '桌游',
    '密室', '剧本杀', '游戏', 'steam', 'playstation', 'psn', 'nintendo',
    'switch', '游戏充值', '王者荣耀', '原神', '米哈游', 'mihoyo', '网吧', '健身',
    '健身房', '游泳', '球场', '羽毛球', '瑜伽', '滑雪', '露营', '徒步', '门票',
    '景区', '旅游', '旅行', '酒店', '民宿', 'airbnb', 'booking', '网易云',
    'netеase', 'QQ音乐', 'qqmusic', 'spotify', '爱奇艺', 'iqiyi', '腾讯视频',
    'v.qq', '优酷', 'youku', '芒果tv', '哔哩哔哩', 'bilibili', 'b站', '会员',
    '按摩', '足浴', '酒吧', 'livehouse', '娱乐', '影视',
  ]),
  通讯: Object.freeze([
    '中国移动', '中国联通', '中国电信', '移动通信', '联通', '电信', '话费',
    '手机充值', '充值话费', '流量包', '移动流量', '套餐费', '宽带', '宽带费',
    '光纤', '10086', '10010', '10000号', '营业厅', 'sim卡', '通讯', '通信服务',
    '缴费充值', '话费充值', '充值话费', '流量包', '缴费',
    'china mobile', 'chinaunicom', 'chinanet', 'voip', '电话费',
  ]),
  人情往来: Object.freeze([
    '红包', '微信红包', '红包发出', '转账给', '份子钱', '随礼', '礼金', '礼金红包',
    '婚礼', '彩礼', '生日礼物', '礼物', '礼品', '慰问', '拜访', '探望', '孝敬',
    '给父母', '给家里', '捐赠', '捐款', '公益', '慈善', '打赏', '人情',
    '生日', '结婚', '礼', 'gift', 'donation',
    // 亲属称谓：给爸妈/伴侣/长辈的钱是最常见的人情往来，漏了会让「其他」撑满饼图
    '老妈', '爸爸', '妈妈', '父亲', '母亲', '老爸', '老爹', '阿爸', '阿妈',
    '老婆', '老公', '媳妇', '爱人', '女神', '宝贝', '丈母娘', '岳父', '岳母', '公婆',
    '爷爷', '奶奶', '外公', '外婆', '姥姥', '姥爷', '叔叔', '阿姨', '舅舅', '姑姑',
    '哥哥', '姐姐', '弟弟', '妹妹', '表哥', '表姐', '堂哥', '堂姐', '侄子', '侄女',
    '儿子', '女儿', '哥哥', '亲戚', '家里',
  ]),
  保险: Object.freeze([
    '保险', '保费', 'insurance', '重疾险', '医疗险', '意外险', '寿险', '年金',
    '平安保险', '中国人寿', '中国人保', '太平洋保险', '泰康', '新华保险',
    '众安保险', '友邦', 'aia', '车险', '交强险', '社保', '公积金', '社保缴费',
    '养老保险', '医疗保险', '保险缴费', '保险公司', '寿险缴费', '保单',
  ]),
  还贷: Object.freeze([
    '信用卡还款', '还款', '花呗', '借呗', '白条', '京东白条', '微粒贷', '分期',
    '最低还款', '自动还款', '房贷', '车贷', '贷款', '助学贷款', '消费贷',
    '借款', '利息', '还本付息', '提前还款', '还款日', 'bank loan', 'loan',
    '信用卡', '还款成功', '还呗', '安逸花', '360借条',
  ]),
  投资: Object.freeze([
    '基金', 'fund', '证券', 'securities', '股票', 'stock', 'etf', '沪深300',
    '中证500', '纳斯达克', '标普500', '债券', '国债', '理财', '银行理财',
    '余额宝', '零钱通', '定期存款', '大额存单', '黄金', '积存金', '股票开户',
    '证券公司', '华泰证券', '中信证券', '东方财富', '同花顺', '天天基金',
    '且慢', '蛋卷', '指数基金', '定投', '申购', '认购', '投顾', 'investment',
    '资产配置', '买入基金', '基金申购', '基金定投',
  ]),
  其他: Object.freeze([
    '转账', '提现', '取现', 'ATM', '手续费', '工本费', '年费', '滞纳金',
    '罚款', '赔偿', '公证', '快递', '顺丰', '菜鸟', '邮政', '外卖配送', '洗车',
    '宠物', '理发', '美容', '美发', '按摩', '洗衣', '擦鞋', '停车', '代驾',
    'netflix', 'netflix会员', 'youtube', 'google play', 'app store', 'icloud',
    '未知商户', '其他', '杂项', 'misc',
  ]),
  收入: Object.freeze([
    '工资', '薪水', 'salary', 'payroll', '代发工资', '奖金', '年终奖', '绩效',
    '报销', '退款', 'refund', '退货', '收款', '收到', '转入', '入账', '利息收入',
    '红包收入', '理财收益', '分红', '股息', 'dividend', '稿费', '兼职', '劳务',
    '补贴', '津贴', '补助', '公积金提取', '中奖', '返现', '返利', '提现',
    'income', 'pay', 'wage', 'bonus', 'interest',
  ]),
});

/** 命中的关键词最长字符数记录，用于「最长优先」。 */
function keywordsOf(category) {
  return CATEGORY_KEYWORDS[category] || [];
}

/**
 * 用关键词表匹配分类；返回命中的分类与命中的关键词。
 *
 * @param {string} text 已归一化的文本（商户 + 备注）
 * @returns {{ category: string, keyword: string } | null}
 */
export function matchCategoryByKeyword(text) {
  if (!text) return null;
  let best = null;
  for (const category of Object.keys(CATEGORY_KEYWORDS)) {
    for (const keywordRaw of keywordsOf(category)) {
      const keyword = normalizeMerchant(keywordRaw);
      if (!keyword) continue;
      if (!text.includes(keyword)) continue;
      if (!best || keyword.length > best.keyword.length) {
        best = { category, keyword };
      }
    }
  }
  return best;
}

/**
 * 取分类的默认目的。
 *
 * @param {string} category 分类
 * @returns {string} 目的；收入或未知分类返回 `""`
 */
export function suggestPurpose(category) {
  if (!category || category === INCOME_CATEGORY) return '';
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_PURPOSE, category)) return '';
  return CATEGORY_PURPOSE[category] ?? '生活必须';
}

/**
 * 校准一条流水/账单行的分类。
 *
 * 优先级：收入方向 → 用户修正记忆（`rules`）→ 行内已有分类（导入时表里就有的）
 * → 关键词规则 → `其他` 兜底。
 *
 * @param {{ merchant?: string, note?: string, category?: string, direction?: string, amount?: number }} input
 *   行信息；`category` 是账单里自带/用户已选分类，`direction` 是 `expense`/`income`
 * @param {Record<string, { category?: string, purpose?: string }>} [rules] 用户修正记忆
 * @returns {{ category: string, purpose: string, confidence: 'user'|'rule'|'default' }}
 *   confidence：user 用户记忆命中、rule 关键词/行内分类命中、default 兜底
 */
/**
 * 常见中文姓氏（覆盖全国人口 90% 以上）。
 *
 * 只用来判断「2-3 个字且以姓氏开头」的商户名像不像人名，
 * 配合商业词排除表，「海鲜档口」「金戈戈」这类不会混进来。
 */
const SURNAMES = new Set(
  '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤'.split(''),
);

/**
 * 判断商户名看起来是不是「转给某个人的钱」。
 *
 * 真实账单里给家人的转账占比很高（「老妈子」「我家女神」「19栋贞姨」），
 * 判成「其他」会让饼图被一大块灰吃掉。
 *
 * **只认强信号，宁可漏判也不误判。** 早期版本用「2–4 个汉字」当人名，
 * 结果把「海鲜档口」「瓦罐汤饭」「深汇充」全判成了人情往来——中文商户名
 * 大多就是 2–4 个字，这个特征毫无区分度。现在的判据只有三类：
 *
 *   1. 括号里的昵称：`老妈子(小黄)`、`我家女神(邓小样)` —— 转账给个人的典型形态
 *   2. 明确的亲属称谓：老妈/老婆/爸爸/爷爷/贞姨/霞姐…
 *   3. 典型的中文姓名（姓氏 + 1-2 字名），且不含任何商业词
 *
 * @param {string} text 已归一化的商户名
 * @returns {boolean} 像不像转给个人的钱
 */
function looksLikePersonTransfer(text) {
  if (!text || text.length > 16) return false;
  // ① 强商业信号：出现任何经营类字眼，一定不是转给个人
  if (/(公司|银行|超市|商店|商城|小店|酒店|宾馆|餐厅|饭店|档口|市场|门诊|医院|药房|药店|证券|基金|保险|集团|中心|科技|有限|店|厂|社|堂|馆|吧|充|车|剪|修|铺|局|站|票|影|超|mall|cafe|coffee|tea|bar)/u.test(text)) {
    return false;
  }
  // ② 亲属称谓：最强信号，无论几个字都算（「霞姐」「阿莲」里的「姨/姐」已覆盖）
  if (/(老妈|爸爸|妈妈|父亲|母亲|老爸|老爹|老婆|老公|媳妇|爱人|女神|宝贝|丈母娘|岳父|岳母|公婆|爷爷|奶奶|外公|外婆|姥姥|姥爷|舅舅|姑姑|姐姐|哥哥|弟弟|妹妹|嫂|姨|叔|婶|婆|奶|爷|姐|哥|妹|弟)/u.test(text)) {
    return true;
  }
  // ③ 括号昵称：「老妈子(小黄)」「朱宝爸爸(一滴水)」
  if (/\([\u4e00-\u9fa5]{1,4}\)/u.test(text)) return true;
  // ④ 「阿X」式小名：「阿莲」「阿强」
  if (/^阿[\u4e00-\u9fa5]{1,2}$/u.test(text)) return true;
  // ⑤ 叠字/重复字（「金戈戈」「牛饭饭」）是店名不是人名，先排除
  if (/^(.)\1{1,}$/u.test(text) || /(.)\1$/u.test(text)) return false;
  // ⑥ 典型中文全名（2-3 字，姓氏开头）——放最后，且要求首字是**常见**姓氏
  if (text.length >= 2 && text.length <= 3 && SURNAMES.has(text[0])) return true;
  return false;
}

/**
 * 给一笔流水分类export function classify(input = {}, rules = {}) {
  const merchant = String(input.merchant ?? '');
  const note = String(input.note ?? '');
  const direction = input.direction === 'income' ? 'income' : 'expense';

  // 1) 收入方向：分类固定「收入」，目的留空
  if (direction === 'income') {
    return { category: INCOME_CATEGORY, purpose: '', confidence: 'rule' };
  }

  // 2) 用户记忆（按商户归一化 key 查；也允许用备注里出现的商户命中）
  const keys = [normalizeMerchant(merchant)].filter(Boolean);
  const noteKey = normalizeMerchant(note);
  if (noteKey && !keys.includes(noteKey)) keys.push(noteKey);
  for (const key of keys) {
    const hit = rules && typeof rules === 'object' ? rules[key] : null;
    if (hit && CATEGORIES.includes(hit.category)) {
      const purpose = hit.purpose && PURPOSES.includes(hit.purpose)
        ? hit.purpose
        : suggestPurpose(hit.category);
      return { category: hit.category, purpose, confidence: 'user' };
    }
  }

  // 3) 行内自带的分类（支付宝「交易分类」列等）
  //    注意「其他」例外：账单自带的「其他」等于「没信息」，不能当成一次有效命中，
  //    否则调用方（routes/tools 的 AI 兜底）没法把这类行挑出来重新判断。
  //    这类行继续往下走关键词表，关键词也没命中时才落到 default。
  const hint = input.category;
  if (hint && hint !== '其他' && CATEGORIES.includes(hint) && hint !== INCOME_CATEGORY) {
    return {
      category: hint,
      purpose: suggestPurpose(hint),
      confidence: 'rule',
    };
  }

  // 4) 关键词表：商户优先，商户没命中再看备注（避免备注里的「地铁口」把
  //    一笔「星巴克」错分类成交通）。两边都命中时取命中的关键词更具体的那个。
  const merchantKey = normalizeMerchant(merchant);
  const byMerchant = matchCategoryByKeyword(merchantKey);
  const byNote = noteKey && noteKey !== merchantKey ? matchCategoryByKeyword(noteKey) : null;
  const hit = byMerchant || byNote;
  if (hit) {
    return { category: hit.category, purpose: suggestPurpose(hit.category), confidence: 'rule' };
  }

  // 5) 看像不像「转给某个人的钱」。
  //    微信/支付宝里直接转给亲戚朋友，商户名就是对方的人名（「老妈子」「19栋贞姨」
  //    「李伟良」）。这类几乎都是人情往来，归「其他」会让饼图被一大块灰吃掉。
  //    例外：账单**自己**标了「其他」时不抢这个判断。账单说的「其他」是权威
  //    信号，留 default 交给调用方的 AI 兜底去看一眼更稳。
  if (hint !== '其他' && looksLikePersonTransfer(merchantKey)) {
    return { category: '人情往来', purpose: suggestPurpose('人情往来'), confidence: 'rule' };
  }

  // 6) 兜底
  return { category: '其他', purpose: suggestPurpose('其他'), confidence: 'default' };
}

/**
 * 把支付宝/银行导出里的「交易分类」文案映射到我们的分类。
 *
 * @param {string} raw 原始分类文案
 * @param {string} [direction='expense'] 方向
 * @returns {string} 分类；认不出返回 `""`
 */
export function mapCategoryHint(raw, direction = 'expense') {
  const text = normalizeMerchant(raw);
  if (!text) return '';
  if (direction === 'income') return INCOME_CATEGORY;
  // 直接是分类名 → 用它
  if (CATEGORY_KEYWORDS[text] && text !== INCOME_CATEGORY) return text;
  // 否则在全部关键词里找「最具体」的命中（命中词越长越具体）
  let best = null;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (category === INCOME_CATEGORY) continue;
    for (const keyword of keywords) {
      const key = normalizeMerchant(keyword);
      if (!key) continue;
      if ((text === key || text.includes(key)) && (!best || key.length > best.key.length)) {
        best = { category, key };
      }
    }
  }
  return best ? best.category : '';
}

/**
 * 批量自动分类（导入预览用）：按需回填 `category` / `purpose`。
 *
 * @param {Array<object>} rows 账单行
 * @param {Record<string, { category?: string, purpose?: string }>} [rules] 用户记忆
 * @returns {Array<object>} 新数组，每行附加 `category/purpose/confidence`
 */
export function classify(input = {}, rules = {}) {
  const merchant = String(input.merchant ?? '');
  const note = String(input.note ?? '');
  const direction = input.direction === 'income' ? 'income' : 'expense';

  // 1) 收入方向：分类固定「收入」，目的留空
  if (direction === 'income') {
    return { category: INCOME_CATEGORY, purpose: '', confidence: 'rule' };
  }

  // 2) 用户记忆（按商户归一化 key 查；也允许用备注里出现的商户命中）
  const keys = [normalizeMerchant(merchant)].filter(Boolean);
  const noteKey = normalizeMerchant(note);
  if (noteKey && !keys.includes(noteKey)) keys.push(noteKey);
  for (const key of keys) {
    const hit = rules && typeof rules === 'object' ? rules[key] : null;
    if (hit && CATEGORIES.includes(hit.category)) {
      const purpose = hit.purpose && PURPOSES.includes(hit.purpose)
        ? hit.purpose
        : suggestPurpose(hit.category);
      return { category: hit.category, purpose, confidence: 'user' };
    }
  }

  // 3) 行内自带的分类（支付宝「交易分类」列等）
  //    注意「其他」例外：账单自带的「其他」等于「没信息」，不能当成一次有效命中，
  //    否则调用方（routes/tools 的 AI 兜底）没法把这类行挑出来重新判断。
  //    这类行继续往下走关键词表，关键词也没命中时才落到 default。
  const hint = input.category;
  if (hint && hint !== '其他' && CATEGORIES.includes(hint) && hint !== INCOME_CATEGORY) {
    return {
      category: hint,
      purpose: suggestPurpose(hint),
      confidence: 'rule',
    };
  }

  // 4) 关键词表：商户优先，商户没命中再看备注（避免备注里的「地铁口」把
  //    一笔「星巴克」错分类成交通）。两边都命中时取命中的关键词更具体的那个。
  const merchantKey = normalizeMerchant(merchant);
  const byMerchant = matchCategoryByKeyword(merchantKey);
  const byNote = noteKey && noteKey !== merchantKey ? matchCategoryByKeyword(noteKey) : null;
  const hit = byMerchant || byNote;
  if (hit) {
    return { category: hit.category, purpose: suggestPurpose(hit.category), confidence: 'rule' };
  }

  // 5) 像不像「转给某个人的钱」。账单自己标了「其他」时不抢这个判断——
  //    那是权威信号，留 default 交给调用方的 AI 兜底。
  if (hint !== '其他' && looksLikePersonTransfer(merchantKey)) {
    return { category: '人情往来', purpose: suggestPurpose('人情往来'), confidence: 'rule' };
  }

  // 6) 兜底
  return { category: '其他', purpose: suggestPurpose('其他'), confidence: 'default' };
}

export function classifyRows(rows, rules = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const result = classify(
      {
        merchant: row.merchant,
        note: row.note,
        category: row.categoryHint || row.category,
        direction: row.direction,
        amount: row.amount,
      },
      rules,
    );
    return {
      ...row,
      category: row.category || result.category,
      purpose: row.purpose ?? result.purpose,
      confidence: row.confidence || result.confidence,
    };
  });
}

/**
 * 统计自动分类率（0-1）：`confidence` 为 rule/user 的行占比。
 *
 * @param {Array<{ confidence?: string }>} rows 已分类的行
 * @returns {number} 0-1
 */
export function autoRateOf(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 0;
  const hit = list.filter((row) => row.confidence === 'rule' || row.confidence === 'user').length;
  return Math.round((hit / list.length) * 10000) / 10000;
}

/**
 * 关键词表规模自检（测试与文档用）：返回 `{ categories, keywords }`。
 *
 * @returns {{ categories: number, keywords: number }}
 */
export function keywordStats() {
  const categories = Object.keys(CATEGORY_KEYWORDS).length;
  let keywords = 0;
  for (const list of Object.values(CATEGORY_KEYWORDS)) keywords += list.length;
  return { categories, keywords };
}

/** 分类里是否含该分类（再导出一个方便调用方做校验）。 */
export const isCategory = (value) => CATEGORIES.includes(value) && oneOf(value, CATEGORIES, '其他') !== undefined;