// ============================================================
// ニュースアプリ — GASスクリプト(データ取得プロキシ専用)
// 役割:
//  1) Googleニュース検索RSSを取得してJSON化する(doGet)
//  2) Yahoo!ファイナンスの投資信託ページから基準価格・前日比を取得する
//  3) 取得結果をCacheService/PropertiesServiceでキャッシュし、
//     取得失敗時は直近の成功値にフォールバックする
// ============================================================
// 【セットアップ手順の概要(詳細は setup_guide.txt)】
// 1. https://script.google.com で新規プロジェクト作成し、このコードを貼り付け
// 2. 下記 FUNDS のファンドコードを確認(初期値は動作確認済みだが、変更したい
//    ファンドがあれば finance.yahoo.co.jp で検索してコードを差し替える)
// 3. デプロイ → 新しいデプロイ → ウェブアプリ → 自分として実行 →
//    アクセスできるユーザー「全員」で公開
// 4. 発行されたURLをアプリの設定画面「GAS Web App URL」欄に貼り付け
// ============================================================

// --- 設定 ---
// code は Yahoo!ファイナンスの投信ページURL末尾のコード。
// 下記2件は https://finance.yahoo.co.jp/quote/<code> で実データ確認済み。
const FUNDS = [
  { key: 'sp500', name: 'eMAXIS Slim米国株式(S&P500)', code: '03311187' },
  { key: 'orikan', name: 'eMAXIS Slim全世界株式(オール・カントリー)', code: '0331418A' }
];

const NEWS_CACHE_TTL = 600;   // 10分
const ALL_CACHE_TTL = 600;    // 10分
const FUND_CACHE_TTL = 1800;  // 30分(基準価格は営業日1回更新のため長め)

// --- エントリーポイント ---
function doGet(e) {
  const category = ((e && e.parameter && e.parameter.category) || 'all').toLowerCase();
  try {
    const data = dispatch(category);
    return jsonOut({ status: 'ok', category: category, data: data, generatedAt: new Date().toISOString() });
  } catch (err) {
    return jsonOut({ status: 'error', category: category, error: String(err) });
  }
}

function dispatch(category) {
  switch (category) {
    case 'entertainment': return fetchNewsCategory('芸能', 10, 'cat_ent');
    case 'economy': return fetchNewsCategory('経済', 10, 'cat_eco');
    case 'tottori': return fetchNewsCategory('鳥取市 OR 鳥取県', 5, 'cat_tot');
    case 'rizin': return fetchNewsCategory('RIZIN', 10, 'cat_riz');
    case 'tesla': return fetchNewsCategory('テスラ OR Tesla', 10, 'cat_tsl');
    case 'funds': return fetchFundsBundle();
    case 'all':
    default: return getAllData();
  }
}

// --- 全カテゴリ一括取得(クライアントは基本これだけを呼ぶ) ---
function getAllData() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('all_bundle');
  if (cached) return JSON.parse(cached);

  const data = {
    entertainment: fetchNewsCategory('芸能', 10, 'cat_ent'),
    economy: fetchNewsCategory('経済', 10, 'cat_eco'),
    tottori: fetchNewsCategory('鳥取市 OR 鳥取県', 5, 'cat_tot'),
    rizin: fetchNewsCategory('RIZIN', 10, 'cat_riz'),
    tesla: fetchNewsCategory('テスラ OR Tesla', 10, 'cat_tsl'),
    funds: fetchFundsBundle()
  };
  cache.put('all_bundle', JSON.stringify(data), ALL_CACHE_TTL);
  return data;
}

// --- Googleニュース検索RSS取得 ---
function buildGoogleNewsUrl(keyword) {
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(keyword) + '&hl=ja&gl=JP&ceid=JP:ja';
}

function fetchNewsCategory(keyword, limit, cacheKey) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const props = PropertiesService.getScriptProperties();
  const lastKey = 'news_last_' + cacheKey;

  try {
    const res = UrlFetchApp.fetch(buildGoogleNewsUrl(keyword), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const xml = res.getContentText('UTF-8');
    const items = parseGoogleNewsRss(xml, limit);
    const json = JSON.stringify(items);
    cache.put(cacheKey, json, NEWS_CACHE_TTL);
    props.setProperty(lastKey, json);
    return items;
  } catch (err) {
    const last = props.getProperty(lastKey);
    if (last) return JSON.parse(last);
    return [];
  }
}

