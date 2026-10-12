import { $, adminGate, api, busy, errorText, formatDateTime, formatNumber, formValues, h, lang, t, toast } from './ui.js';

const state = { page: 1, pages: 1, query: '' };
const SVG = 'http://www.w3.org/2000/svg';
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;

const shortUrl = (slug) => `${location.origin}/${slug}`;

/** An SVG element with attributes (SVG needs createElementNS, so h() from ui.js can't build it). */
function svg(tag, attributes = {}, ...children) {
  const element = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  element.append(...children);
  return element;
}

/** 'YYYY-MM-DD' (UTC) as a short date in the visitor's language. */
function formatDay(day, options = { day: 'numeric', month: 'short' }) {
  return new Intl.DateTimeFormat(lang, { ...options, timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('common.copied'));
  } catch {
    toast(t('error.copy'), 'error');
  }
}

/** Two overlapping sheets: the copy icon. */
function copyIcon() {
  return svg(
    'svg',
    { class: 'icon', viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    svg('rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }),
    svg('path', { d: 'M5 15V6a2 2 0 0 1 2-2h8' }),
  );
}

function selectTab(name) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected));
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}

/** The last 7 days as a small line: `values` are the clicks per day, oldest first. */
function sparkline(values) {
  const width = 84;
  const height = 26;
  const pad = 3;
  const max = Math.max(1, ...values);
  const step = (width - pad * 2) / Math.max(1, values.length - 1);
  const points = values.map((value, index) => [pad + index * step, height - pad - (value / max) * (height - pad * 2)]);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lastX, lastY] = points.at(-1) ?? [width - pad, height - pad];
  return svg(
    'svg',
    {
      class: 'spark',
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': t('links.sparkLabel', { values: values.join(', ') }),
    },
    svg('polygon', { class: 'area', points: `${pad},${height - pad} ${line} ${lastX},${height - pad}` }),
    svg('polyline', { class: 'line', points: line }),
    svg('circle', { class: 'dot', cx: lastX, cy: lastY, r: 2.5 }),
  );
}

/** Daily bars for the details dialog: `days` is [{ day, count }], oldest first. */
function barChart(days) {
  const width = 600;
  const height = 160;
  const top = 18;
  const base = height - 1;
  const gap = 2;
  const max = Math.max(1, ...days.map((entry) => entry.count));
  const slot = width / days.length;
  const barWidth = slot - gap;
  const tip = $('#details-tip');
  const chart = svg('svg', {
    class: 'bars',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': t('details.chartLabel', { total: formatNumber(days.reduce((sum, entry) => sum + entry.count, 0)) }),
  });
  // A light guide at the top (the busiest day) and the baseline
  chart.append(
    svg('line', { class: 'grid', x1: 0, x2: width, y1: top, y2: top, 'stroke-dasharray': '4 4' }),
    svg('line', { class: 'grid', x1: 0, x2: width, y1: base, y2: base }),
  );
  days.forEach((entry, index) => {
    const x = index * slot + gap / 2;
    const label = t('details.dayLabel', { day: formatDay(entry.day), count: formatNumber(entry.count) });
    // The hit area is the whole column, wider and taller than the bar, so small bars are easy to point at
    const hit = svg('rect', { class: 'hit', x: index * slot, y: 0, width: slot, height }, svg('title', {}, label));
    hit.addEventListener('mouseenter', () => {
      tip.textContent = label;
    });
    chart.append(hit);
    const barHeight = (entry.count / max) * (base - top);
    if (entry.count === 0) {
      chart.append(svg('g', { class: 'bar' }));
      return;
    }
    // Rounded at the top, square on the baseline
    const y = base - barHeight;
    const r = Math.min(4, barHeight, barWidth / 2);
    chart.append(
      svg('path', {
        class: 'bar',
        d: `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${base} Z`,
      }),
    );
  });
  chart.addEventListener('mouseleave', () => {
    tip.textContent = '';
  });
  return chart;
}

async function loadStats() {
  const stats = await api('/api/admin/stats');
  $('#stat-links').textContent = formatNumber(stats.links);
  $('#stat-clicks').textContent = formatNumber(stats.clicks);
  $('#stat-week').textContent = formatNumber(stats.week);
}

