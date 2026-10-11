/* 키워드(TF-IDF) 기반 클러스터링 + 유사 논문 + 2D 지도(MDS) */
const Cluster = (() => {
  const STOP = new Set(`the and for with from that this these those its our their them which who what when where how why
    can could should would may might will shall does did done not yes than then such via using use used based into over under
    between about also more most less very much many some any each other new paper method methods approach model models
    propose proposed show shows result results task tasks work works however while both all only one two three first second
    et al figure table section https http www com org arxiv abs pdf html said you chatgpt user assistant like just get got
    make made think know really here there what's it's don't i'm let's are was were been being has have had your yours
    because so if but out up down off again further once same own too can't won't isn't`.split(/\s+/).filter(Boolean));
  const KO_STOP = new Set(['그리고', '하지만', '그래서', '이것', '저것', '그것', '있는', '없는', '하는', '되는', '이런',
    '저런', '그런', '같은', '통해', '대한', '위해', '때문', '경우', '정도', '부분', '이제', '바로', '정말', '진짜', '그냥',
    '근데', '아니', '이건', '그건', '논문', '방법', '모델', '결과', '사용', '제안', '있다', '한다', '된다', '합니다', '입니다',
    '있습니다', '나의', '여기', '어떻게', '무엇', '이렇게', '그렇게', '즉', '또한', '그러면', '그럼', '이게', '거의', '조금']);
  const PARTICLES = ['으로써', '으로서', '에서는', '이라는', '에게서', '입니다', '합니다', '라는', '으로', '에서', '에게',
    '까지', '부터', '처럼', '보다', '하고', '이나', '이랑', '하는', '하면', '은', '는', '이', '가', '을', '를', '의',
    '에', '로', '와', '과', '도', '만'];
  const FIELDS = [['title', 3], ['summary', 2], ['abstract', 1.5], ['intuition', 1], ['ideaSeeds', 1],
    ['questions', 0.5], ['conversation', 0.3]];

  function tokenize(text) {
    const out = [];
    if (!text) return out;
    const t = String(text).toLowerCase();
    for (const m of t.matchAll(/[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g)) {
      let w = m[0];
      if (w.length < 3 || STOP.has(w)) continue;
      if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
      out.push(w);
    }
    for (const m of t.matchAll(/[가-힣]{2,}/g)) {
      let w = m[0];
      for (const p of PARTICLES) {
        if (w.length - p.length >= 2 && w.endsWith(p)) { w = w.slice(0, -p.length); break; }
      }
      if (w.length >= 2 && !KO_STOP.has(w)) out.push(w);
    }
    return out;
  }

  function normalize(m) {
    let norm = 0;
    for (const w of m.values()) norm += w * w;
    norm = Math.sqrt(norm) || 1;
    for (const [k, w] of m) m.set(k, w / norm);
    return m;
  }

  function dot(a, b) {
    if (a.size > b.size) [a, b] = [b, a];
    let s = 0;
    for (const [k, w] of a) { const v = b.get(k); if (v) s += w * v; }
    return s;
  }

  function vectorize(papers) {
    const tfs = papers.map(p => {
      const tf = new Map();
      for (const [f, w] of FIELDS) for (const tok of tokenize(p[f])) tf.set(tok, (tf.get(tok) || 0) + w);
      for (const tag of p.tags || []) {
        const k = '#' + tag.toLowerCase();
        tf.set(k, (tf.get(k) || 0) + 6);
      }
      return tf;
    });
    const df = new Map();
    tfs.forEach(tf => { for (const k of tf.keys()) df.set(k, (df.get(k) || 0) + 1); });
    const N = papers.length;
    return tfs.map(tf => {
      const v = new Map();
      for (const [k, c] of tf) v.set(k, Math.log1p(c) * Math.log((N + 1) / df.get(k)));
      return normalize(v);
    });
  }

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // spherical k-means with k-means++ init
  function kmeans(vecs, k, seed) {
    const rnd = mulberry32(seed);
    const n = vecs.length;
    const cents = [vecs[Math.floor(rnd() * n)]];
    while (cents.length < k) {
      const d = vecs.map(v => Math.max(0, 1 - Math.max(...cents.map(c => dot(v, c)))));
      const sum = d.reduce((a, b) => a + b, 0);
      let i = Math.floor(rnd() * n);
      if (sum > 1e-9) {
        let r = rnd() * sum;
        for (i = 0; i < n - 1; i++) { r -= d[i]; if (r <= 0) break; }
      }
      cents.push(vecs[i]);
    }
    const assign = new Array(n).fill(-1);
    for (let it = 0; it < 40; it++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let bi = 0, bs = -Infinity;
        for (let c = 0; c < k; c++) { const s = dot(vecs[i], cents[c]); if (s > bs) { bs = s; bi = c; } }
        if (assign[i] !== bi) { assign[i] = bi; changed = true; }
      }
      if (!changed) break;
      for (let c = 0; c < k; c++) {
        const m = new Map();
        let cnt = 0;
        for (let i = 0; i < n; i++) {
          if (assign[i] !== c) continue;
          cnt++;
          for (const [t, w] of vecs[i]) m.set(t, (m.get(t) || 0) + w);
        }
        cents[c] = cnt ? normalize(m) : vecs[Math.floor(rnd() * n)];
      }
    }
    let score = 0;
    for (let i = 0; i < n; i++) score += dot(vecs[i], cents[assign[i]]);
    return { assign, cents, score };
  }

  function labelFor(cent, idxs, papers) {
    const tagCount = new Map();
    idxs.forEach(i => (papers[i].tags || []).forEach(t => tagCount.set(t, (tagCount.get(t) || 0) + 1)));
    const minCount = Math.max(1, Math.ceil(idxs.length / 2));
    const tags = [...tagCount.entries()].filter(([, c]) => c >= minCount).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const terms = [...cent.entries()].filter(([k]) => !k.startsWith('#')).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
    const label = [...new Set([...tags, ...terms].map(t => t.toLowerCase()))].slice(0, 3).join(' · ') || '기타';
    return { label, tags, terms };
  }

  function analyze(papers, k) {
    const n = papers.length;
    if (!n) return { k: 0, clusters: [], assign: new Map(), related: new Map(), sims: [] };
    k = Math.max(1, Math.min(k, n));
    const vecs = vectorize(papers);
    let best = null;
    for (let s = 1; s <= 6; s++) {
      const r = kmeans(vecs, k, s * 7919);
      if (!best || r.score > best.score) best = r;
    }
    const groups = new Map();
    best.assign.forEach((c, i) => { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(i); });
    const clusters = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([c, idxs], ci) => ({ idx: ci, paperIds: idxs.map(i => papers[i].id), ...labelFor(best.cents[c], idxs, papers) }));
    const assign = new Map();
    clusters.forEach(cl => cl.paperIds.forEach(id => assign.set(id, cl)));

    const sims = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      sims[i][i] = 1;
      for (let j = i + 1; j < n; j++) sims[i][j] = sims[j][i] = dot(vecs[i], vecs[j]);
    }
    const related = new Map();
    papers.forEach((p, i) => {
      related.set(p.id, sims[i]
        .map((s, j) => ({ id: papers[j].id, sim: s, j }))
        .filter(x => x.j !== i && x.sim > 0.02)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 6));
    });
    return { k, clusters, assign, related, sims };
  }

  // classical MDS on cosine distance → [[x, y], ...]
  function mds(sims) {
    const n = sims.length;
    if (n === 0) return [];
    if (n === 1) return [[0, 0]];
    const D2 = sims.map(r => r.map(s => { const d = Math.max(0, 1 - s); return d * d; }));
    const rowMean = D2.map(r => r.reduce((a, b) => a + b, 0) / n);
    const all = rowMean.reduce((a, b) => a + b, 0) / n;
    const B = D2.map((r, i) => r.map((v, j) => -0.5 * (v - rowMean[i] - rowMean[j] + all)));
    const eig = [];
    for (let e = 0; e < 2; e++) {
      let v = Array.from({ length: n }, (_, i) => Math.sin(i * 12.9898 + e * 78.233 + 1));
      let lam = 0;
      for (let it = 0; it < 100; it++) {
        const w = B.map(r => r.reduce((a, b, j) => a + b * v[j], 0));
        for (const [pl, pv] of eig) {
          const d = pv.reduce((a, b, j) => a + b * v[j], 0);
          for (let j = 0; j < n; j++) w[j] -= pl * d * pv[j];
        }
        const norm = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
        if (norm < 1e-12) break;
        lam = norm;
        v = w.map(x => x / norm);
      }
      eig.push([lam, v]);
    }
    return Array.from({ length: n }, (_, i) => [
      eig[0][1][i] * Math.sqrt(eig[0][0]),
      eig[1][1][i] * Math.sqrt(eig[1][0]),
    ]);
  }

  const autoK = n => Math.max(1, Math.min(n, Math.round(Math.sqrt(n / 2))));

  return { analyze, mds, autoK, tokenize };
})();
