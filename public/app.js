const state = { data: null, active: null };

init();

async function init() {
  try {
    const res = await fetch('./data/radar.json?t=' + Date.now());
    if (!res.ok) throw new Error('数据文件加载失败');
    state.data = await res.json();
    state.active = state.data.categories?.[0]?.id || 'film';
    render();
  } catch (error) {
    document.getElementById('content').innerHTML = `<div class="empty">数据加载失败：${escapeHtml(error.message)}</div>`;
  }
}

function render() {
  const { meta, categories, sources } = state.data;
  document.title = meta.siteTitle || '影视体育话题雷达';
  document.getElementById('site-title').textContent = meta.siteTitle || '影视体育话题雷达';
  document.getElementById('site-subtitle').textContent = meta.siteSubtitle || '';
  document.getElementById('updated-at').textContent = meta.generatedAtText || '-';
  document.getElementById('source-status').textContent = `${meta.okSourceCount || 0}/${meta.sourceCount || 0} 个来源可用 · ${meta.itemCount || 0} 条候选内容`;
  document.getElementById('note').textContent = meta.note || '';

  renderTopCards(categories || []);
  renderTabs(categories || []);
  renderContent(categories || []);
  renderSources(sources || []);
}

function renderTopCards(categories) {
  const html = categories.map(cat => {
    const top = cat.topics?.[0];
    return `
      <article class="top-card ${cat.id === state.active ? 'active' : ''}" data-tab="${cat.id}">
        <span>${cat.emoji || ''} ${escapeHtml(cat.label)}</span>
        <strong>${top ? escapeHtml(top.title) : '暂无话题'}</strong>
        <small>${cat.topicCount || 0} 个话题 · ${cat.itemCount || 0} 条内容</small>
      </article>
    `;
  }).join('');
  const el = document.getElementById('top-cards');
  el.innerHTML = html;
  el.querySelectorAll('[data-tab]').forEach(node => node.addEventListener('click', () => switchTab(node.dataset.tab)));
}

function renderTabs(categories) {
  const html = categories.map(cat => `
    <button class="tab ${cat.id === state.active ? 'active' : ''}" data-tab="${cat.id}">
      ${cat.emoji || ''} ${escapeHtml(cat.label)} <span>${cat.topicCount || 0}</span>
    </button>
  `).join('');
  const el = document.getElementById('tabs');
  el.innerHTML = html;
  el.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
}

function switchTab(id) {
  state.active = id;
  renderTopCards(state.data.categories || []);
  renderTabs(state.data.categories || []);
  renderContent(state.data.categories || []);
}

function renderContent(categories) {
  const cat = categories.find(x => x.id === state.active) || categories[0];
  if (!cat) return;
  const el = document.getElementById('content');
  if (!cat.topics || cat.topics.length === 0) {
    el.innerHTML = `<div class="empty">暂无${escapeHtml(cat.label)}相关话题。可以稍后等定时任务更新，或检查来源是否被限流。</div>`;
    return;
  }
  el.innerHTML = cat.topics.map(topic => renderTopic(topic)).join('');
}

function renderTopic(topic) {
  const platforms = (topic.platforms || []).map(p => `<span class="pill neutral">${escapeHtml(p.name)} × ${p.count}</span>`).join('');
  const words = (topic.relatedWords || []).slice(0, 28).map(w => `<span class="word">${escapeHtml(w)}</span>`).join('');
  const samples = (topic.samples || []).map(sample => `
    <a class="sample" href="${escapeAttr(sample.url || '#')}" target="_blank" rel="noreferrer">
      <span>${escapeHtml(sample.title)}</span>
      <em>${escapeHtml(sample.platform || '')}${sample.rank ? ` · #${sample.rank}` : ''}</em>
    </a>
  `).join('');
  return `
    <article class="topic-card">
      <div class="rank">${topic.rank}</div>
      <div class="topic-main">
        <div class="topic-head">
          <h2>${escapeHtml(topic.title)}</h2>
          <span class="heat ${heatClass(topic.score)}">${topic.score} · ${escapeHtml(topic.heatLevel || '')}热度</span>
        </div>
        <p class="reason">${escapeHtml(topic.reason || '')}</p>
        <div class="pill-row">
          <span class="pill blue">${escapeHtml(topic.family || '自动发现')}</span>
          <span class="pill neutral">${topic.itemCount || 0} 条内容</span>
          <span class="pill neutral">${topic.sourceCount || 0} 个来源</span>
          ${platforms}
        </div>
        <div class="word-row">${words}</div>
        <div class="samples">${samples}</div>
      </div>
    </article>
  `;
}

function renderSources(sources) {
  const el = document.getElementById('sources');
  if (!sources.length) {
    el.innerHTML = '<span class="source-item bad">暂无来源状态</span>';
    return;
  }
  el.innerHTML = sources.map(s => `
    <span class="source-item ${s.ok ? 'ok' : 'bad'}" title="${escapeAttr(s.error || '')}">
      ${s.ok ? '✓' : '×'} ${escapeHtml(s.name)} <em>${s.count || 0}</em>
    </span>
  `).join('');
}

function heatClass(score) {
  if (score >= 80) return 'high';
  if (score >= 60) return 'midhigh';
  if (score >= 36) return 'mid';
  return 'low';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