function linkRow(link) {
  const toggle = h('input', {
    type: 'checkbox',
    class: 'switch',
    checked: link.active,
    'aria-label': t('links.activeLabel', { slug: link.slug }),
    onchange: (event) => setActive(link, event.currentTarget),
  });
  return h(
    'tr',
    { class: link.active ? '' : 'inactive' },
    h(
      'td',
      {},
      h(
        'span',
        { class: 'short-cell' },
        h('a', { href: shortUrl(link.slug), target: '_blank', rel: 'noopener' }, `/${link.slug}`),
        h(
          'button',
          {
            type: 'button',
            class: 'btn small icon-btn',
            title: t('common.copy'),
            'aria-label': t('links.copyLabel', { url: shortUrl(link.slug) }),
            onclick: () => copy(shortUrl(link.slug)),
          },
          copyIcon(),
        ),
      ),
    ),
    h(
      'td',
      {},
      link.title ? h('span', { class: 'link-title' }, link.title) : null,
      h('a', { class: 'destination', href: link.url, title: link.url, target: '_blank', rel: 'noopener noreferrer' }, link.url),
    ),
    h('td', { class: 'num' }, formatNumber(link.clicks)),
    h('td', {}, sparkline(link.week)),
    h('td', {}, formatDay(link.created_at.slice(0, 10), { dateStyle: 'short' })),
    h('td', {}, toggle),
    h(
      'td',
      {},
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', text: t('links.details'), onclick: () => openDetails(link) }),
        h('button', { class: 'btn small', type: 'button', text: t('links.edit'), onclick: () => openEdit(link) }),
        h('button', {
          class: 'btn small danger',
          type: 'button',
          text: t('common.delete'),
          onclick: (event) => removeLink(link, event.currentTarget),
        }),
      ),
    ),
  );
}

async function loadLinks() {
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.query) params.set('q', state.query);
  const data = await api(`/api/admin/links?${params}`);
  state.pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  $('#rows').replaceChildren(...data.items.map(linkRow));
  $('#empty').hidden = data.total > 0;
  $('#empty').textContent = t(state.query ? 'links.noResults' : 'links.empty');
  $('#page-info').textContent = t('pager.info', { page: state.page, pages: state.pages });
  $('#prev').disabled = state.page <= 1;
  $('#next').disabled = state.page >= state.pages;
}

const reload = () => Promise.all([loadLinks(), loadStats()]);

async function setActive(link, input) {
  const active = input.checked;
  await busy(input, async () => {
    try {
      await api(`/api/admin/links/${link.id}`, { method: 'PUT', body: { url: link.url, title: link.title, active } });
      link.active = active;
      input.closest('tr').className = active ? '' : 'inactive';
      toast(t(active ? 'links.activated' : 'links.deactivated'));
    } catch (error) {
      input.checked = !active;
      throw error;
    }
  });
}

async function removeLink(link, button) {
  if (!confirm(t('links.deleteConfirm', { slug: link.slug }))) return;
  await busy(button, async () => {
    await api(`/api/admin/links/${link.id}`, { method: 'DELETE' });
    toast(t('links.deleted'));
    await reload();
  });
}

async function openDetails(link) {
  await busy(null, async () => {
    const data = await api(`/api/admin/links/${link.id}`);
    $('#details-title').textContent = data.title || `/${data.slug}`;
    $('#details-short').href = shortUrl(data.slug);
    $('#details-short').textContent = shortUrl(data.slug);
    $('#details-url').href = data.url;
    $('#details-url').textContent = data.url;
    $('#details-total').textContent = formatNumber(data.clicks);
    $('#details-last30').textContent = formatNumber(data.last30);
    $('#details-last7').textContent = formatNumber(data.last7);
    $('#details-tip').textContent = '';
    $('#details-chart').replaceChildren(barChart(data.days));
    $('#details-from').textContent = formatDay(data.days[0].day);
    $('#details-to').textContent = formatDay(data.days.at(-1).day);
    $('#details-meta').textContent = [
      t('details.created', { date: formatDateTime(data.created_at) }),
      data.last_click_at ? t('details.lastClick', { date: formatDateTime(data.last_click_at) }) : t('details.noClicks'),
      data.active ? '' : t('details.inactive'),
    ]
      .filter(Boolean)
      .join(' · ');
    $('#details-rows').replaceChildren(
      ...data.days
        .slice()
        .reverse()
        .map((entry) =>
          h(
            'tr',
            {},
            h('td', {}, formatDay(entry.day, { dateStyle: 'medium' })),
            h('td', { class: 'num' }, formatNumber(entry.count)),
          ),
        ),
    );
    $('#details').showModal();
  });
}

