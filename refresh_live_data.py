#!/usr/bin/env python3
"""
Mission Metrics — Options Backtester
Live Data Refresher
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Run this script anytime to pull fresh
prices + options chains from Yahoo Finance
and rebuild your backtester app.

HOW TO RUN:
  python3 refresh_live_data.py

REQUIREMENTS:
  pip install yfinance
"""

import yfinance as yf
import json, os, sys, webbrowser
from datetime import datetime, timedelta

TICKERS    = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA']
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(SCRIPT_DIR, 'public')
DATA_FILE  = os.path.join(SCRIPT_DIR, 'live_data.json')
# The refresh script outputs the live app directly into public/
APP_FILE   = os.path.join(PUBLIC_DIR, 'options-backtester.html')
# Base template: keep a copy WITHOUT live data in the repo root for the script to read
BASE_FILE  = os.path.join(SCRIPT_DIR, 'options-backtester-base.html')
OUT_DIR    = SCRIPT_DIR

def fetch_all():
    end   = datetime.today()
    start = end - timedelta(days=730)
    price_data   = {}
    options_data = {}

    print("━" * 50)
    print("  Mission Metrics — Fetching Live Data")
    print("━" * 50)

    print("\n📈 Historical Prices (2 years)...")
    for sym in TICKERS:
        try:
            t    = yf.Ticker(sym)
            hist = t.history(start=start.strftime('%Y-%m-%d'), end=end.strftime('%Y-%m-%d'))
            hist = hist.dropna(subset=['Close'])
            dates  = [str(d.date()) for d in hist.index]
            prices = [round(float(c), 2) for c in hist['Close']]
            price_data[sym] = {'dates': dates, 'prices': prices}
            chg = ((prices[-1] - prices[-2]) / prices[-2] * 100) if len(prices) > 1 else 0
            arrow = "▲" if chg >= 0 else "▼"
            print(f"  {sym:5s} ${prices[-1]:>8.2f}  {arrow} {chg:+.2f}%  ({len(dates)} days)")
        except Exception as e:
            print(f"  {sym}: ERROR — {e}")

    print("\n⚡ Live Options Chains...")
    for sym in TICKERS:
        try:
            t    = yf.Ticker(sym)
            exps = t.options[:3]
            opts = {}
            for exp in exps:
                chain = t.option_chain(exp)
                cols  = ['strike','lastPrice','bid','ask','impliedVolatility','openInterest','volume']
                calls = chain.calls[cols].head(12).fillna(0)
                puts  = chain.puts[cols].head(12).fillna(0)
                opts[exp] = {
                    'calls': [[round(float(x), 4) for x in row] for row in calls.values.tolist()],
                    'puts':  [[round(float(x), 4) for x in row] for row in puts.values.tolist()],
                }
            options_data[sym] = opts
            print(f"  {sym:5s} {len(exps)} expirations: {', '.join(exps)}")
        except Exception as e:
            print(f"  {sym}: options unavailable — {e}")
            options_data[sym] = {}

    fetched = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    payload = {'prices': price_data, 'options': options_data, 'fetched': fetched}
    with open(DATA_FILE, 'w') as f:
        json.dump(payload, f, separators=(',', ':'))

    print(f"\n✅ Data saved ({os.path.getsize(DATA_FILE)//1024} KB) — {fetched}")
    return payload

