/**
 * roles.js — 多角色朗读：给每一句分配「旁白 / 某个角色」的音色
 *
 * 纯本地启发式，不联网、不调模型：
 *   1. 句中有引号 → 视为带台词的句子；
 *   2. 从引号前的「某某说道：」或引号后的「某某说」提取说话人；
 *   3. 提不到就沿用最近一次说话人（对话连续），仍没有则归旁白；
 *   4. 同名角色稳定映射到同一个音色，性别决定用男声池还是女声池。
 *
 * 识别粒度是「整句」：带台词的句子整句用角色音色念，其余用旁白音色。
 * 拿不准的一律退回旁白——宁可少切，不可乱切。
 */

/** 男声池：云希（青年）、云健（浑厚）、云扬（沉稳）、云夏（少年） */
export const MALE_POOL = [
  'edge:zh-CN-YunxiNeural',
  'edge:zh-CN-YunjianNeural',
  'edge:zh-CN-YunyangNeural',
  'edge:zh-CN-YunxiaNeural',
];

/** 女声池：Edge 免费接口能用的普通话女声，实测共 3 个 */
export const FEMALE_POOL = [
  'edge:zh-CN-XiaoyiNeural',     // 晓伊 · 甜美少女
  'edge:zh-CN-XiaoxuanNeural',   // 晓萱 · 清亮（不在官方清单，实测可用）
  'edge:zh-CN-XiaoxiaoNeural',   // 晓晓 · 温柔（默认旁白，被旁白占用时自动让位）
];

/*
 * 为什么池里没有「晓北（东北）/ 晓妮（陕西）/ 晓臻（台湾）/ 晓曼（粤语）」：
 * Edge readaloud 接口的 zh-CN 音色一共只有 6 个 —— 2 女 Xiao(xiao|yi) + 4 男 Yun(xi|jian|yang|xia)，
 * 全部是标准普通话。方言与台湾腔、粤语属于 zh-CN-liaoning / zh-CN-shaanxi / zh-TW / zh-HK，
 * 拿它们凑数会让小说里的女性角色突然说一口陕西话，出戏程度远大于「两个配角共用音色」。
 *
 * 晓萱（XiaoxuanNeural）是额外捡到的：它不在 voices/list 清单里，但实测服务端能正常合成
 * （见 test/probe_voices.py）。Azure 上还有 Xiaohan / Xiaomeng / Xiaomo / Xiaoqiu / Xiaorui /
 * Xiaoyan / Xiaoyou / Xiaozhen 以及全部 Multilingual 系列，实测均返回 NoAudioReceived，用不了。
 * 结论：普通话女声的物理上限是 3 个，女性角色超过 3 个必然复用，这是接口限制。
 * 想要方言腔调，请由用户在听书面板里手动给某个角色指定（那里保留了全部音色）。
 */

const MAX_ROLES = 8;          // 一章最多区分这么多角色，多余的复用音色池
const CARRY_LIMIT = 3;        // 无提示语的对白最多沿用前几轮的说话人

/* ---------------- 词表 ---------------- */

/** 说话动词，用于定位「名字 + 动词」的边界 */
const SPEECH_VERBS = [
  '继续说道', '接着说', '继续说', '补充说道', '开口说', '解释说',
  '低声道', '轻声道', '沉声道', '冷声道', '淡淡道', '柔声道', '大声道', '厉声道',
  '高声说', '轻声说', '低声说', '笑着说道', '冷笑道', '苦笑道', '笑着道',
  '开口道', '说道', '问道', '答道', '笑道', '喊道', '叫道', '嚷道', '吼道',
  '骂道', '叹道', '怒道', '急道', '沉声', '开口', '接着',
  // 下面这批是「名字 + 双字动词」的高频组合。缺了它们，
  // 「孙七回答」会被末尾的单字「答」抢先，剥出「七回」这种假名字。
  '回答道', '回答', '回应道', '回应', '应道', '接话道', '接话',
  '插话道', '插话', '补充道', '解释道', '追问道', '反问道',
  '嘀咕道', '嘟囔道', '喃喃道', '自语道', '低语道',
  '说', '道', '问', '答', '喊', '叫', '嚷', '吼', '骂', '叹', '哼',
];

/** 动词前的这些字说明它不是说话动词（知道 / 难道 / 味道 / 听说 / 据说…） */
const VERB_FALSE_HEAD = '知难味称报听据按虽再假论街航铁通正';

