// scan.mjs — サーバーサイド版スキャンスクリプト（GitHub Actionsから実行）
// ブラウザ版(trade_checklist_pro_v5.html)と同じロジックのポート版。
// CORSの制約がない分、COTデータもTwelve Dataも確実に取得できる。
//
// 実行に必要な環境変数:
//   TD_API_KEY = Twelve DataのAPIキー（GitHub Secretsに設定）
//
// 出力: data/scan.json （このリポジトリにコミットされる）

import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

const TD_API_KEY = process.env.TD_API_KEY || '';
const OUT_PATH = path.join(process.cwd(), 'data', 'scan.json');

// ---------- 対象13銘柄 ----------
const AUTO_SYMS = [
  { id: 'XAUUSD', src: 'td', tsym: 'XAU/USD' },
  { id: 'BTCUSD', src: 'td', tsym: 'BTC/USD' },
  { id: 'USDJPY', src: 'td', tsym: 'USD/JPY' },
  { id: 'EURJPY', src: 'td', tsym: 'EUR/JPY' },
  { id: 'AUDJPY', src: 'td', tsym: 'AUD/JPY' },
  { id: 'CHFJPY', src: 'td', tsym: 'CHF/JPY' },
  { id: 'AUDUSD', src: 'td', tsym: 'AUD/USD' },
  { id: 'EURCHF', src: 'td', tsym: 'EUR/CHF' },
  { id: 'GBPCHF', src: 'td', tsym: 'GBP/CHF' },
  { id: 'EURUSD', src: 'td', tsym: 'EUR/USD' },
  { id: 'GBPUSD', src: 'td', tsym: 'GBP/USD' },
  { id: 'GBPJPY', src: 'td', tsym: 'GBP/JPY' },
  { id: 'USDCHF', src: 'td', tsym: 'USD/CHF' },
];

const FX_STRENGTH_LEGS = {
  USDJPY: ['DXY', 'JXY'], EURJPY: ['EXY', 'JXY'], AUDJPY: ['AXY', 'JXY'],
  CHFJPY: ['CHFX', 'JXY'], GBPJPY: ['BXY', 'JXY'],
  AUDUSD: ['AXY', 'DXY'], EURCHF: ['EXY', 'CHFX'], GBPCHF: ['BXY', 'CHFX'],
  EURUSD: ['EXY', 'DXY'], GBPUSD: ['BXY', 'DXY'], USDCHF: ['DXY', 'CHFX'],
};

const COT_KEYWORDS = {
  DXY: 'USD INDEX', JXY: 'JAPANESE YEN', EXY: 'EURO FX', BXY: 'BRITISH POUND',
  CHFX: 'SWISS FRANC', AXY: 'AUSTRALIAN DOLLAR', XAU: 'GOLD - COMMODITY EXCHANGE', BTC: 'BITCOIN',
};

