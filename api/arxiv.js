// Vercel 서버리스 함수: GET /api/arxiv?q=<arXiv 링크 또는 ID>  (로컬 server.py 의 fetch_arxiv 와 동일)
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const clean = s => decode(s || '').replace(/\s+/g, ' ').trim();

module.exports = async (req, res) => {
  const q = String(req.query.q || '');
  const m = q.match(/(\d{4}\.\d{4,5})(v\d+)?/) || q.match(/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})/);
  if (!m) return res.status(404).json({ error: 'arXiv ID를 찾을 수 없어요' });
  const aid = m[1];
  try {
    const r = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(aid)}`, { headers: { 'User-Agent': 'PaperDex/1.0' } });
    const entry = (await r.text()).split('<entry>')[1];
    const get = tag => (entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
    const title = clean(get('title'));
    if (!entry || !title || title === 'Error') return res.status(404).json({ error: 'arXiv에서 논문을 찾지 못했어요' });
    const published = get('published');
    res.status(200).json({
      arxivId: aid,
      title,
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(x => clean(x[1])).join(', '),
      abstract: clean(get('summary')),
      venue: published ? `arXiv ${published.slice(0, 4)}` : 'arXiv',
      url: `https://arxiv.org/abs/${aid}`,
    });
  } catch (e) {
    res.status(502).json({ error: `arXiv 요청 실패: ${e.message}` });
  }
};
