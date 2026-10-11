/* PaperDex — 매일 읽은 논문 아카이브 */

// ---------- utils ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const fmtDate = s => { if (!s) return ''; const d = parseYmd(s); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} (${WEEK[d.getDay()]})`; };
const snippet = (s, n) => { s = String(s || '').replace(/[#*_>`$\\]/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '';
const stars = n => n ? `<span class="stars">${'★'.repeat(n)}</span>` : '';
const splitTags = s => [...new Set(String(s || '').split(/[,，]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean))];
const keyLine = (p, f) => { const ls = lines(p[f]); const pin = p.keys?.[f]; return ls.includes(pin) ? pin : ls[0]; };
const lines = s => String(s || '').split('\n').map(l => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim()).filter(l => l.length > 1);

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// ---------- storage: 로컬 파이썬 서버 or Supabase(클라우드) ----------
const CFG = window.PAPERDEX_CONFIG || {};
const CLOUD = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
const KIND = { papers: 'paper', ideas: 'idea' };
const signed = new Map(); // storage path → signed URL
let sb = null, sbUser = null;

async function signImages(paths) {
  if (!CLOUD || !paths.length) return;
  const { data, error } = await sb.storage.from('images').createSignedUrls(paths, 60 * 60 * 24 * 7);
  if (error) return console.warn(error);
  data.forEach(d => d.signedUrl && signed.set(d.path, d.signedUrl));
}

const store = {
  async load() {
    if (!CLOUD) return api('GET', '/api/db');
    const db = { papers: [], ideas: [] };
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('items').select('kind,data').range(from, from + 999);
      if (error) throw error;
      data.forEach(r => (r.kind === 'paper' ? db.papers : db.ideas).push(r.data));
      if (data.length < 1000) break;
    }
    await signImages(db.papers.flatMap(p => (p.images || []).map(i => i.path)).filter(Boolean));
    return db;
  },
  async put(coll, obj) {
    if (!CLOUD) return api('PUT', `/api/${coll}/${obj.id}`, obj);
    const { error } = await sb.from('items').upsert({ user_id: sbUser.id, id: obj.id, kind: KIND[coll], data: obj, updated_at: new Date().toISOString() });
    if (error) throw error;
    return obj;
  },
  async del(coll, id) {
    if (!CLOUD) return api('DELETE', `/api/${coll}/${id}`);
    const { error } = await sb.from('items').delete().eq('id', id).eq('kind', KIND[coll]);
    if (error) throw error;
  },
  async uploadImage(blob) {
    const name = uid() + (blob.type === 'image/webp' ? '.webp' : '.jpg');
    if (!CLOUD) {
      const r = await fetch('/api/images?name=' + name, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || r.statusText);
      return { id: name, src: d.src };
    }
    const path = `${sbUser.id}/${name}`;
    const { error } = await sb.storage.from('images').upload(path, blob, { contentType: blob.type });
    if (error) throw error;
    await signImages([path]);
    return { id: name, path };
  },
};

const imgSrc = img => (img.path ? signed.get(img.path) : img.src) || img.data || '';

// 스크린샷은 업로드 전에 최대 2000px · webp(안 되면 jpeg)로 줄여요
async function compressImage(file, max = 2000) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const toBlob = (type, q) => new Promise(r => c.toBlob(r, type, q));
  let b = await toBlob('image/webp', 0.86);
  if (!b || b.type !== 'image/webp') b = await toBlob('image/jpeg', 0.88);
  return b;
}

const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });

async function exportData() {
  toast('내보내는 중… (이미지 포함)');
  const papers = await Promise.all(DB.papers.map(async p => !p.images?.length ? p : {
    ...p,
    images: await Promise.all(p.images.map(async img => {
      try { return { ...img, data: await blobToDataURL(await (await fetch(imgSrc(img))).blob()) }; } catch { return img; }
    })),
  }));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ papers, ideas: DB.ideas }, null, 2)], { type: 'application/json' }));
  a.download = `paperdex-${today()}.json`;
  a.click();
  toast('내보내기 완료 💾');
}

async function importData(data) {
  const counts = { papers: 0, ideas: 0 };
  for (const coll of ['papers', 'ideas']) {
    for (const item of data[coll] || []) {
      if (!item || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id || '')) continue;
      if (item.images) {
        item.images = await Promise.all(item.images.map(async ({ data: d, ...img }) => {
          if (!d) return img;
          const up = await store.uploadImage(await (await fetch(d)).blob());
          return { ...up, caption: img.caption || '' };
        }));
      }
      await store.put(coll, item);
      counts[coll]++;
    }
  }
  return counts;
}

// 페이지 단위 document 리스너 (라우트 바뀌면 해제)
let pageListeners = [];
function onPage(type, fn) { document.addEventListener(type, fn); pageListeners.push([type, fn]); }

function openLightbox(imgs, i) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  const show = () => { lb.innerHTML = `<img src="${esc(imgSrc(imgs[i]))}"><div class="lb-cap">${esc(imgs[i].caption || '')} <span class="muted">${i + 1} / ${imgs.length}</span></div>`; };
  const close = () => { lb.remove(); document.removeEventListener('keydown', key); };
  const key = e => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') { i = (i + 1) % imgs.length; show(); }
    if (e.key === 'ArrowLeft') { i = (i - 1 + imgs.length) % imgs.length; show(); }
  };
  lb.addEventListener('click', close);
  document.addEventListener('keydown', key);
  show();
  document.body.appendChild(lb);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copyText(text, msg = '복사했어요! GPT에 붙여넣으세요 📋') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}

// ---------- markdown + math ----------
function md(text) {
  if (!text) return '';
  const store = [];
  const t = text.replace(/(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g, m => {
    store.push(m);
    return `@@MATH${store.length - 1}@@`;
  });
  let html = window.marked ? marked.parse(t, { breaks: true, gfm: true }) : esc(t).replace(/\n/g, '<br>');
  html = html.replace(/@@MATH(\d+)@@/g, (_, i) => esc(store[+i]));
  return window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : html;
}

function renderMath(el) {
  if (!window.renderMathInElement) return;
  renderMathInElement(el, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
  });
}

// ---------- GPT 대화 파싱 ----------
const USER_MARK = /^(you said|나의 말|내가 말함|user|사용자|me|나)$/i;
function parseConversation(text) {
  if (!text || !text.trim()) return [];
  const re = /^[ \t]*(?:#+\s*)?\**(You said|나의 말|내가 말함|User|사용자|ChatGPT said|ChatGPT의 말|ChatGPT|Assistant|GPT)\**\s*[:：]\**[ \t]*/gim;
  const marks = [...text.matchAll(re)];
  if (!marks.length) return [{ role: 'note', text: text.trim() }];
  const msgs = [];
  const pre = text.slice(0, marks[0].index).trim();
  if (pre) msgs.push({ role: 'note', text: pre });
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(m.index + m[0].length, end).trim();
    if (body) msgs.push({ role: USER_MARK.test(m[1]) ? 'user' : 'assistant', text: body });
  });
  return msgs;
}

function chatHTML(msgs) {
  return msgs.map(m => `
    <div class="msg ${m.role}">
      ${m.role !== 'user' ? `<div class="avatar">${sprite('ghost', 30)}</div>` : ''}
      <div class="msg-body md">${md(m.text)}</div>
      ${m.role === 'user' ? `<div class="avatar">${sprite('cat', 30)}</div>` : ''}
    </div>`).join('');
}

// ---------- GPT 정리 프롬프트 ----------
const SUMMARY_PROMPT = `지금까지 대화한 논문 내용을 아래 형식으로 정리해줘. 각 섹션 제목은 대괄호 그대로 유지해줘.

[요약]
3~5줄 핵심 요약 (문제 → 방법 → 결과)

[직관]
비전공자도 이해할 수 있는 비유와 직관적인 설명

[아이디어]
이 논문에서 파생할 수 있는 연구 아이디어 / 다른 문제에 적용할 점 (불릿)

[의문점]
한계점, 아직 안 풀린 질문, 더 알아봐야 할 것 (불릿)

[태그]
쉼표로 구분된 영어 키워드 3~6개 (예: diffusion, video generation, audio-visual)`;

const QF_MAP = { 요약: 'summary', 직관: 'intuition', 아이디어: 'ideaSeeds', 의문점: 'questions', 태그: 'tags' };
function parseQuickfill(text) {
  const re = /^[#*\s]*\[(요약|직관|아이디어|의문점|태그)\][*\s:]*$/gm;
  const marks = [...text.matchAll(re)];
  const out = {};
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    out[QF_MAP[m[1]]] = text.slice(m.index + m[0].length, end).trim();
  });
  return out;
}

