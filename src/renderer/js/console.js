/**
 * console.js — コンソール表示とコマンド入力
 * mainから100msごとに束ねて届く行をDocumentFragmentで一括追加。
 * DOMは約2000行で頭を切る(履歴の正本はmain側リング5000行+鯖のlogs/latest.log)。
 */
'use strict';

const ConsoleUI = {
  DOM_MAX: 2000,
  history: [],   /* 入力履歴(セッション内) */
  histIdx: -1,

  wire() {
    const form = document.querySelector('#console-form');
    const input = document.querySelector('#console-input');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const cmd = input.value.trim();
      if (!cmd || !App.state.activeId) return;
      saba.sendCmd(App.state.activeId, cmd);
      ConsoleUI.history.push(cmd);
      ConsoleUI.histIdx = ConsoleUI.history.length;
      input.value = '';
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp') {
        if (ConsoleUI.histIdx > 0) { ConsoleUI.histIdx--; input.value = ConsoleUI.history[ConsoleUI.histIdx] || ''; }
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (ConsoleUI.histIdx < ConsoleUI.history.length) { ConsoleUI.histIdx++; input.value = ConsoleUI.history[ConsoleUI.histIdx] || ''; }
        e.preventDefault();
      }
    });
  },

  /* 鯖を切り替えたとき: mainのリングバッファから履歴を引いて全描画 */
  async load(id) {
    const box = document.querySelector('#console-lines');
    box.innerHTML = '';
    const lines = await saba.ring(id);
    if (lines.length === 0) {
      ConsoleUI.appendLines(['[鯖工房] ▶ 起動するとログがここに流れます']);
    } else {
      ConsoleUI.appendLines(lines.slice(-ConsoleUI.DOM_MAX));
    }
    ConsoleUI.scrollBottom();
  },

  /* mainからの押し出し(表示中の鯖以外は無視 — 履歴はmain側にある) */
  onLines({ id, lines }) {
    if (id !== App.state.activeId) return;
    ConsoleUI.appendLines(lines);
  },

  appendLines(lines) {
    const box = document.querySelector('#console-box');
    const wrap = document.querySelector('#console-lines');
    const pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 12;

    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      if (line.startsWith('> ')) div.className = 'ln-cmd';
      else if (line.startsWith('[鯖工房]')) div.className = 'ln-app';
      else if (line.includes('ERROR') || line.includes('Exception')) div.className = 'ln-err';
      else if (line.includes('WARN')) div.className = 'ln-warn';
      frag.appendChild(div);
    }
    wrap.appendChild(frag);
    while (wrap.childNodes.length > ConsoleUI.DOM_MAX) wrap.removeChild(wrap.firstChild);
    if (pinned) ConsoleUI.scrollBottom();
  },

  scrollBottom() {
    const box = document.querySelector('#console-box');
    box.scrollTop = box.scrollHeight;
  }
};
