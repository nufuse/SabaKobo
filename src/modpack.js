/**
 * modpack.js — .mrpack(Modrinthのmodpack形式)取り込みエンジン(v0.4)
 *
 * .mrpackの実体はzip。ルートの modrinth.index.json がマニフェストで、
 * overrides\ → server-overrides\ の順に鯖フォルダへ上書き適用する(client-overrides\は鯖では無視)。
 * ここではファイルの取得・検証・配置までを担当し、EULA同意やIPC・進捗表示はmain.js側の仕事。
 */
'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip');
const download = require('./download');
const properties = require('./properties');
const detect = require('./detect');

const creators = {
  paper: require('./create/paper'),
  fabric: require('./create/fabric'),
  forge: require('./create/forge'),
  neoforge: require('./create/neoforge'),
  vanilla: require('./create/vanilla')
};

/* mrpackのdependenciesキー → 鯖工房内部でのローダー名 */
const LOADER_KEYS = { 'fabric-loader': 'fabric', forge: 'forge', neoforge: 'neoforge' };

/* ── 作業フォルダ ─────────────────────── */
function newWorkDir() {
  return path.join(app.getPath('temp'), `sabakobo-pack-${crypto.randomBytes(6).toString('hex')}`);
}

/* ── パス検証(zip-slip/絶対パス対策。tar.exe自体も弾くが二重で確かめる) ── */
function assertSafePath(p) {
  const norm = String(p).replace(/\\/g, '/');
  if (path.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..')) {
    throw new Error(`不正なファイルパスです: ${p}`);
  }
}

/* ── フォルダの再帰コピー(後勝ち上書き。ファイルのみ対象) ── */
function copyRecursive(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      copyRecursive(s, d);
    } else if (ent.isFile()) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

/* ── フォルダの丸ごと移動(同一ボリュームならrename、失敗したら再帰コピー+元を消す) ── */
function moveEntry(src, dest) {
  try {
    fs.renameSync(src, dest);
    return;
  } catch { /* 別ボリューム等でrenameできない → 下の再帰コピーへ */ }
  const st = fs.lstatSync(src); /* シンボリックリンクを辿らない(copyRecursiveのDirentチェックと同じ二重防御) */
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    copyRecursive(src, dest);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  fs.rmSync(src, { recursive: true, force: true });
}

function moveContents(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    moveEntry(path.join(srcDir, name), path.join(destDir, name));
  }
}

/* ── 解析 ─────────────────────────── */

/**
 * 展開済みのroot(modrinth.index.jsonがある場所)を読み、鯖工房が扱える形へ検証・整形する。
 * analyzeMrpack(.mrpack単体)とanalyzeZip(zip内にmrpackが入っていた場合)の両方から呼ばれる。
 */
function buildMrpackPlan(root) {
  const indexPath = path.join(root, 'modrinth.index.json');
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    throw new Error('mrpackとして読めません(modrinth.index.jsonがありません)');
  }

  if (index.formatVersion !== 1 || index.game !== 'minecraft') {
    throw new Error('対応していないmrpack形式です');
  }
  const mcVersion = index.dependencies && index.dependencies.minecraft;
  if (!mcVersion) throw new Error('minecraftバージョンの指定がありません');

  /* ローダーはfabric-loader/forge/neoforgeのうち丁度1つ。quilt-loaderは明示エラー(黙って壊れない) */
  const deps = index.dependencies || {};
  const loaderKeys = Object.keys(LOADER_KEYS).filter(k => deps[k]);
  if (loaderKeys.length !== 1) {
    if (deps['quilt-loader']) throw new Error('Quiltは未対応です');
    throw new Error('対応するローダー(Fabric/Forge/NeoForge)が見つかりません');
  }
  const loaderKey = loaderKeys[0];
  const loader = LOADER_KEYS[loaderKey];
  const loaderVersion = deps[loaderKey];

  /* files: パス脱出防止のため、鯖用に残す前に全件検証する */
  const rawFiles = index.files || [];
  for (const f of rawFiles) assertSafePath(f.path);

  const files = [];
  for (const f of rawFiles) {
    if (f.env && f.env.server === 'unsupported') continue; /* env無しは含める */
    const p = String(f.path).replace(/\\/g, '/');
    const url = f.downloads && f.downloads[0];
    if (!url) throw new Error(`ダウンロードURLがありません: ${f.path}`);
    files.push({ path: p, url, sha512: f.hashes && f.hashes.sha512, size: f.fileSize });
  }
  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

  return {
    name: index.name || 'modpack',
    summary: index.summary || '',
    mcVersion,
    loader,
    loaderVersion,
    files,
    fileCount: files.length,
    totalSize
  };
}