function brainstormPrompt(papers, extra = '') {
  const body = papers.map((p, i) => [
    `### [${i + 1}] ${p.title}`,
    p.url && `링크: ${p.url}`,
    (p.tags || []).length && `태그: ${p.tags.join(', ')}`,
    `요약: ${p.summary || p.abstract || '(없음)'}`,
    p.ideaSeeds && `내 아이디어 메모: ${p.ideaSeeds}`,
    p.questions && `의문점/한계: ${p.questions}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  return `나는 아래 논문들을 읽었어. 이 논문들을 조합하거나 확장해서 새로운 연구 아이디어를 5개 제안해줘.
각 아이디어마다 (1) 한 줄 제목 (2) 핵심 가설 (3) 어떤 논문의 무엇을 가져오는지 (4) 최소 실험 설계 (5) 예상 리스크 를 써줘.
${extra ? `\n내 관심 방향: ${extra}\n` : ''}
${body}`;
}

// ---------- state ----------
let DB = { papers: [], ideas: [] };
let A = null; // analysis
const K_KEY = 'paperdex.k';
const DRAFT_KEY = 'paperdex.draft';

const getK = () => {
  const saved = +localStorage.getItem(K_KEY);
  return saved > 0 ? Math.min(saved, Math.max(1, DB.papers.length)) : Cluster.autoK(DB.papers.length);
};
const analyze = () => { A = Cluster.analyze(DB.papers, getK()); };
const paperById = id => DB.papers.find(p => p.id === id);
const clusterOf = id => A && A.assign.get(id);
const byDateDesc = (a, b) => (b.dateRead || '').localeCompare(a.dateRead || '') || (b.createdAt || '').localeCompare(a.createdAt || '');

function tagCounts() {
  const m = new Map();
  DB.papers.forEach(p => (p.tags || []).forEach(t => m.set(t, (m.get(t) || 0) + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------- streak ----------
function streakInfo() {
  const days = new Map();
  DB.papers.forEach(p => { if (p.dateRead) days.set(p.dateRead, (days.get(p.dateRead) || 0) + 1); });
  const t = today();
  const readToday = days.has(t);
  let d = parseYmd(t);
  if (!readToday) d = addDays(d, -1);
  let cur = 0;
  while (days.has(ymd(d))) { cur++; d = addDays(d, -1); }
  let best = 0, run = 0, prev = null;
  for (const s of [...days.keys()].sort()) {
    run = prev && ymd(addDays(parseYmd(prev), 1)) === s ? run + 1 : 1;
    best = Math.max(best, run);
    prev = s;
  }
  return { days, cur, best, readToday, total: DB.papers.length, ideas: DB.ideas.length };
}

function heatmapHTML(days) {
  const end = parseYmd(today());
  const start = addDays(end, -7 * 52 - end.getDay());
  const titles = new Map();
  DB.papers.forEach(p => { if (!titles.has(p.dateRead)) titles.set(p.dateRead, []); titles.get(p.dateRead).push(p.title); });
  let cells = '', months = '', lastMonth = -1;
  for (let w = 0; w < 53; w++) {
    const wk = addDays(start, w * 7);
    const m = wk.getMonth();
    months += `<span>${m !== lastMonth && wk.getDate() <= 7 || w === 0 ? `${m + 1}월` : ''}</span>`;
    lastMonth = m;
    for (let dow = 0; dow < 7; dow++) {
      const d = addDays(start, w * 7 + dow);
      if (d > end) { cells += '<i class="cell empty"></i>'; continue; }
      const s = ymd(d);
      const n = days.get(s) || 0;
      const lv = n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : n <= 4 ? 3 : 4;
      const tip = `${fmtDate(s)} · ${n}편` + (n ? '\n' + titles.get(s).map(t => '· ' + t).join('\n') : '');
      cells += n
        ? `<a class="cell l${lv}${s === today() ? ' today' : ''}" href="#/list?date=${s}" title="${esc(tip)}"></a>`
        : `<i class="cell l0${s === today() ? ' today' : ''}" title="${esc(tip)}"></i>`;
    }
  }
  return `
    <div class="heat-wrap" id="heatWrap">
      <div class="heat">
        <span></span><div class="heat-months">${months}</div>
        <div class="heat-days"><span></span><span>월</span><span></span><span>수</span><span></span><span>금</span><span></span></div>
        <div class="heat-grid">${cells}</div>
      </div>
    </div>`;
}

function weekStripHTML(days) {
  const t = parseYmd(today());
  let html = '';
  for (let i = 6; i >= 0; i--) {
    const d = addDays(t, -i);
    const s = ymd(d);
    const done = days.has(s);
    html += `<div class="day ${done ? 'done' : ''} ${i === 0 ? 'is-today' : ''}">
      <div>${i === 0 ? '오늘' : WEEK[d.getDay()]}</div>
      <div class="mark">${done ? sprite('flame', 14, {}, 'flicker') : '·'}</div>
    </div>`;
  }
  return `<div class="week-strip">${html}</div>`;
}

const BADGES = [
  { name: '첫 걸음', desc: '첫 논문 기록', ok: s => s.total >= 1, sp: () => sprite('chick', 34) },
  { name: '3일 연속', desc: '3일 스트릭', ok: s => s.best >= 3, sp: () => sprite('flame', 28) },
  { name: '일주일 개근', desc: '7일 스트릭', ok: s => s.best >= 7, sp: () => sprite('flame', 28, { r: '#ff4f8b' }) },
  { name: '2주 불꽃', desc: '14일 스트릭', ok: s => s.best >= 14, sp: () => sprite('flame', 28, { r: '#8b5cf6', y: '#7ee0c3' }) },
  { name: '한 달 장인', desc: '30일 스트릭', ok: s => s.best >= 30, sp: () => sprite('star', 32, { y: '#ff9ec4' }) },
  { name: '백일 논문', desc: '100일 스트릭', ok: s => s.best >= 100, sp: () => sprite('star', 32, { y: '#c7a8ff' }) },
  { name: '논문 10편', desc: '누적 10편', ok: s => s.total >= 10, sp: () => sprite('bunny', 30) },
  { name: '논문 50편', desc: '누적 50편', ok: s => s.total >= 50, sp: () => sprite('ghost', 30) },
  { name: '논문 100편', desc: '누적 100편', ok: s => s.total >= 100, sp: () => sprite('star', 32) },
  { name: '아이디어 뱅크', desc: '아이디어 노트 5개', ok: s => s.ideas >= 5, sp: () => sprite('bulb', 24) },
];

// ---------- shared pieces ----------
function paperCard(p) {
  const c = clusterOf(p.id);
  const thumb = p.images?.length ? imgSrc(p.images[0]) : '';
  return `<a class="box paper-card" href="#/paper/${p.id}">
    ${thumb ? `<img class="pc-thumb" src="${esc(thumb)}" loading="lazy" alt="">` : ''}
    <div class="pc-head">${c ? slimeIcon(c.idx, 22) : ''}<span>${fmtDate(p.dateRead)}</span>${stars(p.rating)}</div>
    <div class="pc-title">${esc(p.title || '(제목 없음)')}</div>
    <div class="pc-sum">${esc(snippet(p.summary || p.intuition || p.abstract, 140))}</div>
    <div class="tags">${(p.tags || []).map(t => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
  </a>`;
}

function groupedByDate(papers) {
  const groups = new Map();
  [...papers].sort(byDateDesc).forEach(p => {
    if (!groups.has(p.dateRead)) groups.set(p.dateRead, []);
    groups.get(p.dateRead).push(p);
  });
  return [...groups.entries()].map(([d, ps]) => `
    <div class="day-group">
      <span class="day-label">${fmtDate(d)} · ${ps.length}편</span>
      <div class="cards">${ps.map(paperCard).join('')}</div>
    </div>`).join('');
}

const emptyState = (msg, btn = '') => `<div class="box empty-state">${sprite('catSleep', 80, {}, 'bob')}<p>${msg}</p>${btn}</div>`;

// ---------- views ----------
function renderHome(v) {
  const s = streakInfo();
  const t = today();
  const todays = DB.papers.filter(p => p.dateRead === t);
  const weekAgo = ymd(addDays(parseYmd(t), -6));
  const week = DB.papers.filter(p => p.dateRead >= weekAgo && p.dateRead <= t).length;
  let msg, sub;
  if (!s.total) { msg = '첫 논문을 기록해볼까냥? 📚'; sub = '오늘 읽은 논문 링크랑 GPT 대화를 붙여넣으면 끝!'; }
  else if (s.readToday) { msg = `오늘 ${todays.length}편 읽었다냥! 🔥 ${s.cur}일 연속 기록 중`; sub = s.cur >= s.best && s.cur > 1 ? '최장 기록 갱신 중이야! 대단해 ✨' : `최장 기록은 ${s.best}일!`; }
  else if (s.cur > 0) { msg = `오늘은 아직이야… 하나 읽으면 ${s.cur + 1}일 연속!`; sub = '스트릭이 끊기기 전에 한 편만 읽어볼까?'; }
  else { msg = '스트릭이 끊겼다냥 😿 오늘부터 다시 시작!'; sub = `최장 기록은 ${s.best}일이었어`; }
  const recent = DB.papers.filter(p => p.dateRead !== t).sort(byDateDesc).slice(0, 9);
  v.innerHTML = `
    <section class="box hero">
      <div class="hero-mascot">${s.readToday ? sprite('cat', 96, {}, 'bob') : sprite('catSleep', 96, {}, 'bob') + '<span class="zz">z Z</span>'}</div>
      <div class="bubble">${esc(msg)}<span class="sub">${esc(sub)}</span></div>
      <a class="btn btn-pink" href="#/add">+ 오늘 읽은 논문 기록</a>
    </section>

    <section class="stats">
      <div class="box stat ${s.cur ? 'hot' : ''}">${sprite('flame', 34, {}, s.cur ? 'flicker' : '')}<div><div class="num">${s.cur}일</div><div class="lbl">현재 스트릭</div></div></div>
      <div class="box stat">${sprite('star', 36)}<div><div class="num">${s.best}일</div><div class="lbl">최장 스트릭</div></div></div>
      <div class="box stat">${sprite('slime', 36)}<div><div class="num">${s.total}편</div><div class="lbl">총 읽은 논문</div></div></div>
      <div class="box stat">${sprite('chick', 34)}<div><div class="num">${week}편</div><div class="lbl">최근 7일</div></div></div>
    </section>

    <section class="box">
      <h2>🌱 논문 잔디</h2>
      ${heatmapHTML(s.days)}
      <div class="heat-foot">
        <span>지난 1년간 ${s.days.size}일 기록 · 칸을 누르면 그날 읽은 논문을 볼 수 있어요</span>
        <span class="legend">적음 <i class="cell l0"></i><i class="cell l1"></i><i class="cell l2"></i><i class="cell l3"></i><i class="cell l4"></i> 많음</span>
      </div>
      ${weekStripHTML(s.days)}
    </section>

    <section>
      <h2 class="section-title">${sprite('bunny', 26)} 오늘 읽은 논문 · ${fmtDate(t)}</h2>
      ${todays.length ? `<div class="cards">${todays.map(paperCard).join('')}</div>`
        : emptyState('오늘은 아직 기록이 없어요', '<a class="btn btn-pink" href="#/add">+ 기록하기</a>')}
    </section>

    ${recent.length ? `<section>
      <h2 class="section-title">${sprite('ghost', 26)} 최근 기록 <a class="btn btn-sm btn-white" href="#/list">전체 보기</a></h2>
      <div class="cards">${recent.map(paperCard).join('')}</div>
    </section>` : ''}

    <section class="box">
      <h2>🏅 배지</h2>
      <div class="badges">${BADGES.map(b => {
        const ok = b.ok(s);
        return `<div class="badge ${ok ? 'got' : 'locked'}">${b.sp()}<div class="bname">${b.name}</div><div class="bdesc">${b.desc}</div></div>`;
      }).join('')}</div>
    </section>`;
  const hw = $('#heatWrap');
  hw.scrollLeft = hw.scrollWidth;
}

function renderList(v, params) {
  const q = (params.get('q') || '').trim().toLowerCase();
  const tag = params.get('tag');
  const date = params.get('date');
  const cl = params.get('cluster');
  let ps = DB.papers;
  if (q) ps = ps.filter(p => ['title', 'authors', 'summary', 'intuition', 'ideaSeeds', 'questions', 'conversation', 'abstract', 'venue']
    .some(f => (p[f] || '').toLowerCase().includes(q)) || (p.tags || []).some(t => t.toLowerCase().includes(q)));
  if (tag) ps = ps.filter(p => (p.tags || []).includes(tag));
  if (date) ps = ps.filter(p => p.dateRead === date);
  if (cl !== null && A) ps = ps.filter(p => String(clusterOf(p.id)?.idx) === cl);
  const filt = [q && `검색: "${esc(q)}"`, tag && `태그: #${esc(tag)}`, date && `날짜: ${fmtDate(date)}`,
    cl !== null && A?.clusters[+cl] && `클러스터: ${esc(A.clusters[+cl].label)}`].filter(Boolean);
  v.innerHTML = `
    <h1 class="page-title">${sprite('slime', 34, {}, 'bob')} 전체 목록 <span class="muted" style="font-size:14px">${ps.length}편</span></h1>
    ${filt.length ? `<div class="filters">${filt.map(f => `<span class="tag">${f}</span>`).join('')}<a class="btn btn-sm btn-white" href="#/list">필터 지우기</a></div>` : ''}
    <div class="filters">${tagCounts().slice(0, 30).map(([t, c]) => `<a class="tag" href="#/list?tag=${encodeURIComponent(t)}">#${esc(t)}<span class="cnt">${c}</span></a>`).join('')}</div>
    ${ps.length ? groupedByDate(ps) : emptyState(DB.papers.length ? '조건에 맞는 논문이 없어요' : '아직 기록한 논문이 없어요', '<a class="btn btn-pink" href="#/add">+ 기록하기</a>')}`;
}

const FORM_FIELDS = ['url', 'title', 'authors', 'venue', 'dateRead', 'abstract', 'conversation', 'summary', 'intuition', 'ideaSeeds', 'questions'];

function renderForm(v, id) {
  const editing = !!id;
  let p = editing ? paperById(id) : null;
  if (editing && !p) return notFound(v);
  if (!editing) {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    p = draft || { dateRead: today(), tags: [], rating: 0 };
  }
  const val = f => esc(f === 'tags' ? (p.tags || []).join(', ') : p[f] || '');
  v.innerHTML = `
    <h1 class="page-title">${sprite('chick', 34, {}, 'bob')} ${editing ? '논문 수정' : '오늘 읽은 논문 기록'}</h1>
    <form id="pform">
      <div class="box">
        <h2>1. 논문 정보</h2>
        <label class="f">논문 링크 <span class="muted">(arXiv 링크면 '불러오기'로 제목·저자·초록 자동 입력)</span></label>
        <div class="row">
          <input name="url" value="${val('url')}" placeholder="https://arxiv.org/abs/2401.00001">
          <button type="button" class="btn btn-sky" id="fetchBtn">불러오기</button>
        </div>
        <label class="f">제목 *</label>
        <input name="title" required value="${val('title')}">
        <div class="grid2">
          <div><label class="f">저자</label><input name="authors" value="${val('authors')}"></div>
          <div><label class="f">학회 / 연도</label><input name="venue" value="${val('venue')}" placeholder="CVPR 2025"></div>
        </div>
        <div class="grid2">
          <div><label class="f">읽은 날</label><input type="date" name="dateRead" value="${val('dateRead') || today()}"></div>
          <div><label class="f">흥미도</label>
            <input type="hidden" name="rating" value="${p.rating || 0}">
            <div class="stars-input" id="starsInput">${[1, 2, 3, 4, 5].map(i => `<button type="button" data-v="${i}" class="${i <= (p.rating || 0) ? 'on' : ''}">${sprite('star', 22)}</button>`).join('')}</div>
          </div>
        </div>
        <label class="f">태그 <span class="muted">(쉼표로 구분 — 태그를 잘 달수록 클러스터링이 정확해져요)</span></label>
        <input name="tags" value="${val('tags')}" placeholder="diffusion, video generation">
        <div class="tags" style="margin-top:8px">${tagCounts().slice(0, 24).map(([t]) => `<button type="button" class="tag" data-addtag="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div>
        <details style="margin-top:14px" ${p.abstract ? '' : ''}><summary>Abstract</summary><textarea name="abstract" rows="6">${val('abstract')}</textarea></details>
      </div>

      <div class="box">
        <h2>2. 스크린샷 · 그림</h2>
        <p class="hint">논문 figure나 중요한 부분을 캡처해서 <b>이 페이지에서 ⌘V</b> 로 붙여넣거나, 끌어다 놓거나, 파일을 골라주세요. (맥에서 ⌘⇧⌃4 로 캡처하면 바로 클립보드에 들어가요)</p>
        <div class="dropzone" id="dropzone">📸 여기에 이미지를 끌어다 놓거나 <label class="linkbtn">파일 선택<input type="file" id="imgInput" accept="image/*" multiple hidden></label></div>
        <div class="img-grid" id="imgGrid"></div>
      </div>

      <div class="box">
        <h2>3. GPT 대화 붙여넣기</h2>
        <p class="hint">ChatGPT 대화를 통째로 복사해서 붙여넣으세요. "You said / ChatGPT said" (또는 "나의 말 / ChatGPT의 말") 구분을 자동으로 인식해서 말풍선으로 보여줘요.</p>
        <textarea name="conversation" rows="12" placeholder="You said:&#10;이 논문 핵심이 뭐야?&#10;&#10;ChatGPT said:&#10;...">${val('conversation')}</textarea>
        <div class="hint" id="convInfo"></div>
      </div>

      <div class="box">
        <h2>4. 정리</h2>
        <div class="quickfill">
          <b>✨ 한 번에 채우기</b>
          <p class="hint">GPT 대화창에 아래 프롬프트를 보내고, 받은 답변을 여기 붙여넣으면 요약 · 직관 · 아이디어 · 의문점 · 태그가 자동으로 채워져요.</p>
          <button type="button" class="btn btn-white btn-sm" id="copyPrompt">📋 정리 프롬프트 복사</button>
          <textarea id="quickfill" rows="4" placeholder="[요약] ... [직관] ... [아이디어] ... 형식의 GPT 답변 붙여넣기"></textarea>
          <button type="button" class="btn btn-mint btn-sm" id="applyQuick">자동 채우기</button>
        </div>
        <label class="f">📝 요약</label>
        <textarea name="summary" rows="5">${val('summary')}</textarea>
        <label class="f">🧸 직관적 설명</label>
        <textarea name="intuition" rows="5">${val('intuition')}</textarea>
        <label class="f">💡 아이디어 씨앗 <span class="muted">(한 줄에 하나씩 · 첫 줄이 씨앗 보드에 핵심으로 보여요)</span></label>
        <textarea name="ideaSeeds" rows="4">${val('ideaSeeds')}</textarea>
        <label class="f">❓ 의문점 / 한계 <span class="muted">(한 줄에 하나씩 · 가장 중요한 걸 첫 줄에)</span></label>
        <textarea name="questions" rows="4">${val('questions')}</textarea>
      </div>

      <div class="form-actions">
        ${editing ? `<a class="btn btn-white" href="#/paper/${id}">취소</a>` : '<button type="button" class="btn btn-white" id="clearDraft">초기화</button>'}
        <button class="btn btn-pink" type="submit">저장하기 ✨</button>
      </div>
    </form>`;

  const form = $('#pform');
  let arxivId = p.arxivId || '';
  const images = [...(p.images || [])];
  let uploading = 0;
  const renderImgs = () => {
    $('#imgGrid').innerHTML = images.map((img, i) => `<div class="img-item">
        <img src="${esc(imgSrc(img))}" alt="">
        <button type="button" class="img-del" data-i="${i}" title="삭제">✕</button>
        <input class="img-cap" data-i="${i}" value="${esc(img.caption || '')}" placeholder="캡션 (예: Fig.2 전체 구조)">
      </div>`).join('') + (uploading ? `<div class="img-item img-loading">업로드 중… (${uploading})</div>` : '');
  };
  const addFiles = async files => {
    files = [...files].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    uploading += files.length;
    renderImgs();
    for (const f of files) {
      try { images.push({ ...(await store.uploadImage(await compressImage(f))), caption: '' }); }
      catch (err) { toast('이미지 업로드 실패: ' + err.message); }
      uploading--;
      renderImgs();
    }
    form.dispatchEvent(new Event('input'));
  };
  renderImgs();
  $('#imgGrid').addEventListener('click', e => {
    const b = e.target.closest('.img-del');
    if (!b) return;
    images.splice(+b.dataset.i, 1);
    renderImgs();
    form.dispatchEvent(new Event('input'));
  });
  $('#imgGrid').addEventListener('input', e => {
    if (e.target.classList.contains('img-cap')) images[+e.target.dataset.i].caption = e.target.value;
  });
  $('#imgInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  const dz = $('#dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); });
  onPage('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
    toast('스크린샷 붙여넣는 중… 📸');
  });
  const convInfo = () => {
    const msgs = parseConversation(form.conversation.value);
    const u = msgs.filter(m => m.role === 'user').length, a = msgs.filter(m => m.role === 'assistant').length;
    $('#convInfo').textContent = !msgs.length ? '' : (u + a) ? `✅ 질문 ${u}개 · 답변 ${a}개 인식됨` : '구분자를 못 찾아서 한 덩어리 텍스트로 저장돼요';
  };
  convInfo();
  form.conversation.addEventListener('input', convInfo);

  const collect = () => {
    const fd = new FormData(form);
    const obj = { ...p };
    FORM_FIELDS.forEach(f => { obj[f] = (fd.get(f) || '').trim(); });
    obj.tags = splitTags(fd.get('tags'));
    obj.rating = +fd.get('rating') || 0;
    obj.arxivId = arxivId;
    obj.images = images.map(({ data, ...img }) => img);
    return obj;
  };
  if (!editing) form.addEventListener('input', () => localStorage.setItem(DRAFT_KEY, JSON.stringify(collect())));

  $('#starsInput').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const n = +b.dataset.v === +form.rating.value ? 0 : +b.dataset.v;
    form.rating.value = n;
    $$('#starsInput button').forEach(x => x.classList.toggle('on', +x.dataset.v <= n));
    form.dispatchEvent(new Event('input'));
  });
  $$('[data-addtag]').forEach(b => b.addEventListener('click', () => {
    form.tags.value = splitTags(form.tags.value + ',' + b.dataset.addtag).join(', ');
    form.dispatchEvent(new Event('input'));
  }));
  $('#fetchBtn').addEventListener('click', async () => {
    const btn = $('#fetchBtn');
    btn.textContent = '불러오는 중…';
    try {
      const d = await api('GET', '/api/arxiv?q=' + encodeURIComponent(form.url.value));
      ['title', 'authors', 'venue', 'abstract', 'url'].forEach(f => { if (d[f]) form[f].value = d[f]; });
      arxivId = d.arxivId;
      form.dispatchEvent(new Event('input'));
      toast('arXiv에서 불러왔어요! 🐱');
    } catch (e) { toast('😿 ' + e.message); }
    btn.textContent = '불러오기';
  });
  $('#copyPrompt').addEventListener('click', () => copyText(SUMMARY_PROMPT));
  $('#applyQuick').addEventListener('click', () => {
    const r = parseQuickfill($('#quickfill').value);
    if (!Object.keys(r).length) return toast('[요약] [직관] 같은 섹션 제목을 찾지 못했어요');
    for (const [f, val] of Object.entries(r)) {
      if (f === 'tags') form.tags.value = splitTags(form.tags.value + ',' + val.replace(/\n/g, ',')).join(', ');
      else form[f].value = val;
    }
    form.dispatchEvent(new Event('input'));
    toast(`${Object.keys(r).length}개 항목을 채웠어요 ✨`);
  });
  $('#clearDraft')?.addEventListener('click', () => {
    if (!confirm('작성 중인 내용을 지울까요?')) return;
    localStorage.removeItem(DRAFT_KEY);
    renderForm(v);
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (uploading) return toast('이미지 업로드가 끝날 때까지 잠깐만요!');
    const obj = collect();
    const now = new Date().toISOString();
    obj.id = p.id || uid();
    obj.createdAt = p.createdAt || now;
    obj.updatedAt = now;
    try {
      await store.put('papers', obj);
    } catch (err) { return toast('저장 실패: ' + err.message); }
    const before = streakInfo();
    const i = DB.papers.findIndex(x => x.id === obj.id);
    if (i >= 0) DB.papers[i] = obj; else DB.papers.push(obj);
    if (!editing) localStorage.removeItem(DRAFT_KEY);
    analyze();
    const after = streakInfo();
    toast(after.cur > before.cur && after.readToday ? `🔥 ${after.cur}일 연속 기록! 잘했다냥!` : '저장했어요! ✨');
    location.hash = '#/paper/' + obj.id;
  });
}

function renderPaper(v, id) {
  const p = paperById(id);
  if (!p) return notFound(v);
  const c = clusterOf(id);
  const rel = (A?.related.get(id) || []).map(r => ({ ...r, p: paperById(r.id) })).filter(r => r.p);
  const msgs = parseConversation(p.conversation);
  const ideasLinked = DB.ideas.filter(i => (i.paperIds || []).includes(id));
  const note = (title, body, color) => body ? `<section class="box note c-${color}"><h2>${title}</h2><div class="md">${md(body)}</div></section>` : '';
  const url = safeUrl(p.url);
  v.innerHTML = `
    <section class="box detail-head">
      <div class="dh-top">
        ${c ? `<a class="cluster-pill" style="--c:${clusterColor(c.idx)}" href="#/list?cluster=${c.idx}">${slimeIcon(c.idx, 18)} ${esc(c.label)}</a>` : ''}
        <span>📅 ${fmtDate(p.dateRead)} 읽음</span>${stars(p.rating)}
      </div>
      <h1>${esc(p.title)}</h1>
      <div class="meta">${esc(p.authors)}${p.venue ? ` · ${esc(p.venue)}` : ''}</div>
      <div class="tags">${(p.tags || []).map(t => `<a class="tag" href="#/list?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</div>
      <div class="actions">
        ${url ? `<a class="btn btn-sky" href="${esc(url)}" target="_blank" rel="noopener">논문 열기 ↗</a>` : ''}
        <a class="btn btn-white" href="#/edit/${id}">✏️ 수정</a>
        <a class="btn btn-mint" href="#/idea/new?papers=${id}">💡 이 논문으로 아이디어 노트</a>
        <button class="btn btn-danger" id="delBtn">삭제</button>
      </div>
    </section>
    <div class="detail-grid">
      <div class="main-col">
        ${note('📝 요약', p.summary, 'lemon')}
        ${note('🧸 직관적 설명', p.intuition, 'mint')}
        ${p.images?.length ? `<section class="box"><h2>🖼 스크린샷 · 그림 (${p.images.length})</h2><div class="gallery">${p.images.map((img, i) => `
          <figure><img src="${esc(imgSrc(img))}" loading="lazy" data-lb="${i}" alt="">${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ''}</figure>`).join('')}</div></section>` : ''}
        ${note('💡 아이디어 씨앗', p.ideaSeeds, 'pink')}
        ${note('❓ 의문점 / 한계', p.questions, 'lav')}
        ${p.abstract ? `<section class="box note c-sky"><details><summary>📄 Abstract</summary><div class="md">${md(p.abstract)}</div></details></section>` : ''}
        ${msgs.length ? `<section class="box"><details open id="chatDetails"><summary>💬 GPT 대화 (${msgs.length})</summary>
          <div class="chat-tools"><button class="btn btn-sm btn-white" id="copyConv">대화 원문 복사</button><span class="muted">대화를 이어가고 싶으면 원문을 GPT에 다시 붙여넣으세요</span></div>
          <div class="chat">${chatHTML(msgs)}</div></details></section>` : ''}
        ${!p.summary && !p.intuition && !msgs.length && !p.images?.length ? emptyState('아직 정리한 내용이 없어요', `<a class="btn btn-pink" href="#/edit/${id}">정리 추가하기</a>`) : ''}
      </div>
      <aside class="side-col">
        <section class="box">
          <h2>🔗 비슷한 논문</h2>
          ${rel.length ? rel.map(r => {
            const rc = clusterOf(r.id);
            return `<a class="rel-item" href="#/paper/${r.id}">${rc ? slimeIcon(rc.idx, 20) : ''}<div style="flex:1">
              <div class="t">${esc(r.p.title)}</div><div class="s">${fmtDate(r.p.dateRead)} · 유사도 ${Math.round(r.sim * 100)}%</div>
              <div class="simbar"><i style="width:${Math.min(100, Math.round(r.sim * 100))}%"></i></div></div></a>`;
          }).join('') : '<p class="hint">논문이 더 쌓이면 비슷한 논문을 찾아줄게요</p>'}
          ${rel.length ? `<button class="btn btn-sm btn-lav" id="relPrompt" style="margin-top:12px">🧪 이 논문들로 브레인스토밍 프롬프트</button>` : ''}
        </section>
        ${ideasLinked.length ? `<section class="box"><h2>📒 연결된 아이디어</h2>${ideasLinked.map(i => `<a class="rel-item" href="#/idea/${i.id}">${sprite(i.status || 'seed', 18)}<div class="t">${esc(i.title)}</div></a>`).join('')}</section>` : ''}
      </aside>
    </div>`;
  renderMath(v);
  $('#delBtn').addEventListener('click', async () => {
    if (!confirm(`"${p.title}" 을(를) 삭제할까요?`)) return;
    await store.del('papers', id);
    DB.papers = DB.papers.filter(x => x.id !== id);
    analyze();
    toast('삭제했어요');
    location.hash = '#/';
  });
  $$('[data-lb]').forEach(im => im.addEventListener('click', () => openLightbox(p.images, +im.dataset.lb)));
  $('#copyConv')?.addEventListener('click', () => copyText(p.conversation, '대화 원문을 복사했어요'));
  $('#relPrompt')?.addEventListener('click', () => copyText(brainstormPrompt([p, ...rel.slice(0, 4).map(r => r.p)])));
}

function mapSVG() {
  const W = 900, H = 420, P = 40;
  const coords = Cluster.mds(A.sims);
  const xs = coords.map(c => c[0]), ys = coords.map(c => c[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sx = x => x1 - x0 < 1e-9 ? W / 2 : P + (x - x0) / (x1 - x0) * (W - 2 * P);
  const sy = y => y1 - y0 < 1e-9 ? H / 2 : P + (y - y0) / (y1 - y0) * (H - 2 * P);
  const pts = DB.papers.map((p, i) => {
    const c = clusterOf(p.id);
    const jx = (Math.sin(i * 91.7) * 6), jy = (Math.cos(i * 47.3) * 6);
    return { p, c, x: Math.round(sx(coords[i][0]) + jx), y: Math.round(sy(coords[i][1]) + jy) };
  });
  const labels = A.clusters.map(cl => {
    const ps = pts.filter(t => t.c === cl);
    const cx = ps.reduce((a, t) => a + t.x, 0) / ps.length, cy = Math.min(...ps.map(t => t.y));
    return `<text x="${Math.round(cx)}" y="${Math.max(16, Math.round(cy) - 14)}" text-anchor="middle" fill="${'#3b2f4a'}">${esc(snippet(cl.label, 24))}</text>`;
  }).join('');
  const dots = pts.map(t => `<a href="#/paper/${t.p.id}"><title>${esc(t.p.title)}</title>
    <rect class="pt" x="${t.x - 7}" y="${t.y - 7}" width="14" height="14" fill="${clusterColor(t.c?.idx || 0)}" stroke="#3b2f4a" stroke-width="2"/>
    <rect x="${t.x - 3}" y="${t.y - 3}" width="2" height="2" fill="#3b2f4a"/><rect x="${t.x + 1}" y="${t.y - 3}" width="2" height="2" fill="#3b2f4a"/></a>`).join('');
  return `<div class="map-wrap"><svg class="map" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${dots}${labels}</svg></div>`;
}

// ---------- mind map ----------
let mmMode = 'cluster';
const mmCollapsed = new Set();
const textW = s => [...s].reduce((a, c) => a + (/[가-힣]/.test(c) ? 13 : 7.6), 0);
const polar = (a, r) => [Math.cos(a) * r, Math.sin(a) * r];

function mindmapGroups() {
  if (mmMode === 'tag') {
    const top = tagCounts().slice(0, 14).map(([t]) => t);
    const groups = top.map((t, i) => ({ key: 'tag:' + t, label: '#' + t, color: clusterColor(i), papers: DB.papers.filter(p => (p.tags || []).includes(t)).sort(byDateDesc) }));
    const rest = DB.papers.filter(p => !(p.tags || []).some(t => top.includes(t)));
    if (rest.length) groups.push({ key: 'tag:_', label: '기타', color: '#ddd5e6', papers: rest.sort(byDateDesc) });
    return groups;
  }
  return A.clusters.map(cl => ({ key: 'c:' + cl.label, label: cl.label, color: clusterColor(cl.idx), idx: cl.idx, papers: cl.paperIds.map(paperById).sort(byDateDesc) }));
}

function mindmapSVG() {
  const groups = mindmapGroups();
  const shown = g => mmCollapsed.has(g.key) ? 0 : g.papers.length;
  const N = groups.reduce((a, g) => a + Math.max(shown(g), 1.5), 0);
  const R2 = Math.max(280, N * 26 / (2 * Math.PI));
  const R1 = Math.max(150, R2 * 0.48);
  const total = DB.papers.length;
  let ang = -Math.PI / 2, links = '', papers = '', hubs = '', maxLabel = 0;
  groups.forEach(g => {
    const span = 2 * Math.PI * Math.max(shown(g), 1.5) / N;
    const mid = ang + span / 2;
    const [gx, gy] = polar(mid, R1);
    const [c1x, c1y] = polar(mid, R1 * 0.45);
    links += `<path d="M0 0 Q${c1x} ${c1y} ${gx} ${gy}" stroke="${g.color}" stroke-width="7" fill="none" stroke-linecap="round"/>`;
    if (shown(g)) {
      const n = g.papers.length;
      const tight = span / n * R2 < 24;
      g.papers.forEach((p, i) => {
        const a = ang + span * (i + 0.5) / n;
        const r = R2 + (tight && i % 2 ? 80 : 0);
        const [px, py] = polar(a, r);
        const [k1x, k1y] = polar(mid, (R1 + r) / 2);
        const [k2x, k2y] = polar(a, (R1 + r) / 2);
        links += `<path d="M${gx} ${gy} C${k1x} ${k1y} ${k2x} ${k2y} ${px} ${py}" stroke="${g.color}" stroke-width="2.5" fill="none" opacity=".8"/>`;
        const right = Math.cos(a) >= 0;
        const label = snippet(p.title, 38);
        maxLabel = Math.max(maxLabel, textW(label) + (tight && i % 2 ? 80 : 0));
        papers += `<a class="mm-paper" href="#/paper/${p.id}"><title>${esc(p.title)}\n${fmtDate(p.dateRead)}</title>
          <circle cx="${px}" cy="${py}" r="7" fill="${g.color}"/>
          <text x="${px + (right ? 13 : -13)}" y="${py + 4}" text-anchor="${right ? 'start' : 'end'}">${esc(label)}</text></a>`;
      });
    }
    const label = snippet(g.label, 26);
    const w = textW(label) + 70, h = 38;
    const fold = mmCollapsed.has(g.key);
    hubs += `<g class="mm-group" data-key="${esc(g.key)}"><title>${fold ? '펼치기' : '접기'}</title>
      <rect x="${gx - w / 2}" y="${gy - h / 2}" width="${w}" height="${h}" fill="${g.color}"/>
      <g transform="translate(${gx - w / 2 + 8} ${gy - 11})">${g.idx !== undefined ? sprite('slime', 24, { '#': '#ffffff' }) : sprite('star', 22, { y: '#ffffff' })}</g>
      <text x="${gx - w / 2 + 38}" y="${gy + 5}">${esc(label)} <tspan class="mm-cnt">${fold ? '＋' : ''}${g.papers.length}</tspan></text></g>`;
    ang += span;
  });
  const rootW = 150;
  const root = `<g class="mm-root"><rect x="${-rootW / 2}" y="-58" width="${rootW}" height="116"/>
    <g transform="translate(-30 -48)">${sprite('cat', 60)}</g>
    <text x="0" y="34" text-anchor="middle">내 논문</text><text class="mm-cnt" x="0" y="50" text-anchor="middle">${total}편 · ${groups.length}개 ${mmMode === 'tag' ? '태그' : '주제'}</text></g>`;
  const E = Math.ceil(R2 + 100 + maxLabel);
  return `<svg class="mindmap" id="mindmap" viewBox="${-E} ${-E} ${2 * E} ${2 * E}" data-e="${E}">${links}${papers}${hubs}${root}</svg>`;
}

function bindMindmap(redraw) {
  const svg = $('#mindmap');
  const E = +svg.dataset.e;
  let vb = [-E, -E, 2 * E, 2 * E];
  const set = () => svg.setAttribute('viewBox', vb.join(' '));
  const zoom = (f, cx = 0.5, cy = 0.5) => {
    const [x, y, w, h] = vb;
    const nw = Math.min(Math.max(w * f, 200), 4 * E);
    const nh = nw * h / w;
    vb = [x + (w - nw) * cx, y + (h - nh) * cy, nw, nh];
    set();
  };
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });
  let drag = null, moved = false;
  svg.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, vb: [...vb] }; moved = false; });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 4) {
      moved = true;
      svg.classList.add('dragging');
      svg.setPointerCapture(e.pointerId);
    }
    if (!moved) return;
    const s = vb[2] / svg.getBoundingClientRect().width;
    vb = [drag.vb[0] - dx * s, drag.vb[1] - dy * s, vb[2], vb[3]];
    set();
  });
  const end = () => { drag = null; svg.classList.remove('dragging'); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('click', e => {
    if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; return; }
    const g = e.target.closest('.mm-group');
    if (!g) return;
    const k = g.dataset.key;
    mmCollapsed.has(k) ? mmCollapsed.delete(k) : mmCollapsed.add(k);
    redraw();
  }, true);
  $('#mmIn').onclick = () => zoom(1 / 1.3);
  $('#mmOut').onclick = () => zoom(1.3);
  $('#mmFit').onclick = () => { vb = [-E, -E, 2 * E, 2 * E]; set(); };
}

let clusterView = 'mindmap';
function renderClusters(v) {
  const n = DB.papers.length;
  if (n < 2) {
    v.innerHTML = `<h1 class="page-title">${slimeIcon(0, 34, 'bob')} 주제 클러스터</h1>${emptyState('논문이 2편 이상 쌓이면 비슷한 주제끼리 묶어줄게요!', '<a class="btn btn-pink" href="#/add">+ 기록하기</a>')}`;
    return;
  }
  const maxK = Math.min(n, 12);
  v.innerHTML = `
    <h1 class="page-title">${A.clusters.slice(0, 4).map(c => slimeIcon(c.idx, 30, 'bob')).join('')} 주제 클러스터</h1>
    <div class="box cluster-ctl">
      <b>섬 개수</b>
      <input type="range" min="1" max="${maxK}" value="${A.k}" id="kRange"><b id="kVal">${A.k}</b>
      <button class="btn btn-sm btn-white" id="kAuto">자동 (${Cluster.autoK(n)})</button>
      <span class="hint">제목 · 요약 · 태그 · 대화의 키워드(TF-IDF)로 비슷한 논문끼리 묶어요. 태그를 잘 달수록 정확해져요.</span>
    </div>
    <section class="box">
      <div class="sec-head">
        <div class="tabs" style="margin:0">
          <button data-cview="mindmap" class="${clusterView === 'mindmap' ? 'on' : ''}">🧠 마인드맵</button>
          <button data-cview="map" class="${clusterView === 'map' ? 'on' : ''}">🗺 유사도 지도</button>
        </div>
        ${clusterView === 'mindmap' ? `<div class="row" style="align-items:center">
          <div class="tabs" style="margin:0">
            <button data-mm="cluster" class="${mmMode === 'cluster' ? 'on' : ''}">클러스터 기준</button>
            <button data-mm="tag" class="${mmMode === 'tag' ? 'on' : ''}">태그 기준</button>
          </div>
          <button class="btn btn-sm btn-white" id="mmIn">＋</button><button class="btn btn-sm btn-white" id="mmOut">－</button><button class="btn btn-sm btn-white" id="mmFit">맞춤</button>
        </div>` : ''}
      </div>
      ${clusterView === 'mindmap' ? `<div class="mm-wrap" id="mmWrap">${mindmapSVG()}</div>
        <p class="hint">스크롤로 확대/축소, 드래그로 이동해요. 주제 가지를 누르면 접히고 펼쳐지고, 논문을 누르면 상세 페이지로 가요.</p>`
      : `${mapSVG()}<p class="hint">가까이 있을수록 내용이 비슷한 논문이에요. 네모를 누르면 논문으로 이동해요. 서로 멀리 떨어진 섬의 논문을 섞으면 새로운 아이디어가 나올지도?</p>`}
    </section>
    <div class="cluster-grid">${A.clusters.map(cl => {
      const ps = cl.paperIds.map(paperById).sort(byDateDesc);
      return `<section class="box cluster-card" style="--c:${clusterColor(cl.idx)}">
        <div class="cc-head">${slimeIcon(cl.idx, 44, 'bob')}<div><h3>${esc(cl.label)}</h3><span class="muted">${ps.length}편</span></div></div>
        <div class="tags">${cl.terms.slice(0, 8).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        <ul class="cc-list">${ps.map(p => `<li><span class="d">${p.dateRead?.slice(5)}</span><a href="#/paper/${p.id}">${esc(p.title)}</a></li>`).join('')}</ul>
        <div class="row"><button class="btn btn-sm btn-lav" data-cprompt="${cl.idx}">🧪 브레인스토밍 프롬프트</button><a class="btn btn-sm btn-white" href="#/list?cluster=${cl.idx}">카드로 보기</a></div>
      </section>`;
    }).join('')}</div>
    <section class="box">
      <h2>🏷 태그</h2>
      <div class="tags">${tagCounts().map(([t, c]) => `<a class="tag" href="#/list?tag=${encodeURIComponent(t)}">#${esc(t)}<span class="cnt">${c}</span></a>`).join('') || '<span class="hint">아직 태그가 없어요</span>'}</div>
    </section>`;
  $$('[data-cview]').forEach(b => b.addEventListener('click', () => { clusterView = b.dataset.cview; renderClusters(v); }));
  $$('[data-mm]').forEach(b => b.addEventListener('click', () => { mmMode = b.dataset.mm; mmCollapsed.clear(); renderClusters(v); }));
  if (clusterView === 'mindmap') {
    const redraw = () => { $('#mmWrap').innerHTML = mindmapSVG(); bindMindmap(redraw); };
    bindMindmap(redraw);
  }
  const kr = $('#kRange');
  kr.addEventListener('input', () => { $('#kVal').textContent = kr.value; });
  kr.addEventListener('change', () => { localStorage.setItem(K_KEY, kr.value); analyze(); renderClusters(v); });
  $('#kAuto').addEventListener('click', () => { localStorage.removeItem(K_KEY); analyze(); renderClusters(v); });
  $$('[data-cprompt]').forEach(b => b.addEventListener('click', () => {
    const cl = A.clusters[+b.dataset.cprompt];
    copyText(brainstormPrompt(cl.paperIds.map(paperById).slice(0, 12), `"${cl.label}" 주제 안에서 아직 아무도 안 한 방향`));
  }));
}

function pickGacha() {
  const ps = DB.papers;
  if (ps.length < 2) return null;
  const a = ps[Math.floor(Math.random() * ps.length)];
  const ca = clusterOf(a.id);
  let pool = ps.filter(p => p.id !== a.id && clusterOf(p.id) !== ca);
  if (!pool.length) pool = ps.filter(p => p.id !== a.id);
  return [a, pool[Math.floor(Math.random() * pool.length)]];
}

function gachaHTML(pair) {
  const [a, b] = pair;
  const hook = p => keyLine(p, 'ideaSeeds') || lines(p.summary)[0] || snippet(p.abstract, 80) || p.title;
  const card = p => {
    const c = clusterOf(p.id);
    return `<div class="gacha-card pop" style="--c:${clusterColor(c?.idx || 0)}">
      <div class="pc-head">${c ? slimeIcon(c.idx, 22) : ''}<span>${esc(c?.label || '')}</span></div>
      <a class="t" href="#/paper/${p.id}">${esc(p.title)}</a>
      <div class="md">${md(snippet(p.summary || p.abstract, 220))}</div>
    </div>`;
  };
  return `<div class="gacha-out">${card(a)}<div class="plus">+</div>${card(b)}</div>
    <div class="gacha-q pop">💭 <b>${esc(snippet(hook(a), 90))}</b> 를(을) <b>${esc(snippet(b.title, 60))}</b> 의 문제에 적용하면? 반대로는?</div>
    <div class="row" style="flex-wrap:wrap">
      <a class="btn btn-mint" href="#/idea/new?papers=${a.id},${b.id}">📒 이 조합으로 노트 만들기</a>
      <button class="btn btn-lav" id="gachaPrompt">🧪 GPT 프롬프트 복사</button>
    </div>`;
}

let seedTab = 'ideaSeeds';
function renderIdeas(v) {
  const statusName = { seed: '씨앗', sprout: '새싹', tree: '나무' };
  const ideas = [...DB.ideas].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const stickies = [...DB.papers].sort(byDateDesc).map(p => ({ p, l: keyLine(p, seedTab), n: lines(p[seedTab]).length })).filter(s => s.l);
  v.innerHTML = `
    <h1 class="page-title">${sprite('bulb', 30, {}, 'wiggle')} 아이디어 랩</h1>

    <section class="box">
      <div class="sec-head"><h2>🎲 논문 조합 가챠</h2><button class="btn btn-pink" id="gachaBtn">가챠 돌리기!</button></div>
      <p class="hint">서로 다른 클러스터의 논문 두 편을 랜덤으로 뽑아요. 의외의 조합에서 아이디어가 나와요!</p>
      <div id="gachaOut">${DB.papers.length < 2 ? '<p class="hint">논문이 2편 이상 필요해요</p>' : ''}</div>
    </section>

    <section class="box">
      <div class="sec-head"><h2>📒 아이디어 노트 <span class="muted" style="font-size:13px">${ideas.length}개</span></h2><a class="btn btn-mint" href="#/idea/new">+ 새 아이디어</a></div>
      <p class="hint">🌰 씨앗 → 🌱 새싹 → 🌳 나무 순서로 아이디어를 키워보세요.</p>
      ${ideas.length ? `<div class="idea-cards">${ideas.map(i => `
        <a class="idea-card" href="#/idea/${i.id}">
          <div class="top">${sprite(i.status || 'seed', 22)}<span>${statusName[i.status || 'seed']}</span><span style="margin-left:auto">${(i.updatedAt || '').slice(0, 10)}</span></div>
          <div class="t">${esc(i.title || '(제목 없음)')}</div>
          <div class="pc-sum">${esc(snippet(i.body, 120))}</div>
          <div class="tags">${(i.paperIds || []).map(paperById).filter(Boolean).slice(0, 3).map(p => `<span class="tag">📄 ${esc(snippet(p.title, 22))}</span>`).join('')}</div>
        </a>`).join('')}</div>` : '<p class="hint">아직 아이디어 노트가 없어요. 가챠를 돌리거나 논문 페이지에서 만들어보세요!</p>'}
    </section>

    <section class="box">
      <h2>🌱 씨앗 보드</h2>
      <p class="hint">논문마다 핵심 한 줄씩만 모았어요 (기본은 첫 줄). ⇄ 를 누르면 그 논문의 다른 줄로 핵심을 바꿀 수 있어요.</p>
      <div class="tabs">
        <button data-tab="ideaSeeds" class="${seedTab === 'ideaSeeds' ? 'on' : ''}">💡 아이디어 씨앗</button>
        <button data-tab="questions" class="${seedTab === 'questions' ? 'on' : ''}">❓ 의문점 / 한계</button>
      </div>
      ${stickies.length ? `<div class="stickies">${stickies.map(s => `<div class="sticky">
          <div>${esc(s.l)}</div>
          <div class="sticky-foot">
            <a class="from" href="#/paper/${s.p.id}">— ${esc(snippet(s.p.title, 36))}${s.n > 1 ? ` <b>+${s.n - 1}개 더</b>` : ''}</a>
            ${s.n > 1 ? `<button class="cycle" data-cycle="${s.p.id}" title="다른 줄을 핵심으로">⇄</button>` : ''}
          </div></div>`).join('')}</div>`
        : '<p class="hint">논문 기록할 때 아이디어 씨앗 / 의문점을 적어두면 여기에 모여요</p>'}
    </section>

    <section class="box">
      <h2>🧪 브레인스토밍 프롬프트 빌더</h2>
      <p class="hint">논문을 골라서 GPT에게 보낼 연구 아이디어 브레인스토밍 프롬프트를 만들어요.</p>
      <input id="pbSearch" placeholder="논문 검색">
      <div class="pick-list" id="pbList">${DB.papers.map(p => `<label data-s="${esc((p.title + ' ' + (p.tags || []).join(' ')).toLowerCase())}"><input type="checkbox" value="${p.id}">${clusterOf(p.id) ? slimeIcon(clusterOf(p.id).idx, 18) : ''}<span>${esc(p.title)}</span><span class="d">${p.dateRead || ''}</span></label>`).join('')}</div>
      <label class="f">내 관심 방향 (선택)</label>
      <input id="pbExtra" placeholder="예: 오디오-비디오 동기화, 적은 데이터로 학습">
      <div class="row" style="margin-top:12px"><button class="btn btn-lav" id="pbCopy">📋 프롬프트 복사</button></div>
    </section>`;

  let pair = null;
  const roll = () => {
    pair = pickGacha();
    if (!pair) return;
    $('#gachaOut').innerHTML = gachaHTML(pair);
    $('#gachaPrompt').addEventListener('click', () => copyText(brainstormPrompt(pair, '두 논문을 결합하는 방향')));
  };
  if (DB.papers.length >= 2) roll();
  $('#gachaBtn').addEventListener('click', roll);
  $$('[data-tab]').forEach(b => b.addEventListener('click', () => { seedTab = b.dataset.tab; renderIdeas(v); }));
  $$('[data-cycle]').forEach(b => b.addEventListener('click', async () => {
    const p = paperById(b.dataset.cycle);
    const ls = lines(p[seedTab]);
    const next = ls[(ls.indexOf(keyLine(p, seedTab)) + 1) % ls.length];
    const updated = { ...p, keys: { ...p.keys, [seedTab]: next } };
    try { await store.put('papers', updated); } catch (err) { return toast('저장 실패: ' + err.message); }
    DB.papers[DB.papers.indexOf(p)] = updated;
    renderIdeas(v);
  }));
  $('#pbSearch').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $$('#pbList label').forEach(l => { l.style.display = l.dataset.s.includes(q) ? '' : 'none'; });
  });
  $('#pbCopy').addEventListener('click', () => {
    const ids = $$('#pbList input:checked').map(i => i.value);
    if (!ids.length) return toast('논문을 하나 이상 골라주세요');
    copyText(brainstormPrompt(ids.map(paperById), $('#pbExtra').value.trim()));
  });
}

function renderIdeaForm(v, id, params) {
  const isNew = id === 'new';
  const idea = isNew
    ? { status: 'seed', title: '', body: '', paperIds: (params.get('papers') || '').split(',').filter(paperById) }
    : DB.ideas.find(i => i.id === id);
  if (!idea) return notFound(v);
  const linked = new Set(idea.paperIds || []);
  const ordered = [...DB.papers].sort((a, b) => (linked.has(b.id) - linked.has(a.id)) || byDateDesc(a, b));
  if (isNew && !idea.title && linked.size) {
    idea.body = [...linked].map(paperById).map(p => `- **${p.title}**: ${keyLine(p, 'ideaSeeds') || snippet(p.summary, 80)}`).join('\n') + '\n\n## 아이디어\n\n## 가설\n\n## 실험 계획\n';
  }
  v.innerHTML = `
    <h1 class="page-title">${sprite(idea.status || 'seed', 30, {}, 'bob')} ${isNew ? '새 아이디어' : '아이디어 노트'}</h1>
    <form id="iform">
      <div class="box">
        <label class="f">제목</label>
        <input name="title" required value="${esc(idea.title)}" placeholder="예: 오디오 리듬으로 비디오 diffusion guidance 하기">
        <label class="f">단계</label>
        <div class="status-pick">${[['seed', '씨앗'], ['sprout', '새싹'], ['tree', '나무']].map(([s, n]) => `<label><input type="radio" name="status" value="${s}" ${idea.status === s ? 'checked' : ''}>${sprite(s, 20)} ${n}</label>`).join('')}</div>
        <label class="f">내용 <span class="muted">(마크다운 지원)</span></label>
        <textarea name="body" rows="14">${esc(idea.body)}</textarea>
        <label class="f">연결된 논문</label>
        <input id="ipSearch" placeholder="논문 검색">
        <div class="pick-list" id="ipList">${ordered.map(p => `<label data-s="${esc(p.title.toLowerCase())}"><input type="checkbox" name="paperIds" value="${p.id}" ${linked.has(p.id) ? 'checked' : ''}><span>${esc(p.title)}</span><span class="d">${p.dateRead || ''}</span></label>`).join('') || '<p class="hint" style="padding:8px">아직 논문이 없어요</p>'}</div>
      </div>
      <div class="form-actions">
        ${isNew ? '' : '<button type="button" class="btn btn-danger" id="idel" style="margin-right:auto">삭제</button>'}
        <button type="button" class="btn btn-lav" id="iprompt">🧪 이 아이디어 발전시키기 프롬프트</button>
        <a class="btn btn-white" href="#/ideas">목록</a>
        <button class="btn btn-pink" type="submit">저장하기 ✨</button>
      </div>
    </form>`;
  const form = $('#iform');
  const collect = () => {
    const fd = new FormData(form);
    return { ...idea, title: fd.get('title').trim(), status: fd.get('status') || 'seed', body: fd.get('body'), paperIds: fd.getAll('paperIds') };
  };
  $('#ipSearch').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $$('#ipList label').forEach(l => { l.style.display = l.dataset.s.includes(q) ? '' : 'none'; });
  });
  $('#iprompt').addEventListener('click', () => {
    const it = collect();
    copyText(`내 연구 아이디어를 발전시키고 싶어. 비판적으로 검토하고, 더 구체적인 가설 · 실험 설계 · 관련 선행연구 · 예상 리스크를 제안해줘.

## 아이디어: ${it.title}
${it.body}

## 참고한 논문
${brainstormPrompt(it.paperIds.map(paperById).filter(Boolean)).split('\n').slice(3).join('\n')}`);
  });
  $('#idel')?.addEventListener('click', async () => {
    if (!confirm('이 아이디어를 삭제할까요?')) return;
    await store.del('ideas', idea.id);
    DB.ideas = DB.ideas.filter(i => i.id !== idea.id);
    location.hash = '#/ideas';
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const it = collect();
    const now = new Date().toISOString();
    it.id = idea.id || uid();
    it.createdAt = idea.createdAt || now;
    it.updatedAt = now;
    try { await store.put('ideas', it); } catch (err) { return toast('저장 실패: ' + err.message); }
    const i = DB.ideas.findIndex(x => x.id === it.id);
    if (i >= 0) DB.ideas[i] = it; else DB.ideas.push(it);
    toast('아이디어를 저장했어요 🌱');
    location.hash = '#/ideas';
  });
}

function notFound(v) {
  v.innerHTML = emptyState('페이지를 찾을 수 없어요 😿', '<a class="btn" href="#/">홈으로</a>');
}

// ---------- router ----------
function route() {
  const h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  const v = $('#view');
  pageListeners.forEach(([t, f]) => document.removeEventListener(t, f));
  pageListeners = [];
  const navKey = { undefined: 'home', list: 'list', paper: 'list', clusters: 'clusters', ideas: 'ideas', idea: 'ideas' }[parts[0]];
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === navKey));
  if (parts[0] !== 'list') $('#searchInput').value = '';
  switch (parts[0]) {
    case undefined: renderHome(v); break;
    case 'list': renderList(v, params); break;
    case 'add': renderForm(v); break;
    case 'edit': renderForm(v, parts[1]); break;
    case 'paper': renderPaper(v, parts[1]); break;
    case 'clusters': renderClusters(v); break;
    case 'ideas': renderIdeas(v); break;
    case 'idea': renderIdeaForm(v, parts[1], params); break;
    default: notFound(v);
  }
  window.scrollTo(0, 0);
}

function renderLogin() {
  document.body.classList.add('logged-out');
  $('#view').innerHTML = `
    <div class="box login">
      ${sprite('cat', 84, {}, 'bob')}
      <h2>PaperDex 로그인</h2>
      <form id="loginForm">
        <input type="email" name="email" placeholder="이메일" required autocomplete="username">
        <input type="password" name="password" placeholder="비밀번호" required autocomplete="current-password">
        <button class="btn btn-pink" type="submit">로그인</button>
      </form>
      <p class="hint" id="loginErr"></p>
    </div>`;
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: fd.get('email'), password: fd.get('password') });
    if (error) { $('#loginErr').textContent = '😿 ' + error.message; return; }
    location.reload();
  });
}

async function init() {
  $('#logoSprite').innerHTML = sprite('cat', 30, {}, 'bob');
  $('#exportBtn').addEventListener('click', exportData);
  const themeLabel = () => { $('#themeBtn').textContent = document.documentElement.dataset.theme === 'pixel' ? '🎨 픽셀' : '🎨 소프트'; };
  themeLabel();
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'pixel' ? 'soft' : 'pixel';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('paperdex.theme', next);
    themeLabel();
    toast(next === 'pixel' ? '픽셀 테마로 바꿨어요 👾' : '소프트 테마로 바꿨어요 ☁️');
  });
  $('#searchForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    location.hash = q ? '#/list?q=' + encodeURIComponent(q) : '#/list';
  });
  $('#importInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      toast('가져오는 중…');
      const r = await importData(data);
      DB = await store.load();
      analyze();
      route();
      toast(`가져오기 완료: 논문 ${r.papers}편 · 아이디어 ${r.ideas}개`);
    } catch (err) { toast('가져오기 실패: ' + err.message); }
    e.target.value = '';
  });
  if (CLOUD) {
    if (!window.supabase) {
      $('#view').innerHTML = `<div class="box err">${sprite('catSleep', 60)} Supabase 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인해주세요.</div>`;
      return;
    }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return renderLogin();
    sbUser = session.user;
    $('#storageInfo').innerHTML = `☁️ ${esc(sbUser.email)} 계정에 저장 중 · <a class="linkbtn" id="logoutBtn">로그아웃</a>`;
    $('#logoutBtn').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
  }
  try {
    DB = await store.load();
  } catch (err) {
    $('#view').innerHTML = CLOUD
      ? `<div class="box err">${sprite('catSleep', 60)} 데이터를 불러오지 못했어요: ${esc(err.message)}</div>`
      : `<div class="box err">${sprite('catSleep', 60)} 서버에 연결할 수 없어요. 터미널에서 <code>python3 ~/paperdex/server.py</code> 를 실행해주세요.</div>`;
    return;
  }
  analyze();
  window.addEventListener('hashchange', route);
  route();
}

init();
