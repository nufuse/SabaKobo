/**
 * dev-shot.js — CDP経由でアプリのスクリーンショットを撮る
 * 使い方: npx electron . --remote-debugging-port=9223 で起動しておいてから
 *         node scripts/dev-shot.js <保存先.png> [実行するJS(撮影前に評価)]
 */
'use strict';

const fs = require('fs');
const PORT = 9223;
const [dest, preEval] = process.argv.slice(2);
if (!dest) { console.error('引数: <保存先.png> [撮影前に実行するJS]'); process.exit(1); }

let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise(resolve => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) { console.error('アプリのページが見つからない'); process.exit(1); }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(res => { ws.onopen = res; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
  await send('Runtime.enable');
  if (preEval) {
    await send('Runtime.evaluate', { expression: preEval, returnByValue: true, awaitPromise: true });
    await new Promise(r => setTimeout(r, 600));
  }
  /* 背面描画対策の二度撮り(CmdKoboの学び) */
  await send('Page.captureScreenshot', { format: 'png' });
  await new Promise(r => setTimeout(r, 300));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(dest, Buffer.from(shot.data, 'base64'));
  console.log('保存: ' + dest);
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