// 経済指標カレンダー: ForexFactoryが配信している公開JSON（キー不要）。非公式のCDNエンドポイントなので
// 将来フォーマット変更や停止のリスクはあるが、現状は多くのEA/ツールで広く使われている
const FF_CALENDAR_URL = 'https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json';
const RELEVANT_CURRENCIES = new Set(['USD', 'JPY', 'EUR', 'GBP', 'CHF', 'AUD']);
// タイトルのキーワード → アプリ内の EVT_TYPES id にマッピング
const EVENT_KEYWORD_MAP = [
  [/CPI/i, 'cpi'], [/Non-?Farm|NFP/i, 'nfp'], [/FOMC|Fed.*Interest Rate|Federal Funds Rate/i, 'fomc'],
  [/ECB.*Rate|Main Refinancing/i, 'ecb'], [/BOE|Bank of England.*Rate/i, 'boe'], [/BOJ|Bank of Japan.*Rate/i, 'boj'],
  [/PPI/i, 'ppi'], [/ADP/i, 'adp'], [/PMI/i, 'pmi'], [/ISM/i, 'ism'],
  [/Unemployment Claims|Jobless Claims/i, 'claims'], [/Retail Sales/i, 'retail'], [/GDP/i, 'gdp'],
];
function matchEventType(title) {
  for (const [re, id] of EVENT_KEYWORD_MAP) { if (re.test(title)) return id; }
  return null;
}
async function fetchTodayEvents() {
  const r = await fetchWithTimeout(FF_CALENDAR_URL, 15000);
  if (!r.ok) throw new Error('経済指標カレンダー取得失敗');
  const events = await r.json();
  const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const todayStr = jstNow.toISOString().slice(0, 10);
  const matched = [];
  for (const e of events) {
    if (!e.date || !e.country) continue;
    if (!RELEVANT_CURRENCIES.has(e.country)) continue;
    if (e.impact !== 'High' && e.impact !== 'Medium') continue;
    const evtDate = new Date(e.date);
    const evtJst = new Date(evtDate.getTime() + 9 * 3600 * 1000);
    if (evtJst.toISOString().slice(0, 10) !== todayStr) continue;
    const typeId = matchEventType(e.title || '');
    if (!typeId) continue; // アプリ内カテゴリに対応しないものはスキップ（otherに丸めない）
    const hh = String(evtJst.getUTCHours()).padStart(2, '0');
    const mm = String(evtJst.getUTCMinutes()).padStart(2, '0');
    matched.push({ type: typeId, time: `${hh}:${mm}`, impact: e.impact, title: e.title, country: e.country });
  }
  // High優先、その後時刻順。最大3件（アプリ側のevtSlotsが3枠のため）
  matched.sort((a, b) => (a.impact === b.impact ? a.time.localeCompare(b.time) : (a.impact === 'High' ? -1 : 1)));
  return matched.slice(0, 3);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, ms = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- データ取得 ----------
async function fetchBinanceKlines(sym, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  const r = await fetchWithTimeout(url);
  if (!r.ok) throw new Error('Binance取得失敗');
  const j = await r.json();
  return j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}
async function fetchTDKlines(tsym, interval, outputsize) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tsym)}&interval=${interval}&outputsize=${outputsize}&apikey=${encodeURIComponent(TD_API_KEY)}`;
  const r = await fetchWithTimeout(url);
  const j = await r.json();
  if (j.status === 'error' || !j.values) throw new Error(j.message ? j.message.slice(0, 60) : 'TwelveDataエラー');
  return j.values.slice().reverse().map((v) => ({
    t: new Date(v.datetime.replace(' ', 'T')).getTime(),
    o: +v.open, h: +v.high, l: +v.low, c: +v.close,
  }));
}
async function fetchCotNet(keyword) {
  const where = `upper(market_and_exchange_names) like '%${keyword.toUpperCase()}%'`;
  const url = `https://publicreporting.cftc.gov/resource/jun7-fc8e.json?$select=market_and_exchange_names,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all&$where=${encodeURIComponent(where)}&$order=report_date_as_yyyy_mm_dd DESC&$limit=1`;
  const r = await fetchWithTimeout(url);
  const j = await r.json();
  if (!j.length) throw new Error('該当銘柄なし: ' + keyword);
  const row = j[0];
  const long = +row.noncomm_positions_long_all, short = +row.noncomm_positions_short_all;
  if (long + short === 0) return { net: 0, date: row.report_date_as_yyyy_mm_dd };
  return { net: (long - short) / (long + short), date: row.report_date_as_yyyy_mm_dd };
}

