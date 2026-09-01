/* ===========================
   bitcoincash.ee Pool — App
   =========================== */

const API_BASE = 'https://testnet4.bitcoincash.ee';
const EXPLORER_BLOCK_URL = 'https://bchexplorer.cash/testnet4/block';
const CHART_URL = 'https://poolstats.solochance.org/testnet4-bitcoincashee.json';

// ── Disclaimer ───────────────────────────────────────────

const DISCLAIMER_HTML = `
  <span class="disclaimer-icon">⚠️</span>
  <div>
    <strong>Disclaimer</strong>
    <p>Participation in Bitcoin Cash mining, including through bitcoincash.ee Pool, which is still considered in beta testing, involves risks such as market volatility, hardware failure, and changes in network difficulty. bitcoincash.ee Pool is in beta and <span class="disclaimer-block-clause">has not yet found a block</span>; there is no assurance of future block discoveries or payouts. Users should exercise caution and consider their financial situation before engaging in mining activities.</p>
    <p style="margin-top:.75rem">bitcoincash.ee Pool shall not be held responsible for any losses, missed payouts, technical failures, or interruptions of service of any kind.</p>
  </div>
`;

document.querySelectorAll('.disclaimer-placeholder').forEach(el => {
  el.className = 'disclaimer';
  el.innerHTML = DISCLAIMER_HTML;
});

// Filled in once the live found-blocks count loads (see loadPoolStats) —
// starts as the "beta, nothing found yet" wording so it's never wrong
// before that first fetch resolves, on a pool that in fact hasn't found one.
function updateDisclaimerBlockCount(count) {
  const clause = count > 0
    ? `has found ${count} block${count === 1 ? '' : 's'} so far`
    : 'has not yet found a block';
  document.querySelectorAll('.disclaimer-block-clause').forEach(el => { el.textContent = clause; });
}

let topSharesPromise = null;

// ── pool/blocks/ (found blocks) ──────────────────────────────
// /pool/blocks/ is an nginx autoindex JSON listing of one file per found
// block, named "<height>.confirmed" or "<height>.unconfirmed". The listing
// itself carries no block data — each file has to be fetched separately for
// its hash/finder/time.

let foundBlocksPromise = null;

function parseBlockEntry(entry) {
  const m = /^(\d+)\.(confirmed|unconfirmed)$/.exec(entry.name ?? '');
  if (!m) return null;
  return { name: entry.name, height: parseInt(m[1], 10), confirmed: m[2] === 'confirmed' };
}

// Not cached beyond de-duping simultaneous callers — loadPoolStats() polls
// this every 30s for the home page's live block count, so a persistent
// cache would freeze that count at whatever it read on the first load.
function getFoundBlocks() {
  if (!foundBlocksPromise) {
    foundBlocksPromise = fetch(`${API_BASE}/pool/blocks/`, { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(entries => (Array.isArray(entries) ? entries : [])
        .filter(e => e.type === 'file')
        .map(parseBlockEntry)
        .filter(Boolean)
        .sort((a, b) => a.height - b.height))
      .finally(() => { foundBlocksPromise = null; });
  }
  return foundBlocksPromise;
}

const blockDetailsCache = new Map();

function getBlockDetails(entry) {
  if (!blockDetailsCache.has(entry.name)) {
    blockDetailsCache.set(entry.name, fetch(`${API_BASE}/pool/blocks/${entry.name}`, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : null)
      .then(data => ({ ...entry, ...data }))
      .catch(() => entry));
  }
  return blockDetailsCache.get(entry.name);
}

// ── State ────────────────────────────────────────────────

let poolLns          = null;  // total pool shares (herp) — set when pool stats load
let poolReward       = null;  // actual block reward from API
let userPayoutFinder = null;  // BCH payout if user finds block
let userPayoutShare  = null;  // BCH payout if someone else finds block
let bchPrice         = null;  // BCH price in USD
let blocksLoaded     = false;
let bestSharesLoaded = false;
let bsSortCol = 'bestshare'; // 'bestshare' | 'hashrate' — Best Share is the default sort
let bsSortDir = 'desc';      // 'desc' | 'asc'
let bsTop13 = null;          // cached rows for re-sorting without refetching
let bsRest  = null;
let bsTotalBtc = null;       // cached "sum of all coinbase outputs" — re-rendered if price arrives after this table already painted
let bsFinder = null, bsPoolFee = null, bsNetworkDiff = null;
let bsUsersCount = null, bsWorkersCount = null, bsHashrateDisplay = null;
let bsHashbackWinnerAddress = null; // address of the mainnet Hashback Bonus's current pick, if it also shows up here
const HASHBACK_HISTORY_URL = 'https://poolstats.solochance.org/bitcoincashee-hashback-history.json';
const BLOCKS_PAGE_SIZE = 10;
let allBlockEntries   = null; // newest-first, populated once per page load
let currentBlocksPage = 1;
let lastLookupAddr    = null; // guards against routeFromHash() re-triggering doLookup()

// Declared here (rather than down in their own sections) because
// routeFromHash() can call doLookup() synchronously at script load — on a
// "#mystats/<address>" deep link — and doLookup() reads all four of these.
// Declaring them later would leave them in the temporal dead zone at that
// point and throw a ReferenceError.
const lookupBtn  = document.getElementById('lookup-btn');
const addrInput  = document.getElementById('address-input');
const FINDER_CAPTION = '1 BCH bonus + your share';
const SHARE_CAPTION  = 'your Best 13 rank payout';

// ── Navigation ──────────────────────────────────────────

const navBtns = document.querySelectorAll('.nav-btn');
const sections = document.querySelectorAll('.section');
const VALID_SECTIONS = ['home', 'connect', 'mystats', 'blocks', 'bestshares', 'faq'];

// Set by routeFromHash() when a "blocks/<n>" deep link is opened before the
// block list has loaded; loadBlocks() consumes it once entries are fetched.
let pendingBlocksPage = null;

// Reassigned once the chart module below finishes initializing. showSection()
// runs synchronously during the initial routeFromHash() call, which happens
// before that module's `let`/`const` declarations further down the script
// have executed — referencing it here directly would throw (temporal dead
// zone) and abort the rest of the script. This indirection stays a no-op
// until the chart module is ready, then re-renders on later (post-load)
// navigations whenever Home is shown again.
let refreshPoolChartOnShow = () => {};

function showSection(id) {
  sections.forEach(s => s.classList.toggle('active', s.id === id));
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.section === id));
  if (id === 'blocks') loadBlocks();
  if (id === 'bestshares') loadBestShares();
  if (id === 'home') refreshPoolChartOnShow();
}

// Navigating always goes through the URL hash, so the current section (and,
// for Blocks, the current page) is always copyable and survives a reload.
// Setting the same hash again wouldn't fire 'hashchange', so show directly.
function navigateTo(id) {
  const current = location.hash.replace('#', '').split('/')[0] || 'home';
  if (current === id) showSection(id);
  else location.hash = id;
}

navBtns.forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.section));
});

