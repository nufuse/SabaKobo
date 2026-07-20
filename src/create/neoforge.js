/**
 * create/neoforge.js — NeoForge鯖の作成(Forgeの後継。versions APIからビルドを選びインストーラ実行)
 * 唯一「鯖ができる前にJDKが要る」経路(Forgeと同じ)。数分かかるので標準出力をコンソール枠へ流す。
 *
 * バージョン文字列の読み方(実物検証済み。1613件・major∈{0,20,21,26}):
 * - "0.25w14craftmine.*" はエイプリルフール版。必ず除外
 * - 3要素(例 "21.1.95", "20.2.23-beta")   → MC "1.<最初の2要素>" (例 21.1.95 → 1.21.1)
 * - 4要素(例 "26.2.0.25-beta")            → MC "<最初の2要素>"   (例 26.2.0.25 → 26.2、Minecraft自身のカレンダー表記に合わせる)
 * 要素数で見分けているのが実データと一致することを実APIで確認済み(20.2〜21.xは常に3要素、26.x以降は常に4要素)。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');
const { fetchJSON, downloadFile } = require('../download');

const API = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
let cache = null; /* {at, builds} builds=craftmine除去・パース済みの全ビルド */

function mcTuple(v) { return String(v).split(/[.\-]/).map(n => parseInt(n, 10) || 0); }
function cmpMc(a, b) {
  const ta = mcTuple(a), tb = mcTuple(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const d = (tb[i] || 0) - (ta[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* ビルド番号どうしの比較(新しい順)。partsは純粋な数値配列 */
function cmpParts(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] || 0) - (a[i] || 0);
    if (d) return d;
  }
  return 0;
}

/* 1件の生バージョン文字列を解釈する。読めない/エイプリルフール版はnull */
function parse(v) {
  if (/craftmine/i.test(v)) return null;
  const m = String(v).match(/^(\d+(?:\.\d+)+)/);
  if (!m) return null;
  const parts = m[1].split('.').map(n => parseInt(n, 10));
  const beta = /-beta$/.test(v);
  if (parts.length === 3) return { version: v, mc: `1.${parts[0]}.${parts[1]}`, parts, beta };
  if (parts.length === 4) return { version: v, mc: `${parts[0]}.${parts[1]}`, parts, beta };
  return null;
}

async function loadBuilds(signal) {
  if (cache && Date.now() - cache.at < 60 * 60 * 1000) return cache.builds;
  const j = await fetchJSON(API, { signal });
  const builds = (j.versions || []).map(parse).filter(Boolean);
  cache = { at: Date.now(), builds };
  return builds;
}

/** そのMCバージョンに対応するビルド(バージョン文字列)を新しい順で返す。
    後続のmodpack取り込みで「manifestが指すNeoForgeビルド」を探すのに使う */
async function buildsFor(mc, signal) {
  const builds = await loadBuilds(signal);
  return builds.filter(b => b.mc === mc).sort((a, b) => cmpParts(a.parts, b.parts)).map(b => b.version);
}

/** 対応ビルドがあるMCバージョンの一覧(新しい順) */
async function listVersions() {
  const builds = await loadBuilds();
  const set = new Set(builds.map(b => b.mc));
  return [...set].sort(cmpMc);
}

async function create({ mc, dir, javaExe, loaderVersion, onProgress, onLog, signal }) {
  let full = loaderVersion;
  if (!full) {
    const builds = await buildsFor(mc, signal); /* 新しい順 */
    if (!builds.length) throw new Error(`NeoForge ${mc} 向けのバージョンが見つかりません`);
    full = builds.find(v => !/-beta$/.test(v)) || builds[0]; /* -betaなし優先、無ければ最新beta */
  }

  const installer = path.join(dir, `neoforge-${full}-installer.jar`);
  await downloadFile(`${MAVEN}/${full}/neoforge-${full}-installer.jar`, installer, { onProgress, signal });

  /* インストーラ実行(--installServer)。cwd=鯖フォルダ(forge.jsと同じ流儀) */
  await new Promise((resolve, reject) => {
    const p = spawn(javaExe, ['-jar', installer, '--installServer'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    for (const stream of [p.stdout, p.stderr]) {
      stream.setEncoding('utf8');
      readline.createInterface({ input: stream, crlfDelay: Infinity })
        .on('line', l => { if (onLog) onLog(l); });
    }
    const onAbort = () => { try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch { } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    p.once('error', reject);
    p.once('exit', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) reject(new Error('中止しました'));
      else if (code === 0) resolve();
      else reject(new Error(`NeoForgeインストーラが失敗しました(終了コード ${code})。フォルダを確認してください`));
    });
  });

  /* 期待物の確認と掃除。NeoForgeのフォルダ名はMC無しの<full>単独 */
  const libDir = path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge', full);
  if (!fs.existsSync(path.join(libDir, 'win_args.txt'))) {
    throw new Error('インストーラは成功しましたが win_args.txt が見つかりません');
  }
  for (const f of [installer, installer + '.log', path.join(dir, 'installer.log')]) {
    try { fs.unlinkSync(f); } catch { }
  }
  return { jar: null, loaderVersion: full };
}

/* parseはdetect.js(v0.4 サーバーパック導入)がフォルダ名→MC版の変換を再利用するために公開 */
module.exports = { listVersions, create, buildsFor, parse };