// ---------- 分析ロジック（trade_checklist_pro_v5.html と同一アルゴリズム） ----------
function findSwings(candles, look = 2) {
  const highs = [], lows = [];
  for (let i = look; i < candles.length - look; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= look; k++) {
      if (candles[i].h < candles[i - k].h || candles[i].h < candles[i + k].h) isHigh = false;
      if (candles[i].l > candles[i - k].l || candles[i].l > candles[i + k].l) isLow = false;
    }
    if (isHigh) highs.push({ i, price: candles[i].h });
    if (isLow) lows.push({ i, price: candles[i].l });
  }
  return { highs, lows };
}
function trendBias(candles) {
  const { highs, lows } = findSwings(candles, 2);
  if (highs.length < 2 || lows.length < 2) return 'NEUTRAL';
  const h1 = highs[highs.length - 2].price, h2 = highs[highs.length - 1].price;
  const l1 = lows[lows.length - 2].price, l2 = lows[lows.length - 1].price;
  if (h2 > h1 && l2 > l1) return 'BULL';
  if (h2 < h1 && l2 < l1) return 'BEAR';
  return 'NEUTRAL';
}
function detectSweepChoch(candles) {
  const { highs, lows } = findSwings(candles, 2);
  let bull = null, bear = null;
  if (lows.length >= 2) {
    const refLow = lows[lows.length - 2];
    for (let i = refLow.i + 1; i < candles.length; i++) {
      if (candles[i].l < refLow.price && candles[i].c > refLow.price) {
        let minorHigh = -Infinity;
        for (let k = refLow.i; k < i; k++) minorHigh = Math.max(minorHigh, candles[k].h);
        let chochIdx = -1;
        for (let k = i + 1; k < candles.length; k++) { if (candles[k].c > minorHigh) { chochIdx = k; break; } }
        let target = null;
        for (let k = highs.length - 1; k >= 0; k--) { if (highs[k].i < refLow.i) { target = highs[k].price; break; } }
        if (!target) target = minorHigh + (minorHigh - candles[i].l);
        bull = { dir: 'BUY', sweepLow: candles[i].l, chochLevel: minorHigh, confirmed: chochIdx > -1, target, lastClose: candles[candles.length - 1].c, sweepIdx: i };
        break;
      }
    }
  }
  if (highs.length >= 2) {
    const refHigh = highs[highs.length - 2];
    for (let i = refHigh.i + 1; i < candles.length; i++) {
      if (candles[i].h > refHigh.price && candles[i].c < refHigh.price) {
        let minorLow = Infinity;
        for (let k = refHigh.i; k < i; k++) minorLow = Math.min(minorLow, candles[k].l);
        let chochIdx = -1;
        for (let k = i + 1; k < candles.length; k++) { if (candles[k].c < minorLow) { chochIdx = k; break; } }
        let target = null;
        for (let k = lows.length - 1; k >= 0; k--) { if (lows[k].i < refHigh.i) { target = lows[k].price; break; } }
        if (!target) target = minorLow - (candles[i].h - minorLow);
        bear = { dir: 'SELL', sweepHigh: candles[i].h, chochLevel: minorLow, confirmed: chochIdx > -1, target, lastClose: candles[candles.length - 1].c, sweepIdx: i };
        break;
      }
    }
  }
  if (bull && bear) return bull.sweepIdx >= bear.sweepIdx ? bull : bear;
  return bull || bear || null;
}
function calcRR(sig) {
  if (!sig) return null;
  const price = sig.lastClose;
  if (sig.dir === 'BUY') {
    const stop = sig.sweepLow * 0.999, risk = price - stop, reward = sig.target - price;
    if (risk <= 0 || reward <= 0) return null;
    return +(reward / risk).toFixed(1);
  } else {
    const stop = sig.sweepHigh * 1.001, risk = stop - price, reward = price - sig.target;
    if (risk <= 0 || reward <= 0) return null;
    return +(reward / risk).toFixed(1);
  }
}
function judgeRow(tf4, sig, rr) {
  if (!sig) return { tier: '—', dir: 'WAIT', judge: '除外', note: '1Hもレンジ', rr: null, tf4 };
  const dir = sig.dir;
  const aligned = (dir === 'BUY' && tf4 === 'BULL') || (dir === 'SELL' && tf4 === 'BEAR');
  const opposite = (dir === 'BUY' && tf4 === 'BEAR') || (dir === 'SELL' && tf4 === 'BULL');
  if (opposite) return { tier: '—', dir: 'WAIT', judge: '除外', note: '4H逆行のため除外', rr: null, tf4 };
  const tier = aligned ? 'Tier1' : 'Tier2';
  if (!sig.confirmed) return { tier, dir, judge: '除外', note: (dir === 'BUY' ? 'SSL' : 'BSL') + ' sweepのみ・CHoCH未確定', rr: null, tf4 };
  if (!rr || rr < 1.2) return { tier, dir, judge: '除外', note: rr ? `RRが低すぎる(1:${rr})` : 'RR不成立', rr: null, tf4 };
  const nearEntry = dir === 'BUY' ? (sig.lastClose <= sig.chochLevel * 1.006) : (sig.lastClose >= sig.chochLevel * 0.994);
  const label = (dir === 'BUY' ? 'SSL' : 'BSL') + ' sweep+CHoCH';
  if (nearEntry) return { tier, dir, judge: '確定', note: label, rr, tf4 };
  return { tier, dir, judge: '確定(押し目待ち)', note: label + '・押し目待ち', rr, tf4 };
}
function weeklyPctChange(candles) {
  if (!candles || candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const targetT = last.t - 7 * 24 * 3600 * 1000;
  let best = candles[0];
  for (const c of candles) { if (c.t <= targetT) best = c; else break; }
  if (best === last || !best.c) return null;
  return +(((last.c - best.c) / best.c) * 100).toFixed(2);
}
function analyzeSymbol(h4, h1) {
  const tf4 = trendBias(h4);
  const sig = detectSweepChoch(h1.slice(-40));
  const rr = calcRR(sig);
  const row = judgeRow(tf4, sig, rr);
  row.weeklyPct = weeklyPctChange(h4);
  return row;
}
function classifyCotBias(score) {
  if (score > 0.08) return 'long';
  if (score < -0.08) return 'short';
  return 'neutral';
}
function getKillZoneJST() {
  const now = new Date();
  const jstOffsetMs = 9 * 3600 * 1000;
  const jst = new Date(now.getTime() + jstOffsetMs);
  const day = jst.getUTCDay(), h = jst.getUTCHours() + jst.getUTCMinutes() / 60;
  if (day === 0 || day === 6) return '週末 (KZ外)';
  if (h >= 9 && h < 11) return '東京 KZ';
  if (h >= 16 && h < 19) return 'ロンドン KZ';
  if (h >= 21.5 && h < 24) return 'NY KZ（LDN重複）';
  if (h >= 0 && h < 1) return 'NY KZ 後半';
  return 'KZ外';
}

// ---------- メイン ----------
async function main() {
  if (!TD_API_KEY) {
    console.error('TD_API_KEY が設定されていません（GitHub Secretsを確認してください）');
    process.exitCode = 1;
    return;
  }
  const results = {};
  const h4Cache = {};

  const cryptoSyms = AUTO_SYMS.filter((s) => s.src === 'binance');
  const fxSyms = AUTO_SYMS.filter((s) => s.src === 'td');

  console.log('暗号資産を取得中...');
  await Promise.all(cryptoSyms.map(async (s) => {
    try {
      const h4 = await fetchBinanceKlines(s.bsym, '4h', 250);
      const h1 = await fetchBinanceKlines(s.bsym, '1h', 100);
      results[s.id] = analyzeSymbol(h4, h1);
      h4Cache[s.id] = h4;
    } catch (e) { results[s.id] = { error: e.message || '取得失敗' }; }
  }));

  console.log(`為替を取得中（${fxSyms.length}銘柄、8秒間隔でTwelve Dataのレート制限を回避）...`);
  for (let i = 0; i < fxSyms.length; i++) {
    const s = fxSyms[i];
    console.log(`  [${i + 1}/${fxSyms.length}] ${s.id}`);
    try {
      const h4 = await fetchTDKlines(s.tsym, '4h', 250);
      await sleep(8000);
      const h1 = await fetchTDKlines(s.tsym, '1h', 100);
      results[s.id] = analyzeSymbol(h4, h1);
      h4Cache[s.id] = h4;
    } catch (e) { results[s.id] = { error: e.message || '取得失敗' }; }
    if (i < fxSyms.length - 1) await sleep(8000);
  }

  // トレンド信号(H4/D1/W1) — 全13銘柄で計算し、上位3つを「今日の主力候補」として抽出
  console.log('トレンド信号(H4/D1/W1)を計算中（全13銘柄）...');
  const trendGreen = {};
  for (const sym of AUTO_SYMS) {
    const symId = sym.id;
    if (!h4Cache[symId]) continue;
    let g = trendBias(h4Cache[symId]) === 'BULL' ? 1 : 0;
    try {
      let d1, w1;
      if (sym.src === 'binance') {
        d1 = await fetchBinanceKlines(sym.bsym, '1d', 120);
        w1 = await fetchBinanceKlines(sym.bsym, '1w', 60);
      } else {
        await sleep(8000);
        d1 = await fetchTDKlines(sym.tsym, '1day', 120);
        await sleep(8000);
        w1 = await fetchTDKlines(sym.tsym, '1week', 60);
      }
      if (d1 && trendBias(d1) === 'BULL') g++;
      if (w1 && trendBias(w1) === 'BULL') g++;
    } catch (e) { /* ignore, keep partial score */ }
    trendGreen[symId] = g;
  }
  // 上位3つをランキング（同点はメインシグナルが「確定」のものを優先）
  const top3 = AUTO_SYMS.map((s) => s.id)
    .filter((id) => trendGreen[id] != null)
    .sort((a, b) => {
      if (trendGreen[b] !== trendGreen[a]) return trendGreen[b] - trendGreen[a];
      const aConfirmed = results[a] && results[a].judge && results[a].judge.startsWith('確定') ? 1 : 0;
      const bConfirmed = results[b] && results[b].judge && results[b].judge.startsWith('確定') ? 1 : 0;
      return bConfirmed - aConfirmed;
    })
    .slice(0, 3)
    .map((id) => ({ pair: id, green: trendGreen[id], dir: trendGreen[id] >= 2 ? 'up' : 'down' }));

  // COT (CFTC) — サーバーサイドなのでCORSの心配なし
  console.log('COT(CFTC)を取得中...');
  const cotBiasByPair = {};
  let cotDate = null;
  try {
    const keys = Object.keys(COT_KEYWORDS);
    const cotResults = await Promise.all(keys.map((k) => fetchCotNet(COT_KEYWORDS[k]).catch((e) => ({ error: e.message }))));
    const nets = {};
    keys.forEach((k, i) => {
      const res = cotResults[i];
      if (res && !res.error) { nets[k] = res.net; if (res.date && (!cotDate || res.date > cotDate)) cotDate = res.date; }
    });
    if (nets.XAU != null) cotBiasByPair.XAUUSD = classifyCotBias(nets.XAU);
    if (nets.BTC != null) cotBiasByPair.BTCUSD = classifyCotBias(nets.BTC);
    Object.keys(FX_STRENGTH_LEGS).forEach((pair) => {
      const [baseK, quoteK] = FX_STRENGTH_LEGS[pair];
      if (nets[baseK] == null || nets[quoteK] == null) return;
      cotBiasByPair[pair] = classifyCotBias(nets[baseK] - nets[quoteK]);
    });
  } catch (e) {
    console.error('COT取得エラー:', e.message);
  }

  // 通貨強弱 + Macro Dashboard Dollar arrow
  const sums = {}, counts = {};
  Object.keys(FX_STRENGTH_LEGS).forEach((pair) => {
    const r = results[pair];
    if (!r || r.weeklyPct == null) return;
    const [baseK, quoteK] = FX_STRENGTH_LEGS[pair];
    sums[baseK] = (sums[baseK] || 0) + r.weeklyPct; counts[baseK] = (counts[baseK] || 0) + 1;
    sums[quoteK] = (sums[quoteK] || 0) - r.weeklyPct; counts[quoteK] = (counts[quoteK] || 0) + 1;
  });
  const csiData = { DXY: null, JXY: null, EXY: null, BXY: null, CHFX: null, AXY: null, XAU: null, BTC: null };
  ['DXY', 'JXY', 'EXY', 'BXY', 'CHFX', 'AXY'].forEach((k) => { if (counts[k] > 0) csiData[k] = +(sums[k] / counts[k]).toFixed(2); });
  if (results.XAUUSD && results.XAUUSD.weeklyPct != null) csiData.XAU = results.XAUUSD.weeklyPct;
  if (results.BTCUSD && results.BTCUSD.weeklyPct != null) csiData.BTC = results.BTCUSD.weeklyPct;
  const dxyBias = csiData.DXY == null ? null : csiData.DXY > 0.3 ? 'strong' : csiData.DXY < -0.3 ? 'weak' : 'neutral';

  // 経済指標カレンダー（ForexFactory公開JSON、無料・キー不要）
  let todayEvents = [];
  console.log('経済指標カレンダーを取得中...');
  try {
    todayEvents = await fetchTodayEvents();
  } catch (e) {
    console.error('経済指標カレンダー取得エラー:', e.message);
  }

  const output = {
    ts: Date.now(),
    generatedAt: new Date().toISOString(),
    killZoneAtGenTime: getKillZoneJST(),
    results,
    trendGreen,
    top3,
    cotBiasByPair,
    cotDate,
    csiData,
    dxyBias,
    todayEvents,
  };

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(output, null, 2));
  console.log('完了:', OUT_PATH);

  // 高確度シグナル（Tier1・確定・RR2以上）をDiscordに通知（Webhook未設定ならスキップ）
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
  if (webhookUrl) {
    const hot = Object.entries(results).filter(([id, r]) =>
      r && !r.error && r.tier === 'Tier1' && r.judge && r.judge.startsWith('確定') && r.rr != null && r.rr >= 2
    );
    if (hot.length) {
      const lines = hot.map(([id, r]) => `**${id}** ${r.dir} — ${r.note} (RR 1:${r.rr})`);
      const content = `🎯 高確度シグナル検出（Tier1・確定・RR2以上）\n${lines.join('\n')}`;
      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
        console.log('Discord通知:', res.status, hot.length + '件');
      } catch (e) {
        console.error('Discord通知エラー:', e.message);
      }
    } else {
      console.log('高確度シグナルなし（通知スキップ）');
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