// Handle hash-based navigation — also supports "blocks/<page>" deep links
function routeFromHash() {
  const raw = location.hash.replace('#', '') || 'home';
  const [id, rest] = raw.split('/');
  const section = VALID_SECTIONS.includes(id) ? id : 'home';

  if (section === 'blocks' && rest) {
    const page = parseInt(rest, 10);
    if (page > 0) {
      if (allBlockEntries) { currentBlocksPage = page; renderBlocksPage(); }
      else pendingBlocksPage = page;
    }
  }

  // "#mystats/<address>" deep-links straight into a lookup. Using
  // getElementById here (instead of the addrInput const) since this can run
  // before that const's declaration further down the file has executed.
  if (section === 'mystats' && rest) {
    const addr = decodeURIComponent(rest);
    if (addr && addr !== lastLookupAddr) {
      document.getElementById('address-input').value = addr;
      doLookup();
    }
  }

  showSection(section);
}
window.addEventListener('hashchange', routeFromHash);
routeFromHash();

// ── Config tabs ──────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    const card = btn.closest('.card');
    card.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    card.querySelectorAll('.config-block').forEach(block => {
      block.classList.toggle('active', block.id === `tab-${tab}`);
    });
  });
});

// FAQ internal nav buttons
document.querySelectorAll('.faq-link-btn').forEach(btn => {
  btn.addEventListener('click', () => navigateTo(btn.dataset.section));
});

// Make Bitaxe / Avalon / NiceHash inputs selectable for easy copy
document.querySelectorAll('.bitaxe-field input, .avalon-field input, .braiins-field input, .nicehash-field input').forEach(input => {
  input.addEventListener('click', () => input.select());
});

// ── Pool Stats ──────────────────────────────────────────

function hashrateToHps(str) {
  if (str == null) return 0;
  if (typeof str === 'number') return str;
  const match = String(str).match(/^([\d.]+)\s*([KMGTP]?)$/i);
  if (!match) return 0;
  const units = { '': 1, 'K': 1e3, 'M': 1e6, 'G': 1e9, 'T': 1e12, 'P': 1e15 };
  return parseFloat(match[1]) * (units[match[2].toUpperCase()] ?? 1);
}

function parseHashrateStr(str) {
  const hps = hashrateToHps(str);
  return hps > 0 ? formatHashrate(hps) : '0 H/s';
}

function formatHashrate(hps) {
  if (hps == null || isNaN(hps)) return '—';
  if (hps >= 1e18) return (hps / 1e18).toFixed(2) + ' EH/s';
  if (hps >= 1e15) return (hps / 1e15).toFixed(2) + ' PH/s';
  if (hps >= 1e12) return (hps / 1e12).toFixed(2) + ' TH/s';
  if (hps >= 1e9)  return (hps / 1e9).toFixed(2)  + ' GH/s';
  if (hps >= 1e6)  return (hps / 1e6).toFixed(2)  + ' MH/s';
  if (hps >= 1e3)  return (hps / 1e3).toFixed(2)  + ' KH/s';
  return hps.toFixed(0) + ' H/s';
}

function formatDiffCompact(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return (n / 1e9).toFixed(2)  + 'G';
  if (n >= 1e6)  return (n / 1e6).toFixed(2)  + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(2)  + 'K';
  return n.toFixed(0);
}

function formatUptime(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} ${d === 1 ? 'day' : 'days'}`;
  if (h > 0) return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

function setStatValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const valEl = el.querySelector('.stat-value');
  if (valEl) {
    valEl.textContent = value;
    valEl.classList.remove('skeleton');
  }
}

async function loadPoolStats() {
  try {
    const resp = await fetch(`${API_BASE}/pool/pool.status`, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();

    // API returns multiple JSON objects separated by newlines — merge them all
    const pool = {};
    text.trim().split('\n').forEach(line => {
      try { Object.assign(pool, JSON.parse(line)); } catch {}
    });

    setStatValue('stat-hashrate', parseHashrateStr(pool.hashrate5m ?? pool.hashrate1m));
    setStatValue('stat-workers',  pool.Workers  ?? pool.workers  ?? '—');
    setStatValue('stat-uptime',   formatUptime(pool.runtime));
    setStatValue('stat-bestshare', formatDiffCompact(pool.bestshare));
    getFoundBlocks()
      .then(blocks => {
        setStatValue('stat-blocks', blocks.length);
        updateDisclaimerBlockCount(blocks.length);
        // Piggyback the chart's block markers on this same poll rather than
        // running a second, independent poll of the same (uncached) listing.
        updateChartBlocks(blocks);
      })
      .catch(() => setStatValue('stat-blocks', pool.blocks ?? 0));

    const effort = parseFloat(pool.diff ?? pool.difficulty);
    setStatValue('stat-effort', effort > 0 ? effort + '%' : '< 0.01%');

    poolLns    = pool.herp ?? pool.lns ?? pool.shares ?? null;
    poolReward = pool.reward ?? null;

    const hashrate = pool.hashrate5m ?? pool.hashrate1m;
    if (hashrateToHps(hashrate)) loadDailyLuck(hashrate);
    // loadDailyLuck() is the only place that fetches price/network hashrate,
    // but it's skipped whenever the pool has no recent hashrate (e.g. a
    // quiet testnet pool between miners) — fetch them on their own then, so
    // they never silently stay blank just because nobody happened to be mining.
    else fetchPriceAndNetworkHashrate();

    document.getElementById('pool-status-banner').classList.add('hidden');

  } catch (err) {
    console.warn('Pool status unavailable:', err.message);
    showPoolWarming();
  }
}

function showPoolWarming() {
  document.getElementById('pool-status-banner').classList.remove('hidden');
  ['stat-hashrate','stat-workers','stat-blocks','stat-uptime','stat-bestshare','stat-effort','stat-luck','stat-pool-chance-day','stat-pool-chance-week','stat-pool-chance-month'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const v = el.querySelector('.stat-value');
      if (v) { v.textContent = '—'; v.classList.add('skeleton'); }
    }
  });
}

function applyBchPrice(price) {
  if (price == null) return;
  bchPrice = price;
  const priceEl = document.querySelector('#stat-price .stat-value');
  if (priceEl) {
    priceEl.textContent = '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    priceEl.classList.remove('skeleton');
  }
  renderCardThreePayouts();
  // A direct "#bestshares" deep link can render the Best 13 tables before
  // this price fetch (kicked off later, by loadPoolStats()) resolves — when
  // that happens, USD cells are silently omitted and nothing re-renders them
  // afterwards. Re-paint here so a late-arriving price still fills them in.
  renderBsTotalTable();
  renderBsPayoutsTable();
}

// Used both as a fallback when the real-hashrate SoloChance call fails (this
// pool's tiny testnet hashrate seems to trigger intermittent 500s upstream),
// and whenever the pool itself has no recent hashrate to query with at all.
// A fixed, harmless 1 TH/s recovers price and networkHashrate — both are
// independent of the queried hashrate, unlike the luck/chance fields (which
// this response's would be meaningless for at a fake hashrate, so those are
// left untouched).
async function fetchPriceAndNetworkHashrate() {
  try {
    const url  = `https://api.solochance.org/getSoloChanceCalculations?currency=BCH&hashrate=1.000000&hashrateUnit=TH`;
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) return;
    const d = await resp.json();
    applyBchPrice(d.price);
    if (d.networkHashrate != null) {
      setStatValue('stat-nethash', formatHashrate(d.networkHashrate));
    }
  } catch (e) {
    console.warn('Price/network hashrate fallback unavailable:', e.message);
  }
}