/** 名字后可能跟的动作/神态，需要从候选串里剥掉 */
const ACTION_TAILS = [
  '清了清嗓子', '耸了耸肩', '叹了口气', '咬了咬牙', '点了点头', '摇了摇头',
  '抬起头来', '低下头去', '转过身来', '站起身来', '皱起眉头', '皱皱眉',
  '抬起头', '低下头', '转过身', '站起身', '走过来', '走进来', '凑过来',
  '点了点头', '摇了摇头', '点了点头', '皱了皱眉', '顿了顿', '愣了愣',
  '笑了笑', '叹了口气', '咳嗽一声', '沉吟片刻', '沉默片刻', '想了想',
  '点了点头', '看着她', '看着他', '望着他', '望着她', '看着', '盯着', '望着',
  '伸出手', '摆了摆手', '挥了挥手', '点头', '摇头', '皱眉', '叹气', '冷笑',
  '转身', '回头', '站起', '坐下', '走近', '伸手', '摆手', '挥手', '沉默',
  '愣住', '咳嗽', '耸肩', '摊手', '抿嘴', '抬眼', '垂眼', '笑了', '笑道',
  '挑眉', '扬眉', '撇嘴', '嗤笑', '哼道', '接口', '插嘴', '打断', '反问', '追问',
  '沉声', '低声', '轻声', '大声', '急声', '柔声', '笑着', '看着',
  '这才', '随即', '连忙', '急忙', '轻轻', '微微', '冷冷', '淡淡', '缓缓', '慢慢',
  // 「郭襄喜道」「那人鼓掌道」：动作/神态本身不算名字，必须先剥掉
  '鼓掌', '拍手', '拱手', '抱拳', '抚掌', '摆手', '摆手道', '接口道', '起身来',
  '跳起身来', '站起来', '抬起头来', '一声', '几声',
  // 单字状语尾：「郭襄喜道」「卫天望怒道」「那人笑道」
  '喜', '笑', '冷', '淡', '缓', '轻', '低', '沉', '怒', '急', '柔', '厉', '微',
];

/** 状语 / 副词尾：不从「更加青了，冷冷的」里剥掉它们就取不到人名 */
const ADVERB_TAILS = [
  '忍不住', '不由得', '不自觉', '下意识', '不由自主',
  '更加', '越发', '愈加', '更是', '很是', '十分', '非常', '颇为', '甚为',
  '实在', '终究', '毕竟', '果然', '竟然', '终于', '随即', '连忙', '急忙',
];

/** 按长度降序，保证先剥长词再剥短词（否则「点了点头」会被「点头」拆坏） */
const ACTION_TAILS_SORTED = [...ACTION_TAILS].sort((a, b) => b.length - a.length);

/** 尾部助词，需要与动作尾交替剥 */
const PARTICLE_TAIL = /[的地得了着过]+$/;

/** 三字名的第 3 个字若是这些，说明前两字才是名字（「张三说」「郭襄喜」） */
const FUNCTION_TAIL_CHARS = '说道问答笑走站坐转抬低点摇沉冷淡缓轻微便就也都却又才更的了吗呢吧啊呀着过把将给向对在是从竟忽听没未别猛然仍心身眼脸口手眉目气意神';

/** 未具名的说话人（「那人道」「此人道」）合并成一个身份，好过错用上一位的音色 */
const ANON_NAMES = new Set(['那人', '此人', '这人', '对方', '那汉子', '这汉子']);

/** 不能当角色名的词：代词、泛称、虚词片段 */
const STOP_NAMES = new Set([
  '我', '你', '您', '他', '她', '它', '咱', '俺',
  '我们', '你们', '他们', '她们', '咱们', '大家', '众人', '众人都', '有人', '有的人',
  '那人', '此人', '对方', '两人', '二人', '一个人', '几人', '所有人', '其他人', '别人',
  '难道', '知道', '不知', '谁', '什么', '怎么', '为什么', '这个', '那个', '这时', '此时',
  '忽然', '突然', '然后', '于是', '接着', '继续', '说完', '一边', '一面', '话音', '声音',
  '女子', '男子', '少年', '少女', '老者', '中年', '男人', '女人', '孩子', '众人都',
  // 叙述高频词：识别失手时宁可退回旁白，也不要造出「而已」「鼓掌」这种假角色
  '而已', '只好', '只得', '不禁', '不由', '当下', '当下人', '半晌', '片刻',
  '一声', '几声', '两声', '一声道', '鼓掌', '点头', '摇头', '冷笑', '苦笑',
]);

/** 复姓：4 字候选要保住（欧阳锋 / 司马懿） */
const COMPOUND_SURNAMES = new Set([
  '欧阳', '司马', '上官', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容',
  '长孙', '宇文', '司徒', '夏侯', '令狐', '端木', '独孤', '南宫', '西门',
]);

/**
 * 常见单姓。只用于「从结尾取名字」时判断要不要往前多吃一个字：
 * 「……何足道」若不认识「何」是姓，就会截成「足道」。
 */
