(function () {
  'use strict';

  const cfg = window.DG_CLOUD_CONFIG || {};
  if (!cfg.appId || !Array.isArray(cfg.keys)) {
    console.warn('DG Cloud Sync: konfiguracija manjka.');
    return;
  }

  const deviceId = localStorage.getItem('dgCloudDeviceId') ||
    ('dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  localStorage.setItem('dgCloudDeviceId', deviceId);

  const metaKey = 'dgCloudMeta:' + cfg.appId;
  const original = {
    setItem: localStorage.setItem.bind(localStorage),
    removeItem: localStorage.removeItem.bind(localStorage),
    clear: localStorage.clear.bind(localStorage)
  };

  let applyingRemote = false;
  let uploadTimer = null;
  let unsubscribe = null;
  let currentUser = null;
  let statusHideTimer = null;
  let uploadInProgress = false;
  let uploadQueued = false;

  const tracked = (key) => cfg.keys.includes(key) || (cfg.prefixes || []).some((prefix) => key.startsWith(prefix));

  function collect() {
    const values = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (tracked(key)) values[key] = localStorage.getItem(key);
    }
    return values;
  }

  function hasLocalData() {
    return Object.keys(collect()).length > 0;
  }

  function readMeta() {
    try {
      return JSON.parse(original.getItem ? original.getItem(metaKey) : localStorage.getItem(metaKey)) || {};
    } catch (_) {
      return {};
    }
  }

  function writeMeta(patch) {
    const current = (() => {
      try { return JSON.parse(localStorage.getItem(metaKey) || '{}'); } catch (_) { return {}; }
    })();
    original.setItem(metaKey, JSON.stringify(Object.assign({}, current, patch)));
  }

  function formatTime(timestamp) {
    if (!timestamp) return 'še nikoli';
    try {
      return new Intl.DateTimeFormat('sl-SI', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestamp));
    } catch (_) {
      return new Date(timestamp).toLocaleTimeString();
    }
  }

  function showStatus(state, text, autoHide) {
    const bar = document.getElementById('dg-sync-bar');
    if (!bar) return;
    clearTimeout(statusHideTimer);
    bar.dataset.state = state;
    bar.textContent = text;
    bar.style.display = 'flex';
    requestAnimationFrame(() => { bar.style.opacity = '1'; });

    if (autoHide) {
      statusHideTimer = setTimeout(() => {
        bar.style.opacity = '0';
        setTimeout(() => { if (bar.style.opacity === '0') bar.style.display = 'none'; }, 220);
      }, 1800);
    }
    updatePanel();
  }

  function hideStatus() {
    const bar = document.getElementById('dg-sync-bar');
    if (!bar) return;
    clearTimeout(statusHideTimer);
    bar.style.opacity = '0';
    setTimeout(() => { bar.style.display = 'none'; }, 220);
  }

  function toast(message, isError) {
    let element = document.getElementById('dg-cloud-toast');
    if (!element) {
      element = document.createElement('div');
      element.id = 'dg-cloud-toast';
      element.style.cssText = 'position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;padding:10px 14px;border-radius:12px;font:600 13px system-ui;box-shadow:0 8px 24px #0004;max-width:85vw;text-align:center;opacity:0;transition:.2s';
      document.body.appendChild(element);
    }
    element.textContent = message;
    element.style.background = isError ? '#a61b1b' : '#111';
    element.style.opacity = '1';
    clearTimeout(element._hideTimer);
    element._hideTimer = setTimeout(() => { element.style.opacity = '0'; }, 2400);
  }

  function injectUI() {
    if (document.getElementById('dg-cloud-button')) return;

    const style = document.createElement('style');
    style.textContent = `
      #dg-sync-bar{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;height:20px;min-width:150px;max-width:92vw;padding:0 9px;border-radius:0 0 9px 9px;display:none;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:700 10px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;box-shadow:0 2px 8px #0003;opacity:0;transition:opacity .2s ease;background:#177447}
      #dg-sync-bar[data-state="saving"]{background:#946200}
      #dg-sync-bar[data-state="offline"]{background:#a45300}
      #dg-sync-bar[data-state="error"]{background:#a61b1b}
      #dg-sync-bar[data-state="signedout"]{background:#4b5563}
      #dg-cloud-button{position:fixed;right:12px;top:12px;z-index:2147483646;width:38px;height:38px;border:0;border-radius:50%;background:#fff;color:#111;font-size:18px;box-shadow:0 4px 16px #0003;cursor:pointer}
      #dg-cloud-button[data-online="false"]{filter:grayscale(1);opacity:.72}
    `;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = 'dg-sync-bar';
    bar.setAttribute('role', 'status');
    bar.setAttribute('aria-live', 'polite');
    document.body.appendChild(bar);

    const button = document.createElement('button');
    button.id = 'dg-cloud-button';
    button.type = 'button';
    button.title = 'Cloud Sync in uporabniški račun';
    button.setAttribute('aria-label', 'Cloud Sync in uporabniški račun');
    button.textContent = '☁️';
    button.onclick = openPanel;
    document.body.appendChild(button);

    const panel = document.createElement('div');
    panel.id = 'dg-cloud-panel';
    panel.style.cssText = 'display:none;position:fixed;inset:0;z-index:2147483645;background:#0008;padding:18px;align-items:center;justify-content:center;font-family:system-ui';
    panel.innerHTML = `<div style="width:min(430px,100%);max-height:86vh;overflow:auto;background:#fff;color:#111;border-radius:20px;padding:20px;box-shadow:0 20px 60px #0006">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
        <div><div style="font-size:21px;font-weight:800">${cfg.appName || cfg.appId} Cloud Sync</div><div id="dg-cloud-status" style="font-size:13px;color:#666;margin-top:3px">Preverjanje …</div></div>
        <button id="dg-cloud-close" style="border:0;background:#eee;border-radius:50%;width:36px;height:36px;font-size:20px">×</button>
      </div>
      <div id="dg-cloud-user" style="margin:16px 0;padding:12px;background:#f4f6f8;border-radius:12px;font-size:14px"></div>
      <div id="dg-cloud-last" style="margin:-7px 2px 14px;color:#667085;font-size:12px"></div>
      <div style="display:grid;gap:10px">
        <button id="dg-cloud-login" style="padding:12px;border:0;border-radius:12px;background:#1769e0;color:#fff;font-weight:700">Prijava z Googlom</button>
        <button id="dg-cloud-export" style="padding:12px;border:0;border-radius:12px;background:#eee;font-weight:700">Izvozi varnostno kopijo</button>
        <label style="padding:12px;border-radius:12px;background:#eee;font-weight:700;text-align:center;cursor:pointer">Uvozi varnostno kopijo<input id="dg-cloud-import" type="file" accept="application/json" hidden></label>
        <button id="dg-cloud-logout" style="padding:12px;border:0;border-radius:12px;background:#ffe9e9;color:#9b1c1c;font-weight:700">Odjava</button>
      </div>
      <p style="font-size:12px;color:#666;line-height:1.45;margin:15px 2px 0">Po prijavi se vse spremembe shranjujejo samodejno. Če internet ni na voljo, ostanejo lokalno in se po ponovni povezavi samodejno pošljejo v oblak.</p>
    </div>`;
    document.body.appendChild(panel);

    panel.onclick = (event) => { if (event.target === panel) closePanel(); };
    document.getElementById('dg-cloud-close').onclick = closePanel;
    document.getElementById('dg-cloud-login').onclick = login;
    document.getElementById('dg-cloud-logout').onclick = () => firebase.auth().signOut();
    document.getElementById('dg-cloud-export').onclick = exportBackup;
    document.getElementById('dg-cloud-import').onchange = importBackup;
    updatePanel();
  }

  function openPanel() {
    document.getElementById('dg-cloud-panel').style.display = 'flex';
    updatePanel();
  }

  function closePanel() {
    document.getElementById('dg-cloud-panel').style.display = 'none';
  }

  function updatePanel() {
    const status = document.getElementById('dg-cloud-status');
    const user = document.getElementById('dg-cloud-user');
    const loginButton = document.getElementById('dg-cloud-login');
    const logoutButton = document.getElementById('dg-cloud-logout');
    const last = document.getElementById('dg-cloud-last');
    const cloudButton = document.getElementById('dg-cloud-button');
    if (!status) return;

    if (cloudButton) cloudButton.dataset.online = navigator.onLine ? 'true' : 'false';
    const meta = (() => { try { return JSON.parse(localStorage.getItem(metaKey) || '{}'); } catch (_) { return {}; } })();

    if (currentUser) {
      status.textContent = navigator.onLine ? 'Samodejna sinhronizacija je vključena' : 'Brez povezave – spremembe čakajo na prenos';
      user.textContent = currentUser.displayName || currentUser.email || 'Prijavljen uporabnik';
      last.textContent = 'Zadnja uspešna sinhronizacija: ' + formatTime(meta.lastSuccess);
      loginButton.style.display = 'none';
      logoutButton.style.display = 'block';
    } else {
      status.textContent = 'Sinhronizacija ni vključena';
      user.textContent = 'Za sinhronizacijo te aplikacije se prijavi z Googlom.';
      last.textContent = 'Vsaka aplikacija uporablja svojo prijavo in svoj Firebase projekt.';
      loginButton.style.display = 'block';
      logoutButton.style.display = 'none';
    }
  }

  async function login() {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await firebase.auth().signInWithPopup(provider);
    } catch (error) {
      if (['auth/popup-blocked', 'auth/cancelled-popup-request', 'auth/operation-not-supported-in-this-environment'].includes(error.code)) {
        await firebase.auth().signInWithRedirect(new firebase.auth.GoogleAuthProvider());
      } else {
        console.error(error);
        toast('Prijava ni uspela: ' + (error.message || error.code), true);
      }
    }
  }

  function documentRef() {
    return firebase.firestore().collection('users').doc(currentUser.uid).collection('apps').doc(cfg.appId);
  }

  function scheduleUpload() {
    if (applyingRemote || !currentUser) return;
    clearTimeout(uploadTimer);
    if (!navigator.onLine) {
      writeMeta({ pending: true });
      showStatus('offline', '☁️ Brez povezave – shranjeno lokalno', false);
      return;
    }
    showStatus('saving', '☁️ Shranjujem …', false);
    uploadTimer = setTimeout(upload, 650);
  }

  localStorage.setItem = function (key, value) {
    original.setItem(key, value);
    if (tracked(key)) scheduleUpload();
  };

  localStorage.removeItem = function (key) {
    original.removeItem(key);
    if (tracked(key)) scheduleUpload();
  };

  localStorage.clear = function () {
    original.clear();
    scheduleUpload();
  };

  async function upload() {
    if (!currentUser) return;
    if (!navigator.onLine) {
      writeMeta({ pending: true });
      showStatus('offline', '☁️ Brez povezave – shranjeno lokalno', false);
      return;
    }
    if (uploadInProgress) {
      uploadQueued = true;
      return;
    }

    uploadInProgress = true;
    showStatus('saving', '☁️ Shranjujem …', false);
    const now = Date.now();

    try {
      await documentRef().set({
        appId: cfg.appId,
        appName: cfg.appName || cfg.appId,
        data: collect(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAtMs: now,
        updatedByDevice: deviceId,
        schemaVersion: 2
      }, { merge: true });

      writeMeta({ lastUpload: now, lastSuccess: now, pending: false });
      showStatus('success', '☁️ Sinhronizirano', true);
    } catch (error) {
      console.error(error);
      writeMeta({ pending: true, lastError: Date.now() });
      showStatus('error', '☁️ Napaka pri sinhronizaciji', false);
    } finally {
      uploadInProgress = false;
      updatePanel();
      if (uploadQueued) {
        uploadQueued = false;
        setTimeout(upload, 100);
      }
    }
  }

  function applyRemote(remote) {
    if (!remote || !remote.data) return;
    applyingRemote = true;
    try {
      const current = collect();
      Object.keys(current).forEach((key) => {
        if (!(key in remote.data)) original.removeItem(key);
      });
      Object.entries(remote.data).forEach(([key, value]) => original.setItem(key, value));
      const now = Date.now();
      writeMeta({ lastRemote: remote.updatedAtMs || now, lastSuccess: now, pending: false });
    } finally {
      applyingRemote = false;
    }
    showStatus('success', '☁️ Prejeti so novi podatki', true);
    setTimeout(() => location.reload(), 450);
  }

  async function startSync(user) {
    currentUser = user;
    updatePanel();
    const reference = documentRef();
    const snapshot = await reference.get();

    if (!snapshot.exists) {
      if (hasLocalData()) {
        await upload();
      } else {
        const now = Date.now();
        await reference.set({
          appId: cfg.appId,
          appName: cfg.appName || cfg.appId,
          data: {},
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAtMs: now,
          updatedByDevice: deviceId,
          schemaVersion: 2
        });
        writeMeta({ lastUpload: now, lastSuccess: now, pending: false });
        showStatus('success', '☁️ Sinhronizacija vključena', true);
      }
    } else {
      const remote = snapshot.data();
      const meta = (() => { try { return JSON.parse(localStorage.getItem(metaKey) || '{}'); } catch (_) { return {}; } })();
      if (!hasLocalData()) {
        applyRemote(remote);
      } else if (!meta.lastUpload && !meta.lastRemote) {
        await upload();
      } else if (remote.updatedByDevice !== deviceId && (remote.updatedAtMs || 0) > Math.max(meta.lastRemote || 0, meta.lastUpload || 0)) {
        applyRemote(remote);
      } else if (meta.pending) {
        await upload();
      } else {
        showStatus('success', '☁️ Sinhronizirano', true);
      }
    }

    if (unsubscribe) unsubscribe();
    unsubscribe = reference.onSnapshot((snap) => {
      if (!snap.exists) return;
      const remote = snap.data();
      const meta = (() => { try { return JSON.parse(localStorage.getItem(metaKey) || '{}'); } catch (_) { return {}; } })();
      const localTimestamp = Math.max(meta.lastRemote || 0, meta.lastUpload || 0);
      if (remote.updatedByDevice !== deviceId && (remote.updatedAtMs || 0) > localTimestamp) {
        applyRemote(remote);
      }
    }, (error) => {
      console.error(error);
      showStatus('error', '☁️ Napaka pri povezavi', false);
    });
  }

  function stopSync() {
    currentUser = null;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    updatePanel();
    hideStatus();
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify({
      appId: cfg.appId,
      appName: cfg.appName,
      exportedAt: new Date().toISOString(),
      data: collect()
    }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = (cfg.appId || 'aplikacija') + '-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('Varnostna kopija je izvožena');
  }

  async function importBackup(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const object = JSON.parse(await file.text());
      if (!object.data || typeof object.data !== 'object') throw new Error('Neveljavna datoteka');
      if (object.appId && object.appId !== cfg.appId && !confirm('Kopija je iz druge aplikacije. Ali jo vseeno želiš uvoziti?')) return;

      applyingRemote = true;
      Object.keys(collect()).forEach((key) => original.removeItem(key));
      Object.entries(object.data).forEach(([key, value]) => original.setItem(key, value));
      applyingRemote = false;
      writeMeta({ pending: true });
      if (currentUser) await upload();
      toast('Varnostna kopija je uvožena');
      setTimeout(() => location.reload(), 450);
    } catch (error) {
      applyingRemote = false;
      toast('Uvoz ni uspel: ' + error.message, true);
    } finally {
      event.target.value = '';
    }
  }

  window.addEventListener('online', () => {
    updatePanel();
    if (currentUser) upload();
  });

  window.addEventListener('offline', () => {
    updatePanel();
    if (currentUser) {
      writeMeta({ pending: true });
      showStatus('offline', '☁️ Brez povezave – shranjeno lokalno', false);
    }
  });

  function boot() {
    injectUI();
    if (!window.firebase) {
      showStatus('error', '☁️ Firebase se ni naložil', false);
      return;
    }
    try {
      firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch(() => {});
      firebase.auth().onAuthStateChanged((user) => {
        if (user) {
          startSync(user).catch((error) => {
            console.error(error);
            showStatus('error', '☁️ Povezava z oblakom ni uspela', false);
          });
        } else {
          stopSync();
        }
      });
    } catch (error) {
      console.error(error);
      showStatus('error', '☁️ Firebase ni pravilno nastavljen', false);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
