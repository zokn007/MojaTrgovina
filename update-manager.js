(() => {
  const CHECK_INTERVAL = 30 * 60 * 1000;
  const current = document.documentElement.dataset.appVersion || '0.0.0';

  function parts(v) { return String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0); }
  function newer(remote, local) {
    const a = parts(remote), b = parts(local), len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if ((a[i] || 0) > (b[i] || 0)) return true;
      if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
  }

  function showUpdate(version) {
    if (document.getElementById('dg-update-banner')) return;
    const box = document.createElement('div');
    box.id = 'dg-update-banner';
    box.innerHTML = `<div><strong>Na voljo je nova različica ${version}</strong><br><small>Podatki ostanejo varno shranjeni.</small></div><button type="button">Posodobi</button><button type="button" aria-label="Zapri">×</button>`;
    Object.assign(box.style, {position:'fixed',left:'12px',right:'12px',bottom:'82px',zIndex:'100000',display:'flex',alignItems:'center',gap:'10px',padding:'12px',borderRadius:'16px',background:'#10243a',color:'#fff',border:'1px solid #4f6f91',boxShadow:'0 12px 35px #0008',fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'});
    box.firstElementChild.style.flex = '1';
    [...box.querySelectorAll('button')].forEach(btn => Object.assign(btn.style, {border:'0',borderRadius:'10px',padding:'9px 12px',fontWeight:'800',cursor:'pointer'}));
    const [updateBtn, closeBtn] = box.querySelectorAll('button');
    updateBtn.style.background = '#22c55e'; updateBtn.style.color = '#06110a';
    closeBtn.style.background = '#263b52'; closeBtn.style.color = '#fff';
    updateBtn.onclick = async () => {
      updateBtn.disabled = true; updateBtn.textContent = 'Posodabljam…';
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.update()));
        }
        const url = new URL(location.href); url.searchParams.set('v', Date.now()); location.replace(url.toString());
      } catch (_) { location.reload(); }
    };
    closeBtn.onclick = () => box.remove();
    document.body.appendChild(box);
  }

  async function check() {
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, {cache:'no-store'});
      if (!res.ok) return;
      const info = await res.json();
      if (newer(info.version, current)) showUpdate(info.version);
    } catch (_) {}
  }

  window.addEventListener('load', () => { setTimeout(check, 1200); setInterval(check, CHECK_INTERVAL); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
})();
