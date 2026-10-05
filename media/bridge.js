// LiveDeck browser bridge: stands in for VS Code's acquireVsCodeApi() when
// the shell runs in a plain browser tab (`livedeck serve`). Host → page
// messages arrive over Server-Sent Events and are re-dispatched as window
// 'message' events; page → host messages are POSTed strictly in order.
// Things only the browser can do (clipboard, file picker, opening tabs) are
// handled here instead of by the host.
(function () {
  'use strict';
  const client = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const STATE_KEY = 'livedeck-shell-state';

  let connected = false;
  let everConnected = false;
  const waiting = []; // serialized messages posted before the stream opened
  let chain = Promise.resolve();

  function deliver(msg) {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  }

  function sendRaw(body) {
    chain = chain
      .then(() => fetch('/msg?client=' + client, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LiveDeck': '1' },
        body,
      }))
      .catch(() => { /* server gone; the stream reconnects */ });
  }

  const events = new EventSource('/events?client=' + client);
  events.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    deliver(msg);
  };
  events.onopen = () => {
    connected = true;
    // after a server restart the new session needs the deck again
    if (everConnected) sendRaw(JSON.stringify({ type: 'ready' }));
    everConnected = true;
    waiting.splice(0).forEach(sendRaw);
  };
  events.onerror = () => { connected = false; };

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  /** "Insert image…": a file input stands in for the editor's open dialog. */
  function pickImage(msg) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const finish = () => { settled = true; input.remove(); };
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      finish();
      if (!f) { deliver({ type: 'imageReady', reqId: msg.reqId, cancelled: true }); return; }
      try {
        const data = await readAsBase64(f);
        post({ type: 'saveImage', reqId: msg.reqId, mime: f.type, name: f.name, data });
      } catch (err) {
        deliver({ type: 'imageReady', reqId: msg.reqId, error: 'Could not read image' });
      }
    });
    input.addEventListener('cancel', () => {
      if (settled) return;
      finish();
      deliver({ type: 'imageReady', reqId: msg.reqId, cancelled: true });
    });
    input.click();
  }

  /** Messages the browser handles itself. Returns true when handled. */
  function local(msg) {
    switch (msg && msg.type) {
      case 'clipboardWrite':
        navigator.clipboard.writeText(String(msg.text || ''))
          .catch(() => {})
          .then(() => deliver({ type: 'clipboardText', reqId: msg.reqId }));
        return true;
      case 'clipboardRead':
        navigator.clipboard.readText()
          .catch(() => '')
          .then((text) => deliver({ type: 'clipboardText', reqId: msg.reqId, text }));
        return true;
      case 'openExternal':
        if (/^https?:/i.test(String(msg.url))) window.open(msg.url, '_blank', 'noopener');
        return true;
      case 'openBrowser':
        window.open('/deck/', '_blank', 'noopener');
        return true;
      case 'pickImage':
        if (msg.uri) return false; // a dropped file: the host reads it from disk
        pickImage(msg);
        return true;
    }
    return false;
  }

  function post(msg) {
    if (local(msg)) return;
    const body = JSON.stringify(msg); // serialize now: the shell may mutate msg later
    if (connected) sendRaw(body);
    else waiting.push(body);
  }

  window.acquireVsCodeApi = () => ({
    postMessage: post,
    getState() {
      try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (err) { return null; }
    },
    setState(s) {
      try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (err) { /* storage blocked */ }
    },
  });
})();
