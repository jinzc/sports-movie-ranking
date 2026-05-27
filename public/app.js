const state = {
  data: null,
  categoryId: 'film',
  query: ''
};

const $ = selector => document.querySelector(selector);

async function init() {
  try {
    const res = await fetch('./data/radar.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    state.categoryId = state.data.categories?.[0]?.id || 'film';
    renderShell();
    render();
  } catch (error) {
    $('#topic-list').innerHTML = `<section class="empty-panel">数据加载失败：${escapeHtml(error.message)}。请先在 GitHub Actions 手动运行一次 Update Topic Radar。</section>`;
  }
}

function renderShell() {
  const { meta, categories = [], sources = [] } = state.data;
  $('#site-title').textContent = meta.siteTitle || '影视体育话题雷达';
  $('#site-subtitle').textContent = meta.siteSubtitle || '';
  $('#updated-at').textContent = meta.generatedAtText || meta.generatedAt || '未知';
  $('#source-status').textContent = `成功 ${meta.okSourceCount || 0} / ${meta.sourceCount || sources.length || 0} 个来源，条目 ${meta.itemCount || 0}`;

  $('#category-tabs').innerHTML = categories.map(category => `
    <button class="tab ${category.id === state.categoryId ? 'active' : ''}" data-id="${category.id}">
      ${category.emoji || ''} ${category.label}
    </button>
  `).join('');
  $('#category-tabs').addEventListener('click', event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    state.categoryId = button.dataset.id;
    render();
  });

  $('#search-input').addEventListener('input', event => {
    state.query = event.target.value.trim().toLowerCase();
    render();
  });

  $('#source-list').innerHTML = sources.map(source => `
    <div class="source-item">
      <strong>${escapeHtml(source.name)} <span class="${source.ok ? 'ok' : 'fail'}">${source.ok ? '成功' : '失败'}</span></strong>
      <small>${escapeHtml(source.platform || '')} · ${source.count || 0} 条${source.error ? ` · ${escapeHtml(source.error)}` : ''}</small>
    </div>
  `).join('');
}

function render() {
  const category = state.data.categories.find(item => item.id === state.categoryId) || state.data.categories[0];
  const tabs = $('#category-tabs').querySelectorAll('.tab');
  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.id === category.id));

  const topics = filterTopics(category.topics || []);
  renderSummary(category, topics);
  renderTopics(topics);
}

function filterTopics(topics) {
  if (!state.query) return topics;
  return topics.filter(topic => {
    const text = [
      topic.title,
      topic.family,
      topic.reason,
      ...(topic.relatedWords || []),
      ...(topic.platforms || []).map(p => p.name),
      ...(topic.samples || []).map(s => s.title)
    ].join(' ').toLowerCase();
    return text.includes(state.query);
  });
}

function renderSummary(category, topics) {
  const totalSources = new Set(topics.flatMap(t => (t.platforms || []).map(p => p.name))).size;
  const avg = topics.length ? Math.round(topics.reduce((sum, t) => sum + t.score, 0) / topics.length) : 0;
  const top = topics[0]?.title || '暂无';
  const cards = [
    ['当前分类', `${category.emoji || ''} ${category.label}`],
    ['热门话题', topics.length],
    ['来源平台', totalSources],
    ['平均热度', avg],
    ['榜首话题', top]
  ];
  $('#summary-grid').innerHTML = cards.map(([label, value]) => `
    <div class="summary-card"><p>${label}</p><strong>${escapeHtml(String(value))}</strong></div>
  `).join('');
}

function renderTopics(topics) {
  const list = $('#topic-list');
  const empty = $('#empty-panel');
  list.innerHTML = '';
  empty.classList.toggle('hidden', topics.length > 0);

  const template = $('#topic-card-template');
  for (const topic of topics) {
    const node = template.content.cloneNode(true);
    node.querySelector('.topic-rank').textContent = topic.rank;
    node.querySelector('h2').textContent = topic.title;
    node.querySelector('.heat-badge').textContent = `${topic.score} · ${topic.heatLevel}热度`;
    node.querySelector('.reason').textContent = topic.reason;
    node.querySelector('.meta-row').innerHTML = [
      `<span class="meta family">${escapeHtml(topic.family || '自动发现')}</span>`,
      `<span class="meta">${topic.itemCount || 0} 条内容</span>`,
      `<span class="meta">${topic.sourceCount || 0} 个来源</span>`,
      ...((topic.platforms || []).slice(0, 5).map(p => `<span class="meta">${escapeHtml(p.name)} × ${p.count}</span>`))
    ].join('');
    node.querySelector('.related').innerHTML = (topic.relatedWords || []).slice(0, 30).map(word => `<span class="chip">${escapeHtml(word)}</span>`).join('');
    node.querySelector('.samples').innerHTML = (topic.samples || []).slice(0, 5).map(sample => `
      <div class="sample">
        <a href="${escapeAttr(sample.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(sample.title)}</a>
        <small>${escapeHtml(sample.platform || '')} · #${sample.rank || '-'}</small>
      </div>
    `).join('');
    list.appendChild(node);
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

init();
