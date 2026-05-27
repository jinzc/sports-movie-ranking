import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'radar.config.json');
const FALLBACK_PATH = path.join(ROOT, 'config', 'fallback-sample.json');
const OUTPUT_DIR = path.join(ROOT, 'public', 'data');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'radar.json');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
const STOP_WORDS = new Set([
  '微博', '百度', '抖音', '知乎', '虎扑', 'B站', '哔哩哔哩', '豆瓣', '今日热榜', '热搜', '热榜', '话题', '视频', '网友',
  '相关', '回应', '为何', '怎么', '哪些', '一个', '可以', '已经', '正式', '最新', '突然', '真的', '原来', '今年', '今日', '今天', '昨天', '明天', '现在',
  '冠军', '比赛', '影视', '体育', '娱乐', '新闻', '热门', '论坛', '榜单', '讨论', '引发', '升温', '关注', '上榜', '榜首', '冲上', '登上', '进入',
  '数据', '官方', '平台', '开放', 'API', 'api', '全网', '阅读', '高效', '榜眼', '来源', '内容', '自动发现',
  '榜中榜', '热文库', '小部件', '公众号', '赞助商', '垂类热榜', '接口', '模板', '聚合页', '今日简报', '即时写作'
]);

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const startedAt = new Date();
  const statuses = [];
  const allItems = [];

  const activeSources = config.sources.filter(s => s.enabled !== false);
  const results = await Promise.all(activeSources.map(async source => {
    try {
      const items = await fetchSource(source, config.settings);
      const cleaned = items
        .map((item, index) => normalizeItem(item, source, index, startedAt, config.settings))
        .filter(item => isUsableTitle(item.title, config.settings));
      const deduped = dedupeItems(cleaned).slice(0, config.settings.maxItemsPerSource || 100);
      return { source, ok: true, items: deduped };
    } catch (error) {
      return { source, ok: false, error };
    }
  }));

  for (const result of results) {
    if (result.ok) {
      allItems.push(...result.items);
      statuses.push({ id: result.source.id, name: result.source.name, platform: result.source.platform, ok: true, count: result.items.length });
      console.log(`✓ ${result.source.name}: ${result.items.length}`);
    } else {
      statuses.push({ id: result.source.id, name: result.source.name, platform: result.source.platform, ok: false, count: 0, error: result.error.message });
      console.warn(`✗ ${result.source.name}: ${result.error.message}`);
    }
  }

  let usedFallback = false;
  let itemsForBuild = allItems;
  if (itemsForBuild.length === 0) {
    const fallback = JSON.parse(await fs.readFile(FALLBACK_PATH, 'utf8'));
    itemsForBuild = fallback.map((item, index) => ({
      ...item,
      id: `fallback-${index + 1}`,
      sourceId: `fallback-${item.platform}-${index + 1}`,
      sourceName: `${item.platform} · 示例`,
      channel: '示例',
      sourceWeight: 1,
      fetchedAt: startedAt.toISOString(),
      categoryHint: item.categoryHint || 'auto',
      isFallback: true
    }));
    usedFallback = true;
  }

  const categories = config.categories.map(category => buildCategoryLeaderboard(category, itemsForBuild, config.settings));
  const output = {
    meta: {
      siteTitle: config.settings.siteTitle,
      siteSubtitle: config.settings.siteSubtitle,
      timezone: config.settings.timezone,
      generatedAt: startedAt.toISOString(),
      generatedAtText: formatInTimezone(startedAt, config.settings.timezone),
      sourceCount: activeSources.length,
      okSourceCount: statuses.filter(s => s.ok).length,
      failedSourceCount: statuses.filter(s => !s.ok).length,
      itemCount: itemsForBuild.length,
      usedFallback,
      note: usedFallback
        ? '当前运行环境没有抓到外部数据，展示内置示例。部署到 GitHub 并运行 Actions 后会自动抓取真实热榜。'
        : '已过滤广告/API/榜单入口/频道页等无效标题，仅保留具体影视与体育事件话题。'
    },
    categories,
    sources: statuses,
    rawSample: itemsForBuild.slice(0, 30).map(x => ({ title: x.title, platform: x.platform, source: x.sourceName, rank: x.rank, url: x.url }))
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

function normalizeItem(item, source, index, startedAt, settings) {
  return {
    ...item,
    id: `${source.id}-${index + 1}`,
    sourceId: source.id,
    sourceName: source.name,
    platform: item.platform || source.platform,
    channel: source.channel,
    categoryHint: item.categoryHint || source.categoryHint || 'auto',
    sourceWeight: Number(source.weight || 1),
    rank: Number(item.rank || index + 1),
    title: cleanupTitle(item.title),
    description: cleanupDescription(item.description || ''),
    url: item.url || source.url,
    hot: item.hot || '',
    fetchedAt: startedAt.toISOString()
  };
}

async function fetchSource(source, settings) {
  const url = resolveUrl(source.url, settings);
  if (!url || url.includes('{')) throw new Error(`URL 未配置完整：${source.url}`);
  const body = await fetchText(url, settings.requestTimeoutMs || 18000);
  if (source.type === 'rss') return parseRss(body, source);
  if (source.type === 'html_rank') return parseRankHtml(body, source, settings);
  throw new Error(`不支持的来源类型：${source.type}`);
}

function resolveUrl(url, settings) {
  const rsshubBase = (process.env[settings.rsshubBaseEnv || 'RSSHUB_BASE'] || settings.defaultRsshubBase || 'https://rsshub.app').replace(/\/$/, '');
  return url.replaceAll('{RSSHUB_BASE}', rsshubBase);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        'Cache-Control': 'no-cache'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseRss(xml, source) {
  const blocks = [...xml.matchAll(/<item[\s\S]*?<\/item>/gi)].map(m => m[0]);
  const entries = blocks.length ? blocks : [...xml.matchAll(/<entry[\s\S]*?<\/entry>/gi)].map(m => m[0]);
  return entries.map((block, index) => {
    const title = cleanupTitle(decodeHtml(stripTags(pickXml(block, 'title'))));
    const link = decodeHtml(stripTags(pickXml(block, 'link'))).trim() || pickAtomLink(block) || source.url;
    const description = cleanupDescription(decodeHtml(stripTags(pickXml(block, 'description') || pickXml(block, 'summary') || pickXml(block, 'content:encoded'))));
    const hot = pickHeatText(`${title} ${description}`);
    return { title, description, url: link, rank: index + 1, platform: source.platform, hot };
  }).filter(item => item.title);
}

function pickXml(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const found = block.match(re);
  return found ? found[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '') : '';
}

function pickAtomLink(block) {
  const found = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return found ? found[1] : '';
}

function parseRankHtml(html, source, settings) {
  const items = [];
  const decoded = decodeHtml(html);
  const withoutNoise = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  // 1) 常见前端数据字段：title / word / name / label。
  const jsonTitleRe = /"(?:title|word|name|label)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let jsonMatch;
  let jsonRank = 1;
  while ((jsonMatch = jsonTitleRe.exec(decoded)) !== null) {
    const title = cleanupTitle(safeJsonString(jsonMatch[1]));
    if (isUsableTitle(title, settings)) items.push({ title, url: source.url, rank: jsonRank++ });
  }

  // 2) a 标签。优先抓长度像热榜标题的链接文本。
  const anchorRe = /<a\b([^>]*)>([\s\S]{0,700}?)<\/a>/gi;
  let anchorMatch;
  let anchorRank = 1;
  while ((anchorMatch = anchorRe.exec(withoutNoise)) !== null) {
    const attrs = anchorMatch[1] || '';
    const href = absolutize((attrs.match(/href=["']([^"']+)["']/i) || [])[1] || '', source.url);
    const text = cleanupTitle(stripTags(anchorMatch[2]));
    if (isUsableTitle(text, settings)) items.push({ title: text, url: href || source.url, rank: anchorRank++ });
  }

  // 3) 行文本兜底：只接受带序号或明显热榜标题的行，过滤站点模板。
  const lineText = withoutNoise
    .replace(/<\/(li|tr|div|p|h\d|a|td|span)>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = lineText.split(/\n+/).map(cleanupTitle).filter(Boolean);
  let rank = 1;
  for (const line of lines) {
    const normalized = line.replace(/^\s*(No\.?\s*)?/, '');
    const match = normalized.match(/^(\d{1,3})[\.、\)）\s]+(.{2,100})$/i);
    const title = cleanupTitle(match ? match[2] : line);
    if (!match && !looksLikeChineseHeadline(title)) continue;
    if (isUsableTitle(title, settings)) items.push({ title, url: source.url, rank: match ? Number(match[1]) : rank++ });
  }

  return dedupeItems(items)
    .filter(item => isUsableTitle(item.title, settings))
    .slice(0, 120)
    .map((item, index) => ({ ...item, rank: item.rank || index + 1, platform: source.platform }));
}

function isTemplateOrServiceTitle(title, settings = {}) {
  const t = cleanupTitle(title);
  if (!t) return true;
  const lower = t.toLowerCase();
  const hard = settings.hardBlockTerms || [];
  if (hard.some(term => term && lower.includes(String(term).toLowerCase()))) return true;
  if (/榜眼|垂类热榜|榜中榜|热文库|小部件|赞助商|公众号|今日简报|即时写作|让每个人都可以自信地写作|人工智能让每个人|开放平台|数据\s*API|API\s*开放|接口服务|商业合作|广告合作|免责声明|隐私政策|用户协议/i.test(t)) return true;
  if (/^(榜中榜|热文库|小部件|公众号|赞助商|更多|首页|登录|注册|下载|开发者|文档)$/i.test(t)) return true;
  if (isBroadRankingTitle(t)) return true;
  return false;
}

// 这类标题看起来命中了“影视/体育”关键词，但本质是榜单入口、频道页、论坛入口，
// 不是可以给运营做选题的具体话题，必须直接排除。
function isBroadRankingTitle(title) {
  const t = cleanupTitle(title);
  if (!t) return true;
  const compact = t.replace(/\s+/g, '');

  // 平台名 + 榜单/频道名，例如：百度视频 · 热门电视剧榜、微博 · 电影榜、虎扑社区 · NBA论坛热帖。
  if (/^(微博|新浪微博|百度|百度视频|百度贴吧|好看视频|虎扑|虎扑社区|B站|哔哩哔哩|bilibili|抖音|快手|知乎|豆瓣|猫眼|灯塔|懂球帝|小红书|微信|公众号)[\s·\-_:：｜|]+.*(榜|榜单|排行|排行榜|热帖|论坛热帖|空间|热门新闻|今日头条)$/i.test(t)) return true;

  // 频道入口/榜单入口，没有具体人物、作品、比赛或事件。
  if (/(热门电视剧榜|热门电影榜|热门综艺榜|今日热播榜|电影榜|电视剧榜|综艺榜|文娱榜|娱乐榜|体育榜|话题榜|热搜榜|热议榜|实时热点|排行榜|榜单|论坛热帖|社区热帖|bilibili空间|BILIBILI空间)$/i.test(t)) return true;
  if (/^(电影|电视剧|剧集|综艺|文娱|娱乐|体育|足球|篮球|NBA|CBA|中国足球|国际足球|中超|国足)(榜|热榜|榜单|排行|排行榜|论坛热帖|热帖|社区)$/i.test(compact)) return true;
  if (/^.*的?bilibili空间$/i.test(t)) return true;
  if (/^(百度视频|好看视频|虎扑社区|虎扑|微博|抖音|B站|知乎|豆瓣|懂球帝)[·\s-]*(电影|电视剧|综艺|体育|足球|篮球|NBA|CBA)?.*(榜|热帖)$/i.test(t)) return true;

  return false;
}

function isConcreteTopicTitle(title, category, settings = {}) {
  const t = cleanupTitle(title);
  if (!isUsableTitle(t, settings)) return false;
  if (isBroadRankingTitle(t)) return false;

  const compact = t.replace(/\s+/g, '');
  const hasQuotedWork = /《[^》]{2,30}》/.test(t);
  const hasHashtag = /#[^#\s]{2,36}#/.test(t);
  const concreteAction = /(战胜|击败|不敌|绝杀|逆转|晋级|出局|夺冠|卫冕|淘汰|受伤|复出|退役|转会|签约|续约|交易|裁掉|官宣|定档|改档|撤档|上映|开播|收官|大结局|杀青|开机|发布|预告|路透|海报|票房|破亿|开分|入围|获奖|提名|回应|道歉|发文|声明|辟谣|争议|翻车|爆料|曝光|确认|公布|缺席|停赛|禁赛|复盘|赛后|赛前)/u.test(t);
  const hasScoreOrGame = /\b(G[1-7]|[0-9]+[-:：比][0-9]+|[0-9]+分|[0-9]+球|[0-9]+连胜|[0-9]+连败)\b/i.test(t);
  const hasSportsEntity = /(湖人|勇士|快船|太阳|凯尔特人|尼克斯|骑士|独行侠|森林狼|雷霆|马刺|掘金|火箭|国足|申花|海港|国安|泰山|蓉城|皇马|巴萨|曼城|曼联|利物浦|阿森纳|拜仁|巴黎|国米|米兰|尤文|郑钦文|德约|辛纳|詹姆斯|库里|杜兰特|约基奇|东契奇|亚历山大|布伦森|文班亚马|梅西|C罗|姆巴佩|哈兰德)/iu.test(t);
  const hasFilmEntity = hasQuotedWork || /(导演|主演|主创|演员|女主|男主|角色|片方|剧方|节目组|工作室|白玉兰|金鸡|百花|奥斯卡|戛纳|春节档|暑期档|国庆档|五一档|贺岁档)/u.test(t);

  // 去掉平台名和泛化词后，如果几乎没有剩余信息，就不是具体话题。
  const residue = compact
    .replace(/^(微博|新浪微博|百度|百度视频|百度贴吧|好看视频|虎扑|虎扑社区|B站|哔哩哔哩|bilibili|抖音|快手|知乎|豆瓣|猫眼|灯塔|懂球帝|小红书)[·:：-]?/i, '')
    .replace(/(热门|今日|实时|最新|全站|垂类|相关|话题|热搜|热榜|榜单|排行|排行榜|热议|讨论|论坛|社区|空间|频道|入口|视频|新闻|头条|内容|来源)/g, '')
    .replace(/(电影|电视剧|剧集|综艺|文娱|娱乐|体育|足球|篮球|NBA|CBA|中超|国足|欧冠|世界杯)/gi, '')
    .trim();
  if (residue.length <= 2 && !hasQuotedWork && !hasHashtag && !concreteAction) return false;

  if (category?.id === 'film') return hasQuotedWork || hasHashtag || concreteAction || hasFilmEntity;
  if (category?.id === 'sports') return hasHashtag || concreteAction || hasScoreOrGame || hasSportsEntity;
  return hasQuotedWork || hasHashtag || concreteAction || hasScoreOrGame || hasSportsEntity || hasFilmEntity;
}

function isUsableTitle(title, settings = {}) {
  const t = cleanupTitle(title);
  if (!t || t.length < 3 || t.length > 90) return false;
  if (isTemplateOrServiceTitle(t, settings)) return false;
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return false;
  if (/^(首页|登录|注册|下载|更多|关于我们|用户中心|夜间模式|订阅|设置|开发者|文档|App|API|今日热榜|热搜榜|话题榜|实时热点)$/i.test(t)) return false;
  if (/^[\d\s\.、#\-]+$/.test(t)) return false;
  if ((settings.hardBlockTerms || []).some(term => term && t.toLowerCase().includes(String(term).toLowerCase()))) return false;
  const genericHits = (settings.genericBlockTerms || []).filter(term => t.toLowerCase().includes(String(term).toLowerCase())).length;
  const hasSpecificSignal = /《[^》]{2,30}》|#[^#\s]{2,36}#|战胜|击败|晋级|夺冠|淘汰|官宣|定档|上映|开播|收官|发布|预告|票房|破亿|开分|MVP|转会|受伤|退役|回应|争议|NBA|CBA|LPL|KPL|WTT|世界杯|欧冠|中超|国足|电影|电视剧|剧集|综艺|演员|导演|主演|总决赛|季后赛|奥运|网球|足球|篮球/i.test(t);
  if (genericHits >= 2 && !hasSpecificSignal) return false;
  if (/榜眼|开放平台|数据\s*API|API\s*开放|总结全网|今日简报|赛博修行|解压神器/i.test(t)) return false;
  return true;
}

function looksLikeChineseHeadline(title) {
  if (!title || title.length < 6 || title.length > 70) return false;
  if (!/[\u4e00-\u9fa5]/.test(title)) return false;
  const badPunctuation = (title.match(/[{}<>]/g) || []).length;
  return badPunctuation === 0;
}

function buildCategoryLeaderboard(category, allItems, settings) {
  const clusters = [];
  const acceptedItems = [];
  for (const item of allItems) {
    const match = categoryMatch(category, item, settings);
    if (!match.ok) continue;
    const enriched = enrichItem(item, category, match, settings);
    if (!enriched.topicTitle || !isUsableTitle(enriched.topicTitle, settings)) continue;
    acceptedItems.push(enriched);
    addItemToCluster(clusters, enriched, category, settings);
  }

  const maxRaw = Math.max(1, ...clusters.map(c => c.rawScore));
  const topics = clusters
    .map(cluster => finalizeCluster(cluster, maxRaw, settings))
    .filter(topic => topic.score >= (settings.minTopicScore || 18) || topic.itemCount >= 2)
    .sort((a, b) => b.score - a.score || b.itemCount - a.itemCount || a.title.localeCompare(b.title, 'zh-CN'))
    .slice(0, settings.maxTopicsPerCategory || 40)
    .map((topic, index) => ({ ...topic, rank: index + 1 }));

  return { id: category.id, label: category.label, emoji: category.emoji, itemCount: acceptedItems.length, topicCount: topics.length, topics };
}

function categoryMatch(category, item, settings) {
  const text = `${item.title} ${item.description || ''}`;
  const hint = String(item.categoryHint || '').toLowerCase();
  const isHinted = hint === category.id || hint === String(category.label).toLowerCase() || hint === category.label;
  const matchedTerms = findMatchedTerms(text, category.includeTerms || []);
  const matchedSeedTerms = [];
  for (const seed of category.topicSeeds || []) {
    matchedSeedTerms.push(...findMatchedTerms(text, seed.aliases || []).map(term => ({ term, family: seed.label })));
  }
  const positiveCount = matchedTerms.length + matchedSeedTerms.length;
  const hasQuotedFilmSignal = category.id === 'film' && /《[^》]{2,30}》/.test(text);
  const hasStrongSignal = positiveCount > 0 || hasQuotedFilmSignal;

  // v3 修复：不能因为来源是“文娱榜/体育榜”就全量收录。
  // TopHub 页面里会混入“榜中榜、热文库、公众号、小部件、赞助商、API开放平台”等站点模板文本。
  // 因此所有候选标题都必须命中影视/体育词库，或具备片名《》这类强信号，才进入榜单。
  const ok = hasStrongSignal
    && !isTemplateOrServiceTitle(text, settings)
    && isConcreteTopicTitle(item.title, category, settings);
  return { ok, isHinted, matchedTerms, matchedSeedTerms, positiveCount };
}

function enrichItem(item, category, match, settings) {
  const text = `${item.title} ${item.description || ''}`;
  const hashtags = extractHashtags(text);
  const quoted = extractQuotedTitles(text);
  const familyScores = new Map();
  for (const seed of category.topicSeeds || []) {
    const hits = findMatchedTerms(text, seed.aliases || []);
    if (hits.length) familyScores.set(seed.label, hits.length);
  }
  const family = [...familyScores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '自动发现';
  const relatedTerms = unique([
    ...quoted,
    ...match.matchedTerms,
    ...match.matchedSeedTerms.map(x => x.term),
    ...hashtags,
    ...extractKeywords(text, [...(category.includeTerms || []), ...flattenSeedAliases(category)])
  ]).filter(term => !isBadRelatedTerm(term, settings));
  const topicTitle = chooseTopicTitle(item.title, relatedTerms, family, settings);
  const itemScore = scoreItem(item, relatedTerms, match);
  return { ...item, topicTitle, family, relatedTerms, itemScore };
}

function flattenSeedAliases(category) {
  return (category.topicSeeds || []).flatMap(seed => seed.aliases || []);
}

function chooseTopicTitle(title, terms, family, settings) {
  const hashtags = extractHashtags(title).filter(tag => tag.length >= 3 && tag.length <= 28 && !isBadRelatedTerm(tag, settings));
  if (hashtags.length) return hashtags[0];
  const quoted = extractQuotedTitles(title).filter(q => q.length >= 2 && q.length <= 24);
  let cleaned = cleanupTitle(title)
    .replace(/^(网传|曝|媒体：|官方：|热议：|话题：|现场：|突发：|独家：|组图：)/, '')
    .replace(/(冲上热搜|登上热搜|引热议|引发热议|相关讨论|话题升温|上榜|热度上升).*$/u, '')
    .trim();
  if (quoted.length && cleaned.length > 32) {
    const q = quoted[0];
    const around = cleaned.match(new RegExp(`.{0,10}${escapeRegExp(q)}.{0,14}`));
    if (around) cleaned = around[0];
  }
  const pieces = cleaned.split(/[，。！？、；;:：|｜]/).map(x => cleanupTitle(x)).filter(x => x.length >= 4 && isUsableTitle(x, settings));
  let best = pieces.find(p => terms.some(t => p.includes(t))) || pieces[0] || cleaned;
  best = best.replace(/^(\d+\s*)/, '').trim();
  if (best.length > 34) best = best.slice(0, 33) + '…';
  if (best.length < 4) return '';
  if (isTemplateOrServiceTitle(best, settings) || isBroadRankingTitle(best)) return '';
  return cleanupTitle(best);
}

function scoreItem(item, relatedTerms, match) {
  const rank = Number(item.rank || 99);
  const rankBoost = Math.max(0.25, (110 - Math.min(rank, 110)) / 50);
  const hotBoost = parseHeat(item.hot || item.description || '') || 0;
  const termBoost = Math.min(2.4, relatedTerms.length * 0.14);
  const hintedBoost = match.isHinted ? 0.35 : 0;
  const strongBoost = match.positiveCount >= 2 ? 0.22 : 0;
  return Number(item.sourceWeight || 1) * (1 + rankBoost + hotBoost + termBoost + hintedBoost + strongBoost);
}

function addItemToCluster(clusters, item, category, settings) {
  const key = normalizeKey(item.topicTitle);
  let target = clusters.find(cluster => areSimilarTopics(cluster.key, key, cluster.title, item.topicTitle, item));
  if (!target) {
    target = {
      key,
      title: item.topicTitle,
      family: item.family,
      rawScore: 0,
      itemCount: 0,
      sourceIds: new Set(),
      platforms: new Map(),
      related: new Map(),
      samples: [],
      sampleKeys: new Set(),
      itemKeys: new Set(),
      families: new Map()
    };
    clusters.push(target);
  }

  // v5 修复：同一个热词常会同时出现在微博热搜、微博文娱榜、RSSHub、TopHub 等多个入口。
  // 之前只做了“同一来源内去重”，没有在同一话题卡片里继续去重，所以底部样本会重复显示。
  // 这里按“标题核心 + 平台”去重：同一平台同一标题只计一次、只展示一次；
  // 但仍保留 sourceIds，用于判断这个话题来自几个来源入口。
  target.sourceIds.add(item.sourceId);
  const itemKey = makeSampleKey(item);
  const isNewItem = !target.itemKeys.has(itemKey);

  if (isNewItem) {
    target.itemKeys.add(itemKey);
    target.rawScore += item.itemScore;
    target.itemCount += 1;
    target.platforms.set(item.platform, (target.platforms.get(item.platform) || 0) + 1);
    target.families.set(item.family, (target.families.get(item.family) || 0) + 1);
    for (const term of item.relatedTerms) {
      if (isBadRelatedTerm(term, settings)) continue;
      target.related.set(term, (target.related.get(term) || 0) + 1);
    }
  }

  const sampleKey = makeSampleKey(item);
  if (isNewItem && !target.sampleKeys.has(sampleKey) && target.samples.length < (settings.topicSampleLimit || 8)) {
    target.sampleKeys.add(sampleKey);
    target.samples.push({ title: item.title, platform: item.platform, sourceName: item.sourceName, channel: item.channel, url: item.url, rank: item.rank, isFallback: item.isFallback || false });
  }
}

function makeSampleKey(item) {
  const titleKey = normalizeKey(item.title)
    .replace(/冲上热搜|登上热搜|引热议|引发热议|相关讨论|话题升温|上榜|热度上升/g, '')
    .trim();
  return `${String(item.platform || '').toLowerCase()}|${titleKey}`;
}

function areSimilarTopics(keyA, keyB, titleA, titleB) {
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  if (keyA.length >= 6 && keyB.length >= 6 && (keyA.includes(keyB) || keyB.includes(keyA))) return true;
  const tokensA = topicTokens(titleA);
  const tokensB = topicTokens(titleB);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const shared = tokensA.filter(t => tokensB.includes(t)).length;
  const ratio = shared / Math.min(tokensA.length, tokensB.length);
  return shared >= 2 && ratio >= 0.5;
}

function topicTokens(title) {
  return unique([...extractQuotedTitles(title), ...extractKeywords(title, []), ...((String(title).match(/[A-Za-z0-9]{2,}/g) || []).map(x => x.toUpperCase()))])
    .filter(t => !STOP_WORDS.has(t) && t.length >= 2);
}

function finalizeCluster(cluster, maxRaw, settings) {
  const platformDiversity = Math.max(0, cluster.platforms.size - 1) * 4;
  const sourceDiversity = Math.max(0, cluster.sourceIds.size - 1) * 3;
  const score = Math.min(100, Math.round((cluster.rawScore / maxRaw) * 78 + platformDiversity + sourceDiversity + Math.min(10, cluster.itemCount * 1.4)));
  const family = [...cluster.families.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || cluster.family;
  const relatedWords = [...cluster.related.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term]) => term)
    .filter(term => !isBadRelatedTerm(term, settings))
    .slice(0, settings.relatedWordLimit || 42);
  const platforms = [...cluster.platforms.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  return {
    title: cluster.title,
    family,
    score,
    heatLevel: score >= 80 ? '高' : score >= 60 ? '中高' : score >= 36 ? '中' : '低',
    itemCount: cluster.itemCount,
    sourceCount: cluster.sourceIds.size,
    platforms,
    relatedWords,
    reason: makeReason(family, platforms, relatedWords, cluster.itemCount),
    samples: cluster.samples
  };
}

function makeReason(family, platforms, relatedWords, count) {
  const platformText = platforms.slice(0, 3).map(p => p.name).join('、') || '多个来源';
  const words = relatedWords.slice(0, 8).join('、');
  return `${platformText}等来源出现 ${count} 条相关内容，归入「${family}」方向；关联词包括：${words || '暂无'}。`;
}

function findMatchedTerms(text, terms) {
  const lower = String(text || '').toLowerCase();
  const result = [];
  for (const term of terms || []) {
    const value = String(term || '').trim();
    if (!value) continue;
    if (lower.includes(value.toLowerCase())) result.push(value);
  }
  return unique(result);
}

function extractHashtags(text) {
  const matches = String(text || '').match(/#[^#\s]{2,36}#/g) || [];
  return unique(matches.map(x => x.replace(/^#|#$/g, '').trim()).filter(Boolean));
}

function extractQuotedTitles(text) {
  const matches = [...String(text || '').matchAll(/《([^》]{2,30})》/g)].map(m => m[1].trim());
  return unique(matches);
}

function extractKeywords(text, dictionaryTerms) {
  const value = String(text || '');
  const dictHits = findMatchedTerms(value, dictionaryTerms || []);
  const quoted = extractQuotedTitles(value);
  const ascii = (value.match(/[A-Za-z]{2,}[A-Za-z0-9-]*/g) || []).map(s => s.toUpperCase());
  const chunks = value
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/《[^》]+》/g, ' ')
    .replace(/[“”"'（）()【】\[\]{}]/g, ' ')
    .split(/[\s，。！？、；;:：|｜\/\\·…~!@#$%^&*+=<>]+/)
    .map(x => x.trim())
    .filter(x => x.length >= 2 && x.length <= 18)
    .filter(x => /[\u4e00-\u9fa5A-Za-z0-9]/.test(x))
    .filter(x => !/^\d+$/.test(x))
    .filter(x => !STOP_WORDS.has(x));
  const named = [];
  for (const chunk of chunks) {
    if (/[A-Za-z]/.test(chunk) && chunk.length <= 14) named.push(chunk.toUpperCase());
    else if (/^[\u4e00-\u9fa5A-Za-z0-9]{2,18}$/.test(chunk)) named.push(chunk);
  }
  return unique([...quoted, ...dictHits, ...ascii, ...named]).slice(0, 48);
}

function isBadRelatedTerm(term, settings = {}) {
  const t = String(term || '').trim();
  if (!t || t.length < 2 || t.length > 24) return true;
  if (STOP_WORDS.has(t)) return true;
  if (/^\d+$/.test(t)) return true;
  if ((settings.hardBlockTerms || []).some(block => t.toLowerCase().includes(String(block).toLowerCase()))) return true;
  if (/榜眼|垂类热榜|榜中榜|热文库|小部件|赞助商|公众号|API|开放平台|总结全网|今日简报|即时写作|赛博|解压神器|让阅读更高效|让每个人都可以自信地写作/i.test(t)) return true;
  return false;
}

function parseHeat(value) {
  const s = String(value || '');
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(亿|万)?/);
  if (!m) return 0;
  let n = Number(m[1]);
  if (m[2] === '亿') n *= 10000;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1.4, Math.log10(n + 1) / 4);
}

function pickHeatText(text) {
  const m = String(text || '').match(/[0-9]+(?:\.[0-9]+)?\s*(?:亿|万)?/);
  return m ? m[0] : '';
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const title = cleanupTitle(item.title);
    const key = normalizeKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...item, title });
  }
  return result;
}

function cleanupTitle(value) {
  return decodeHtml(String(value || ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\d\s\.、#\-—_]+/, '')
    .replace(/[\s·|｜_-]*(热|新|爆|荐|顶|沸|精|广告)$/u, '')
    .trim();
}

function cleanupDescription(value) {
  return cleanupTitle(value).slice(0, 240);
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[《》“”"'（）()【】\[\]{}#\s\-—_·.,，。！!？?、:：;；|｜/\\]/g, '')
    .replace(/相关话题|引热议|引发热议|冲上热搜|登上热搜|回应|官宣|热议/g, '')
    .trim();
}

function safeJsonString(value) {
  try { return JSON.parse(`"${value}"`); } catch { return value; }
}

function absolutize(href, base) {
  if (!href) return base;
  try { return new URL(href, base).toString(); } catch { return base; }
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

function decodeHtml(input) {
  return String(input || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(arr) {
  return [...new Set((arr || []).map(x => String(x || '').trim()).filter(Boolean))];
}

function formatInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(date);
}

main().catch(async error => {
  console.error(error);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify({
    meta: {
      siteTitle: '影视体育话题雷达',
      generatedAt: new Date().toISOString(),
      generatedAtText: new Date().toLocaleString('zh-CN'),
      usedFallback: true,
      note: `更新失败：${error.message}`
    },
    categories: [],
    sources: []
  }, null, 2));
  process.exitCode = 1;
});