async function loadDailyLuck(poolHps) {
  try {
    const thps = hashrateToHps(poolHps) / 1e12;
    const url  = `https://api.solochance.org/getSoloChanceCalculations?currency=BCH&hashrate=${thps.toFixed(6)}&hashrateUnit=TH`;
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) { await fetchPriceAndNetworkHashrate(); return; }
    const d = await resp.json();

    // Expected blocks per day = pool share of network * 144 blocks/day
    const blocksPerDay = d.currentHashrate / d.networkHashrate * 144;

    let display;
    if (blocksPerDay >= 10) {
      display = blocksPerDay.toFixed(0) + ' / day';
    } else if (blocksPerDay >= 1) {
      display = blocksPerDay.toFixed(1) + ' / day';
    } else {
      const days = 1 / blocksPerDay;
      if (days < 2)       display = (days * 24).toFixed(1) + ' hr avg';
      else if (days < 60) display = days.toFixed(1) + ' day avg';
      else                display = (days / 30).toFixed(1) + ' mo avg';
    }

    setStatValue('stat-luck', display);
    setStatValue('stat-pool-chance-day',   d.dayChanceText   ?? '—');
    setStatValue('stat-pool-chance-week',  d.weekChanceText  ?? '—');
    setStatValue('stat-pool-chance-month', d.monthChanceText ?? '—');

    applyBchPrice(d.price);

    if (d.networkHashrate != null) {
      setStatValue('stat-nethash', formatHashrate(d.networkHashrate));
    }

  } catch (e) {
    console.warn('Daily luck unavailable:', e.message);
  }
}

loadPoolStats();
// Refresh every 30 seconds
setInterval(loadPoolStats, 30_000);

// ── Hashrate & Workers chart ──────────────────────────────

const chartSvg         = document.getElementById('pool-chart-svg');
const chartMessage     = document.getElementById('pool-chart-message');
const chartTooltip     = document.getElementById('pool-chart-tooltip');
const chartWrap        = document.getElementById('pool-chart-wrap');
const chartWindowEl    = document.getElementById('chart-window');
const chartCard        = document.querySelector('.chart-card');

const CHART_PAD = { top: 26, right: 46, bottom: 22, left: 50 }; // extra top room for block-height labels
const CHART_MOBILE_BREAKPOINT = '(max-width: 600px)'; // matches style.css's mobile breakpoint
const CHART_WINDOW_MOBILE_MS  = 60 * 60_000;      // 1h on mobile
const CHART_WINDOW_DESKTOP_MS = 3 * 60 * 60_000;  // 3h on desktop

let chartPoints = []; // [{ t: ms, hashrate: hps, workers: n }], oldest first — full, unclamped

