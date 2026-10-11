/* 픽셀 스프라이트: 문자 그리드 → SVG. '.' 은 투명 */
const INK = '#3b2f4a';

const SPRITES = {
  cat: {
    pal: { o: INK, w: '#fff3e0', p: '#ffb3c7', k: INK, c: '#ffb3c7' },
    grid: [
      '.oo........oo.',
      '.opo......opo.',
      '.owwoooooowwo.',
      'owwwwwwwwwwwwo',
      'owwkwwwwwwkwwo',
      'owwkwwwwwwkwwo',
      'ocwwwwkkwwwwco',
      'owwwwwwwwwwwwo',
      '.owwwwwwwwwwo.',
      '..oooooooooo..',
    ],
  },
  catSleep: {
    pal: { o: INK, w: '#fff3e0', p: '#ffb3c7', k: INK, c: '#ffb3c7' },
    grid: [
      '.oo........oo.',
      '.opo......opo.',
      '.owwoooooowwo.',
      'owwwwwwwwwwwwo',
      'owwwwwwwwwwwwo',
      'owkkwwwwwwkkwo',
      'ocwwwwwwwwwwco',
      'owwwwwkkwwwwwo',
      '.owwwwwwwwwwo.',
      '..oooooooooo..',
    ],
  },
  slime: {
    pal: { o: INK, '#': '#7ee0c3', h: '#ffffff', k: INK, c: '#ff9ec4' },
    grid: [
      '....oooo....',
      '..oo####oo..',
      '.o###hh###o.',
      '.o##h#####o.',
      'o##########o',
      'o##k####k##o',
      'o##k####k##o',
      'o#c######c#o',
      'o####kk####o',
      '.oooooooooo.',
    ],
  },
  ghost: {
    pal: { o: INK, w: '#f4f1ff', k: INK, c: '#c7a8ff' },
    grid: [
      '...oooooo...',
      '..owwwwwwo..',
      '.owwwwwwwwo.',
      '.owkwwwwkwo.',
      '.owkwwwwkwo.',
      '.ocwwwwwwco.',
      '.owwwkkwwwo.',
      '.owwwwwwwwo.',
      '.owwowwowwo.',
      '.oo.oooo.oo.',
    ],
  },
  bunny: {
    pal: { o: INK, w: '#ffffff', p: '#ffc4d6', k: INK, c: '#ffb3c7' },
    grid: [
      '..oo....oo..',
      '..opo..opo..',
      '..opo..opo..',
      '..owoooowo..',
      '.owwwwwwwwo.',
      'owwwwwwwwwwo',
      'owwkwwwwkwwo',
      'owcwwppwwcwo',
      'owwwwwwwwwwo',
      '.owwwwwwwwo.',
      '..oooooooo..',
    ],
  },
  chick: {
    pal: { o: INK, y: '#ffe27a', k: INK, a: '#ff9f4a', c: '#ffb3c7' },
    grid: [
      '...oooo...',
      '..oyyyyo..',
      '.oyyyyyyo.',
      '.oykyykyo.',
      'oyyyaayyyo',
      'oycyyyycyo',
      '.oyyyyyyo.',
      '..oooooo..',
      '...a..a...',
    ],
  },
  flame: {
    pal: { r: '#ff6b4a', y: '#ffd23f', w: '#fff6d6' },
    grid: [
      '...r....',
      '...rr...',
      '..rrr.r.',
      '.rryrrr.',
      '.ryyyrr.',
      'rryyyyrr',
      'ryywyyyr',
      'ryywwyyr',
      '.ryyyyr.',
      '..rrrr..',
    ],
  },
  star: {
    pal: { y: '#ffd23f' },
    grid: [
      '....y....',
      '...yyy...',
      'yyyyyyyyy',
      '.yyyyyyy.',
      '..yyyyy..',
      '.yyy.yyy.',
      'yy.....yy',
    ],
  },
  bulb: {
    pal: { o: INK, y: '#ffe27a', w: '#ffffff', g: '#a59cb5' },
    grid: [
      '..oooo..',
      '.oyyyyo.',
      'oyywyyyo',
      'oywyyyyo',
      'oyyyyyyo',
      '.oyyyyo.',
      '..oyyo..',
      '..oggo..',
      '..oggo..',
      '...oo...',
    ],
  },
  seed: {
    pal: { b: '#a0703c', B: '#d9a066' },
    grid: ['..bb..', '.bBBb.', 'bBBBBb', 'bBBBBb', '.bBBb.', '..bb..'],
  },
  sprout: {
    pal: { g: '#3f9a3a', G: '#8fdc6a', b: '#a0703c', B: '#d9a066' },
    grid: [
      '.gg..gg.',
      'gGGggGGg',
      '.gGggGg.',
      '...gg...',
      '...gg...',
      '.bbbbbb.',
      '.bBBBBb.',
      '..bbbb..',
    ],
  },
  tree: {
    pal: { g: '#2f7d32', G: '#7bd35a', b: '#8a5a2b' },
    grid: [
      '...gggg...',
      '..gGGGGg..',
      '.gGGgGGGg.',
      'gGGGGGgGGg',
      'gGgGGGGGGg',
      '.gGGGGGGg.',
      '..gggggg..',
      '....bb....',
      '....bb....',
      '...bbbb...',
    ],
  },
};

const CLUSTER_COLORS = ['#7ee0c3', '#ff9ec4', '#8ecbff', '#ffd86b', '#c7a8ff', '#ffab76',
  '#a3e86b', '#7fd6f0', '#f59bdc', '#b5b5ff', '#ffc2a1', '#9be0a0'];
const clusterColor = i => CLUSTER_COLORS[i % CLUSTER_COLORS.length];

function sprite(name, size = 48, palOverride = {}, cls = '') {
  const s = SPRITES[name];
  if (!s) return '';
  const pal = { ...s.pal, ...palOverride };
  const h = s.grid.length;
  const w = Math.max(...s.grid.map(r => r.length));
  let rects = '';
  s.grid.forEach((row, y) => [...row].forEach((ch, x) => {
    if (pal[ch]) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${pal[ch]}"/>`;
  }));
  return `<svg class="sprite ${cls}" viewBox="0 0 ${w} ${h}" width="${size}" height="${Math.round(size * h / w)}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

const slimeIcon = (idx, size = 24, cls = '') => sprite('slime', size, { '#': clusterColor(idx) }, cls);
