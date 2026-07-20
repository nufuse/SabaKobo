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
    return open && document.querySelectorAll('input[name=wz-loader]').length === 4;
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
  const dummy = await evaluate(`saba.devRegister({ name: '削除テスト', dir: ${JSON.stringify(dummyDir)}, port: 25599, writeProps: { port: 25599, motd: 'てすとMOTD' } })`);
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

  /* ---- 6. 実行時エラーが出ていないか ---- */
  check('実行時エラーなし', exceptions, v => v.length === 0);
  if (exceptions.length) console.log('  exceptions:', exceptions);

  console.log(`\n結果: ${passCount} PASS / ${failCount} FAIL`);
  ws.close();
  process.exit(failCount ? 1 : 0);
})().catch(e => { console.error('テスト実行エラー:', e.message); process.exit(1); });