function getChartWindowMs() {
  return window.matchMedia(CHART_MOBILE_BREAKPOINT).matches
    ? CHART_WINDOW_MOBILE_MS
    : CHART_WINDOW_DESKTOP_MS;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// Quadratic-through-midpoints spline: each real point becomes a curve
// control point, and the curve passes through the midpoint between each
// consecutive pair. Stays close to the real data (unlike Catmull-Rom, it
// never overshoots on sharp jumps) while rounding off the pointy vertices
// a plain polyline would have at every sample.
function smoothPath(pts) {
  if (pts.length < 3) {
    return 'M' + pts.map(([x, y]) => `${x},${y}`).join(' L ');
  }
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const mx = (cx + nx) / 2;
    const my = (cy + ny) / 2;
    d += ` Q ${cx},${cy} ${mx},${my}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  d += ` L ${lx},${ly}`;
  return d;
}

function formatSpan(ms) {
  const totalMin = Math.max(1, Math.round(ms / 60_000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

let chartBlocks = []; // [{ height, t: ms, confirmed }] — most recently found blocks

// entries is the (ascending by height) list loadPoolStats() already fetches
// every 30s for the live block count — reused here instead of running a
// second, independent poll of the same (uncached) listing. Only the newest
// entries can fall inside the chart's few-hour window, so only fetch details
// for the tail of the list; getBlockDetails() is cached, so repeat calls
// only fetch details for blocks found since the last poll.
async function updateChartBlocks(entries) {
  try {
    const candidates = entries.slice(-60); // covers a 6h window at testnet's find rate with margin
    const details = await Promise.all(candidates.map(getBlockDetails));
    chartBlocks = details
      .map(b => ({
        height: b.height,
        confirmed: b.confirmed,
        t: (b.time ?? b.createdate ?? b.timestamp) * 1000,
      }))
      .filter(b => Number.isFinite(b.t));
    if (chartPoints.length >= 2) renderPoolChart();
  } catch (e) {
    console.warn('Chart blocks unavailable:', e.message);
  }
}

async function loadPoolChart() {
  try {
    const resp = await fetch(CHART_URL, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    chartPoints = (data.points ?? [])
      .map(p => ({
        t: Date.parse(p.capturedAt),
        hashrate: p.hashrate1mHashesPerSec ?? hashrateToHps(p.hashrate1mRaw),
        workers: p.workers ?? 0,
      }))
      .filter(p => !isNaN(p.t))
      .sort((a, b) => a.t - b.t);

    renderPoolChart();
    // Block markers are kept in sync separately, piggybacked on
    // loadPoolStats()'s existing 30s poll of the found-blocks listing —
    // see updateChartBlocks().
  } catch (e) {
    console.warn('Pool chart unavailable:', e.message);
    if (!chartPoints.length) {
      chartSvg.classList.add('hidden');
      chartMessage.classList.remove('hidden');
      chartMessage.textContent = 'Chart unavailable right now — the pool and mining are unaffected.';
    }
  }
}

function renderPoolChart() {
  const windowMs = getChartWindowMs();
  const fullTMax = chartPoints.length ? chartPoints[chartPoints.length - 1].t : 0;
  const cutoff = fullTMax - windowMs;
  const points = chartPoints.filter(p => p.t >= cutoff);

  if (points.length < 2) {
    chartSvg.classList.add('hidden');
    chartMessage.classList.remove('hidden');
    chartMessage.textContent = points.length
      ? 'Gathering chart data — check back in a few minutes. The pool and mining are unaffected.'
      : 'No chart data yet — check back in a few minutes. The pool and mining are unaffected.';
    chartWindowEl.textContent = '';
    return;
  }

  // If the chart is already showing, measure before touching anything else.
  // Mobile browsers can report a transient near-zero box mid-orientation-
  // change (address bar show/hide animation, etc.); committing that size
  // into the viewBox would squash the whole chart into a corner until
  // another resize happens to fire. Bail out and leave the previous render
  // in place — the resize handler's follow-up "settle" pass retries once
  // layout has actually caught up. (This guard is skipped on the very
  // first reveal, where the SVG legitimately measures 0×0 because it's
  // still display:none.)
  const wasVisible = !chartSvg.classList.contains('hidden');
  if (wasVisible) {
    const precheck = chartSvg.getBoundingClientRect();
    if (precheck.width < 50 || precheck.height < 40) return;
  }

  chartMessage.classList.add('hidden');
  chartSvg.classList.remove('hidden');
  chartSvg.innerHTML = '';

  // Match the viewBox to the SVG's actual rendered pixel size so 1 viewBox
  // unit == 1 CSS pixel. Without this, the viewBox aspect ratio (fixed)
  // rarely matches the rendered box's aspect ratio (which varies by screen
  // width), and preserveAspectRatio="none" then scales x and y by different
  // factors — stretching every shape non-uniformly, including <text> glyphs,
  // which is what made axis labels look flattened/squished.
  const rectNow = chartSvg.getBoundingClientRect();
  const vbW = Math.max(Math.round(rectNow.width), 300);
  const vbH = Math.max(Math.round(rectNow.height), 100);
  chartSvg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);

  const { top, right, bottom, left } = CHART_PAD;
  const plotW = vbW - left - right;
  const plotH = vbH - top - bottom;

  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const tSpan = Math.max(tMax - tMin, 1);
  chartWindowEl.textContent = `(last ${formatSpan(tSpan)})`;

  const hrMax = Math.max(...points.map(p => p.hashrate), 1) * 1.15;
  const wMax  = Math.max(...points.map(p => p.workers), 1) * 1.3;

  const xPos  = t => left + ((t - tMin) / tSpan) * plotW;
  const yHr   = h => top + plotH - (h / hrMax) * plotH;
  const yW    = w => top + plotH - (w / wMax) * plotH;

  const blocksInRange = chartBlocks.filter(b => b.t >= tMin && b.t <= tMax);

  // Grid lines + axis labels (3 horizontal bands)
  for (let i = 0; i <= 2; i++) {
    const frac = i / 2;
    const yy = top + plotH * frac;
    chartSvg.appendChild(svgEl('line', {
      class: 'grid-line', x1: left, x2: left + plotW, y1: yy, y2: yy,
    }));
    chartSvg.appendChild(svgEl('text', {
      class: 'axis-label', x: left - 6, y: yy + 3, 'text-anchor': 'end',
    })).textContent = formatHashrate(hrMax * (1 - frac));
    chartSvg.appendChild(svgEl('text', {
      class: 'axis-label', x: left + plotW + 6, y: yy + 3, 'text-anchor': 'start',
    })).textContent = Math.round(wMax * (1 - frac));
  }

  // X-axis time labels (start / mid / end)
  [0, 0.5, 1].forEach(frac => {
    const t = tMin + tSpan * frac;
    chartSvg.appendChild(svgEl('text', {
      class: 'axis-label', x: xPos(t), y: vbH - 6,
      'text-anchor': frac === 0 ? 'start' : frac === 1 ? 'end' : 'middle',
    })).textContent = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  });

  // Found-block guide lines (subtle vertical reference, drawn behind the data)
  blocksInRange.forEach(b => {
    const bx = xPos(b.t);
    chartSvg.appendChild(svgEl('line', {
      class: 'block-line', x1: bx, x2: bx, y1: top, y2: top + plotH,
    }));
  });

  // Hashrate area + line
  const hrPts = points.map(p => [xPos(p.t), yHr(p.hashrate)]);
  const hrLineD = smoothPath(hrPts);
  const areaD = `${hrLineD} L ${left + plotW},${top + plotH} L ${left},${top + plotH} Z`;
  chartSvg.appendChild(svgEl('path', { class: 'hashrate-area', d: areaD }));
  chartSvg.appendChild(svgEl('path', { class: 'hashrate-line', d: hrLineD }));

  // Workers line
  const wPts = points.map(p => [xPos(p.t), yW(p.workers)]);
  chartSvg.appendChild(svgEl('path', { class: 'workers-line', d: smoothPath(wPts) }));

  // Interactive crosshair + tooltip
  const crosshair = svgEl('line', { class: 'crosshair', x1: 0, x2: 0, y1: top, y2: top + plotH, opacity: 0 });
  const dotHr = svgEl('circle', { class: 'dot-hashrate', r: 3.5, opacity: 0 });
  const dotW  = svgEl('circle', { class: 'dot-workers', r: 3, opacity: 0 });
  chartSvg.appendChild(crosshair);
  chartSvg.appendChild(dotHr);
  chartSvg.appendChild(dotW);

  const overlay = svgEl('rect', { x: left, y: top, width: plotW, height: plotH, fill: 'transparent' });
  chartSvg.appendChild(overlay);

  // Found-block markers, drawn last so they sit above the overlay and stay
  // hoverable (native <title> tooltip) even where they cross the data.
  // Height labels are skipped where blocks are too close together to avoid
  // overlapping text — the tick + dot still mark every block either way.
  let lastLabelX = -Infinity;
  const minLabelGap = 34;
  blocksInRange.forEach(b => {
    const bx = xPos(b.t);
    const dotClass = 'block-dot' + (b.confirmed ? '' : ' unconfirmed');
    const dot = svgEl('circle', { class: dotClass, cx: bx, cy: top, r: 3 });
    const dotTitle = svgEl('title', {});
    const timeLabel = new Date(b.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    dotTitle.textContent = `Block #${b.height} — ${timeLabel}${b.confirmed ? '' : ' (unconfirmed)'}`;
    dot.appendChild(dotTitle);
    chartSvg.appendChild(dot);

    if (bx - lastLabelX >= minLabelGap) {
      chartSvg.appendChild(svgEl('text', {
        class: 'block-label', x: bx, y: top - 8, 'text-anchor': 'middle',
      })).textContent = '#' + b.height;
      lastLabelX = bx;
    }
  });

  function showPoint(clientX) {
    const rect = chartSvg.getBoundingClientRect();
    const svgX = (clientX - rect.left) * (vbW / rect.width);
    const frac = Math.min(Math.max((svgX - left) / plotW, 0), 1);
    const targetT = tMin + tSpan * frac;

    let nearest = points[0];
    let bestDiff = Infinity;
    for (const p of points) {
      const diff = Math.abs(p.t - targetT);
      if (diff < bestDiff) { bestDiff = diff; nearest = p; }
    }

    const px = xPos(nearest.t);
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.setAttribute('opacity', 1);
    dotHr.setAttribute('cx', px);
    dotHr.setAttribute('cy', yHr(nearest.hashrate));
    dotHr.setAttribute('opacity', 1);
    dotW.setAttribute('cx', px);
    dotW.setAttribute('cy', yW(nearest.workers));
    dotW.setAttribute('opacity', 1);

    const wrapRect = chartWrap.getBoundingClientRect();
    const tooltipX = (rect.left - wrapRect.left) + (px / vbW) * rect.width;
    const tooltipY = (rect.top - wrapRect.top) + (yHr(nearest.hashrate) / vbH) * rect.height;

    chartTooltip.style.left = tooltipX + 'px';
    chartTooltip.style.top  = Math.max(tooltipY - 12, 0) + 'px';
    chartTooltip.innerHTML = `
      <div class="tooltip-time">${new Date(nearest.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</div>
      <div class="tooltip-hashrate">⬤ ${formatHashrate(nearest.hashrate)}</div>
      <div class="tooltip-workers">⬤ ${nearest.workers} worker${nearest.workers === 1 ? '' : 's'}</div>
    `;
    chartTooltip.classList.remove('hidden');
  }

  function hidePoint() {
    crosshair.setAttribute('opacity', 0);
    dotHr.setAttribute('opacity', 0);
    dotW.setAttribute('opacity', 0);
    chartTooltip.classList.add('hidden');
  }

  overlay.addEventListener('mousemove', e => showPoint(e.clientX));
  overlay.addEventListener('mouseleave', hidePoint);
  overlay.addEventListener('touchstart', e => { const t = e.touches[0]; if (t) showPoint(t.clientX); }, { passive: true });
  overlay.addEventListener('touchmove',  e => { const t = e.touches[0]; if (t) showPoint(t.clientX); }, { passive: true });
  overlay.addEventListener('touchend', hidePoint);
}

loadPoolChart();
// Refresh every minute — the source data updates on the same cadence
setInterval(loadPoolChart, 60_000);