function parseGoogleNewsRss(xmlText, limit) {
  const doc = XmlService.parse(xmlText);
  const channel = doc.getRootElement().getChild('channel');
  if (!channel) return [];
  const items = channel.getChildren('item');
  const result = [];
  for (let i = 0; i < items.length && result.length < limit; i++) {
    result.push(cleanGoogleNewsItem(items[i]));
  }
  return result;
}

// Googleニュースのタイトルは "見出し - 発行元" 形式のため、
// <source>要素が無い場合は最後の " - " で分割して見出しと発行元に分ける。
function cleanGoogleNewsItem(item) {
  const rawTitle = item.getChildText('title') || '';
  const link = item.getChildText('link') || '';
  const pubDate = item.getChildText('pubDate') || '';
  const sourceEl = item.getChild('source');
  let source = sourceEl ? sourceEl.getText() : '';
  let title = rawTitle;

  if (!source) {
    const idx = rawTitle.lastIndexOf(' - ');
    if (idx > -1) {
      title = rawTitle.substring(0, idx);
      source = rawTitle.substring(idx + 3);
    }
  }
  return { title: title, link: link, pubDate: pubDate, source: source };
}

// --- 投資信託(基準価格・前日比 + 関連ニュース) ---
function fetchFundsBundle() {
  return {
    funds: FUNDS.map(scrapeYahooFundPage),
    relatedNews: fetchNewsCategory('投資信託 OR S&P500 OR オルカン', 5, 'cat_fund')
  };
}

// Yahoo!ファイナンスの投信ページHTMLから基準価格・前日比を抽出する。
// クラス名の末尾(ハッシュ)はビルドごとに変わり得るため、
// 意味のあるクラス名の接頭辞(PriceBoard__price__ / StyledNumber__value)を
// 目印にして抽出している(2026年時点の実ページで検証済み)。
// ページ構造が変わり抽出に失敗した場合は、前回成功値を stale:true で返す。
function scrapeYahooFundPage(fundConfig) {
  const props = PropertiesService.getScriptProperties();
  const lastKey = 'fund_last_' + fundConfig.key;

  try {
    const url = 'https://finance.yahoo.co.jp/quote/' + fundConfig.code;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
    const html = res.getContentText('UTF-8');

    const nav = extractNav(html);
    const change = extractChange(html);
    if (!nav) throw new Error('基準価格を取得できませんでした');

    const result = {
      key: fundConfig.key,
      name: fundConfig.name,
      nav: nav,
      changeAbs: change.abs,
      changePct: change.pct,
      stale: false,
      updatedAt: new Date().toISOString()
    };
    props.setProperty(lastKey, JSON.stringify(result));
    return result;
  } catch (err) {
    const last = props.getProperty(lastKey);
    if (last) {
      const lastResult = JSON.parse(last);
      lastResult.stale = true;
      return lastResult;
    }
    return {
      key: fundConfig.key, name: fundConfig.name,
      nav: null, changeAbs: null, changePct: null,
      stale: true, error: String(err)
    };
  }
}

function extractNav(html) {
  const m = html.match(/PriceBoard__price__[A-Za-z0-9]+[\s\S]{0,200}?StyledNumber__value[^>]*>([\d,]+(?:\.\d+)?)</);
  return m ? m[1] : null;
}

function extractChange(html) {
  const idx = html.indexOf('前日比');
  if (idx === -1) return { abs: null, pct: null };
  const windowText = html.substring(idx, idx + 800);
  const matches = windowText.match(/StyledNumber__value[^>]*>(-?[\d,]+(?:\.\d+)?)</g);
  if (!matches || matches.length < 2) return { abs: null, pct: null };
  const pick = function (s) {
    const m = s.match(/>(-?[\d,]+(?:\.\d+)?)</);
    return m ? m[1] : null;
  };
  return { abs: pick(matches[0]), pct: pick(matches[1]) };
}

// --- 共通ヘルパー ---
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
