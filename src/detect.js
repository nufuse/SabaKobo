/**
 * detect.js — サーバーパックzipを解凍したフォルダの素性判別(v0.4 CurseForge取り込み)
 *
 * 設計原則: ルート直下のjarと起動スクリプトだけが真実。mods\・plugins\の有無では判断しない。
 * (Fabricクライアントフォルダの中でPaper鯖が動いている実例があり、フォルダ名やmods\の有無で
 *  推測すると誤爆するため。起動に使われている実体だけを見る)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const neoforge = require('./create/neoforge');

/* ── メモリ表記(6G/4096M等)→ GB数値。変換できなければnull ── */
function memToGB(raw) {
  const m = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([kKmMgG])$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const gb = unit === 'G' ? num : unit === 'M' ? num / 1024 : num / 1024 / 1024;
  const rounded = Math.round(gb);
  return rounded >= 1 ? rounded : null;
}

/* ── フォルダ直下の最初のサブフォルダ名(libraries配下のバージョンフォルダ探索用) ── */
function firstSubdir(base) {
  try {
    const ent = fs.readdirSync(base, { withFileTypes: true }).find(e => e.isDirectory());
    return ent ? ent.name : null;
  } catch { return null; }
}

/* Paper/Purpur/Foliaのversion_history.jsonから正確なMC版を抜く。
   currentVersionの実例: "1.21.11-130-c5a2736 (MC: 1.21.11)" */
function readVersionHistoryMc(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'version_history.json'), 'utf8'));
    const m = String(j.currentVersion || '').match(/\(MC:\s*([^)]+)\)/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/* NeoForgeのバージョン文字列からMC版を導出(create/neoforge.jsの変換をそのまま流用) */
function mcFromNeoforgeVersion(v) {
  const info = neoforge.parse(v);
  return info ? info.mc : null;
}

/* ── jarファイル名だけからローダーを見分ける(paper/purpur/folia・fabric・vanilla) ── */
function classifyJarName(dir, name) {
  let m = name.match(/^(paper|purpur|folia)-(.+)-(\d+)\.jar$/i);
  if (m) {
    const loader = m[1].toLowerCase();
    let mcVersion = m[2];
    const loaderVersion = m[3];
    const vh = readVersionHistoryMc(dir); /* あれば優先(jar名より確実) */
    if (vh) mcVersion = vh;
    return { loader, mcVersion, loaderVersion };
  }
  if (/^fabric-server-launch\.jar$/i.test(name)) {
    return { loader: 'fabric', mcVersion: null, loaderVersion: null };
  }
  if ((m = name.match(/^minecraft_server[._]([\d.]+)\.jar$/i))) {
    return { loader: 'vanilla', mcVersion: m[1], loaderVersion: null };
  }
  if (/^server\.jar$/i.test(name)) {
    return { loader: 'vanilla', mcVersion: null, loaderVersion: null };
  }
  return null;
}

/* ── 起動スクリプトが指す "@...win_args.txt" 引数からForge/NeoForgeを見分ける ── */
function classifyWinArgsPath(raw) {
  const norm = String(raw).replace(/\\/g, '/');
  let m = norm.match(/net\/minecraftforge\/forge\/([^/]+)\/win_args\.txt$/i);
  if (m) {
    const folder = m[1];
    const idx = folder.indexOf('-');
    return idx > 0
      ? { loader: 'forge', mcVersion: folder.slice(0, idx), loaderVersion: folder.slice(idx + 1) }
      : { loader: 'forge', mcVersion: null, loaderVersion: folder };
  }
  m = norm.match(/net\/neoforged\/neoforge\/([^/]+)\/win_args\.txt$/i);
  if (m) {
    const full = m[1];
    return { loader: 'neoforge', mcVersion: mcFromNeoforgeVersion(full), loaderVersion: full };
  }
  return null;
}

/* ── 起動スクリプト(run.bat/start.bat/起動.bat)を読む。最初に見つかった1つだけを見る ── */
const SCRIPT_NAMES = ['run.bat', 'start.bat', '起動.bat'];

function readStartupScript(dir) {
  for (const name of SCRIPT_NAMES) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      return fs.readFileSync(p, 'utf8');
    } catch { continue; }
  }
  return null;
}

/* ── 本体 ─────────────────────────── */
/**
 * サーバーパックのフォルダを見て {loader, mcVersion, loaderVersion, jar, xms, xmx} を見積もる。
 * 不明な項目はnull。確定はできても自信がない、というのが普通なので呼び出し側で必ず確認させること。
 */