// Re-measure on resize (debounced) so the viewBox keeps matching the
// rendered size, and the mobile/desktop clamp (getChartWindowMs) keeps
// matching the current width — e.g. on orientation change or window
// resize. A second "settle" pass follows the first: on phones, rotating
// can take longer than one debounce interval to finish (address bar
// show/hide animation, etc.), so this catches whatever changed after our
// first re-measure. renderPoolChart() itself also refuses to commit a
// measurement that still looks mid-transition, rather than rendering a
// squashed chart from a bad size.
let chartResizeTimer = null;
let chartResizeSettleTimer = null;

function scheduleChartResize() {
  clearTimeout(chartResizeTimer);
  clearTimeout(chartResizeSettleTimer);
  chartResizeTimer = setTimeout(() => {
    if (chartPoints.length >= 2) renderPoolChart();
    chartResizeSettleTimer = setTimeout(() => {
      if (chartPoints.length >= 2) renderPoolChart();
    }, 350);
  }, 150);
}
window.addEventListener('resize', scheduleChartResize);
window.addEventListener('orientationchange', scheduleChartResize);

// The chart card is display:none while another tab is active, so a periodic
// refresh landing during that window would measure a 0×0 box. Re-measure
// whenever the user navigates back to Home.
refreshPoolChartOnShow = () => {
  if (chartPoints.length >= 2) renderPoolChart();
};

// ── Payout breakdown (How Each Block Pays Out) ────────────

// BCH has 8 decimal places (satoshis) — show full precision but drop trailing zeros
function formatBch(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' BCH';
}

// Same as formatBch(), but always keeps all 8 decimals — used on the
// Coinbase Breakdown table, where the full precision is the point.
function formatBch8(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(8) + ' BCH';
}

// bchPrice is null for tBCH (no real-world price) — callers omit USD entirely then
function formatUsd(bch) {
  if (bchPrice == null || bch == null || isNaN(bch)) return null;
  return '$' + (bch * bchPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Matches solo100.org's ".usd-val" treatment: the parenthetical USD amount
// is muted and slightly smaller than the BCH figure it follows, not
// colored/sized the same as the headline number.
function formatUsdSuffix(bch) {
  const usd = formatUsd(bch);
  return usd ? ` <span class="usd-val">(${usd})</span>` : '';
}

// "1 BCH Finder Bonus, First 3 Leaderboard Payments, Following Best 10
// Shares Bonuses" card — one live amount per rank, sourced from the same
// topshares.status data as the Best Shares page.
let cardThreePayouts = null; // { finder, ranked } once loaded

function renderCardThreePayouts() {
  if (!cardThreePayouts) return;
  const { finder, ranked } = cardThreePayouts;

  const setAmount = (id, btc) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = btc != null ? formatBch(btc) + formatUsdSuffix(btc) : '—';
  };

  setAmount('c3-finder', finder?.btc);
  for (let rank = 1; rank <= 3; rank++) {
    setAmount('c3-rank-' + rank, ranked.find(r => r.rank === rank)?.btc);
  }
  // Ranks 4–13 all pay the same fixed 2.35% share, so one rank stands in for all ten.
  setAmount('c3-rank-4-13', ranked.find(r => r.rank === 4)?.btc);

  // "Minimum Best Share to Win" card — the live best-share difficulty
  // currently holding each key rank, paired with that rank's payout.
  const setMinShareRow = (id, rank) => {
    const el = document.getElementById(id);
    if (!el) return;
    const entry = ranked.find(r => r.rank === rank);
    el.innerHTML = entry
      ? `<span class="payout-amount">${formatDiffCompact(entry.bestshare)}</span> share to win <span class="payout-amount">${formatBch(entry.btc)}${formatUsdSuffix(entry.btc)}</span>`
      : '—';
  };
  setMinShareRow('mbs-13', 13);
  setMinShareRow('mbs-3', 3);
  setMinShareRow('mbs-2', 2);
  setMinShareRow('mbs-1', 1);
  setAmount('mbs-finder', finder?.btc);
}

async function loadCardThreePayouts() {
  try {
    const { finder, ranked } = await fetchTopShares();
    cardThreePayouts = { finder, ranked };
    renderCardThreePayouts();
  } catch (e) {
    console.warn('Card payouts unavailable:', e.message);
  }
}

loadCardThreePayouts();

// ── My Stats ──────────────────────────────────────────

lookupBtn.addEventListener('click', doLookup);
addrInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });

function goToMyStats(address) {
  addrInput.value = address;
  navigateTo('mystats');
  doLookup();
}