def build_html(live):
    if not os.path.exists(BASE_FILE):
        print(f"\n❌ Base file not found: {BASE_FILE}")
        print("   Please make sure options-backtester-base.html is in the repo root.")
        sys.exit(1)

    with open(BASE_FILE) as f:
        base = f.read()

    fetched  = live['fetched']
    prices   = live['prices']
    options  = live['options']
    price_js = json.dumps(prices, separators=(',', ':'))
    opts_js  = json.dumps(options, separators=(',', ':'))

    EXTRA_CSS = """
/* ---- LIVE CHAIN ---- */
.chain-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.chain-panel{background:white;border-radius:12px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,.06);}
.chain-tbl{width:100%;border-collapse:collapse;font-size:12px;}
.chain-tbl th{background:var(--navy);color:white;padding:8px 10px;text-align:right;font-size:11px;font-weight:600;}
.chain-tbl th:first-child{text-align:left;border-radius:6px 0 0 0;}
.chain-tbl th:last-child{border-radius:0 6px 0 0;}
.chain-tbl td{padding:7px 10px;border-bottom:1px solid var(--gray-200);text-align:right;}
.chain-tbl td:first-child{text-align:left;font-weight:600;color:var(--navy);}
.chain-tbl tr:hover td{background:var(--mint-bg);}
.itm-call{background:#D1FAE5;}.itm-put{background:#FEE2E2;}
.live-dot{display:inline-block;width:8px;height:8px;background:#10B981;border-radius:50%;margin-right:6px;animation:pulse 1.5s infinite;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
.price-card{background:var(--navy);color:white;border-radius:10px;padding:14px 18px;text-align:center;}
.price-card .sym{font-size:13px;color:#A0B0C8;margin-bottom:4px;}
.price-card .px{font-size:26px;font-weight:800;color:var(--emerald-light);}
.price-cards-row{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:18px;}
"""

    LIVE_TAB_BTN = '<button class="tab-btn" onclick="showTab(\'chain\',this)">⚡ Live Options Chain</button>'

    LIVE_TAB = f"""
<div id="tab-chain" class="tab-content">
<div class="container">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
    <span class="live-dot"></span>
    <span style="font-size:13px;font-weight:700;color:var(--navy);">Live Market Data — Yahoo Finance</span>
    <span style="font-size:11px;color:var(--gray-500);margin-left:8px;">Last fetched: {fetched}</span>
  </div>
  <div class="price-cards-row" id="price-cards"></div>
  <div style="display:flex;gap:12px;align-items:flex-end;margin-bottom:16px;">
    <div class="fg" style="margin:0;flex:0 0 180px;">
      <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--gray-500);">Symbol</label>
      <select id="chain-sym" onchange="populateExps()" style="margin-top:4px;padding:8px 10px;border:1.5px solid var(--gray-200);border-radius:7px;font-size:13px;color:var(--navy);background:var(--gray-100);width:100%;">
        <option>SPY</option><option>QQQ</option><option>AAPL</option><option>TSLA</option><option>NVDA</option>
      </select>
    </div>
    <div class="fg" style="margin:0;flex:0 0 220px;">
      <label style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--gray-500);">Expiration</label>
      <select id="chain-exp" onchange="renderChain()" style="margin-top:4px;padding:8px 10px;border:1.5px solid var(--gray-200);border-radius:7px;font-size:13px;color:var(--navy);background:var(--gray-100);width:100%;"></select>
    </div>
  </div>
  <div class="chain-grid">
    <div class="chain-panel">
      <div class="ctitle" style="color:#065F46;">📈 CALLS — Green rows = In The Money</div>
      <table class="chain-tbl"><thead><tr><th>Strike</th><th>Last</th><th>Bid</th><th>Ask</th><th>IV%</th><th>OI</th><th>Vol</th></tr></thead>
      <tbody id="calls-body"></tbody></table>
    </div>
    <div class="chain-panel">
      <div class="ctitle" style="color:#991B1B;">📉 PUTS — Red rows = In The Money</div>
      <table class="chain-tbl"><thead><tr><th>Strike</th><th>Last</th><th>Bid</th><th>Ask</th><th>IV%</th><th>OI</th><th>Vol</th></tr></thead>
      <tbody id="puts-body"></tbody></table>
    </div>
  </div>
  <div class="panel" style="margin-top:16px;">
    <div class="panel-title">💡 How To Read This Chain</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:18px;font-size:12px;color:var(--gray-700);line-height:1.7;">
      <div><strong style="color:var(--navy);">IV% — Implied Volatility</strong><br>How expensive the option is. High IV = sell premium strategies (covered calls, iron condors). Low IV = buy directional (straddles, spreads).</div>
      <div><strong style="color:var(--navy);">Bid / Ask Spread</strong><br>Always enter orders between bid and ask (limit orders). Tight spread = liquid option. Wide spread = costs you more to enter.</div>
      <div><strong style="color:var(--navy);">Open Interest (OI)</strong><br>Total open contracts. High OI = institutional attention at that strike. These levels often act as support/resistance per the Master Surge Strategy.</div>
    </div>
  </div>
</div>
</div>
"""

    LIVE_JS = f"""
const LIVE_PRICES  = {price_js};
const LIVE_OPTIONS = {opts_js};

function renderPriceCards() {{
  const row = document.getElementById('price-cards');
  if (!row) return;
  row.innerHTML = ['SPY','QQQ','AAPL','TSLA','NVDA'].map(s => {{
    const d = LIVE_PRICES[s]; if (!d) return '';
    const last = d.prices[d.prices.length-1];
    const prev = d.prices.length > 1 ? d.prices[d.prices.length-2] : last;
    const chg  = ((last-prev)/prev*100).toFixed(2);
    const col  = chg >= 0 ? '#10B981' : '#EF4444';
    return `<div class="price-card"><div class="sym">${{s}}</div><div class="px">$${{last}}</div><div style="font-size:12px;color:${{col}};margin-top:3px;">${{chg>=0?'+':''}}${{chg}}%</div></div>`;
  }}).join('');
}}

function populateExps() {{
  const sym = document.getElementById('chain-sym')?.value||'SPY';
  const sel = document.getElementById('chain-exp');
  if (!sel) return;
  const opts = LIVE_OPTIONS[sym]||{{}};
  sel.innerHTML = Object.keys(opts).map(e=>`<option>${{e}}</option>`).join('');
  renderChain();
}}

function renderChain() {{
  const sym  = document.getElementById('chain-sym')?.value||'SPY';
  const exp  = document.getElementById('chain-exp')?.value||'';
  const data = (LIVE_OPTIONS[sym]||{{}})[exp]||{{calls:[],puts:[]}};
  const spot = LIVE_PRICES[sym]?.prices.at(-1)||0;
  function rows(list, type) {{
    return list.map(r => {{
      const [strike,last,bid,ask,iv,oi,vol]=r;
      const itm = type==='call'?(spot>strike):(spot<strike);
      return `<tr class="${{itm?(type==='call'?'itm-call':'itm-put'):''}}">
        <td>$${{(+strike).toFixed(0)}}</td><td>$${{(+last).toFixed(2)}}</td>
        <td>$${{(+bid).toFixed(2)}}</td><td>$${{(+ask).toFixed(2)}}</td>
        <td>${{(+iv*100).toFixed(1)}}%</td><td>${{(+oi).toLocaleString()}}</td>
        <td>${{(+vol).toLocaleString()}}</td></tr>`;
    }}).join('');
  }}
  document.getElementById('calls-body').innerHTML = rows(data.calls,'call');
  document.getElementById('puts-body').innerHTML  = rows(data.puts,'put');
}}

// Override simulated prices with real data
function genPrices(startDate, endDate, s0, mu, sigma, seed) {{
  const sym = document.getElementById('sym')?.value||'SPY';
  const raw = LIVE_PRICES[sym];
  if (!raw) return {{dates:[],prices:[]}};
  const res = {{dates:[],prices:[]}};
  raw.dates.forEach((d,i) => {{
    if (d >= startDate && d <= endDate) {{ res.dates.push(d); res.prices.push(raw.prices[i]); }}
  }});
  return res.dates.length > 10 ? res : {{dates:raw.dates, prices:raw.prices}};
}}
"""

    html = base.replace('</style>', EXTRA_CSS + '\n</style>', 1)
    html = html.replace(
        '  <button class="tab-btn" onclick="showTab(\'about\',this)">📖 Strategy Guide</button>',
        '  <button class="tab-btn" onclick="showTab(\'about\',this)">📖 Strategy Guide</button>\n  ' + LIVE_TAB_BTN
    )
    html = html.replace('<!-- ===== ABOUT TAB ===== -->', LIVE_TAB + '\n<!-- ===== ABOUT TAB ===== -->')
    html = html.replace('</script>', LIVE_JS + '\n</script>', 1)
    html = html.replace('calcSET();', 'calcSET();\nrenderPriceCards();\npopulateExps();')
    html = html.replace(
        "if (tab === 'regime') renderRegimeTab();",
        "if (tab === 'regime') renderRegimeTab();\nif (tab === 'chain') { renderPriceCards(); populateExps(); }"
    )

    with open(APP_FILE, 'w') as f:
        f.write(html)

    kb = os.path.getsize(APP_FILE) // 1024
    print(f"\n🏗️  App rebuilt → options-backtester-live.html ({kb} KB)")

def main():
    live = fetch_all()
    build_html(live)

    print("\n━" * 25)
    print("  ✅ ALL DONE!")
    print(f"  Open: {APP_FILE}")
    print("━" * 25)

    try:
        webbrowser.open('file://' + APP_FILE)
        print("  🌐 Opening in browser...")
    except Exception:
        pass

if __name__ == '__main__':
    main()