/**
 * .mrpackを展開してmodrinth.index.jsonを読み、鯖工房が扱える形へ検証・整形する。
 * 戻り値のworkDir(展開先の作業フォルダ)は install 完了後に削除される想定。
 */
async function analyzeMrpack(mrpackPath, { signal } = {}) {
  const workDir = newWorkDir();
  try {
    await zip.extract(mrpackPath, workDir, { signal });
    const plan = buildMrpackPlan(workDir);
    return { ...plan, workDir };
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}

/* 直下が「フォルダ1個だけ・ファイル0個」なら、その中身をworkDir直下へ引き上げる(一皮むき)。
   CurseForgeのサーバーパックzipは1階層包んでいる配布が多いため */
function flattenSingleWrapper(workDir) {
  const entries = fs.readdirSync(workDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory());
  const files = entries.filter(e => e.isFile());
  if (dirs.length !== 1 || files.length !== 0) return;
  const inner = path.join(workDir, dirs[0].name);
  for (const name of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, name), path.join(workDir, name));
  }
  fs.rmdirSync(inner);
}

/**
 * サーバーパックzip(CurseForge配布に多い、鯖フォルダ一式が丸ごと入ったzip)を解析する。
 * ルートにmodrinth.index.jsonがあればmrpack扱い(.mrpackをzipに改名して配る例があるため)。
 * CurseForgeのクライアント用パック(manifest.jsonのみで起動手段が無いもの)は明示エラーにする。
 */
async function analyzeZip(zipPath, { signal } = {}) {
  const workDir = newWorkDir();
  try {
    await zip.extract(zipPath, workDir, { signal });
    flattenSingleWrapper(workDir);

    if (fs.existsSync(path.join(workDir, 'modrinth.index.json'))) {
      const plan = buildMrpackPlan(workDir);
      return { kind: 'mrpack', ...plan, workDir };
    }

    const estimate = detect.detect(workDir);
    const hasLoaderFiles = estimate.loader != null; /* jar/win_args等の起動手段が既にあるか */

    const manifestPath = path.join(workDir, 'manifest.json');
    if (fs.existsSync(manifestPath) && !hasLoaderFiles) {
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* 読めなくても以降の判定は続ける */ }
      const looksLikeCfClient = Array.isArray(manifest && manifest.files) &&
        manifest.files.some(f => f && (f.projectID != null || f.fileID != null));
      if (looksLikeCfClient) {
        throw new Error('これはCurseForgeのクライアント用パックです。配布ページの「Server Pack(Server Files)」のzipを使ってください');
      }
    }

    return { kind: 'serverpack', workDir, estimate, hasLoaderFiles };
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}

