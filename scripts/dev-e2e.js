/**
 * dev-e2e.js — 実鯖での通し検証(作成→起動→コマンド→停止)
 * 使い方: npx electron . --remote-debugging-port=9223 で起動しておいてから
 *         node scripts/dev-e2e.js <loader> <mcVersion> <作成先フォルダ> [ポート]
 * 例:     node scripts/dev-e2e.js paper 1.21.11 C:\tmp\e2e-paper 25600
 * 注意: 本物のjarをダウンロードし、EULA同意済みとして鯖を1回起動する。使い捨てフォルダで使うこと。
 */
'use strict';

const { execSync } = require('child_process');

const [loader, mc, dir, portArg] = process.argv.slice(2);
if (!loader || !mc || !dir) { console.error('引数: <loader> <mcVersion> <dir> [port]'); process.exit(1); }
const port = Number(portArg) || 25600;

const PORT = 9223;
let ws, msgId = 0;
const pending = new Map();

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

async function waitFor(label, fn, timeoutMs, everyMs = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) { console.log(`      ...${label} (${Math.round((Date.now() - t0) / 1000)}秒)`); return v; }
    if (Date.now() - t0 > timeoutMs) throw new Error(`タイムアウト: ${label}`);
    await new Promise(r => setTimeout(r, everyMs));
  }
}

function javaCount() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq java.exe" /NH', { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).filter(l => /java\.exe/i.test(l)).length;
  } catch { return -1; }
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
  };
  await send('Runtime.enable');

  const baseline = javaCount();
  console.log(`java.exe ベースライン: ${baseline}個`);

  /* ---- 1. 作成(ウィザードの進捗画面を表示したまま=UI凍結バグの再現条件) ---- */
  console.log(`作成中: ${loader} ${mc} → ${dir} (ポート${port})`);
  await evaluate(`(() => {
    document.querySelector('#btn-new').click();
    document.querySelector('#wz-form').hidden = true;
    document.querySelector('#wz-progress').hidden = false;
  })()`);
  const createPromise = evaluate(`saba.createRun(${JSON.stringify({ loader, mc, name: 'E2Eテスト-' + loader, eula: true, port, xms: '1G', xmx: '2G', dir })})`);

  /* 作成中に2秒おきでUIの応答速度を測る(凍っていればここが跳ね上がる) */
  let maxLag = 0, probes = 0;
  for (;;) {
    const done = await Promise.race([createPromise.then(() => true), new Promise(r => setTimeout(() => r(false), 2000))]);
    if (done) break;
    const t0 = Date.now();
    await evaluate('1+1');
    maxLag = Math.max(maxLag, Date.now() - t0);
    probes++;
  }
  const created = await createPromise;
  await evaluate(`document.querySelector('#wizard-overlay').hidden = true`);
  check(`作成中もUIが応答(プローブ${probes}回, 最大遅延${maxLag}ms)`, maxLag < 1500, true);
  check('作成成功', created, v => v && v.ok === true);
  if (!created.ok) { console.log('  error:', created.error); process.exit(1); }
  const id = created.server.id;
  check('jar/loaderVersionが記録された', created.server, v => v.loader === loader && (v.jar || v.loader === 'forge' || v.loader === 'neoforge'));

  /* ---- 2. 起動 → Done ---- */
  const started = await evaluate(`saba.start('${id}')`);
  check('起動受理', started, v => v.ok === true);
  if (!started.ok) { console.log('  error:', started.error); process.exit(1); }

  await waitFor('Done(起動完了)が出る', async () =>
    evaluate(`saba.ring('${id}').then(r => r.some(l => l.includes('Done (')))`), 300000);
  check('起動完了ログ', true, true);

  /* ---- 3. コマンド往復(list) + 日本語往復(say) ---- */
  await evaluate(`saba.sendCmd('${id}', 'say こんにちは鯖工房')`);
  await evaluate(`saba.sendCmd('${id}', 'list')`);
  const gotList = await waitFor('listの返事', async () =>
    evaluate(`saba.ring('${id}').then(r => r.some(l => /players online|プレイヤーがオンライン/.test(l)))`), 30000);
  check('listコマンドの返事', gotList, true);
  const gotSay = await evaluate(`saba.ring('${id}').then(r => r.some(l => l.includes('こんにちは鯖工房') && !l.startsWith('>')))`);
  check('日本語がコンソールを往復(文字化けなし)', gotSay, true);

  /* ---- 4. 停止(stop→自然終了) ---- */
  const t0 = Date.now();
  await evaluate(`saba.stop('${id}')`);
  const stopSec = Math.round((Date.now() - t0) / 1000);
  console.log(`      ...停止完了 (${stopSec}秒)`);
  const ring = await evaluate(`saba.ring('${id}')`);
  const exitLine = ring.filter(l => l.includes('プロセス終了')).pop() || '';
  check('正常終了(コード0=stopが効いた。強制終了ではない)', exitLine, v => /コード 0\)/.test(v));
  check('30秒以内に自然停止(taskkillに落ちていない)', stopSec < 30, true);

  /* ---- 5. java.exe残留ゼロ ---- */
  await new Promise(r => setTimeout(r, 3000));
  const after = javaCount();
  check(`java.exe残留なし(${baseline}→${after})`, after, baseline);

  console.log(`\n結果: ${passCount} PASS / ${failCount} FAIL`);
  ws.close();
  process.exit(failCount ? 1 : 0);
})().catch(e => { console.error('E2Eエラー:', e.message); process.exit(1); });
