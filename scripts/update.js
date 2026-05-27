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

const STOP_WORDS = new Set([
  '微博', '百度', '抖音', '知乎', '虎扑', 'B站', '哔哩哔哩', '豆瓣', '今日热榜', '热搜', '热榜', '话题', '视频', '网友',
  '相关', '回应', '为何', '怎么', '哪些', '一个', '可以', '已经', '正式', '最新', '突然', '真的', '原来', '今年', '今日', '今天', '昨天', '明天', '现在',
  '冠军', '比赛', '影视', '体育', '娱乐', '新闻', '热门', '论坛', '榜单', '讨论', '引发', '升温', '关注', '上榜', '榜首', '冲上'
]);

const USER_AGENT = 'Mozilla/5.0 (compatible; TopicRadarBot/2.0; +https://github.com/)';

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const startedAt = new Date();
  const statuses = [];
  const allItems = [];

  const activeSources = config.sources.filter(s => s.enabled !== false);
  const sourceResults = await Promise.all(activeSources.map(async source => {
    try {
      const items = await fetchSource(source, config.settings);
      const normalized = items.slice(0, config.settings.maxItemsPerSource || 80).map((item, index) => ({
        ...item,
        id: `${source.id}-${index + 1}`,
        sourceId: source.id,
        sourceName: source.name,
        platform: item.platform || source.platform,
        channel: source.channel,
        sourceWeight: Number(source.weight || 1),
        categoryHint: item.categoryHint || source.categoryHint || 'auto',
        rank: Number(item.rank || index + 1),
        fetchedAt: startedAt.toISOString()
      })).filter(item => item.title && item.title.trim().length >= 2);
      return { source, ok: true, items: normalized };
    } catch (error) {
      return { source, ok: false, error };
    }
  }));

  for (const result of sourceResults) {
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
  if (allItems.length === 0) {
    const fallback = JSON.parse(await fs.readFile(FALLBACK_PATH, 'utf8'));
    fallback.forEach((item, index) => allItems.push({
      ...item,
      id: `fallback-${index + 1}`,
      sourceId: `fallback-${index + 1}`,
      sourceName: `${item.platform} · 示例`,
      channel: '示例',
      sourceWeight: 1,
      fetchedAt: startedAt.toISOString(),
      isFallback: true
    }));
    usedFallback = true;
  }

  const categories = config.categories.map(category => buildCategoryLeaderboard(category, allItems, config.settings));
  const output = {
    meta: {
      siteTitle: config.settings.siteTitle,
      siteSubtitle: config.settings.siteSubtitle,
      timezone: config.settings.timezone,
      generatedAt: startedAt.toISOString(),
      generatedAtText: formatInTimezone(startedAt, config.settings.timezone),
      sourceCount: config.sources.filter(s => s.enabled !== false).length,
      okSourceCount: statuses.filter(s => s.ok).length,
      failedSourceCount: statuses.filter(s => !s.ok).length,
      itemCount: allItems.length,
      usedFallback,
      note: usedFallback ? '当前运行环境无法访问外部来源，已展示示例数据。部署到 GitHub 后，Actions 会自动抓取真实数据。' : '数据由程序自动更新，热度分为相对值，适合运营选题参考。'
    },
    categories,
    sources: statuses,
    rawSample: allItems.slice(0, 20).map(item => ({ title: item.title, platform: item.platform, url: item.url, rank: item.rank }))
  };

  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

async function fetchSource(source, settings) {
  const url = resolveUrl(source.url, settings);
  if (!url || url.includes('{')) throw new Error(`URL 未配置完整：${source.url}`);
  const body = await fetchText(url, settings.requestTimeoutMs || 16000);
  if (source.type === 'rss') return parseRss(body, source);
  if (source.type === 'html_rank') return parseRankHtml(body, source);
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
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7'
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
    const title = decodeHtml(stripTags(pickXml(block, 'title'))).trim();
    const link = decodeHtml(stripTags(pickXml(block, 'link'))).trim() || pickAtomLink(block) || source.url;
    const description = decodeHtml(stripTags(pickXml(block, 'description') || pickXml(block, 'summary') || pickXml(block, 'content:encoded'))).trim();
    return { title, description, url: link, rank: index + 1, platform: source.platform };
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

function parseRankHtml(html, source) {
  const text = decodeHtml(html);
  const items = [];

  const jsonLikeTitles = [...text.matchAll(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .map((m, index) => ({ title: safeJsonString(m[1]), url: source.url, rank: index + 1 }));
  items.push(...jsonLikeTitles);

  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,500}?)<\/a>/gi;
  let anchorMatch;
  let anchorRank = 1;
  while ((anchorMatch = anchorRe.exec(html)) !== null) {
    const href = absolutize(anchorMatch[1], source.url);
    const title = cleanupTitle(decodeHtml(stripTags(anchorMatch[2])));
    if (isLikelyRankTitle(title)) {
      items.push({ title, url: href, rank: anchorRank++ });
    }
  }

  const lineText = decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(li|tr|div|p|h\d|a)>/gi, '\n')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
  const lines = lineText.split(/\n+/).map(cleanupTitle).filter(Boolean);
  let rank = 1;
  for (const line of lines) {
    const match = line.match(/^(?:No\.?\s*)?(\d{1,3})[\.、\s]+(.{2,120})$/i);
    const title = cleanupTitle(match ? match[2] : line);
    if (isLikelyRankTitle(title)) items.push({ title, url: source.url, rank: match ? Number(match[1]) : rank++ });
  }

  return dedupeItems(items)
    .filter(item => item.title.length >= 2 && item.title.length <= 90)
    .slice(0, 100)
    .map((item, index) => ({ ...item, rank: item.rank || index + 1, platform: source.platform }));
}

function safeJsonString(value) {
  try { return JSON.parse(`"${value}"`); } catch { return value; }
}

function absolutize(href, base) {
  try { return new URL(href, base).toString(); } catch { return base; }
}

function cleanupTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/^[\d\s\.、#-]+/, '')
    .replace(/[\s·|_-]*(热|新|爆|荐|顶|沸|精|广告)$/u, '')
    .trim();
}

function isLikelyRankTitle(title) {
  if (!title) return false;
  if (title.length < 3 || title.length > 90) return false;
  if (/^(首页|登录|注册|下载|更多|关于我们|用户中心|夜间模式|订阅|设置|开发者|App|API|今日热榜)$/i.test(title)) return false;
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(title)) return false;
  return true;
}

function dedupeItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = normalizeKey(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ ...item, title: cleanupTitle(item.title) });
  }
  return result;
}

function buildCategoryLeaderboard(category, allItems, settings) {
  const clusters = [];
  const categoryItems = [];
  for (const item of allItems) {
    const match = categoryMatch(category, item);
    if (!match.ok) continue;
    const enriched = enrichItem(item, category, match);
    categoryItems.push(enriched);
    addItemToCluster(clusters, enriched, category);
  }

  const maxRaw = Math.max(1, ...clusters.map(c => c.rawScore));
  const topics = clusters
    .map(cluster => finalizeCluster(cluster, maxRaw))
    .filter(topic => topic.score >= (settings.minTopicScore || 0.6) * 10 || topic.itemCount > 1)
    .sort((a, b) => b.score - a.score || b.itemCount - a.itemCount)
    .slice(0, settings.maxTopicsPerCategory || 30)
    .map((topic, index) => ({ ...topic, rank: index + 1 }));

  return {
    id: category.id,
    label: category.label,
    emoji: category.emoji,
    itemCount: categoryItems.length,
    topicCount: topics.length,
    topics
  };
}

function categoryMatch(category, item) {
  const text = `${item.title} ${item.description || ''}`;
  const hint = String(item.categoryHint || '').toLowerCase();
  const isHinted = hint === category.id || hint === category.label.toLowerCase() || hint === category.label;
  const matchedTerms = findMatchedTerms(text, category.includeTerms || []);
  const matchedSeedTerms = [];
  for (const seed of category.topicSeeds || []) {
    matchedSeedTerms.push(...findMatchedTerms(text, seed.aliases || []).map(term => ({ term, family: seed.label })));
  }
  return {
    ok: isHinted || matchedTerms.length > 0 || matchedSeedTerms.length > 0,
    isHinted,
    matchedTerms,
    matchedSeedTerms
  };
}