/* ── ファイル取得(並列4本。1つ失敗したら全体中止) ── */
async function downloadPlanFiles(files, dir, onEach, signal) {
  let index = 0;
  let doneCount = 0;
  let firstError = null;
  const ac = new AbortController();
  const merged = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;

  async function worker() {
    for (;;) {
      if (firstError) return;
      const i = index++;
      if (i >= files.length) return;
      const f = files[i];
      const dest = path.join(dir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        await download.downloadFile(f.url, dest, { sha512: f.sha512, signal: merged });
        doneCount++;
        if (onEach) onEach(doneCount, f.path);
      } catch (err) {
        if (!firstError) { firstError = err; ac.abort(); }
        return;
      }
    }
  }

  const workerCount = Math.min(4, files.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (firstError) throw firstError;
}

/* ── 取り込み ─────────────────────── */

/**
 * analyzeMrpackの戻り値(plan)をもとに鯖フォルダを組み立てる。
 * eulaはここでは書かない(UI側の明示同意チェックを通ってからmain.jsが書く。create:runと同じ流儀)。
 */
async function installMrpack(plan, opts) {
  const { dir, port, name, xms, xmx, javaExe, onProgress, onLog, signal } = opts || {};
  const progress = (phase, extra) => { if (onProgress) onProgress({ phase, ...extra }); };

  try {
    /* 1) ローダー鯖を組む */
    const creator = creators[plan.loader];
    if (!creator) throw new Error(`不明なローダーです: ${plan.loader}`);
    if ((plan.loader === 'forge' || plan.loader === 'neoforge') && !javaExe) {
      throw new Error('このmodpackにはJDKが必要ですが、見つかりませんでした');
    }
    progress('loader', {});
    const created = await creator.create({
      mc: plan.mcVersion, dir, javaExe,
      loaderVersion: plan.loaderVersion,
      onProgress: (got, total) => progress('loader', { got, total }),
      onLog: line => { if (onLog) onLog(line); },
      signal
    });

    /* 2) mrpack本体のファイルを並列4本でDL(1つ失敗したら全体中止) */
    const total = plan.files.length;
    progress('files', { done: 0, total, file: null });
    await downloadPlanFiles(plan.files, dir, (done, file) => progress('files', { done, total, file }), signal);

    /* 3) overrides → server-overrides の順に鯖フォルダへ上書き適用(client-overridesは無視) */
    progress('overrides', {});
    copyRecursive(path.join(plan.workDir, 'overrides'), dir);
    copyRecursive(path.join(plan.workDir, 'server-overrides'), dir);

    /* 4) properties: 無ければ新規作成、あれば(packが同梱していた場合)server-portだけバイト保全で差し替え */
    const propsPath = path.join(dir, 'server.properties');
    if (!fs.existsSync(propsPath)) {
      properties.writeInitial(dir, { port, motd: name });
    } else {
      properties.update(dir, { 'server-port': port });
    }

    return { jar: created.jar, loaderVersion: created.loaderVersion };
  } finally {
    fs.rmSync(plan.workDir, { recursive: true, force: true });
  }
}

/**
 * analyzeZip(サーバーパックzip)の戻り値をもとに鯖フォルダを組み立てる。
 * loaderOverride(確認画面でユーザーが手直しした値)は、起動手段が無い時だけローダーを組むのに使う。
 * eulaはここでは書かない(installMrpackと同じ流儀。UI同意後にmain.jsが書く)。
 */
async function installZip(analysis, opts) {
  const { dir, name, port, loaderOverride, javaExe, onProgress, onLog, signal } = opts || {};
  const progress = (phase, extra) => { if (onProgress) onProgress({ phase, ...extra }); };

  try {
    /* 1) 展開済みルートの中身をそのまま鯖フォルダへ移動。
       onProgressはmrpack installと同じphase体系を使う('overrides'=設定/ファイルの適用) */
    progress('overrides', {});
    moveContents(analysis.workDir, dir);

    let jar = analysis.estimate.jar;
    let loaderVersion = analysis.estimate.loaderVersion;

    /* 2) 起動手段が無く、確認画面でローダーが指定されていれば新たに組み立てる */
    if (!analysis.hasLoaderFiles && loaderOverride && loaderOverride.loader) {
      const creator = creators[loaderOverride.loader];
      if (!creator) throw new Error(`不明なローダーです: ${loaderOverride.loader}`);
      if (!loaderOverride.mcVersion) throw new Error('MCバージョンが不明なため、確認画面で指定してください');
      if ((loaderOverride.loader === 'forge' || loaderOverride.loader === 'neoforge') && !javaExe) {
        throw new Error('このmodpackにはJDKが必要ですが、見つかりませんでした');
      }
      progress('loader', {});
      const created = await creator.create({
        mc: loaderOverride.mcVersion, dir, javaExe,
        loaderVersion: loaderOverride.loaderVersion,
        onProgress: (got, total) => progress('loader', { got, total }),
        onLog: line => { if (onLog) onLog(line); },
        signal
      });
      jar = created.jar;
      loaderVersion = created.loaderVersion;
    }

    /* 3) properties: 同梱されていればserver-portだけバイト保全で差し替え、無ければ新規作成 */
    const propsPath = path.join(dir, 'server.properties');
    if (!fs.existsSync(propsPath)) {
      properties.writeInitial(dir, { port, motd: name });
    } else {
      properties.update(dir, { 'server-port': port });
    }

    return { jar, loaderVersion };
  } finally {
    fs.rmSync(analysis.workDir, { recursive: true, force: true });
  }
}

module.exports = { analyzeMrpack, analyzeZip, installMrpack, installZip };