let editing = null;

function openEdit(link) {
  editing = link;
  const form = $('#edit-form');
  form.elements.url.value = link.url;
  form.elements.title.value = link.title;
  form.elements.active.checked = link.active;
  $('#edit-short').textContent = shortUrl(link.slug);
  $('#edit-error').hidden = true;
  $('#edit').showModal();
}

/** Shows `message` in the form's alert (or hides it when empty). */
function showError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function updatePreview() {
  const slug = $('#create').elements.slug.value.trim();
  $('#preview').textContent = slug ? shortUrl(slug) : `${location.origin}/${t('create.random')}`;
}

async function createLink(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formValues(form);
  values.slug = values.slug.trim();
  const error = $('#create-error');
  showError(error, '');
  $('#created').hidden = true;
  if (!form.elements.url.checkValidity() || !/^https?:\/\//i.test(values.url.trim())) {
    showError(error, t('error.invalid_url'));
    form.elements.url.focus();
    return;
  }
  if (values.slug && !SLUG.test(values.slug)) {
    showError(error, t('error.invalid_slug'));
    form.elements.slug.focus();
    return;
  }
  const button = event.submitter ?? form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const link = await api('/api/admin/links', { method: 'POST', body: values });
    form.reset();
    updatePreview();
    $('#created-link').href = shortUrl(link.slug);
    $('#created-link').textContent = shortUrl(link.slug);
    $('#created').hidden = false;
    state.page = 1;
    await busy(null, reload);
  } catch (failure) {
    if (failure.code === 'unauthorized') location.reload();
    showError(error, errorText(failure));
  } finally {
    button.disabled = false;
  }
}

async function saveEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('#edit-error');
  if (!form.elements.url.checkValidity() || !/^https?:\/\//i.test(form.elements.url.value.trim())) {
    showError(error, t('error.invalid_url'));
    return;
  }
  const button = event.submitter ?? form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/admin/links/${editing.id}`, { method: 'PUT', body: formValues(form) });
    $('#edit').close();
    toast(t('common.saved'));
    await busy(null, reload);
  } catch (failure) {
    if (failure.code === 'unauthorized') location.reload();
    showError(error, errorText(failure));
  } finally {
    button.disabled = false;
  }
}

async function loadSettings() {
  const settings = await api('/api/admin/settings');
  $('#settings').elements.home_url.value = settings.home_url;
}

async function start() {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
  }
  $('#slug-prefix').textContent = `${location.host}/`;
  $('#create').elements.slug.addEventListener('input', updatePreview);
  $('#create').addEventListener('submit', createLink);
  $('#created-copy').addEventListener('click', () => copy($('#created-link').textContent));
  $('#details-close').addEventListener('click', () => $('#details').close());
  $('#edit-cancel').addEventListener('click', () => $('#edit').close());
  $('#edit-form').addEventListener('submit', saveEdit);
  updatePreview();

  let timer;
  $('#search').addEventListener('input', (event) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = event.target.value.trim();
      state.page = 1;
      busy(null, loadLinks);
    }, 250);
  });
  $('#prev').addEventListener('click', () => {
    state.page -= 1;
    busy(null, loadLinks);
  });
  $('#next').addEventListener('click', () => {
    state.page += 1;
    busy(null, loadLinks);
  });
  $('#settings').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    const value = form.elements.home_url.value.trim();
    if (value && !/^https?:\/\/\S+$/i.test(value)) {
      toast(t('error.invalid_home_url'), 'error');
      form.elements.home_url.focus();
      return;
    }
    busy(event.submitter, async () => {
      await api('/api/admin/settings', { method: 'PUT', body: { home_url: value } });
      toast(t('common.saved'));
    });
  });
  await busy(null, () => Promise.all([loadStats(), loadLinks(), loadSettings()]));
}

adminGate(start);