function enrichItem(item, category, match) {
  const text = `${item.title} ${item.description || ''}`;
  const hashtags = extractHashtags(text);
  const terms = [
    ...match.matchedTerms,
    ...match.matchedSeedTerms.map(x => x.term),
    ...hashtags,
    ...extractChineseKeywords(text, category.includeTerms)
  ];
  const familyScores = new Map();
  for (const seed of category.topicSeeds || []) {
    const count = findMatchedTerms(text, seed.aliases || []).length;
    if (count > 0) familyScores.set(seed.label, count);
  }
  const family = [...familyScores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '自动发现';
  const title = chooseTopicTitle(item.title, terms, family);
  const score = scoreItem(item, terms, match);
  return { ...item, topicTitle: title, family, relatedTerms: unique(terms), itemScore: score };
}

function chooseTopicTitle(title, terms, family) {
  const hashtags = extractHashtags(title).filter(tag => tag.length >= 3 && tag.length <= 24);
  if (hashtags.length) return hashtags[0].replace(/^#|#$/g, '');
  let cleaned = cleanupTitle(title)
    .replace(/^(网传|曝|媒体：|官方：|热议：|话题：|现场：|突发：)/, '')
    .replace(/(冲上热搜|登上热搜|引热议|引发热议|相关讨论|话题升温|上榜).*$/, '')
    .trim();
  const pieces = cleaned.split(/[，。！？、；;:：|｜]/).map(x => x.trim()).filter(x => x.length >= 4);
  let best = pieces.find(p => terms.some(t => p.includes(t))) || pieces[0] || cleaned;
  if (best.length > 32) best = best.slice(0, 31) + '…';
  if (best.length < 4 && family !== '自动发现') best = `${family}相关话题`;
  return best;
}

function scoreItem(item, relatedTerms, match) {
  const rank = Number(item.rank || 99);
  const rankBoost = Math.max(0.18, (90 - Math.min(rank, 90)) / 45);
  const hotBoost = parseHeat(item.hot || item.description || '') || 0;
  const termBoost = Math.min(2.2, relatedTerms.length * 0.16);
  const hintedBoost = match.isHinted ? 0.55 : 0;
  return (Number(item.sourceWeight || 1) * (1 + rankBoost + hotBoost + termBoost + hintedBoost));
}

function parseHeat(value) {
  const s = String(value || '');
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(亿|万)?/);
  if (!m) return 0;
  let n = Number(m[1]);
  if (m[2] === '亿') n *= 10000;
  if (m[2] === '万') n *= 1;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1.4, Math.log10(n + 1) / 4);
}

function addItemToCluster(clusters, item, category) {
  const key = normalizeKey(item.topicTitle);
  let target = clusters.find(cluster => areSimilarTopics(cluster.key, key, cluster.title, item.topicTitle));
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
      families: new Map()
    };
    clusters.push(target);
  }
  target.rawScore += item.itemScore;
  target.itemCount += 1;
  target.sourceIds.add(item.sourceId);
  target.platforms.set(item.platform, (target.platforms.get(item.platform) || 0) + 1);
  target.families.set(item.family, (target.families.get(item.family) || 0) + 1);
  for (const term of item.relatedTerms) {
    if (!term || STOP_WORDS.has(term)) continue;
    target.related.set(term, (target.related.get(term) || 0) + 1);
  }
  if (target.samples.length < 8) {
    target.samples.push({ title: item.title, platform: item.platform, sourceName: item.sourceName, channel: item.channel, url: item.url, rank: item.rank, isFallback: item.isFallback || false });
  }
}