const SURNAMES = new Set(('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜' +
  '戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐费廉岑薛雷贺倪汤' +
  '滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明' +
  '臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐' +
  '邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉' +
  '钮龚程嵇邢滑裴陆荣翁荀羊于惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车' +
  '侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟薄印宿白怀' +
  '蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴鬱胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍卻璩桑' +
  '桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居' +
  '衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾' +
  '毋沙乜养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公').split(''));

/*
 * 性别词表分「强 / 弱」两级。旧版把「雪玉兰香红美秀」这类中性字和「娘姐妹」并列，
 * 只要命中就判女 —— 男性名里带这些字（秦红棉是女，但「段玉」「花铁干」是男）
 * 就会被塞一个女声。现在只有强字能独立定性别，弱字只提供 1 分佐证。
 */
const STRONG_F = '娘姐妹婆婶妈姑姨奶妃后妻媳嫂婕妍媛姝婉娴娇媚婷黛襄娥胭女姥';
const WEAK_F = '芳雪玉兰香翠珠珊素珍洁敏悦欣慧静怡思雨梦涵蕊薇裳韵曼蓉芷若芸圆美秀莉莎娜琪莹萌甜俏' +
  '红丽倩雅琴萍燕梅菊莲霞玲瑶凤莺娟嫣盈钗佩绮罗脂粉愁紫碧珂';
const STRONG_M = '哥兄弟爹爸爷叔伯侠僧帝侯帅郎翁汉强刚伟勇猛峰磊栋军毅鹏辉斌杰雄豪';
const WEAK_M = '公';

/** 名字里出现这些词直接定性（「灭绝师太」「梅师姑」） */
const TITLE_F = ['师太', '师姑', '道姑', '尼姑', '婆婆', '老太太'];

/** 台词里的自称：说话人自己报性别，最硬的证据 */
const SELF_M = ['本公子', '本少爷', '在下', '老夫', '贫道', '贫僧', '洒家', '小生', '晚生',
  '本座', '本王', '老子', '我老人家', '小老儿', '末将', '微臣', '臣'];
const SELF_F = ['妾身', '奴家', '小女子', '本姑娘', '本宫', '臣妾', '人家', '老身', '小女子'];

/** 叙述里的身份名词：紧挨着说话人的描写 */
const NOUN_M = ['少年', '男子', '男人', '汉子', '大汉', '老者', '老翁', '公子', '青年',
  '道士', '和尚', '少侠', '壮士', '老头', '男子汉', '那汉'];
const NOUN_F = ['少女', '女子', '女人', '姑娘', '妇人', '老妇', '美妇', '丫鬟', '婢女',
  '小姐', '夫人', '太婆', '女侠', '尼姑', '道姑', '老妪', '娘子', '小女孩']; 

/* ---------------- 文本工具 ---------------- */