function detect(dir) {
  const result = { loader: null, mcVersion: null, loaderVersion: null, jar: null, xms: null, xmx: null };

  /* 1) 起動スクリプト優先 */
  const script = readStartupScript(dir);
  if (script) {
    const xmsM = script.match(/-Xms(\S+)/i);
    const xmxM = script.match(/-Xmx(\S+)/i);
    if (xmsM) result.xms = memToGB(xmsM[1]);
    if (xmxM) result.xmx = memToGB(xmxM[1]);

    const jarM = script.match(/-jar\s+(\S+\.jar)/i);
    const argM = script.match(/@(\S*win_args\.txt)/i);

    if (jarM) {
      const jarName = path.basename(jarM[1]);
      result.jar = jarName;
      const info = classifyJarName(dir, jarName);
      if (info) { result.loader = info.loader; result.mcVersion = info.mcVersion; result.loaderVersion = info.loaderVersion; }
    } else if (argM) {
      const info = classifyWinArgsPath(argM[1]);
      if (info) { result.loader = info.loader; result.mcVersion = info.mcVersion; result.loaderVersion = info.loaderVersion; }
    }
  }
  if (result.loader) return result; /* スクリプトで確定した */

  /* 2) スクリプトで確定しなければ、ルートのjarをこの順で照合(mods\・plugins\は見ない) */
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return result; }
  const jars = entries.filter(e => e.isFile() && /\.jar$/i.test(e.name)).map(e => e.name);

  /* (a) paper/purpur/folia */
  const paperLike = jars.find(f => /^(paper|purpur|folia)-.+-\d+\.jar$/i.test(f));
  if (paperLike) {
    const info = classifyJarName(dir, paperLike);
    result.loader = info.loader; result.mcVersion = info.mcVersion; result.loaderVersion = info.loaderVersion;
    result.jar = paperLike;
    return result;
  }

  /* (b) fabric */
  const fabricJar = jars.find(f => /^fabric-server-launch\.jar$/i.test(f));
  if (fabricJar || fs.existsSync(path.join(dir, 'fabric-server-launcher.properties'))) {
    result.loader = 'fabric';
    result.jar = fabricJar || null;
    /* librariesはローダー確定後のバージョン補完だけに使う */
    const loaderVer = firstSubdir(path.join(dir, 'libraries', 'net', 'fabricmc', 'fabric-loader'));
    if (loaderVer) result.loaderVersion = loaderVer;
    const mcVer = firstSubdir(path.join(dir, 'libraries', 'net', 'fabricmc', 'intermediary'));
    if (mcVer) result.mcVersion = mcVer;
    return result;
  }

  /* (c) forge(user_jvm_args.txt + libraries\net\minecraftforge\forge\<mc>-<forge>\) */
  const forgeLibBase = path.join(dir, 'libraries', 'net', 'minecraftforge', 'forge');
  if (fs.existsSync(path.join(dir, 'user_jvm_args.txt')) && fs.existsSync(forgeLibBase)) {
    const folder = firstSubdir(forgeLibBase);
    if (folder) {
      result.loader = 'forge';
      const idx = folder.indexOf('-');
      if (idx > 0) { result.mcVersion = folder.slice(0, idx); result.loaderVersion = folder.slice(idx + 1); }
      else { result.loaderVersion = folder; }
      return result;
    }
  }

  /* (d) neoforge(libraries\net\neoforged\neoforge\<v>\) */
  const neoLibBase = path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge');
  if (fs.existsSync(neoLibBase)) {
    const folder = firstSubdir(neoLibBase);
    if (folder) {
      result.loader = 'neoforge';
      result.loaderVersion = folder;
      result.mcVersion = mcFromNeoforgeVersion(folder);
      return result;
    }
  }

  /* (e) vanilla(server.jar/minecraft_server*.jarのみ) */
  const vanillaJar = jars.find(f => /^server\.jar$/i.test(f)) || jars.find(f => /^minecraft_server/i.test(f));
  if (vanillaJar) {
    const info = classifyJarName(dir, vanillaJar);
    result.loader = 'vanilla';
    result.jar = vanillaJar;
    result.mcVersion = info ? info.mcVersion : null;
    return result;
  }

  /* どれでもない → unknown(loader:null)のまま返す */
  return result;
}

module.exports = { detect, memToGB };