// DD.MM.YYYY HH:mm, zero-padded, local time, 24-hour — a fixed format
// instead of toLocaleString() so it reads the same for every visitor
// regardless of browser locale.
function formatBlockTimestamp(ts) {
  const d = new Date(ts * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "abc123...789xyz" — first 6 / last 6 chars, so a 64-char block hash
// still fits on one line without needing to wrap or truncate with CSS.
function shortenHash(hash) {
  if (!hash || hash.length <= 16) return hash ?? '—';
  return `${hash.slice(0, 6)}...${hash.slice(-6)}`;
}

function relativeTime(ts) {
  if (!ts) return '—';
  const diff = Math.floor((Date.now() / 1000) - ts);
  if (diff < 0) return 'just now';
  const units = [
    ['year',   31536000],
    ['month',  2592000],
    ['week',   604800],
    ['day',    86400],
    ['hour',   3600],
    ['minute', 60],
  ];
  for (const [label, secs] of units) {
    if (diff >= secs) {
      const n = Math.floor(diff / secs);
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'Now';
}

function updatePayoutUsd(price) {
  if (price == null) return;
  const fmt = bch => '$' + (bch * price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (userPayoutFinder != null)
    document.getElementById('user-payout-finder-usd').innerHTML = fmt(userPayoutFinder) + '<br>' + FINDER_CAPTION;
  if (userPayoutShare != null)
    document.getElementById('user-payout-share-usd').innerHTML = fmt(userPayoutShare) + '<br>' + SHARE_CAPTION;
}

async function doLookup() {
  const addr = addrInput.value.trim();
  if (!addr) { addrInput.focus(); return; }

  // Reflect the address in the URL immediately (not just on success) so the
  // link is shareable, and record it before any await so a routeFromHash()
  // triggered by the navigateTo() just before this call doesn't re-fire it.
  lastLookupAddr = addr;
  history.replaceState(null, '', `#mystats/${encodeURIComponent(addr)}`);

  const banner  = document.getElementById('user-status-banner');
  const grid    = document.getElementById('user-stats-grid');
  const details = document.getElementById('user-details-card');

  // Reset
  banner.classList.add('hidden');
  grid.classList.add('hidden');
  details.classList.add('hidden');
  document.getElementById('user-payout-note').classList.add('hidden');
  document.getElementById('user-payout-unranked').classList.add('hidden');
  document.getElementById('user-payout-grid').classList.add('hidden');
  document.getElementById('user-chance-grid').classList.add('hidden');
  document.getElementById('user-workers-card').classList.add('hidden');
  userPayoutFinder = null;
  userPayoutShare  = null;
  document.getElementById('user-payout-finder-usd').textContent = FINDER_CAPTION;
  document.getElementById('user-payout-share-usd').textContent  = SHARE_CAPTION;
  ['user-chance-day','user-chance-week','user-chance-month'].forEach(id => {
    const el = document.getElementById(id);
    el.textContent = '—';
    el.classList.add('skeleton');
  });
  lookupBtn.disabled = true;
  lookupBtn.textContent = 'Loading…';

  try {
    const resp = await fetch(`${API_BASE}/users/${encodeURIComponent(addr)}`, { cache: 'no-cache' });

    lookupBtn.disabled = false;
    lookupBtn.textContent = 'Look Up';

    if (resp.status === 404) {
      document.getElementById('user-status-msg').textContent =
        "This address hasn't been seen by the pool yet, or the node is still warming up.";
      banner.classList.remove('hidden');
      return;
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const data = await resp.json();

    // Populate stats — field names vary by pool software; try multiple keys
    document.getElementById('user-hashrate').textContent =
      parseHashrateStr(data.hashrate5m ?? data.hashrate1m ?? data.hashrate ?? data.workerHashrate);

    document.getElementById('user-workers').textContent =
      data.workers ?? data.worker_count ?? 1;

    document.getElementById('user-lastseen').textContent =
      relativeTime(data.lastshare ?? data.last_share ?? data.lastShareTime);

    // Block chance calculation
    const rawHashrate = data.hashrate5m ?? data.hashrate1m ?? data.hashrate ?? data.workerHashrate;
    const chanceGrid = document.getElementById('user-chance-grid');
    if (hashrateToHps(rawHashrate)) {
      chanceGrid.classList.remove('hidden');
      loadUserChance(rawHashrate);
    } else {
      chanceGrid.classList.add('hidden');
    }

    // Expected payout calculation — pulled directly from the pool node's
    // authoritative topshares.status, not a client-side estimate
    const payoutGrid     = document.getElementById('user-payout-grid');
    const unrankedNote   = document.getElementById('user-payout-unranked');
    const { entry, finderBtc } = await getMyTopShareEntry(addr);
    if (entry != null && entry.satoshis > 0) {
      userPayoutShare  = entry.btc;
      userPayoutFinder = entry.btc + finderBtc;

      document.getElementById('user-payout-finder').textContent = userPayoutFinder.toFixed(6) + ' BCH';
      document.getElementById('user-payout-share').textContent  = userPayoutShare.toFixed(6) + ' BCH';
      document.getElementById('user-payout-finder-usd').textContent = FINDER_CAPTION;
      document.getElementById('user-payout-share-usd').textContent  = SHARE_CAPTION;
      payoutGrid.classList.remove('hidden');
      unrankedNote.classList.add('hidden');
      document.getElementById('user-payout-note').classList.remove('hidden');
    } else {
      userPayoutFinder = null;
      userPayoutShare  = null;
      payoutGrid.classList.add('hidden');
      document.getElementById('user-payout-note').classList.add('hidden');
      unrankedNote.classList.remove('hidden');
    }

    // Show USD values from cached price when hashrate is zero (loadUserChance won't run or bails early)
    if (!hashrateToHps(rawHashrate) && bchPrice != null) {
      updatePayoutUsd(bchPrice);
    }

    grid.classList.remove('hidden');

    // Workers table
    const workersCard  = document.getElementById('user-workers-card');
    const workersTable = document.getElementById('user-workers-table');
    const workerList   = Array.isArray(data.worker) ? data.worker : [];
    const activeWorkers = workerList.filter(w => parseFloat(w.hashrate1hr || 0) !== 0 || (w.bestshare_alltime ?? w.bestshare ?? 0) > 0);
    if (activeWorkers.length > 0) {
      workersTable.innerHTML = `
        <thead><tr>
          <th>Worker</th>
          <th>1m</th><th>5m</th><th>1hr</th><th>Current Best</th><th>Best Ever</th>
        </tr></thead>
        <tbody>${activeWorkers.map(w => {
          const wn = w.workername ?? '';
          const name = wn.includes('.') ? wn.split('.').pop() : wn;
          return `<tr>
            <td>${escapeHtml(name)}</td>
            <td>${escapeHtml(parseHashrateStr(w.hashrate1m))}</td>
            <td>${escapeHtml(parseHashrateStr(w.hashrate5m))}</td>
            <td>${escapeHtml(parseHashrateStr(w.hashrate1hr))}</td>
            <td>${formatDiffCompact(w.bestshare ?? 0)}</td>
            <td>${formatDiffCompact(w.bestshare_alltime ?? w.bestshare ?? 0)}</td>
          </tr>`;
        }).join('')}</tbody>`;
      workersCard.classList.remove('hidden');
    } else {
      workersCard.classList.add('hidden');
    }

    // Show curl command and raw JSON for transparency
    document.getElementById('user-curl').textContent =
      `curl "${API_BASE}/users/${encodeURIComponent(addr)}"`;
    document.getElementById('user-raw').textContent = JSON.stringify(data, null, 2);
    details.classList.remove('hidden');

  } catch (err) {
    console.warn('User lookup failed:', err.message);
    lookupBtn.disabled = false;
    lookupBtn.textContent = 'Look Up';
    document.getElementById('user-status-msg').textContent =
      'Could not reach the pool API. It may still be warming up.';
    banner.classList.remove('hidden');
  }
}

async function loadUserChance(hashrateStr) {
  const thps = hashrateToHps(hashrateStr) / 1e12;
  if (!thps) return;
  try {
    const url  = `https://api.solochance.org/getSoloChanceCalculations?currency=BCH&hashrate=${thps.toFixed(6)}&hashrateUnit=TH`;
    const resp = await fetch(url, { cache: 'no-cache' });
    if (!resp.ok) return;
    const d = await resp.json();

    document.getElementById('user-chance-day').textContent   = d.dayChanceText   ?? '—';
    document.getElementById('user-chance-week').textContent  = d.weekChanceText  ?? '—';
    document.getElementById('user-chance-month').textContent = d.monthChanceText ?? '—';

    ['user-chance-day','user-chance-week','user-chance-month'].forEach(id => {
      document.getElementById(id).classList.remove('skeleton');
    });

    updatePayoutUsd(d.price);
  } catch (e) {
    console.warn('User chance unavailable:', e.message);
  }
}

// ── Blocks ──────────────────────────────────────────────

function buildBlockRow(b) {
  const hash      = b.hash   ?? null;
  const height    = b.height ?? null;
  const when      = b.time ?? b.createdate ?? b.timestamp;
  const finder    = b.finder_address ?? b.solvedby ?? '';
  const confirmed = b.confirmed;

  // Link the row to its BCH Explorer page when we have an id to point at
  const explorerId = height ?? hash;
  const row = document.createElement(explorerId ? 'a' : 'div');
  row.className = 'block-row';
  if (explorerId) {
    row.href = `${EXPLORER_BLOCK_URL}/${explorerId}`;
    row.target = '_blank';
    row.rel = 'noopener';
  }

  // Flat children placed via CSS grid-area (see .block-row), not nested
  // wrapper divs — so the mobile breakpoint can rearrange them (status
  // pill next to the height, instead of trailing below everything else
  // once a wrapping flex column dropped to its own line) without needing
  // a different DOM structure per breakpoint.
  const heightEl = document.createElement('div');
  heightEl.className = 'block-height';
  heightEl.textContent = 'Block #' + (height ?? '—');

  const statusEl = document.createElement('div');
  statusEl.className = 'block-status' + (confirmed ? ' confirmed' : '');
  statusEl.textContent = confirmed ? 'Confirmed' : 'Unconfirmed';

  const hashEl = document.createElement('div');
  hashEl.className = 'block-hash';
  hashEl.textContent = shortenHash(hash);
  if (hash) hashEl.title = hash;

  const whenEl = document.createElement('div');
  whenEl.className = 'block-meta block-when';
  whenEl.textContent = when ? `${formatBlockTimestamp(when)} (${relativeTime(when)})` : '';

  row.appendChild(heightEl);
  row.appendChild(statusEl);
  row.appendChild(hashEl);
  row.appendChild(whenEl);

  if (finder) {
    const finderEl = document.createElement('div');
    finderEl.className = 'block-meta block-finder';
    finderEl.textContent = '⛏ ' + finder;
    row.appendChild(finderEl);
  }

  return row;
}

async function renderBlocksPage() {
  const list       = document.getElementById('blocks-list');
  const pagination = document.getElementById('blocks-pagination');
  const pageInfo   = document.getElementById('blocks-page-info');
  const prevBtn    = document.getElementById('blocks-prev-btn');
  const nextBtn    = document.getElementById('blocks-next-btn');

  const totalPages = Math.max(1, Math.ceil(allBlockEntries.length / BLOCKS_PAGE_SIZE));
  currentBlocksPage = Math.min(Math.max(1, currentBlocksPage), totalPages);

  const start = (currentBlocksPage - 1) * BLOCKS_PAGE_SIZE;
  const pageEntries = allBlockEntries.slice(start, start + BLOCKS_PAGE_SIZE);

  list.innerHTML = '<div class="card text-center">Loading page…</div>';
  const details = await Promise.all(pageEntries.map(getBlockDetails));

  list.innerHTML = '';
  details.forEach(b => list.appendChild(buildBlockRow(b)));

  pageInfo.textContent = `Page ${currentBlocksPage} of ${totalPages}`;
  prevBtn.disabled = currentBlocksPage <= 1;
  nextBtn.disabled = currentBlocksPage >= totalPages;
  pagination.classList.toggle('hidden', totalPages <= 1);

  // Keep the URL copyable/reloadable without spamming browser history —
  // one entry per pagination click would make Back nearly unusable.
  history.replaceState(null, '', `#blocks/${currentBlocksPage}`);
}

document.getElementById('blocks-prev-btn').addEventListener('click', () => {
  currentBlocksPage -= 1;
  renderBlocksPage();
});
document.getElementById('blocks-next-btn').addEventListener('click', () => {
  currentBlocksPage += 1;
  renderBlocksPage();
});

async function loadBlocks() {
  if (blocksLoaded) return;

  const banner  = document.getElementById('blocks-status-banner');
  const loading = document.getElementById('blocks-loading');
  const empty   = document.getElementById('blocks-empty');

  // Reset UI in case this is a retry after a previous failed attempt
  // (blocksLoaded stays false on error, so the Blocks tab can re-trigger this)
  banner.classList.add('hidden');
  empty.classList.add('hidden');
  loading.classList.remove('hidden');

  try {
    const entries = await getFoundBlocks();

    const countEl = document.getElementById('blocks-total-count');
    if (countEl) countEl.textContent = entries.length;

    if (!Array.isArray(entries) || entries.length === 0) {
      loading.classList.add('hidden');
      empty.classList.remove('hidden');
      blocksLoaded = true;
      return;
    }

    allBlockEntries = entries.slice().reverse(); // newest first
    currentBlocksPage = pendingBlocksPage ?? 1;
    pendingBlocksPage = null;

    loading.classList.add('hidden');
    await renderBlocksPage();

    blocksLoaded = true;

  } catch (err) {
    console.warn('Blocks unavailable:', err.message);
    loading.classList.add('hidden');
    banner.classList.remove('hidden');
  }
}

// ── Best Shares ──────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// topshares.status is newline-delimited JSON: one "finder" line, one
// "pool_fee" line, then one line per ranked address (rank 1..N). Entries
// past rank 13 carry satoshis: 0 — informational only, not paid.
function fetchTopShares() {
  if (!topSharesPromise) {
    topSharesPromise = fetch(`${API_BASE}/pool/topshares.status`, { cache: 'no-cache' })
      .then(r => r.text())
      .then(text => {
        let finder = null, poolFee = null;
        const ranked = [];
        text.trim().split('\n').forEach(line => {
          let entry;
          try { entry = JSON.parse(line); } catch { return; }
          if (entry.role === 'finder') finder = entry;
          else if (entry.role === 'pool_fee') poolFee = entry;
          else if (entry.rank != null) ranked.push(entry);
        });
        ranked.sort((a, b) => a.rank - b.rank);
        return { finder, poolFee, ranked };
      })
      .finally(() => { topSharesPromise = null; });
  }
  return topSharesPromise;
}

// This address's own row on the current round's Top Shares board (plus the
// finder bonus amount), or a null entry if it hasn't submitted a share yet.
async function getMyTopShareEntry(address) {
  const { finder, ranked } = await fetchTopShares();
  return {
    entry: ranked.find(r => r.address === address) ?? null,
    finderBtc: finder?.btc ?? 1,
  };
}

const bsMedals = ['🥇', '🥈', '🥉'];

function bsUsdCell(btc) {
  const usd = formatUsd(btc);
  return usd ? `<div class="bs-payout-usd">${usd}</div>` : '';
}

function renderBsShareRow(r, networkDiff, includePayout) {
  const pct = (r.bestshare / networkDiff * 100);
  const pctTip = pct > 100
    ? ` <span class="info-tip" data-tip="This share was sent before the last target was lowered">i</span>`
    : '';
  const idle = !r.lastshare || (Date.now() / 1000 - r.lastshare) >= 300;
  const hashrateCell = idle
    ? '<span class="miner-idle-icon">💤</span>'
    : `<span class="miner-active-icon">⛏️</span> ${escapeHtml(parseHashrateStr(r.hashrate1m))}`;
  const medal = r.rank <= 3 ? bsMedals[r.rank - 1] : null;
  const bsCell = `${medal ? medal + ' ' : ''}${formatDiffCompact(r.bestshare)} (${pct.toFixed(2)}%)${pctTip}`;
  const payoutCell = includePayout ? `${formatBch(r.btc)}${bsUsdCell(r.btc)}` : '—';
  const isHashbackWinner = bsHashbackWinnerAddress != null && r.address === bsHashbackWinnerAddress;
  const rowClasses = [r.rank <= 3 ? `bs-rank-${r.rank}` : null, isHashbackWinner ? 'bs-hashback-winner' : null].filter(Boolean);
  const rowClass = rowClasses.length ? ` class="${rowClasses.join(' ')}"` : '';
  const addressPrefix = isHashbackWinner ? '🎁 ' : '';
  return `<tr${rowClass}>
    <td>${r.rank}</td>
    <td><code class="bs-address" data-address="${escapeHtml(r.address)}">${addressPrefix}${escapeHtml(r.address)}</code></td>
    <td>${hashrateCell}</td>
    <td class="col-bs">${bsCell}</td>
    <td class="col-payout">${payoutCell}</td>
  </tr>`;
}

// Sorts a copy of `rows` by the current bsSortCol/bsSortDir — used to reorder
// the Top 13 block and the "rest" block independently, so the two groups
// never merge into each other.
function sortBsRows(rows) {
  const sorted = rows.slice();
  const dir = bsSortDir === 'asc' ? 1 : -1;
  sorted.sort((a, b) => {
    const va = bsSortCol === 'hashrate' ? hashrateToHps(a.hashrate1m) : a.bestshare;
    const vb = bsSortCol === 'hashrate' ? hashrateToHps(b.hashrate1m) : b.bestshare;
    return (va - vb) * dir;
  });
  return sorted;
}

function bsSortArrow(col) {
  if (bsSortCol !== col) return '';
  return bsSortDir === 'desc' ? ' ▼' : ' ▲';
}

function renderBsTotalTable() {
  const totalTable = document.getElementById('bs-total-table');
  if (!totalTable || bsTotalBtc == null) return;
  const finderBtc = bsFinder?.btc;
  const poolFeeBtc = bsPoolFee?.btc;
  const best13Btc = (finderBtc != null && poolFeeBtc != null) ? bsTotalBtc - finderBtc - poolFeeBtc : null;
  totalTable.innerHTML = `
    <thead><tr><th>Output</th><th>Amount</th></tr></thead>
    <tbody>
      <tr><td>Total Block Reward</td><td>${formatBch8(bsTotalBtc)}${bsUsdCell(bsTotalBtc)}</td></tr>
      <tr><td>🏆 Block Finder</td><td>${formatBch8(finderBtc)}${bsUsdCell(finderBtc)}</td></tr>
      <tr><td>Pool Fee</td><td>${formatBch8(poolFeeBtc)}${bsUsdCell(poolFeeBtc)}</td></tr>
      <tr><td>Best 13 Distribution</td><td>${formatBch8(best13Btc)}${bsUsdCell(best13Btc)}</td></tr>
    </tbody>`;
}

// Pool-wide summary as the table's first row — same Users/Workers/Hashrate
// fields shown on the home page's pool-stats cards, so the Best 13 list
// reads in context rather than just as a bare address ranking.
function renderBsSummaryRow() {
  if (bsUsersCount == null && bsWorkersCount == null && bsHashrateDisplay == null) return '';
  const users = bsUsersCount != null ? `${bsUsersCount} user${bsUsersCount === 1 ? '' : 's'}` : '—';
  const workers = bsWorkersCount != null ? `${bsWorkersCount} worker${bsWorkersCount === 1 ? '' : 's'}` : '—';
  return `<tr class="bs-summary-row">
    <td></td>
    <td>Total Hashrate (${users} / ${workers})</td>
    <td>${escapeHtml(bsHashrateDisplay ?? '—')}</td>
    <td class="col-bs"></td>
    <td class="col-payout"></td>
  </tr>`;
}

function renderBsPayoutsTable() {
  const payoutsTable = document.getElementById('bs-payouts-table');
  if (!payoutsTable || !bsTop13 || !bsRest) return;

  const cutoffRow = bsRest.length > 0 ? `
    <tr class="bs-cutoff-row"><td colspan="5"><div class="bs-cutoff-inner">
      <span class="bs-cutoff-line"></span>
      Best 13 cutoff — addresses below earn no payout this round
      <span class="bs-cutoff-line"></span>
    </div></td></tr>` : '';

  const sortedTop13 = sortBsRows(bsTop13);
  const sortedRest = sortBsRows(bsRest);

  payoutsTable.innerHTML = `
    <thead><tr>
      <th>#</th><th>Address</th>
      <th class="bs-sortable" data-sort="hashrate">Hashrate${bsSortArrow('hashrate')}</th>
      <th class="col-bs bs-sortable" data-sort="bestshare">Best Share${bsSortArrow('bestshare')}</th>
      <th class="col-payout">Payout</th>
    </tr></thead>
    <tbody>
      ${renderBsSummaryRow()}
      ${sortedTop13.map(r => renderBsShareRow(r, bsNetworkDiff, true)).join('')}
      ${cutoffRow}
      ${sortedRest.map(r => renderBsShareRow(r, bsNetworkDiff, false)).join('')}
    </tbody>`;
}

// Fetches the current round's coinbase split and re-renders both Best 13
// tables. Split out from loadBestShares() so a periodic refresh (below) can
// re-run just this part — otherwise each row's idle/active (💤/⛏️) icon is
// computed from a `lastshare` timestamp that was only ever fetched once, and
// coming back to an already-open tab after a few minutes makes every miner
// look idle even if they never stopped mining.
async function fetchAndRenderBestShares() {
  const [{ finder, poolFee, ranked }, statusResp] = await Promise.all([
    fetchTopShares(),
    fetch(`${API_BASE}/pool/pool.status`, { cache: 'no-cache' }),
  ]);

  const statusText = await statusResp.text();
  const pool = {};
  statusText.trim().split('\n').forEach(line => {
    try { Object.assign(pool, JSON.parse(line)); } catch {}
  });

  const diffPercent = parseFloat(pool.diff);
  const accepted = pool.accepted;
  const networkDiff = (diffPercent > 0 && accepted > 0) ? accepted / (diffPercent / 100) : 874000000000;

  // Same fields/formatting as the home page's pool-stats cards
  bsUsersCount = pool.Users ?? pool.users ?? null;
  bsWorkersCount = pool.Workers ?? pool.workers ?? null;
  bsHashrateDisplay = parseHashrateStr(pool.hashrate5m ?? pool.hashrate1m);

  // Coinbase breakdown — Block Finder and Pool Fee are cached here so
  // renderBsTotalTable() can show them alongside the total; needs to
  // happen before that render call, not after.
  bsFinder = finder;
  bsPoolFee = poolFee;
  const totalSats = (finder?.satoshis ?? 0) + (poolFee?.satoshis ?? 0)
    + ranked.reduce((sum, r) => sum + (r.satoshis ?? 0), 0);
  bsTotalBtc = totalSats / 1e8;
  renderBsTotalTable();

  // Payout breakdown — Top 13 Ranks, then the rest
  bsNetworkDiff = networkDiff;
  bsTop13 = ranked.filter(r => r.rank <= 13);
  bsRest = ranked.filter(r => r.rank > 13);

  renderBsPayoutsTable();
}

async function loadBestShares() {
  if (bestSharesLoaded) return;
  bestSharesLoaded = true;

  const loading = document.getElementById('bestshares-loading');
  const content = document.getElementById('bestshares-content');

  try {
    await fetchAndRenderBestShares();

    // Hashback Bonus is mainnet-only, so this is fetched separately and
    // re-renders the table when (if) it resolves — a slow/failed fetch here
    // shouldn't hold up or break the main Best 13 list.
    fetch(HASHBACK_HISTORY_URL, { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        bsHashbackWinnerAddress = Array.isArray(data) && data.length > 0 ? data[0].address : null;
        renderBsPayoutsTable();
      })
      .catch(() => {});

    // Delegate sort-header clicks and address clicks from the whole content block
    content.addEventListener('click', e => {
      const sortEl = e.target.closest('.bs-sortable');
      if (sortEl) {
        const col = sortEl.dataset.sort;
        if (bsSortCol === col) {
          bsSortDir = bsSortDir === 'desc' ? 'asc' : 'desc';
        } else {
          bsSortCol = col;
          bsSortDir = 'desc';
        }
        renderBsPayoutsTable();
        return;
      }
      const addrEl = e.target.closest('.bs-address');
      if (addrEl) goToMyStats(addrEl.dataset.address);
    });

    loading.classList.add('hidden');
    content.classList.remove('hidden');

  } catch (err) {
    bestSharesLoaded = false;
    console.warn('Best shares unavailable:', err.message);
    loading.textContent = 'Could not load Best 13.';
  }
}

// Keeps hashrate/idle-state and payout figures current while the Best 13
// section sits open in the background — see fetchAndRenderBestShares()'s
// comment for why this matters.
setInterval(() => {
  if (bestSharesLoaded) fetchAndRenderBestShares().catch(() => {});
}, 30_000);