function areSimilarTopics(keyA, keyB, titleA, titleB) {
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  if (keyA.length >= 5 && keyB.length >= 5 && (keyA.includes(keyB) || keyB.includes(keyA))) return true;
  const tokensA = topicTokens(titleA);
  const tokensB = topicTokens(titleB);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const shared = tokensA.filter(t => tokensB.includes(t)).length;
  const ratio = shared / Math.min(tokensA.length, tokensB.length);
  return shared >= 2 && ratio >= 0.5;
}

function topicTokens(title) {
  const terms = extractChineseKeywords(title, []);
  const ascii = String(title).match(/[A-Za-z0-9]{2,}/g) || [];
  return unique([...terms, ...ascii.map(s => s.toUpperCase())]).filter(t => !STOP_WORDS.has(t));
}

function finalizeCluster(cluster, maxRaw) {
  const platformDiversity = Math.max(0, cluster.platforms.size - 1) * 4;
  const sourceDiversity = Math.max(0, cluster.sourceIds.size - 1) * 3;
  const score = Math.min(100, Math.round((cluster.rawScore / maxRaw) * 82 + platformDiversity + sourceDiversity + Math.min(8, cluster.itemCount)));
  const family = [...cluster.families.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || cluster.family;
  const relatedWords = [...cluster.related.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term]) => term)
    .filter(term => term && !STOP_WORDS.has(term))
    .slice(0, 36);
  const platforms = [...cluster.platforms.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  return {
    title: cluster.title,
    family,
    score,
    heatLevel: score >= 80 ? '高' : score >= 55 ? '中高' : score >= 32 ? '中' : '低',
    itemCount: cluster.itemCount,
    sourceCount: cluster.sourceIds.size,
    platforms,
    relatedWords,
    reason: makeReason(cluster.title, family, platforms, relatedWords, cluster.itemCount),
    samples: cluster.samples
  };
}

function makeReason(title, family, platforms, relatedWords, count) {
  const platformText = platforms.slice(0, 3).map(p => p.name).join('、') || '多个来源';
  const words = relatedWords.slice(0, 6).join('、');
  return `${platformText}等来源出现 ${count} 条相关内容，归入「${family}」方向；关联词包括：${words || title}。`;
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
  const matches = String(text || '').match(/#[^#\s]{2,30}#/g) || [];
  return unique(matches.map(x => x.replace(/^#|#$/g, '').trim()).filter(Boolean));
}

function extractChineseKeywords(text, dictionaryTerms) {
  const value = String(text || '');
  const dictHits = findMatchedTerms(value, dictionaryTerms || []);
  const chunks = value
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[《》“”"'（）()【】\[\]{}]/g, ' ')
    .split(/[\s，。！？、；;:：|｜\/\\·…~!@#$%^&*+=<>]+/)
    .map(x => x.trim())
    .filter(x => x.length >= 2 && x.length <= 18)
    .filter(x => /[\u4e00-\u9fa5A-Za-z0-9]/.test(x))
    .filter(x => !/^\d+$/.test(x))
    .filter(x => !STOP_WORDS.has(x));
  const named = [];
  for (const chunk of chunks) {
    if (/[A-Za-z]/.test(chunk) && chunk.length <= 12) named.push(chunk.toUpperCase());
    else if (/^[\u4e00-\u9fa5A-Za-z0-9]{2,18}$/.test(chunk)) named.push(chunk);
  }
  return unique([...dictHits, ...named]).slice(0, 24);
}

function unique(arr) {
  return [...new Set((arr || []).map(x => String(x || '').trim()).filter(Boolean))];
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[《》“”"'（）()【】\[\]{}#\s\-—_·.,，。！!？?、:：;；|｜/\\]/g, '')
    .replace(/相关话题|引热议|引发热议|冲上热搜|登上热搜|回应/g, '')
    .trim();
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
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
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