const OPEN_Q = /[“「『"]/;
const CLOSE_Q = /[”」』"]/;

/**
 * PDF 抽出来的文本经常把开引号也提取成 ”（方向信息丢失），
 * 例如「潘天耕道：”阁下连败我两个师弟…」。只认 “ 的话这类句子全被当成叙述，
 * 整本书的对白都退化成旁白。这里在「说话动词 + 引号」的组合下把 ” 也当开引号 ——
 * 不无条件放宽，否则「她转身走了。”」这种纯叙述句会被误判成台词。
 */
const SPEAK_MARK = /(道|说|问|答|喊|叫|笑|喝|哼|嚷|骂)[：:]?\s*[”」』]/;

/**
 * 内心独白：「心中一乐」「心中蓦地一动」「暗想」「寻思」——说完这些，引号里是心理活动。
 * 只认「心 / 暗 + 不超过 6 字的修饰」收尾，避免把「郭襄心中想什么我不知道」这种
 * 长叙述也当成说话提示。
 */
const MIND_HEAD = /(心中|心念|心想|心道|心下|暗道|暗想|暗忖|寻思)/;

/** 该句是否含引号（有开引号即算，防止分句把引号切到下一句） */
function hasQuote(s) {
  if (OPEN_Q.test(s)) return true;
  return SPEAK_MARK.test(String(s || ''));
}

/** 找开引号的位置；PDF 文本里「道：”」这种方向错乱的引号也认 */
function openQuoteAt(s) {
  for (let i = 0; i < s.length; i++) {
    if (OPEN_Q.test(s[i])) return i;
  }
  const m = String(s || '').match(SPEAK_MARK);
  return m ? m.index + m[0].length - 1 : -1;
}

/** 引号里只是笑声/叹词（“哈哈、哈哈”），不是台词 */
const INTERJECTION = /^[哈嘿呵嗯啊唉哦咦嘻呜哇呀呦哎唉唉嗯呐么]+$/;

function isInterjection(s) {
  const m = String(s || '').match(/[“「『"]([^”」』"]*)[”」』"]/);
  if (!m) return false;
  const inner = stripPunct(m[1]);
  return inner.length > 0 && inner.length <= 8 && INTERJECTION.test(inner);
}

/** 取引号内的台词正文（用于识别「妾身」「在下」这类自称） */
function quoteOf(s) {
  const at = openQuoteAt(s);
  if (at < 0) return '';
  const rest = String(s).slice(at + 1);
  const m = rest.match(/^([\s\S]*?)[”」』"]/);
  return m ? m[1] : rest;
}

/**
 * 切出「引号前」与「最后一个引号后」两段。
 * 中文引号成对，英文引号同时充当开闭，按第一个成对匹配处理。
 */
function splitAtQuote(s) {
  const first = openQuoteAt(s);
  if (first < 0) return null;
  let last = -1;
  for (let i = s.length - 1; i > first; i--) {
    if (CLOSE_Q.test(s[i])) { last = i; break; }
  }
  return {
    prefix: s.slice(0, first),
    suffix: last > first ? s.slice(last + 1) : '',
  };
}

/** 去掉句子里的标点与空白，便于分析 */
function stripPunct(s) {
  return String(s || '').replace(/[\s，。！？；：、,.!?;:"“”‘’「」『』（()）—…·]/g, '');
}

/** 反复剥动作 / 状语 / 助词，直到剥不动为止（三者必须交替，否则「冷冷的」剥不干净） */
function cleanCandidate(cand) {
  let s = String(cand || '');
  for (let round = 0; round < 8; round++) {
    let hit = '';
    for (const a of ACTION_TAILS_SORTED) {
      if (s.length > a.length && s.endsWith(a)) { hit = a; break; }
    }
    if (!hit) {
      for (const a of ADVERB_TAILS) {
        if (s.length > a.length && s.endsWith(a)) { hit = a; break; }
      }
    }
    if (!hit) {
      const m = s.match(PARTICLE_TAIL);
      if (m && s.length > m[0].length) hit = m[0];
    }
    if (!hit) break;
    s = s.slice(0, s.length - hit.length);
  }
  return s;
}

/**
 * 从候选串里剥出人名。
 * @param {string} cand 已去掉标点的文字
 * @param {boolean} fromStart true = 名字在开头（引号之后），false = 名字在结尾（引号之前）
 *
 * 引号前是「张三抬起头来说道」，名字在末尾；引号后是「”王五在后面喊」，名字在开头。
 * 两个方向都先剥动作词，再按「双字名优先、复姓三字」取名。
 */
function pickName(cand, fromStart = false) {
  let s = cleanCandidate(cand);
  if (!s) return '';
  // 代词开头的不是名字：「他说」「她笑」由调用方按代词处理
  if (/^[他她它我你您咱俺]/.test(s)) return '';

  // 只保留一段连续汉字，避免把前后分句的字粘进来
  const m = fromStart ? s.match(/^[\u4e00-\u9fa5]+/) : s.match(/[\u4e00-\u9fa5]+$/);
  if (!m) return '';
  s = m[0];

  let name;
  if (fromStart) {
    if (s.length >= 3 && COMPOUND_SURNAMES.has(s.slice(0, 2))) name = s.slice(0, 3);
    // 三字名（卫天望 / 何足道）：第 3 字不是虚词或动词，才取三字
    else if (s.length >= 3 && !FUNCTION_TAIL_CHARS.includes(s[2])) name = s.slice(0, 3);
    else name = s.slice(0, 2);
  } else {
    // 「……何足道」：尾字前一位是姓氏，说明是三字名，不要截成「足道」
    if (s.length >= 3 && (COMPOUND_SURNAMES.has(s.slice(-3, -1)) || SURNAMES.has(s[s.length - 3]))) {
      name = s.slice(-3);
    } else {
      name = s.slice(-2);
    }
  }

  if (ANON_NAMES.has(name)) return '那人';       // 未具名说话人合并成一个身份
  if (INTERJECTION.test(name)) return '';        // 「哈哈」不是人
  if (STOP_NAMES.has(name)) return '';
  // 1 字名只接受亲属称呼类，避免「难」「知」这类碎片
  if (name.length === 1 && !'娘姐妹婆婶妈姑姨奶爹爸爷叔舅嫂'.includes(name)) return '';
  return name;
}

/** 句末是否为「（名字）+ 说话动词」，是则返回动词与名字候选 */
function verbAtEnd(seg) {
  if (!seg) return null;
  let bestEnd = -1;
  let bestVerb = '';
  for (const v of SPEECH_VERBS) {
    const i = seg.lastIndexOf(v);
    if (i < 0) continue;
    const end = i + v.length;
    if (end > bestEnd || (end === bestEnd && v.length > bestVerb.length)) {
      bestEnd = end;
      bestVerb = v;
    }
  }
  if (bestEnd !== seg.length || bestEnd <= 0) return null;
  const head = seg.slice(0, bestEnd - bestVerb.length);
  // 挡住「知道 / 难道 / 味道 / 听说」
  if (bestVerb.length === 1 && head && VERB_FALSE_HEAD.includes(head[head.length - 1])) return null;
  return { verb: bestVerb, head };
}

/** 按标点切出短句，名字只可能出现在短句级的片段里 */
function clauseList(s) {
  return String(s || '').split(/[，。；！？,;!?、\n]/).map(x => x.trim()).filter(Boolean);
}

/**
 * 从引号前的提示语里取说话人：「张三冷冷道：」→ 张三
 * 同时兼容剧本式「张三：“……”」（冒号前只有名字）。
 *
 * 关键改动：按短句从后往前扫。整串里取人会粘上「一张铁青的脸更加青了」这类叙述，
 * 单个短句才是真正的提示语。
 */
/** 从短句开头取人名（提示语的主语前置句：「卫天望给他这双眼一瞪」） */
function leadingName(clause) {
  const s = stripPunct(clause);
  if (!s || s.length > 14) return '';
  if (SPEECH_VERBS.some(v => s.startsWith(v))) return '';   // 「说道」本身不是人
  return pickName(s, true);
}

function speakerFromPrefix(prefix) {
  const raw = stripPunct(prefix);
  if (!raw) return '';

  const clauses = clauseList(prefix);

  // 1) 从最后一个短句往前找「名字 + 说话动词」
  for (let c = clauses.length - 1; c >= 0; c--) {
    const seg = stripPunct(clauses[c]);
    if (!seg) continue;
    const hit = verbAtEnd(seg);
    if (!hit) continue;

    // 动词前没有人物（「……，跳起身来，说道：」）：名字在更前面的短句里
    // 「对郭襄道」「向张三问道」：动词后是听话人，说话人同样在前一句
    const needPrev = !hit.head || /^[对向跟朝和与同]/.test(hit.head);
    if (needPrev) {
      for (let k = c - 1; k >= Math.max(0, c - 2); k--) {
        const nm = leadingName(clauses[k]);
        if (nm) return nm;
      }
      continue;
    }

    const name = pickName(hit.head, false);
    if (name) return name;
  }

  // 1.5) 内心独白：「郭襄心中一乐：“…”」「他暗想：」——动词不是「说」而是「心动」类，
  //      台词其实是这个人物的心理活动，说话人就是他。缺这一步会沿用上一位说话人。
  for (let c = clauses.length - 1; c >= 0; c--) {
    const seg = stripPunct(clauses[c]);
    if (!seg) continue;
    const mm = seg.match(MIND_HEAD);
    if (!mm) continue;
    const tail = seg.slice(mm.index + mm[0].length);
    if (tail.length > 6) continue;              // 修饰太长 → 是叙述，不是提示语
    const name = pickName(seg.slice(0, mm.index), false);
    if (name) return name;
  }

  // 2) 剧本式：整段就是名字（含说话动词说明不是名字）
  if (raw.length >= 1 && raw.length <= 4 && !STOP_NAMES.has(raw)
      && !SPEECH_VERBS.some(v => raw.includes(v))) {
    return pickName(raw, true);
  }

  // 3) 兜底：取最前面一个短句的开头（「卫天望给他这双眼一瞪，……，冷冷的道」）
  //    只有前缀里存在说话动词时才这么做；没有动词说明这句是上一段台词的续句，
  //    强行取首两字会造出「偏有一」这种假角色。
  if (!SPEECH_VERBS.some(v => raw.includes(v))) return '';
  for (let c = 0; c < Math.min(2, clauses.length); c++) {
    const s = stripPunct(clauses[c]);
    if (!s) continue;
    if (s.length > (c === 0 ? 14 : 6)) continue;
    if (SPEECH_VERBS.some(v => s.includes(v))) continue;
    const name = pickName(s.slice(0, 6), true);
    if (name) return name;
  }
  return '';
}

/** 从引号后的文字取说话人：「……”，张三说。」「……”，张三挑眉。」→ 张三 */
function speakerFromSuffix(suffix) {
  const raw = stripPunct(suffix);
  if (!raw) return '';

  const clauses = clauseList(suffix);
  const first = stripPunct(clauses[0] || '');
  if (!first) return '';

  // 说话人必须紧贴引号，也就是出现在第一个片段里。
  // 往后面的片段找会扫到台词正文（「我姓何，名字叫作足道」→「名字叫」）。
  const hit = verbAtEnd(first);
  if (hit && hit.head && !/^[对向跟朝和与同]/.test(hit.head)) {
    const name = pickName(hit.head, true);
    if (name) return name;
  }

  // 「”张三笑了笑，说道」：名字在第一段，动词在第二段
  if (first.length <= 5 && SPEECH_VERBS.some(v => (clauses[1] || '').includes(v))) {
    const name = pickName(first, true);
    if (name) return name;
  }

  // 无动词：只有「短片段」才可能是「名字 + 动作」。
  // 「”而已，居然能震破屋顶」这种长叙述若也取头两字，就会造出「而已」这类假角色。
  if (first.length >= 2 && first.length <= 4) {
    const name = pickName(first, true);
    if (name) return name;
  }
  return '';
}

/**
 * 性别打分。正数偏男，负数偏女，0 表示没有任何线索。
 *
 * 证据按可靠性从高到低：
 *   1. 台词自称（「在下」「妾身」）±6 —— 说话人自己说的，几乎不会错；
 *   2. 紧邻说话动词的代词（「她笑道」「”他说」）±4 —— 只取引号旁那一个短句，
 *      避免「郭襄看着他，笑道」里的「他」被当成主语（那是宾语）；
 *   3. 叙述身份名词（「少女」「汉子」）±3；
 *   4. 名字里的强性别字 ±3，弱性别字 ±1 —— 中性字不再一票定男女；
 *   5. 三字名 +1：中文小说里三字名绝大多数是男性，作为先验而非结论。
 *
 * @param {string} name 角色名
 * @param {{prefix?:string, suffix?:string, quote?:string}} ctx 该句的原文片段
 */
export function genderScore(name, ctx = {}) {
  const prefix = ctx.prefix || '';
  const suffix = ctx.suffix || '';
  const quote = ctx.quote || '';
  let s = 0;

  // 1) 台词自称
  if (SELF_F.some(w => quote.includes(w))) s -= 6;
  else if (SELF_M.some(w => quote.includes(w))) s += 6;

  // 2) 紧邻说话动词的代词：只取引号前最后一个短句 + 引号后第一个短句
  const pc = clauseList(prefix);
  const sc = clauseList(suffix);
  const near = stripPunct((pc[pc.length - 1] || '') + '|' + (sc[0] || ''));
  const hasM = /(^|[^其])他/.test(near);     // 「其他」不是代词
  const hasF = /她/.test(near);
  if (hasF && !hasM) s -= 4;
  else if (hasM && !hasF) s += 4;

  // 3) 身份名词：只在叙述里找，台词里的「姑娘」是称呼对方，不能算说话人
  const narr = prefix + suffix;
  const nf = NOUN_F.filter(w => narr.includes(w)).length;
  const nmc = NOUN_M.filter(w => narr.includes(w)).length;
  if (nf > nmc) s -= 3 * Math.min(nf - nmc, 2);
  else if (nmc > nf) s += 3 * Math.min(nmc - nf, 2);

  // 4) 名字用字：先剥掉姓氏 —— 「王语嫣」的「王」、「花铁干」的「花」都不是性别线索，
  //    不剥的话「王」会被当成男性字（王 → 公 → 男），女角色直接判反。
  const nm = String(name || '');
  const first = nm[0] || '';
  const firstGendered = STRONG_F.includes(first) || STRONG_M.includes(first)
    || WEAK_F.includes(first) || WEAK_M.includes(first);
  const given = (nm.length >= 2 && SURNAMES.has(first) && !firstGendered) ? nm.slice(1) : nm;

  if (TITLE_F.some(w => nm.includes(w))) s -= 5;
  // 「阿紫」「阿朱」「阿碧」：阿 + 单字是典型女性昵称
  if (/^阿[\u4e00-\u9fa5]$/.test(nm)) s -= 3;

  let ns = 0;
  for (const ch of given) {
    if (STRONG_F.includes(ch)) { ns = -3; break; }
  }
  if (!ns) {
    for (const ch of given) {
      if (STRONG_M.includes(ch)) { ns = 3; break; }
    }
  }
  if (!ns) {
    let wf = 0;
    let wm = 0;
    for (const ch of given) {
      if (WEAK_F.includes(ch)) wf++;
      if (WEAK_M.includes(ch)) wm++;
    }
    ns = Math.max(-2, Math.min(2, wm - wf));
  }
  s += ns;

  // 5) 男先验：只在名字完全给不出线索时用。三字名在中文小说里多为男性（潘天耕 / 卫天望 / 何足道）
  if (!ns && !TITLE_F.some(w => nm.includes(w))) {
    if (nm.length >= 3) s += 1;
    // 「张三」「王五」这类排行称呼基本都是男性
    if (/[一二三四五六七八九十甲乙丙丁]$/.test(nm)) s += 2;
  }

  return s;
}

/** 子串出现次数，用于判断候选是否是真名（真名会在整章里反复出现） */
function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

/** 名字 → 稳定下标，保证同一角色每次拿到同一音色 */
export function stableHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100003;
  return h;
}

/**
 * 同一角色在「引号前 / 引号后」可能被截成不同长度（诸葛亮 / 葛亮）。
 * 差一个字且互为后缀时并到已登记的名字上。
 */
function canonical(name, order) {
  if (!name) return name;
  for (const n of order) {
    if (n === name) return n;
    if (n.length >= 2 && name.length >= 2
        && Math.abs(n.length - name.length) === 1
        && (n.endsWith(name) || name.endsWith(n) || n.startsWith(name) || name.startsWith(n))) {
      return n;                                     // 并到先登记的那个（郭襄心 → 郭襄）
    }
  }
  return name;
}

/**
 * 给角色挑一个音色，三级退让：
 *   1) 池里还有完全没人用的 → 用它（角色之间不撞）
 *   2) 池用尽了 → 至少避开旁白（角色撞角色，只是两个配角像同一人；
 *      角色撞旁白，会让人以为这一句是旁白在念叙述，破坏更大）
 *   3) 连旁白都避不开（池只有 1 个）→ 按 hash 起点稳定复用
 * @param {Set<string>} used 已被占用的音色（含旁白、已分配的角色）
 */
function pickVoice(name, pool, used, avoid) {
  if (!pool.length) return null;
  const start = stableHash(name) % pool.length;
  for (let k = 0; k < pool.length; k++) {
    const v = pool[(start + k) % pool.length];
    if (!used.has(v)) return v;
  }
  for (let k = 0; k < pool.length; k++) {
    const v = pool[(start + k) % pool.length];
    if (v !== avoid) return v;
  }
  return pool[start];
}

/* ---------------- 主入口 ---------------- */

/**
 * 为整章句子生成音色表。
 *
 * @param {string[]} sentences 章节句子（与阅读器高亮、进度索引一一对应）
 * @param {object} opt
 *   enabled       是否启用多角色（false 时全部返回 null）
 *   narration     旁白音色 id（角色音色不会与它相同）
 *   malePool/femalePool  音色池
 *   overrides     { 角色名: voiceId } 用户手动指定的映射
 * @returns {{voices:(string|null)[], roles:Array}}
 *   voices[i] === null 表示「跟随当前音色（旁白）」，非空为该句固定的角色音色
 */
export function buildVoices(sentences, opt = {}) {
  const list = Array.isArray(sentences) ? sentences : [];
  const voices = new Array(list.length).fill(null);
  if (!opt.enabled || !list.length) return { voices, roles: [] };

  const malePool = (opt.malePool && opt.malePool.length) ? opt.malePool : MALE_POOL;
  const femalePool = (opt.femalePool && opt.femalePool.length) ? opt.femalePool : FEMALE_POOL;
  const overrides = opt.overrides || {};
  const narration = opt.narration || '';
  const book = opt.book || null;    // 书级角色档案（rolebook.js），保证跨章同一角色同一声音

  const roles = new Map();          // name -> { name, gender, voiceId, count }
  const order = [];                 // 首次出场顺序
  const debug = opt.explain ? [] : null;
  const fullText = list.join('\n');  // 用于判断候选名字是否为真名
  const freqFilter = list.length >= 8;   // 句子太少时「出现次数」没有统计意义
  let lastSpeaker = '';
  let lastAt = -999;
  let unknownSeq = 0;

  for (let i = 0; i < list.length; i++) {
    const s = String(list[i] || '');
    if (!s || !hasQuote(s)) { lastAt = i; continue; }

    const parts = splitAtQuote(s);
    if (!parts) continue;

    // 引号里只有笑声/叹词（“哈哈、哈哈”），且前缀没有「某某说」的提示 →
    // 这是叙述里的拟声，不是台词。有提示语时不能跳（「李四回应道：“嗯。”」）
    if (isInterjection(s) && !SPEECH_VERBS.some(v => stripPunct(parts.prefix).includes(v))) {
      lastAt = i;
      continue;
    }

    const byPrefix = speakerFromPrefix(parts.prefix);
    const bySuffix = byPrefix ? '' : speakerFromSuffix(parts.suffix);
    let name = byPrefix || bySuffix;
    if (debug) debug.push({ i, text: s, prefix: parts.prefix, suffix: parts.suffix, byPrefix, bySuffix, name });

    // 代词对白：「他苦笑。」「她说。」按性别找最近的同性别角色
    if (!name) {
      const pre = stripPunct(parts.prefix);
      const suf = stripPunct(parts.suffix);
      const lead = (/^她/.test(pre) || /^她/.test(suf)) ? 'f'
        : ((/^他/.test(pre) || /^他/.test(suf)) ? 'm' : '');
      if (lead) {
        const last = lastSpeaker ? roles.get(lastSpeaker) : null;
        if (last && last.gender === lead) name = lastSpeaker;
        else {
          for (let k = order.length - 1; k >= 0; k--) {
            const r = roles.get(order[k]);
            if (r && r.gender === lead) { name = order[k]; break; }
          }
        }
        // 全书还没出现过对应性别的角色：给一个按性别固定的兜底身份
        if (!name) name = lead === 'f' ? '女声' : '男声';
      }
    }
    // 没有提示语（或是上一段台词的续句）：沿用上一位说话人。
    // 前缀里带说话动词却不给名字，说明这句是对白本身而非续句，交给后面归旁白。
    if (!name && lastSpeaker && i - lastAt <= CARRY_LIMIT
        && !SPEECH_VERBS.some(v => stripPunct(parts.prefix).includes(v))) {
      name = lastSpeaker;
    }
    // 兜底：给「无名对白」一个独立身份，按出场顺序区分不同声音
    if (!name) {
      const pre = stripPunct(parts.prefix) + stripPunct(parts.suffix);
      if (pre) continue;                       // 有旁白文字但提不到人 → 归旁白
      unknownSeq = (unknownSeq % 3) + 1;
      name = '旁白对话' + unknownSeq;           // 内部名，UI 会折叠显示
    }

    name = canonical(name, order);
    // 再和全书档案对一次名字：本章切出「郭襄心」而档案里是「郭襄」时并过去，
    // 否则同一个人会在不同章节拿到不同声音
    if (name && book && name !== '那人' && !/^旁白对话\d$/.test(name)) name = book.alias(name);
    // 只在整章出现一次的「名字」多半是从长句里误切的片段（郭襄心 / 暗自惊 / 道喝）。
    // 真名会反复出现；宁可退回旁白，也不要凭空多出一个抢音色的假角色。
    // 章节太短时统计不可靠（一句话的样本里谁都只出现一次），此时不做过滤。
    if (name && freqFilter && name !== '那人' && !/^旁白对话\d$/.test(name)
        && countOcc(fullText, name) < 2) {
      name = '';
    }
    if (debug && debug.length) debug[debug.length - 1].name = name;
    if (!name) continue;               // 判定为噪声：这一句归旁白

    let role = roles.get(name);
    // 性别证据：台词自称、紧邻代词、叙述身份名词、名字用字一起打分
    const gs = genderScore(name, {
      prefix: parts.prefix, suffix: parts.suffix, quote: quoteOf(s),
    });
    if (!role) {
      // 有全书档案时以「跨章累积证据」为准，单章几十句的证据太薄；
      // 没有档案时按本章证据判，判不出来默认男性 —— 中文小说里男性角色占绝大多数，
      // 而旧版「定不下来就男女交替」会让一半男角色拿到女声，这是最出戏的错误。
      const g = book ? book.genderOf(name, gs) : (gs < 0 ? 'f' : 'm');
      role = { name, gender: g, voiceId: null, count: 0, score: gs };
      if (order.length < MAX_ROLES) order.push(name);
      roles.set(name, role);
    } else {
      role.score += gs;
      role.gender = book ? book.genderOf(name, gs)
        : (role.score < 0 ? 'f' : (role.score > 0 ? 'm' : role.gender));
    }
    role.count++;
    lastSpeaker = name;
    lastAt = i;

    voices[i] = name;              // 先存名字，最后统一翻译成 voiceId
  }

  // 名字 → 音色：同性别角色之间也尽量不撞色（只避旁白不够，一章五六个角色时
  // 会出现三四个角色同一个声音，多角色就白做了）。撞不上才复用。
  const byName = new Map();
  const used = new Set();
  if (narration) used.add(narration);          // 旁白先占位，角色避开

  // 出场多的角色先挑：主角拿到更自然的音色
  const ranked = Array.from(roles.values()).sort((a, b) => b.count - a.count);
  // 1) 用户手动指定的优先落定，并把对应音色标记为已占用
  for (const r of ranked) {
    const ov = overrides[r.name];
    if (ov && ov !== 'default') { r.voiceId = ov; used.add(ov); byName.set(r.name, ov); }
  }
  // 2) 其余角色：有全书档案就查档案（换章不换声），没有就在本章现分
  for (const r of ranked) {
    if (byName.has(r.name)) continue;
    const pick = book
      ? book.voiceFor(r.name, r.gender, { malePool, femalePool, narration })
      : pickVoice(r.name, r.gender === 'f' ? femalePool : malePool, used, narration);
    r.voiceId = pick;
    if (pick) used.add(pick);
    byName.set(r.name, pick);
  }

  for (let i = 0; i < voices.length; i++) {
    const n = voices[i];
    voices[i] = n ? (byName.get(n) || null) : null;
  }

  const out = Array.from(roles.values())
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count);

  return { voices, roles: out, debug: debug || [] };
}

/** 角色名是否值得展示在面板里（无名对白折叠成一个） */
export function roleLabel(name) {
  return /^旁白对话\d$/.test(name) ? '未标注对白' : name;
}
