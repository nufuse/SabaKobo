/**
 * dev-test.js — CDP(Chrome DevTools Protocol)経由の自動テスト
 * 使い方: npx electron . --remote-debugging-port=9223 で起動しておいてから
 *         node scripts/dev-test.js
 * ネット不要のテストだけ(バージョン一覧の取得など実ネットに触る部分は手動検証で)。
 */
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const zip = require('../src/zip');
const PORT = 9223;
let ws, msgId = 0;
const pending = new Map();
const exceptions = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('evaluate error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

let passCount = 0, failCount = 0;
function check(label, actual, expected) {
  const ok = (typeof expected === 'function') ? expected(actual) : actual === expected;
  if (ok) { passCount++; console.log(`PASS  ${label}`); }
  else { failCount++; console.log(`FAIL  ${label}\n      actual: ${JSON.stringify(actual)}`); }
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) { console.error('アプリのページが見つからない(起動してる?)'); process.exit(1); }

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(res => { ws.onopen = res; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails?.exception?.description || 'unknown');
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 1500));

  /* ---- 1. 起動確認 ---- */
  check('タイトル', await evaluate('document.title'), '鯖工房');
  check('Saba.state 露出', await evaluate('typeof window.Saba === "object" && Array.isArray(Saba.state.data.servers)'), true);

  /* ---- 2. Javaルール表(v0.1の核心。Forge 1.20.1→17限定 / Paper 1.21.11→21) ---- */
  const jForge = await evaluate(`saba.javaFor('1.20.1','forge')`);
  check('javaFor(1.20.1, forge) → JDK17', jForge, v => v.ok && v.major === 17 && /jdk-17/.test(v.path));
  const jPaper = await evaluate(`saba.javaFor('1.21.11','paper')`);
  check('javaFor(1.21.11, paper) → JDK21', jPaper, v => v.ok && v.major === 21 && /jdk-21/.test(v.path));
  const jCal = await evaluate(`saba.javaFor('26.2','vanilla')`);
  check('javaFor(26.2) → Java 25要求でエラー(Mojang公式データ。未インストール)', jCal, v => v.ok === false && /25/.test(v.error));
  const j206 = await evaluate(`saba.javaFor('1.20.6','paper')`);
  check('javaFor(1.20.6, paper) → 21(公式データ=21)', j206, v => v.ok && v.major === 21);
  const jFabric18 = await evaluate(`saba.javaFor('1.18.2','fabric')`);
  check('javaFor(1.18.2, fabric) → 17以上(21が選ばれる)', jFabric18, v => v.ok && v.major === 21);
  const jForge18 = await evaluate(`saba.javaFor('1.18.2','forge')`);
  check('javaFor(1.18.2, forge) → 17限定', jForge18, v => v.ok && v.major === 17);
  const jOld = await evaluate(`saba.javaFor('1.16.5','paper')`);
  check('javaFor(1.16.5) → JDK8無しでエラー', jOld, v => v.ok === false && /Java 8/.test(v.error));

  /* ---- 3. Paper Fillのバージョン平坦化(キー付きオブジェクト+rc除外) ---- */
  const flat = await evaluate(`saba.devFlattenPaper({"26.2":["26.2","26.2-rc-2"],"1.21":["1.21.11","1.21.11-rc3","1.21.10"]})`);
  check('Paperバージョン平坦化(rc除外・順序保持)', JSON.stringify(flat), JSON.stringify(['26.2', '1.21.11', '1.21.10']));

  /* ---- 4. ポートプローブ(このテスト自身が25599を塞いで、使用中と判定されるか) ---- */
  const blocker = net.createServer();
  await new Promise(res => blocker.listen({ port: 25599, host: '0.0.0.0' }, res));
  check('probePort(使用中の25599) → false', await evaluate(`saba.probePort(25599)`), false);
  await new Promise(res => blocker.close(res));
  check('probePort(空きの25599) → true', await evaluate(`saba.probePort(25599)`), true);

  /* ---- 5. ウィザードが開く ---- */
  check('ウィザード起動', await evaluate(`(() => {
    document.querySelector('#btn-new').click();
    const open = !document.querySelector('#wizard-overlay').hidden;
    return open && document.querySelectorAll('input[name=wz-loader]').length === 5;
  })()`), true);
  /* ポート既定値が入るのを待つ(suggestPortは非同期) */
  await new Promise(r => setTimeout(r, 800));
  const portVal = await evaluate(`Number(document.querySelector('#wz-port').value)`);
  check('既定ポートが提案されている', portVal, v => Number.isInteger(v) && v >= 25565);
  check('メモリスライダー: XmxをXmsより下げるとXmsが追従', await evaluate(`(() => {
    const xms = document.querySelector('#wz-xms'), xmx = document.querySelector('#wz-xmx');
    xms.value = 6; xms.dispatchEvent(new Event('input'));
    xmx.value = 3; xmx.dispatchEvent(new Event('input'));
    const r = { xms: xms.value, xmx: xmx.value, label: document.querySelector('#wz-xms-val').textContent };
    xms.value = 2; xms.dispatchEvent(new Event('input'));
    xmx.value = 4; xmx.dispatchEvent(new Event('input'));
    return r;
  })()`), v => v.xms === '3' && v.xmx === '3' && v.label === '3 GB');
  check('EULA未チェックでは作成できない', await evaluate(`(async () => {
    document.querySelector('#wz-name').value = 'テスト';
    document.querySelector('#wz-name').dispatchEvent(new Event('input'));
    document.querySelector('#wz-create').click();
    await new Promise(r => setTimeout(r, 100));
    return document.querySelector('#wz-error').textContent;
  })()`), v => /EULA/.test(v));
  check('ウィザードが閉じる(display:flex+hiddenの罠対策)', await evaluate(`(() => {
    document.querySelector('#wz-close').click();
    return getComputedStyle(document.querySelector('#wizard-overlay')).display;
  })()`), 'none');

  /* ---- 7. properties往復(バイト保全 — 日本語ワールド名を壊さないことの証明) ---- */
  const fixture = '#Minecraft server properties\r\n#comment line\r\nserver-port=25565\r\nlevel-name=マイクラバトロワお借り用\r\nmotd=古いMOTD\r\npvp=true\r\n';
  const rt = await evaluate(`saba.devPropsRoundtrip(${JSON.stringify(fixture)}, {motd:'新しいMOTD'})`);
  const beforeText = Buffer.from(rt.before, 'base64').toString('utf8');
  const afterText = Buffer.from(rt.after, 'base64').toString('utf8');
  check('properties: motd行だけ変わり他は1バイトも変わらない(CRLF・日本語・コメント保全)',
    afterText, beforeText.replace('motd=古いMOTD', 'motd=新しいMOTD'));

  /* ---- 8. プレイヤー出入りの行解析 ---- */
  check('player: Paperのjoin行', await evaluate(`saba.devPlayerLine('[12:00:00] [Server thread/INFO]: Steve joined the game')`),
    v => v && v.name === 'Steve' && v.event === 'join');
  check('player: Forgeのjoin行', await evaluate(`saba.devPlayerLine('[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: yuyu_02 joined the game')`),
    v => v && v.name === 'yuyu_02' && v.event === 'join');
  check('player: left行', await evaluate(`saba.devPlayerLine('[12:00:00] [Server thread/INFO]: Steve left the game')`),
    v => v && v.event === 'left');
  check('player: チャットの偽joinは無視', await evaluate(`saba.devPlayerLine('[12:00:00] [Server thread/INFO]: <Steve> fake joined the game')`),
    v => v === null);

  /* ---- 9. ダミー鯖で設定モーダルと削除フロー ---- */
  const dummyDir = 'C:\\Users\\PC_User\\AppData\\Local\\Temp\\saba-devtest-dummy';
  let dummy = null;
  try {
    dummy = await evaluate(`saba.devRegister({ name: '削除テスト', dir: ${JSON.stringify(dummyDir)}, port: 25599, writeProps: { port: 25599, motd: 'てすとMOTD' } })`);
    check('ダミー鯖の登録', dummy, v => v && v.id && v.name === '削除テスト');
    await evaluate(`View.select('${dummy.id}')`);
    await new Promise(r => setTimeout(r, 400));
    check('プレイヤーパネルが出ている(停止中表示)', await evaluate(`document.querySelector('#pp-empty').textContent`), '(停止中)');

    /* 設定モーダル: 開く→motdが読める→書き換えて保存→ファイルに反映 */
    await evaluate(`document.querySelector('#btn-props').click()`);
    await new Promise(r => setTimeout(r, 400));
    check('設定モーダルが開きmotdが読めている', await evaluate(`(() => {
      const el = [...document.querySelectorAll('#props-form [data-key]')].find(x => x.dataset.key === 'motd');
      return { open: !document.querySelector('#props-overlay').hidden, motd: el && el.value };
    })()`), v => v.open === true && v.motd === 'てすとMOTD');
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('#props-form [data-key]')].find(x => x.dataset.key === 'motd');
      el.value = '書き換え後';
      document.querySelector('#props-save').click();
    })()`);
    await new Promise(r => setTimeout(r, 400));
    const reread = await evaluate(`saba.propsRead('${dummy.id}')`);
    check('保存でファイルに反映(server-portは無傷)', reread, v => v.ok && v.values.motd === '書き換え後' && v.values['server-port'] === '25599');

    /* 削除フロー: 🗑 → ゴミ箱へ → 一覧から消える */
    await evaluate(`document.querySelector('#btn-remove').click()`);
    check('削除モーダルが開く', await evaluate(`!document.querySelector('#remove-overlay').hidden`), true);
    await evaluate(`document.querySelector('#rm-trash').click()`);
    await new Promise(r => setTimeout(r, 800));
    check('一覧から消えた', await evaluate(`Saba.state.data.servers.some(s => s.name === '削除テスト')`), false);
    check('プレースホルダに戻った', await evaluate(`document.querySelector('#placeholder').hidden`), false);
  } finally {
    /* 後始末: 途中で失敗しても登録が残っていればunregisterし、フォルダも消す(幽霊鯖を残さない) */
    if (dummy) {
      try {
        const stillThere = await evaluate(`Saba.state.data.servers.some(s => s.id === '${dummy.id}')`);
        if (stillThere) await evaluate(`saba.remove('${dummy.id}', 'unregister')`);
      } catch (e) { console.error('後始末失敗(ダミー鯖のunregister):', e.message); }
    }
    fs.rmSync(dummyDir, { recursive: true, force: true });
  }

  /* ---- 10. プラグイン/Mod管理(v0.3) ---- */
  /* 偽鯖のplugins構成をNode側(このプロセス自身)で作る。データフォルダ(Citizens)や
     読めないファイル(readme.txt)が絶対に一覧へ混ざらないことを見るのが狙い */
  const modsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-mods-'));
  const vanillaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-vanilla-'));
  let modsServer = null, vanillaServer = null; /* try内で代入。途中で例外が出てもfinallyで後始末できるようにスコープ外に出す */
  try {
    const pluginsDir = path.join(modsDir, 'plugins');
    const disabledDir = path.join(pluginsDir, 'disabled');
    const citizensDir = path.join(pluginsDir, 'Citizens');
    fs.mkdirSync(disabledDir, { recursive: true });
    fs.mkdirSync(citizensDir, { recursive: true });
    fs.writeFileSync(path.join(pluginsDir, 'A.jar'), 'dummy-A');
    fs.writeFileSync(path.join(pluginsDir, 'B.jar'), 'dummy-B');
    fs.writeFileSync(path.join(disabledDir, 'C.jar.disabled'), 'dummy-C');
    fs.writeFileSync(path.join(citizensDir, 'dummy.yml'), 'x: 1');
    fs.writeFileSync(path.join(pluginsDir, 'readme.txt'), 'readme');

    modsServer = await evaluate(`saba.devRegister({ name: 'Modsテスト', dir: ${JSON.stringify(modsDir)}, loader: 'paper', port: 25598 })`);
    check('Mod用ダミー鯖(paper)の登録', modsServer, v => v && v.id && v.loader === 'paper');

    const listed = await evaluate(`saba.modsList('${modsServer.id}')`);
    check('mods:list はA.jar/B.jar(有効)・C.jar(無効)の3件だけ(Citizens・readme.txtは出ない)', listed, v =>
      v.ok && v.folder === 'plugins' && v.mods.length === 3 &&
      v.mods.some(m => m.name === 'A.jar' && m.enabled === true) &&
      v.mods.some(m => m.name === 'B.jar' && m.enabled === true) &&
      v.mods.some(m => m.name === 'C.jar' && m.enabled === false));

    const toggleOff = await evaluate(`saba.modsToggle('${modsServer.id}', 'A.jar', false)`);
    check('A.jarを無効化', toggleOff, v => v.ok === true);
    check('A.jarが実ファイルとしてdisabledへ移動している',
      fs.existsSync(path.join(disabledDir, 'A.jar.disabled')) && !fs.existsSync(path.join(pluginsDir, 'A.jar')), true);

    const toggleOn = await evaluate(`saba.modsToggle('${modsServer.id}', 'A.jar', true)`);
    check('A.jarを再度有効化', toggleOn, v => v.ok === true);
    check('A.jarが完全に元へ戻っている',
      fs.existsSync(path.join(pluginsDir, 'A.jar')) && !fs.existsSync(path.join(disabledDir, 'A.jar.disabled')), true);

    const badName = '..\\evil.jar';
    const badToggle = await evaluate(`saba.modsToggle('${modsServer.id}', ${JSON.stringify(badName)}, false)`);
    check('不正名(..\\evil.jar)のtoggleはエラー', badToggle, v => v.ok === false);

    /* modsAddは実ファイルをcopyFileSyncするので、コピー元(同名B.jar)を別途用意する */
    const srcDup = path.join(modsDir, 'B.jar');
    fs.writeFileSync(srcDup, 'dummy-B-src');
    const addRes = await evaluate(`saba.modsAdd('${modsServer.id}', [${JSON.stringify(srcDup)}])`);
    check('modsAddで同名B.jarはskippedに入る', addRes, v => v.ok && v.added.length === 0 && v.skipped.some(s => s.name === 'B.jar'));

    /* modsAddの成功パス: 新規jarはaddedに入り、実ファイルもコピーされる */
    const srcNew = path.join(modsDir, 'New.jar');
    fs.writeFileSync(srcNew, 'dummy-New');
    const addNewRes = await evaluate(`saba.modsAdd('${modsServer.id}', [${JSON.stringify(srcNew)}])`);
    check('modsAddで新規New.jarはaddedに入る', addNewRes, v => v.ok && v.added.includes('New.jar'));
    check('New.jarが実ファイルとしてplugins直下にコピーされている', fs.existsSync(path.join(pluginsDir, 'New.jar')), true);

    /* 削除(mods:remove): 完全削除ではなくゴミ箱送りなので、実ファイルが消えたことだけ見ればよい */
    const removeEnabled = await evaluate(`saba.modsRemove('${modsServer.id}', 'B.jar', true)`);
    check('有効なB.jarの削除', removeEnabled, v => v.ok === true);
    check('B.jarがplugins直下から消えている', fs.existsSync(path.join(pluginsDir, 'B.jar')), false);

    const removeDisabled = await evaluate(`saba.modsRemove('${modsServer.id}', 'C.jar', false)`);
    check('無効なC.jarの削除', removeDisabled, v => v.ok === true);
    check('C.jar.disabledがdisabled\\から消えている', fs.existsSync(path.join(disabledDir, 'C.jar.disabled')), false);

    const badRemove = await evaluate(`saba.modsRemove('${modsServer.id}', ${JSON.stringify(badName)}, false)`);
    check('不正名(..\\evil.jar)の削除はエラー', badRemove, v => v.ok === false);

    vanillaServer = await evaluate(`saba.devRegister({ name: 'Vanillaテスト', dir: ${JSON.stringify(vanillaDir)}, loader: 'vanilla', port: 25597 })`);
    const vanillaList = await evaluate(`saba.modsList('${vanillaServer.id}')`);
    check('vanilla鯖ではfolderがnull', vanillaList, v => v.ok && v.folder === null);
  } finally {
    /* 後始末: 途中で例外が出ても一時鯖をレジストリから外し一時フォルダを消す(幽霊鯖を残さない) */
    if (modsServer) {
      try { await evaluate(`saba.remove('${modsServer.id}', 'unregister')`); }
      catch (e) { console.error('後始末失敗(Modsテスト鯖のunregister):', e.message); }
    }
    if (vanillaServer) {
      try { await evaluate(`saba.remove('${vanillaServer.id}', 'unregister')`); }
      catch (e) { console.error('後始末失敗(Vanillaテスト鯖のunregister):', e.message); }
    }
    fs.rmSync(modsDir, { recursive: true, force: true });
    fs.rmSync(vanillaDir, { recursive: true, force: true });
  }

  /* ---- 11. zip.js: tar.exe(bsdtar)によるzip展開/一覧(v0.4 modpack導入の土台) ---- */
  const zipSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-zipsrc-'));
  const zipDestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-zipdest-'));
  const zipFile = path.join(os.tmpdir(), `saba-devtest-${Date.now()}.zip`);
  try {
    fs.writeFileSync(path.join(zipSrcDir, 'a.txt'), 'ファイルA');
    fs.writeFileSync(path.join(zipSrcDir, 'b.txt'), 'ファイルB');
    fs.mkdirSync(path.join(zipSrcDir, 'sub'));
    fs.writeFileSync(path.join(zipSrcDir, 'sub', 'c.txt'), 'ファイルC');
    execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', zipFile, 'a.txt', 'b.txt', 'sub'], { cwd: zipSrcDir, windowsHide: true });

    const entries = await zip.list(zipFile);
    check('zip.list: エントリ名を返す(a.txt/b.txt/sub含む)', entries, v =>
      v.includes('a.txt') && v.includes('b.txt') && v.some(e => e.startsWith('sub/') || e.startsWith('sub\\')));

    await zip.extract(zipFile, zipDestDir);
    check('zip.extract: a.txtの中身が一致', fs.readFileSync(path.join(zipDestDir, 'a.txt'), 'utf8'), 'ファイルA');
    check('zip.extract: b.txtの中身が一致', fs.readFileSync(path.join(zipDestDir, 'b.txt'), 'utf8'), 'ファイルB');
    check('zip.extract: サブフォルダ内c.txtの中身が一致', fs.readFileSync(path.join(zipDestDir, 'sub', 'c.txt'), 'utf8'), 'ファイルC');
  } finally {
    fs.rmSync(zipSrcDir, { recursive: true, force: true });
    fs.rmSync(zipDestDir, { recursive: true, force: true });
    try { fs.unlinkSync(zipFile); } catch { }
  }

  /* ---- 12. NeoForge: バージョンAPI(実ネット。0.25w14craftmineの除外・1.21.1の存在) ---- */
  const nfVersions = await evaluate(`saba.createVersions('neoforge')`);
  check('neoforge listVersions: 取得成功', nfVersions, v => v.ok === true && Array.isArray(v.versions) && v.versions.length > 0);
  if (nfVersions.ok) {
    check('neoforge listVersions: craftmine(エイプリルフール版)を含まない', nfVersions.versions, v => !v.some(x => /craftmine/i.test(x)));
    check("neoforge listVersions: '1.21.1'を含む", nfVersions.versions, v => v.includes('1.21.1'));
  }

  /* ---- 13. Java要求: NeoForgeもForge同様 1.20.4はJDK17限定 ---- */
  const jNeo = await evaluate(`saba.javaFor('1.20.4','neoforge')`);
  check("javaFor('1.20.4','neoforge') → JDK17限定", jNeo, v => v.ok && v.major === 17);

  /* ---- 14. downloadFileのsha512検証(実ネット。テスト12で叩いたNeoForge APIを流用) ---- */
  const shaUrl = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
  const shaBuf = Buffer.from(await (await fetch(shaUrl)).arrayBuffer());
  const goodSha512 = crypto.createHash('sha512').update(shaBuf).digest('hex');
  const badSha512 = goodSha512.slice(0, -1) + (goodSha512.slice(-1) === '0' ? '1' : '0');
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-dl-'));
  try {
    const dlDest = path.join(dlDir, 'fixture.json');
    const dlOk = await evaluate(`saba.devDownload({ url: ${JSON.stringify(shaUrl)}, dest: ${JSON.stringify(dlDest)}, sha512: ${JSON.stringify(goodSha512)} })`);
    check('downloadFile: 正しいsha512で成功', dlOk, v => v.ok === true);
    check('downloadFile: 実ファイルが書かれている', fs.existsSync(dlDest), true);

    const dlBad = await evaluate(`saba.devDownload({ url: ${JSON.stringify(shaUrl)}, dest: ${JSON.stringify(dlDest)}, sha512: ${JSON.stringify(badSha512)} })`);
    check('downloadFile: 壊れたsha512で失敗する', dlBad, v => v.ok === false && /チェックサム不一致/.test(v.error));
  } finally {
    fs.rmSync(dlDir, { recursive: true, force: true });
  }

  /* ---- 15. modpack導入エンジン(v0.4): analyze/quilt検出/パス脱出防止/通しinstall/Modrinth検索 ---- */
  const packFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-pack-'));
  let packServer = null;
  const packInstallDir = path.join(os.tmpdir(), `saba-devtest-packinstall-${crypto.randomUUID()}`);
  try {
    /* mrpack一式をtar.exeで固めるヘルパ(既存のzipテストと同じ流儀) */
    function buildMrpack(destPath, indexObj, withOverrides) {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-mrsrc-'));
      try {
        fs.writeFileSync(path.join(src, 'modrinth.index.json'), JSON.stringify(indexObj));
        if (withOverrides) {
          fs.mkdirSync(path.join(src, 'overrides', 'config'), { recursive: true });
          fs.mkdirSync(path.join(src, 'server-overrides', 'config'), { recursive: true });
          fs.mkdirSync(path.join(src, 'client-overrides'), { recursive: true });
          fs.writeFileSync(path.join(src, 'overrides', 'config', 'test.cfg'), 'A');
          fs.writeFileSync(path.join(src, 'server-overrides', 'config', 'test.cfg'), 'B');
          fs.writeFileSync(path.join(src, 'client-overrides', 'readme.txt'), 'client only');
        }
        const entries = fs.readdirSync(src);
        execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', destPath, ...entries], { cwd: src, windowsHide: true });
      } finally {
        fs.rmSync(src, { recursive: true, force: true });
      }
    }

    /* Fabricの実在バージョン(mc・loader)を本物のmeta APIから取る(でっち上げない) */
    const fabricGames = await (await fetch('https://meta.fabricmc.net/v2/versions/game')).json();
    const fabricMc = (fabricGames.find(g => g.stable) || fabricGames[0]).version;
    const fabricLoaders = await (await fetch('https://meta.fabricmc.net/v2/versions/loader')).json();
    const fabricLoaderVersion = (fabricLoaders.find(l => l.stable) || fabricLoaders[0]).version;

    /* 1) analyze: ローダー判定・mcVersion・env.server=unsupportedの除外/env無しの包含 */
    const analyzeIndex = {
      formatVersion: 1, game: 'minecraft', versionId: '1.0.0',
      name: 'SabaKobo Test Pack', summary: 'テスト用modpack',
      files: [
        { path: 'mods/server-required.jar', hashes: { sha1: '0'.repeat(40), sha512: '0'.repeat(128) }, env: { client: 'unsupported', server: 'required' }, downloads: ['https://example.invalid/a.jar'], fileSize: 111 },
        { path: 'mods/client-only.jar', hashes: { sha1: '1'.repeat(40), sha512: '1'.repeat(128) }, env: { client: 'required', server: 'unsupported' }, downloads: ['https://example.invalid/b.jar'], fileSize: 222 },
        { path: 'mods/no-env.jar', hashes: { sha1: '2'.repeat(40), sha512: '2'.repeat(128) }, downloads: ['https://example.invalid/c.jar'], fileSize: 333 }
      ],
      dependencies: { minecraft: fabricMc, 'fabric-loader': fabricLoaderVersion }
    };
    const analyzeMrpackPath = path.join(packFixtureRoot, 'fixture.mrpack');
    buildMrpack(analyzeMrpackPath, analyzeIndex, true);

    const analyzed = await evaluate(`saba.packAnalyze(${JSON.stringify(analyzeMrpackPath)})`);
    check('pack:analyze: fabricローダーと判定', analyzed, v => v.ok && v.loader === 'fabric');
    check('pack:analyze: mcVersionが期待通り', analyzed, v => v.ok && v.mcVersion === fabricMc);
    check('pack:analyze: env.server=unsupportedは除外・env無しは含む(2件)', analyzed, v => v.ok && v.fileCount === 2 &&
      v.files.some(f => f.path === 'mods/server-required.jar') &&
      v.files.some(f => f.path === 'mods/no-env.jar') &&
      !v.files.some(f => f.path === 'mods/client-only.jar'));
    check('pack:analyze: workDirをレンダラーに渡さない', analyzed, v => v.workDir === undefined);

    /* 2) quilt-loaderは明示エラー(黙って壊れない) */
    const quiltIndex = { ...analyzeIndex, dependencies: { minecraft: fabricMc, 'quilt-loader': '0.1.0' } };
    const quiltMrpackPath = path.join(packFixtureRoot, 'fixture-quilt.mrpack');
    buildMrpack(quiltMrpackPath, quiltIndex, false);
    const quiltResult = await evaluate(`saba.packAnalyze(${JSON.stringify(quiltMrpackPath)})`);
    check('pack:analyze: quilt-loaderはエラー', quiltResult, v => v.ok === false && /Quilt/.test(v.error));

    /* 3) パス脱出(..\evil.jar)は明示エラー */
    const badPathIndex = {
      ...analyzeIndex,
      files: [{ path: '..\\evil.jar', hashes: { sha1: '9'.repeat(40), sha512: '9'.repeat(128) }, downloads: ['https://example.invalid/evil.jar'], fileSize: 1 }]
    };
    const badPathMrpackPath = path.join(packFixtureRoot, 'fixture-badpath.mrpack');
    buildMrpack(badPathMrpackPath, badPathIndex, false);
    const badPathResult = await evaluate(`saba.packAnalyze(${JSON.stringify(badPathMrpackPath)})`);
    check('pack:analyze: パス脱出(..\\evil.jar)はエラー', badPathResult, v => v.ok === false);

    /* 4) 通しinstall(files:[]の軽量mrpack。overrides/server-overrides/client-overridesの適用まで確認。実DL・ネット必要) */
    const installIndex = { ...analyzeIndex, files: [] };
    const installMrpackPath = path.join(packFixtureRoot, 'fixture-install.mrpack');
    buildMrpack(installMrpackPath, installIndex, true);

    const installAnalyzed = await evaluate(`saba.packAnalyze(${JSON.stringify(installMrpackPath)})`);
    check('pack:analyze(install用軽量mrpack): 成功しfiles0件', installAnalyzed, v => v.ok === true && v.fileCount === 0);

    const installPort = 25596;
    const installResult = await evaluate(`saba.packInstall({
      analysisId: ${JSON.stringify(installAnalyzed.analysisId)},
      name: 'modpackテスト',
      dir: ${JSON.stringify(packInstallDir)},
      port: ${installPort},
      xms: '1G', xmx: '2G',
      eula: true
    })`);
    check('pack:install: 成功しfabric-server-launch.jarができる', installResult, v =>
      v.ok === true && fs.existsSync(path.join(packInstallDir, 'fabric-server-launch.jar')));
    if (installResult.ok) packServer = installResult.server;

    check('pack:install: server-overridesが勝つ(config\\test.cfgがB)',
      fs.readFileSync(path.join(packInstallDir, 'config', 'test.cfg'), 'utf8'), 'B');
    check('pack:install: client-overrides由来のファイルは無い', fs.existsSync(path.join(packInstallDir, 'readme.txt')), false);

    const installProps = packServer && await evaluate(`saba.propsRead('${packServer.id}')`);
    check('pack:install: server.propertiesが生成されportが一致', installProps, v => v && v.ok && Number(v.values['server-port']) === installPort);
    check('pack:install: origin=modpackで登録されている', packServer, v => v && v.origin === 'modpack' && v.pack && v.pack.source === 'file');

    /* 5) Modrinth検索(実API) */
    const searchResult = await evaluate(`saba.packSearch('fabulously')`);
    check('pack:search: hitsが1件以上でslugが取れる', searchResult, v => v.ok && v.hits.length > 0 && !!v.hits[0].slug);
  } finally {
    /* 後始末: 途中で例外が出ても登録した鯖を外し、一時フォルダを消す */
    if (packServer) {
      try { await evaluate(`saba.remove('${packServer.id}', 'unregister')`); }
      catch (e) { console.error('後始末失敗(modpackテスト鯖のunregister):', e.message); }
    }
    fs.rmSync(packInstallDir, { recursive: true, force: true });
    fs.rmSync(packFixtureRoot, { recursive: true, force: true });
  }

  /* ---- 16. modpack導入UI(v0.4): モーダル開閉・検索・ファイル経由の通し ---- */
  check('📦ボタンでmodpackモーダルが開く', await evaluate(`(() => {
    document.querySelector('#btn-pack').click();
    return !document.querySelector('#pack-overlay').hidden;
  })()`), true);

  /* 検索: UI経由(検索ボックス入力→検索ボタン)でpackSearchを実走させ、結果行がDOMに出るのを見る(実API) */
  check('modpack検索: UI経由で結果行が出る', await evaluate(`(async () => {
    document.querySelector('#pk-search-box').value = 'fabulously';
    document.querySelector('#pk-search-btn').click();
    await new Promise(r => setTimeout(r, 2500));
    return document.querySelectorAll('#pk-results .pk-row').length;
  })()`), v => v >= 1);

  check('modpackモーダルが閉じる(display:flex+hiddenの罠対策)', await evaluate(`(() => {
    document.querySelector('#pk-close').click();
    return getComputedStyle(document.querySelector('#pack-overlay')).display;
  })()`), 'none');

  /* ファイル経由の通し: files:[]の軽量fabric mrpackを作り、packAnalyzeを直接呼んでPack.showConfigへ入る
     (ファイルダイアログはUIから叩けないため) */
  /* 設定画面にフォルダ選択は無いので、実際の作成先はnewServerRoot配下になる(dirは指定できない) */
  const packUiFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-packui-'));
  let packUiServer = null;
  try {
    function buildMrpackUi(destPath, indexObj) {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-packui-src-'));
      try {
        fs.writeFileSync(path.join(src, 'modrinth.index.json'), JSON.stringify(indexObj));
        const entries = fs.readdirSync(src);
        execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', destPath, ...entries], { cwd: src, windowsHide: true });
      } finally {
        fs.rmSync(src, { recursive: true, force: true });
      }
    }

    /* Fabricの実在バージョン(mc・loader)を本物のmeta APIから取る(でっち上げない) */
    const fabricGamesUi = await (await fetch('https://meta.fabricmc.net/v2/versions/game')).json();
    const fabricMcUi = (fabricGamesUi.find(g => g.stable) || fabricGamesUi[0]).version;
    const fabricLoadersUi = await (await fetch('https://meta.fabricmc.net/v2/versions/loader')).json();
    const fabricLoaderVersionUi = (fabricLoadersUi.find(l => l.stable) || fabricLoadersUi[0]).version;

    const packUiIndex = {
      formatVersion: 1, game: 'minecraft', versionId: '1.0.0',
      name: 'SabaKobo UIテストPack', summary: '',
      files: [],
      dependencies: { minecraft: fabricMcUi, 'fabric-loader': fabricLoaderVersionUi }
    };
    const packUiMrpackPath = path.join(packUiFixtureRoot, 'fixture-ui.mrpack');
    buildMrpackUi(packUiMrpackPath, packUiIndex);

    check('modpack(UI): packAnalyze→Pack.showConfigで設定画面まで進む', await evaluate(`(async () => {
      const analysis = await saba.packAnalyze(${JSON.stringify(packUiMrpackPath)});
      if (!analysis.ok) return { ok: false, error: analysis.error };
      await Pack.showConfig(analysis);
      document.querySelector('#pk-name').value = 'UIテストmodpack';
      document.querySelector('#pk-port').value = 25593;
      return { ok: true, configOpen: !document.querySelector('#pk-config').hidden };
    })()`), v => v.ok === true && v.configOpen === true);

    check('modpack(UI): EULA未チェックでは導入ボタンがdisabled', await evaluate(`document.querySelector('#pk-install').disabled`), true);

    check('modpack(UI): EULAチェックで導入ボタンが有効化', await evaluate(`(() => {
      const cb = document.querySelector('#pk-eula');
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      return document.querySelector('#pk-install').disabled;
    })()`), false);

    const packUiRunResult = await evaluate(`(async () => {
      document.querySelector('#pk-install').click();
      for (let i = 0; i < 200; i++) {
        await new Promise(r => setTimeout(r, 300));
        if (document.querySelector('#pack-overlay').hidden) break;
        if (!document.querySelector('#pk-error').hidden) break;
      }
      return {
        overlayHidden: document.querySelector('#pack-overlay').hidden,
        errorText: document.querySelector('#pk-error').hidden ? null : document.querySelector('#pk-error').textContent,
        server: Saba.state.data.servers.find(s => s.name === 'UIテストmodpack')
      };
    })()`);
    check('modpack(UI): 導入→モーダルが閉じ鯖一覧にorigin:modpackで出る', packUiRunResult, v =>
      v.overlayHidden === true && v.server && v.server.origin === 'modpack');
    if (packUiRunResult.server) packUiServer = packUiRunResult.server;
  } finally {
    /* 後始末: 途中で例外が出ても登録した鯖を外し、実フォルダ(newServerRoot配下)・一時フォルダを消す */
    if (packUiServer) {
      try { await evaluate(`saba.remove('${packUiServer.id}', 'unregister')`); }
      catch (e) { console.error('後始末失敗(modpack UIテスト鯖のunregister):', e.message); }
      try { fs.rmSync(packUiServer.dir, { recursive: true, force: true }); }
      catch (e) { console.error('後始末失敗(modpack UIテスト鯖のフォルダ削除):', e.message); }
    }
    fs.rmSync(packUiFixtureRoot, { recursive: true, force: true });
  }

  /* ---- 17. サーバーパックzip取り込み(v0.4 CurseForge対応):
        一皮むき・Paper誤爆防止(mods\・plugins\があっても判定を誤らない)・通しinstall・
        クライアント用パック拒否・mrpack-in-zip・detect単体 ---- */
  const spFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-sp-'));
  let spServer = null;
  const spInstallDir = path.join(os.tmpdir(), `saba-devtest-spinstall-${crypto.randomUUID()}`);
  try {
    /* srcDir直下のエントリをそのままzip化するヘルパ(既存のbuildMrpack系と同じ流儀) */
    function zipEntries(srcDir, destZipPath) {
      const entries = fs.readdirSync(srcDir);
      execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', destZipPath, ...entries], { cwd: srcDir, windowsHide: true });
    }

    /* 1) 一皮むき+Paper判別: TestPack\の中にjar・version_history.json・起動.bat(メモリ指定入り)。
       わざとmods\とplugins\の両方を入れて、その有無で判定を誤らない(=jarと起動スクリプトだけを見る)ことを確かめる */
    const spSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-sp-src-'));
    let spZipPath;
    try {
      const inner = path.join(spSrc, 'TestPack');
      fs.mkdirSync(inner, { recursive: true });
      fs.writeFileSync(path.join(inner, 'paper-1.21.11-100.jar'), 'dummy-paper-jar');
      fs.writeFileSync(path.join(inner, 'version_history.json'),
        JSON.stringify({ currentVersion: '1.21.11-130-c5a2736 (MC: 1.21.11)' }));
      fs.writeFileSync(path.join(inner, '起動.bat'),
        Buffer.from('@echo off\r\njava -Xms6G -Xmx8G -jar paper-1.21.11-100.jar nogui\r\npause\r\n', 'utf8'));
      fs.mkdirSync(path.join(inner, 'mods'));
      fs.writeFileSync(path.join(inner, 'mods', 'FakeMod.jar'), 'dummy-mod');
      fs.mkdirSync(path.join(inner, 'plugins'));
      fs.writeFileSync(path.join(inner, 'plugins', 'FakePlugin.jar'), 'dummy-plugin');

      spZipPath = path.join(spFixtureRoot, 'TestPack.zip');
      zipEntries(spSrc, spZipPath); /* 直下は"TestPack"1個だけ(=一皮むきの条件) */
    } finally {
      fs.rmSync(spSrc, { recursive: true, force: true });
    }

    const spAnalyzed = await evaluate(`saba.packAnalyze(${JSON.stringify(spZipPath)})`);
    check('pack:analyze(zip): kind=serverpack', spAnalyzed, v => v.ok && v.kind === 'serverpack');
    check('pack:analyze(zip): Paperと判定(mods\\・plugins\\が両方あっても誤爆しない)', spAnalyzed,
      v => v.ok && v.estimate.loader === 'paper');
    check('pack:analyze(zip): mcVersionがversion_history.json由来で1.21.11', spAnalyzed,
      v => v.ok && v.estimate.mcVersion === '1.21.11');
    check('pack:analyze(zip): 起動.batのメモリ指定からxms=6/xmx=8', spAnalyzed,
      v => v.ok && v.estimate.xms === 6 && v.estimate.xmx === 8);
    check('pack:analyze(zip): hasLoaderFiles=true(jarが既にある)', spAnalyzed, v => v.ok && v.hasLoaderFiles === true);

    /* 2) installZip通し: 同じzipをもう一度analyzeして実際に取り込む */
    const spAnalyzed2 = await evaluate(`saba.packAnalyze(${JSON.stringify(spZipPath)})`);
    check('pack:analyze(zip・install用): 成功', spAnalyzed2, v => v.ok === true);

    const spPort = 25595;
    const spInstallResult = await evaluate(`saba.packInstall({
      analysisId: ${JSON.stringify(spAnalyzed2.analysisId)},
      name: 'サーバーパックテスト',
      dir: ${JSON.stringify(spInstallDir)},
      port: ${spPort},
      xms: '1G', xmx: '2G',
      eula: true
    })`);
    check('pack:install(zip): 成功しpaper jarがdirへ移動している', spInstallResult, v =>
      v.ok === true && fs.existsSync(path.join(spInstallDir, 'paper-1.21.11-100.jar')));
    if (spInstallResult.ok) spServer = spInstallResult.server;

    check('pack:install(zip): mods\\・plugins\\もそのまま移動している(中身は一切見ない)',
      fs.existsSync(path.join(spInstallDir, 'mods', 'FakeMod.jar')) &&
      fs.existsSync(path.join(spInstallDir, 'plugins', 'FakePlugin.jar')), true);

    const spProps = spServer && await evaluate(`saba.propsRead('${spServer.id}')`);
    check('pack:install(zip): server.propertiesが生成されportが一致', spProps, v => v && v.ok && Number(v.values['server-port']) === spPort);
    check('pack:install(zip): origin=modpack・pack.source=curseforge-zipで登録', spServer, v =>
      v && v.origin === 'modpack' && v.pack && v.pack.source === 'curseforge-zip');

    /* 3) クライアント用パック拒否: manifest.json(projectID/fileID入り)+overrides\だけ、鯖のjar/win_argsは無い */
    const spClientSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-sp-client-'));
    let spClientZipPath;
    try {
      fs.writeFileSync(path.join(spClientSrc, 'manifest.json'), JSON.stringify({
        minecraft: { version: '1.20.1' },
        files: [{ projectID: 111, fileID: 222 }]
      }));
      fs.mkdirSync(path.join(spClientSrc, 'overrides', 'config'), { recursive: true });
      fs.writeFileSync(path.join(spClientSrc, 'overrides', 'config', 'test.cfg'), 'x');

      spClientZipPath = path.join(spFixtureRoot, 'ClientPack.zip');
      zipEntries(spClientSrc, spClientZipPath);
    } finally {
      fs.rmSync(spClientSrc, { recursive: true, force: true });
    }

    const spClientResult = await evaluate(`saba.packAnalyze(${JSON.stringify(spClientZipPath)})`);
    check('pack:analyze(zip): クライアント用パックは明示エラー', spClientResult, v =>
      v.ok === false && /クライアント用パック/.test(v.error));

    /* 4) mrpack-in-zip: modrinth.index.json入りのzip → kind:'mrpack'として解析される
       (Fabricの実在バージョンを本物のmeta APIから取る。でっち上げない) */
    const fabricGamesSp = await (await fetch('https://meta.fabricmc.net/v2/versions/game')).json();
    const fabricMcSp = (fabricGamesSp.find(g => g.stable) || fabricGamesSp[0]).version;
    const fabricLoadersSp = await (await fetch('https://meta.fabricmc.net/v2/versions/loader')).json();
    const fabricLoaderVersionSp = (fabricLoadersSp.find(l => l.stable) || fabricLoadersSp[0]).version;

    const spMrpackSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-sp-mriz-'));
    let spMrpackZipPath;
    try {
      fs.writeFileSync(path.join(spMrpackSrc, 'modrinth.index.json'), JSON.stringify({
        formatVersion: 1, game: 'minecraft', versionId: '1.0.0',
        name: 'zip越しmrpack', summary: '', files: [],
        dependencies: { minecraft: fabricMcSp, 'fabric-loader': fabricLoaderVersionSp }
      }));
      spMrpackZipPath = path.join(spFixtureRoot, 'MrpackInZip.zip');
      zipEntries(spMrpackSrc, spMrpackZipPath);
    } finally {
      fs.rmSync(spMrpackSrc, { recursive: true, force: true });
    }

    const spMrpackResult = await evaluate(`saba.packAnalyze(${JSON.stringify(spMrpackZipPath)})`);
    check('pack:analyze(zip): modrinth.index.json入りはkind=mrpackとして解析される', spMrpackResult, v =>
      v.ok && v.kind === 'mrpack' && v.loader === 'fabric');

    /* 5) detect単体: libraries\net\neoforged\neoforge\21.1.95\ を持つフォルダ → neoforge・MC 1.21.1 */
    const detectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-detect-'));
    try {
      fs.mkdirSync(path.join(detectDir, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.95'), { recursive: true });
      const detected = await evaluate(`saba.devDetect(${JSON.stringify(detectDir)})`);
      check('detect: neoforgeのlibrariesフォルダからneoforge・MC 1.21.1と判定', detected, v =>
        v.loader === 'neoforge' && v.mcVersion === '1.21.1' && v.loaderVersion === '21.1.95');
    } finally {
      fs.rmSync(detectDir, { recursive: true, force: true });
    }
  } finally {
    /* 後始末: 途中で例外が出ても登録した鯖を外し、一時フォルダを消す */
    if (spServer) {
      try { await evaluate(`saba.remove('${spServer.id}', 'unregister')`); }
      catch (e) { console.error('後始末失敗(サーバーパックテスト鯖のunregister):', e.message); }
    }
    fs.rmSync(spInstallDir, { recursive: true, force: true });
    fs.rmSync(spFixtureRoot, { recursive: true, force: true });
  }

  /* ---- 18. pack:discard(レビュー修正#1の回帰): 導入せずに解析しただけのworkDirが残らない ---- */
  {
    const discardFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-discard-'));
    try {
      function buildMrpackDiscard(destPath, indexObj) {
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-discard-src-'));
        try {
          fs.writeFileSync(path.join(src, 'modrinth.index.json'), JSON.stringify(indexObj));
          const entries = fs.readdirSync(src);
          execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', destPath, ...entries], { cwd: src, windowsHide: true });
        } finally {
          fs.rmSync(src, { recursive: true, force: true });
        }
      }

      /* Fabricの実在バージョンを本物のmeta APIから取る(でっち上げない) */
      const fabricGamesD = await (await fetch('https://meta.fabricmc.net/v2/versions/game')).json();
      const fabricMcD = (fabricGamesD.find(g => g.stable) || fabricGamesD[0]).version;
      const fabricLoadersD = await (await fetch('https://meta.fabricmc.net/v2/versions/loader')).json();
      const fabricLoaderVersionD = (fabricLoadersD.find(l => l.stable) || fabricLoadersD[0]).version;

      const discardIndex = {
        formatVersion: 1, game: 'minecraft', versionId: '1.0.0',
        name: 'discardテスト', summary: '', files: [],
        dependencies: { minecraft: fabricMcD, 'fabric-loader': fabricLoaderVersionD }
      };
      const discardMrpackPath = path.join(discardFixtureRoot, 'fixture-discard.mrpack');
      buildMrpackDiscard(discardMrpackPath, discardIndex);

      /* 前のテストの解析結果が残っていないよう、まず一度discardしてから基準数を数える */
      await evaluate(`saba.packDiscard()`);
      const countPackDirs = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('sabakobo-pack-')).length;
      const beforeCount = countPackDirs();

      const discardAnalyzed = await evaluate(`saba.packAnalyze(${JSON.stringify(discardMrpackPath)})`);
      check('pack:analyze(discard用): 成功', discardAnalyzed, v => v.ok === true);
      check('pack:analyze直後はworkDirが1つ増えている', countPackDirs(), beforeCount + 1);

      await evaluate(`saba.packDiscard()`);
      check('pack:discard後はworkDirが消えている', countPackDirs(), beforeCount);
    } finally {
      fs.rmSync(discardFixtureRoot, { recursive: true, force: true });
    }
  }

  /* ---- 19. サーバーパック取り込み: MCバージョン不明のまま取り込むとエラーになる(レビュー修正#2の回帰) ---- */
  {
    const mcMissingFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-mcmissing-'));
    const mcMissingInstallDir = path.join(os.tmpdir(), `saba-devtest-mcmissing-install-${crypto.randomUUID()}`);
    try {
      const mmSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'saba-devtest-mcmissing-src-'));
      let mmZipPath;
      try {
        fs.writeFileSync(path.join(mmSrc, 'server.jar'), 'dummy-server-jar'); /* mcVersionを持たないvanilla判定(server.jarはmc不明) */
        mmZipPath = path.join(mcMissingFixtureRoot, 'McMissing.zip');
        execFileSync('C:\\Windows\\System32\\tar.exe', ['-a', '-cf', mmZipPath, ...fs.readdirSync(mmSrc)], { cwd: mmSrc, windowsHide: true });
      } finally {
        fs.rmSync(mmSrc, { recursive: true, force: true });
      }

      const mmAnalyzed = await evaluate(`saba.packAnalyze(${JSON.stringify(mmZipPath)})`);
      check('pack:analyze(zip・mcVersion不明fixture): vanillaと判定・mcVersionは不明', mmAnalyzed, v =>
        v.ok && v.kind === 'serverpack' && v.estimate.loader === 'vanilla' && !v.estimate.mcVersion);

      const mmInstallResult = await evaluate(`saba.packInstall({
        analysisId: ${JSON.stringify(mmAnalyzed.analysisId)},
        name: 'MC不明テスト',
        dir: ${JSON.stringify(mcMissingInstallDir)},
        port: 25594,
        xms: '1G', xmx: '2G',
        eula: true
      })`);
      check('pack:install(zip): MCバージョン不明のままではエラーになる(起動不能鯖の登録を防止)', mmInstallResult, v =>
        v.ok === false && /MC/.test(v.error));
    } finally {
      fs.rmSync(mcMissingInstallDir, { recursive: true, force: true });
      fs.rmSync(mcMissingFixtureRoot, { recursive: true, force: true });
    }
  }

  /* ---- 6. 実行時エラーが出ていないか ---- */
  check('実行時エラーなし', exceptions, v => v.length === 0);
  if (exceptions.length) console.log('  exceptions:', exceptions);

  console.log(`\n結果: ${passCount} PASS / ${failCount} FAIL`);
  ws.close();
  process.exit(failCount ? 1 : 0);
})().catch(e => { console.error('テスト実行エラー:', e.message); process.exit(1); });
