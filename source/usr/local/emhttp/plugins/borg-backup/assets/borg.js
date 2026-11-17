/* Borg Backup for Unraid - shared UI code and page controllers. */
(function () {
  'use strict';
  const BB = window.BB = window.BB || {};
  BB.pages = {};
  const API = '/plugins/borg-backup/include/api.php';
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /* ------------------------------ helpers ------------------------------ */
  BB.ready = fn => document.readyState !== 'loading' ? fn() : document.addEventListener('DOMContentLoaded', fn);
  BB.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  BB.size = b => {
    if (b == null || b === '') return '-';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0; b = +b;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i ? b.toFixed(1) : b) + ' ' + u[i];
  };
  BB.time = ts => ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '-';
  BB.ago = ts => {
    if (!ts) return 'never';
    const d = Math.round(Date.now() / 1000 - ts), a = Math.abs(d);
    const f = a < 60 ? a + 's' : a < 3600 ? Math.round(a / 60) + 'm' : a < 86400 ? Math.round(a / 3600) + 'h' : Math.round(a / 86400) + 'd';
    return d >= 0 ? f + ' ago' : 'in ' + f;
  };
  BB.dur = s => { s = Math.max(0, Math.round(s)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm'; };
  BB.badge = (st, running) => running ? '<span class="bb-badge running"><span class="bb-spin"></span> running</span>'
    : st ? `<span class="bb-badge ${BB.esc(st)}">${BB.esc(st)}</span>` : '<span class="bb-muted">never run</span>';
  BB.icon = { container: 'fa-cube', compose: 'fa-cubes', custom: 'fa-folder-open', job: 'fa-archive', test: 'fa-stethoscope', restore: 'fa-history' };

  // URL-encoded on purpose: Unraid 7.4 stalls on multipart/form-data POSTs to plugin PHP files.
  // Quick calls time out after 60s; borg operations (init, delete, browse) get 30 minutes.
  const SLOW = ['repo_save', 'repo_refresh', 'archives', 'archive_browse', 'archive_delete', 'repo_key', 'script_test'];
  BB.api = async (action, data = {}) => {
    const body = new URLSearchParams({ action, data: JSON.stringify(data), csrf_token: BB.csrf || window.csrf_token || '' });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SLOW.includes(action) ? 1800000 : 60000);
    let r;
    try { r = await fetch(API, { method: 'POST', body, credentials: 'same-origin', signal: ac.signal }); }
    catch (e) { throw new Error(e.name === 'AbortError' ? 'The server did not answer in time (' + action + ')' : 'Network error: ' + e.message); }
    finally { clearTimeout(timer); }
    let j;
    try { j = await r.json(); } catch (e) { throw new Error('Unexpected server response (HTTP ' + r.status + ')'); }
    if (!j.ok) throw new Error(j.error || 'Request failed');
    return j;
  };

  BB.toast = (msg, type = 'ok') => {
    const t = document.createElement('div');
    t.className = 'bb-toast ' + type; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), type === 'err' ? 7000 : 3500);
  };
  BB.err = e => BB.toast(e.message || String(e), 'err');

  /** Run an async action on a button with a spinner + error toast. */
  BB.busy = async (btn, fn) => {
    const old = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="bb-spin"></span> ' + old; }
    try { return await fn(); } catch (e) { BB.err(e); throw e; }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
  };

  /* Modals inherit the page background so they work with every Unraid theme. */
  function themeColors() {
    let el = document.body, bg = 'rgba(0, 0, 0, 0)';
    for (const c of [document.querySelector('#displaybox'), document.querySelector('.content'), document.body, document.documentElement]) {
      if (!c) continue;
      const b = getComputedStyle(c).backgroundColor;
      if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') { bg = b; el = c; break; }
    }
    if (bg === 'rgba(0, 0, 0, 0)') bg = '#fff';
    return { bg, fg: getComputedStyle(el).color };
  }

  /**
   * Open a modal. opts: title, body (html), wide, buttons: [{label, cls, left, click(m, btn)}], onClose
   * Returns {el, body, close}.
   */
  BB.modal = (opts) => {
    const ov = document.createElement('div');
    ov.className = 'bb-overlay';
    const c = themeColors();
    ov.innerHTML = `<div class="bb-modal ${opts.wide ? 'wide' : ''}" style="--bb-bg:${c.bg};--bb-fg:${c.fg}">
      <div class="bb-modal-head"><span>${opts.title || ''}</span><span class="bb-x" title="Close">&times;</span></div>
      <div class="bb-modal-body"></div><div class="bb-modal-foot"></div></div>`;
    const m = { el: ov, body: ov.querySelector('.bb-modal-body'), foot: ov.querySelector('.bb-modal-foot') };
    m.close = () => { ov.remove(); document.removeEventListener('keydown', esc); opts.onClose && opts.onClose(); };
    const esc = e => { if (e.key === 'Escape') m.close(); };
    document.addEventListener('keydown', esc);
    ov.querySelector('.bb-x').onclick = m.close;
    if (typeof opts.body === 'string') m.body.innerHTML = opts.body; else if (opts.body) m.body.appendChild(opts.body);
    m.setButtons = (buttons) => {
      m.foot.innerHTML = '';
      (buttons || []).forEach(b => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.innerHTML = b.label; btn.className = (b.cls || '') + (b.left ? ' bb-left' : '');
        btn.onclick = () => b.click ? b.click(m, btn) : m.close();
        m.foot.appendChild(btn);
      });
    };
    m.setButtons(opts.buttons || [{ label: 'Close' }]);
    document.body.appendChild(ov);
    return m;
  };

  BB.confirm = (title, html, okLabel = 'OK', danger = false) => new Promise(res => {
    BB.modal({
      title, body: `<div>${html}</div>`, onClose: () => res(false),
      buttons: [{ label: 'Cancel' }, { label: okLabel, cls: danger ? 'bb-danger' : '', click: m => { res(true); m.close(); } }]
    });
  });

  /** Show a log file; polls while the task is running and offers Cancel. */
  BB.showLog = (log, title) => {
    let timer = null, done = false;
    const m = BB.modal({ title: BB.esc(title || 'Log'), wide: true, body: '<pre class="bb-log">Loading…</pre><div class="bb-small bb-muted" style="margin-top:6px"></div>',
      onClose: () => { done = true; clearTimeout(timer); } });
    const pre = m.body.querySelector('pre'), info = m.body.querySelector('div');
    const load = async () => {
      try {
        const r = await BB.api('log', { log });
        const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = (r.truncated ? '… (showing last 256 KB)\n' : '') + (r.text || '(empty)');
        if (stick) pre.scrollTop = pre.scrollHeight;
        info.innerHTML = r.running ? `<span class="bb-spin"></span> ${BB.esc(r.running.step)} – running for ${BB.dur(Date.now() / 1000 - r.running.started)}` : BB.esc(log);
        m.setButtons([
          ...(r.running ? [{ label: 'Cancel task', cls: 'bb-danger bb-left', click: async (mm, b) => {
            if (await BB.confirm('Cancel task', 'Stop this task? Containers that were stopped will be started again.', 'Stop task', true))
              BB.busy(b, () => BB.api('cancel', { key: r.running.key }));
          } }] : []),
          { label: 'Close' }]);
        if (r.running && !done) timer = setTimeout(load, 2000);
      } catch (e) { pre.textContent = e.message; }
    };
    load();
  };

  /** Switch to another tab of the plugin (works with Unraid's tab markup). */
  BB.gotoTab = (title) => {
    const el = [...document.querySelectorAll('.tabs label, .tabs a, .tab label, nav a, [role=tab]')].find(x => x.textContent.trim() === title);
    if (el) el.click();
    const sec = document.querySelector(`[data-bb-page="${title}"]`);
    if (sec) setTimeout(() => sec.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  /* ---------------------------- global state --------------------------- */
  BB.state = null;
  const listeners = [];
  let pollTimer = null;
  BB.onState = fn => { listeners.push(fn); if (BB.state) fn(BB.state); };
  BB.refresh = async () => {
    clearTimeout(pollTimer);
    try {
      BB.state = await BB.api('state', { history: 30 });
      document.querySelectorAll('.bb-api-error').forEach(x => x.remove());
      listeners.forEach(fn => { try { fn(BB.state); } catch (e) { console.error(e); } });
    } catch (e) {
      console.error(e);
      // make failures visible instead of leaving the pages blank
      document.querySelectorAll('.bb-page').forEach(p => {
        let n = p.previousElementSibling;
        if (!n || !n.classList.contains('bb-api-error')) { n = document.createElement('div'); n.className = 'bb-note err bb-api-error'; p.before(n); }
        n.textContent = 'Could not load data from the plugin backend: ' + e.message + ' – retrying…';
      });
    }
    pollTimer = setTimeout(BB.refresh, BB.state && BB.state.tasks.length ? 3000 : 20000);
  };
  BB.repoName = id => (BB.state.repos.find(r => r.id === id) || {}).name || '(missing)';
  let started = false;
  BB.start = () => { if (!started) { started = true; BB.refresh(); } };

  /* -------------------------- schedule editor -------------------------- */
  /** Render a schedule editor into el; returns a function that reads the schedule. */
  BB.scheduleEditor = (el, s) => {
    s = Object.assign({ preset: 'daily', time: '02:00', minute: 0, dow: 0, dom: 1, cron: '0 3 * * *' }, s || {});
    el.innerHTML = `<div class="bb-form">
      <label>Run</label><select data-k="preset">
        ${[['manual', 'Manually only'], ['hourly', 'Every hour'], ['daily', 'Every day'], ['weekly', 'Every week'], ['monthly', 'Every month'], ['custom', 'Custom (cron)']]
          .map(([v, t]) => `<option value="${v}" ${s.preset === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <label data-for="dow">Day of week</label><select data-k="dow" data-for="dow">${DAYS.map((d, i) => `<option value="${i}" ${+s.dow === i ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <label data-for="dom">Day of month</label><input data-k="dom" data-for="dom" type="number" min="1" max="28" value="${+s.dom || 1}">
      <label data-for="time">Time</label><input data-k="time" data-for="time" type="time" value="${BB.esc(s.time)}">
      <label data-for="minute">Minute past the hour</label><input data-k="minute" data-for="minute" type="number" min="0" max="59" value="${+s.minute || 0}">
      <label data-for="cron">Cron expression</label><input data-k="cron" data-for="cron" type="text" class="bb-mono" value="${BB.esc(s.cron)}" placeholder="m h dom mon dow">
      <div class="bb-help" data-for="cron">Five fields: minute hour day-of-month month day-of-week. Example: <code>30 1 * * 1-5</code></div>
    </div>`;
    const show = () => {
      const p = el.querySelector('[data-k=preset]').value;
      const vis = { dow: p === 'weekly', dom: p === 'monthly', time: ['daily', 'weekly', 'monthly'].includes(p), minute: p === 'hourly', cron: p === 'custom' };
      el.querySelectorAll('[data-for]').forEach(x => x.style.display = vis[x.dataset.for] ? '' : 'none');
    };
    el.querySelector('[data-k=preset]').onchange = show;
    show();
    return () => {
      const v = k => el.querySelector(`[data-k=${k}]`).value;
      return { preset: v('preset'), time: v('time') || '02:00', minute: +v('minute'), dow: +v('dow'), dom: +v('dom'), cron: v('cron') };
    };
  };

  /* --------------------------- path resolver --------------------------- */
  /** Live folder suggestions and a status line for a repository path input. */
  BB.pathResolver = (input, list, status, opt = {}) => {
    let seq = 0, timer = null, items = [], sel = -1;
    const active = opt.active || (() => true);
    const hide = () => { list.hidden = true; items = []; sel = -1; };
    const msg = (cls, html) => { status.className = 'bb-pathstat ' + cls; status.innerHTML = html; };
    const showList = () => {
      if (!items.length || document.activeElement !== input) return hide();
      list.innerHTML = items.map((p, i) => { const cut = p.lastIndexOf('/') + 1;
        return `<div data-i="${i}" class="${i === sel ? 'on' : ''}"><i class="fa fa-folder-o"></i> <span class="bb-muted">${BB.esc(p.slice(0, cut))}</span>${BB.esc(p.slice(cut))}</div>`; }).join('');
      list.hidden = false;
      const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const pick = i => { input.value = items[i] + '/'; hide(); input.focus(); lookup(0); };
    const render = r => {
      items = r.suggestions || []; sel = -1; showList();
      const free = r.free != null ? ` · ${BB.size(r.free)} free` : '';
      const w = r.where || {};
      if (w.type === 'pool' && w.new || (r.state === 'missing' && r.ancestor === '/mnt'))
        return msg('err', `<code>/mnt/${BB.esc(w.name || '')}</code> is not a disk or pool on this server.`), opt.onState && opt.onState('bad');
      const shareNote = w.type === 'share' && w.new ? ` A new share <b>${BB.esc(w.name)}</b> is created.` : '';
      const loc = { ram: ' <b>Warning:</b> this is not on the array, a pool or a device – it is in RAM and is lost on reboot.',
        flash: ' <b>Warning:</b> this is on the USB flash drive, which is small and wears out.' }[w.type] || '';
      const warn = loc ? 'warn' : 'ok';
      switch (r.state) {
        case 'borg': msg(warn, `<i class="fa fa-check-circle"></i> Existing Borg repository – it will be added. Enter its passphrase below.${free}${loc}`); break;
        case 'empty': msg(warn, `<i class="fa fa-check-circle"></i> Empty folder – a new repository is created here.${free}${loc}`); break;
        case 'missing': msg(warn, `<i class="fa fa-plus-circle"></i> New folder – created inside <code>${BB.esc(r.ancestor)}</code>.${shareNote}${free}${loc}`); break;
        case 'file': msg('err', '<i class="fa fa-times-circle"></i> This is a file, not a folder.'); break;
        case 'notempty': msg('err', `<i class="fa fa-times-circle"></i> This folder has other files and is not a Borg repository. Use a new or empty folder, e.g. <a href="#" data-use="${BB.esc(r.path.replace(/\/$/, ''))}/borg">${BB.esc(r.path.replace(/\/$/, ''))}/borg</a>.`); break;
      }
      if (opt.onState) opt.onState(r.state);
    };
    const lookup = (delay = 250) => {
      clearTimeout(timer);
      const v = input.value.trim(), my = ++seq;
      if (!active()) { hide(); return; }
      if (!v) { hide(); msg('', ''); if (opt.onState) opt.onState(''); return; }
      if (v[0] !== '/') { hide(); msg('err', 'Enter a full path starting with <code>/</code>, e.g. <code>/mnt/user/backups/borg</code>.'); return; }
      timer = setTimeout(async () => {
        let r; try { r = await BB.api('path_info', { path: v }); } catch (e) { if (my === seq) msg('', ''); return; }
        if (my !== seq) return;            // a newer keystroke won
        if (!r.valid) { hide(); msg('err', 'This path is not valid.'); return; }
        render(r);
      }, delay);
    };
    input.addEventListener('input', () => lookup());
    input.addEventListener('focus', () => { if (input.value.trim()) lookup(0); });
    input.addEventListener('blur', () => setTimeout(hide, 150));
    input.addEventListener('keydown', e => {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length + 1) % (items.length + 1); if (sel === items.length) sel = -1; showList(); }
      else if ((e.key === 'Tab' || e.key === 'Enter') && (sel >= 0 || items.length === 1)) { e.preventDefault(); pick(sel >= 0 ? sel : 0); }
      else if (e.key === 'Tab') {
        // several matches: complete their common part, like a shell
        let c = items[0]; for (const p of items) while (p.toLowerCase().indexOf(c.toLowerCase()) !== 0) c = c.slice(0, -1);
        if (c.length > input.value.length) { e.preventDefault(); input.value = c; lookup(0); }
      }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); }
    });
    list.addEventListener('mousedown', e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pick(+d.dataset.i); } });
    status.addEventListener('click', e => { const a = e.target.closest('[data-use]'); if (a) { e.preventDefault(); input.value = a.dataset.use; input.focus(); lookup(0); } });
    if (input.value.trim()) lookup(0);
  };

  /* ------------------------------ repo form ---------------------------- */
  /** Repository form (used by Repositories page and the wizard). Returns {get()}. */
  BB.repoForm = (el, repo) => {
    const editing = !!(repo && repo.id);
    repo = Object.assign({ name: '', location: '', encryption: 'repokey-blake2', remote_path: '', ssh_key: '', mode: 'new' }, repo || {});
    const remote = /^(ssh:\/\/|[^/]+@[^/]+:)/.test(repo.location);
    el.innerHTML = `
      <div class="bb-form">
        <label>Name</label><input type="text" data-k="name" value="${BB.esc(repo.name)}" placeholder="e.g. Local array, Hetzner Storage Box">
        <label>Location</label><div>${editing ? `<code>${BB.esc(repo.location)}</code>` : `
          <div class="bb-seg" data-g="where"><span data-v="local" class="${remote ? '' : 'on'}">Local path</span><span data-v="ssh" class="${remote ? 'on' : ''}">Remote (SSH)</span></div>
          <div class="bb-acwrap"><input type="text" data-k="location" class="bb-mono" value="${BB.esc(repo.location)}" autocomplete="off" spellcheck="false"><div class="bb-ac" hidden></div></div>
          <div class="bb-pathstat" data-status></div>
          <div class="bb-seg" data-g="mode" style="margin-top:6px"><span data-v="new" class="on">Create it (borg init)</span><span data-v="existing">It already exists</span></div>`}</div>
        <div class="bb-help" data-help="loc"></div>
        ${editing ? '' : `<label data-enc>Encryption</label><select data-k="encryption" data-enc>
          <option value="repokey-blake2">repokey-blake2 (recommended – key stored in repo)</option>
          <option value="repokey">repokey (AES, older CPUs)</option>
          <option value="keyfile-blake2">keyfile-blake2 (key stored on flash)</option>
          <option value="none">none (no encryption)</option></select>`}
        <label>Passphrase</label><input type="password" data-k="passphrase" autocomplete="new-password" placeholder="${editing ? 'leave empty to keep current' : ''}">
        <label data-confirm>Confirm passphrase</label><input type="password" data-k="passphrase2" data-confirm autocomplete="new-password">
        <div class="bb-help">Stored on the flash drive so scheduled jobs can run. <b>Keep a copy elsewhere</b> – without it the backups cannot be read.</div>
        <label>Remote borg path</label><input type="text" data-k="remote_path" class="bb-mono" value="${BB.esc(repo.remote_path)}" placeholder="optional, e.g. borg-1.4">
        <label>SSH key</label><input type="text" data-k="ssh_key" class="bb-mono" value="${BB.esc(repo.ssh_key)}" placeholder="optional – defaults to the key in Settings">
      </div>`;
    const q = s => el.querySelector(s);
    const state = { mode: 'new', where: remote ? 'ssh' : 'local' };
    const setSeg = (g, v) => { state[g] = v; el.querySelectorAll(`[data-g=${g}] span`).forEach(x => x.classList.toggle('on', x.dataset.v === v)); };
    const upd = () => {
      // local paths are checked as you type, so new/existing is detected; SSH needs the choice
      const modeSeg = q('[data-g=mode]'); if (modeSeg) modeSeg.style.display = state.where === 'ssh' ? '' : 'none';
      const st = q('[data-status]'); if (st && state.where === 'ssh') st.innerHTML = '';
      el.querySelectorAll('[data-confirm]').forEach(x => x.style.display = (!editing && state.mode === 'new') ? '' : 'none');
      el.querySelectorAll('[data-enc]').forEach(x => x.style.display = state.mode === 'new' ? '' : 'none');
      const loc = q('[data-k=location]');
      if (loc) loc.placeholder = state.where === 'ssh' ? 'ssh://u123456@u123456.your-storagebox.de:23/./borg/unraid' : '/mnt/user/backups/borg';
      q('[data-help=loc]').innerHTML = editing ? 'The location of an existing repository cannot be changed.' : state.where === 'ssh'
        ? 'Use <code>ssh://user@host:port/path</code> or <code>user@host:path</code>. Add the public key from Settings to the remote <code>authorized_keys</code> first.'
        : 'A folder on the array, a pool or an unassigned device: a new or empty folder, or an existing Borg repository.';
    };
    el.querySelectorAll('.bb-seg').forEach(seg => seg.onclick = e => {
      const s = e.target.closest('span'); if (!s) return;
      seg.querySelectorAll('span').forEach(x => x.classList.toggle('on', x === s));
      state[seg.dataset.g] = s.dataset.v; upd();
      if (seg.dataset.g === 'where' && s.dataset.v === 'local') q('[data-k=location]').dispatchEvent(new Event('input'));
    });
    if (!editing) q('[data-k=encryption]').value = repo.encryption;
    upd();
    if (!editing) BB.pathResolver(q('[data-k=location]'), q('.bb-ac'), q('[data-status]'), {
      active: () => state.where === 'local',
      onState: s => { setSeg('mode', s === 'borg' ? 'existing' : 'new'); upd(); }
    });
    return {
      get() {
        const v = k => (q(`[data-k=${k}]`) || {}).value || '';
        if (!v('name').trim()) throw new Error('Enter a repository name');
        if (!editing && !v('location').trim()) throw new Error('Enter a repository location');
        if (!editing && state.mode === 'new' && v('encryption') !== 'none') {
          if (v('passphrase').length < 8) throw new Error('Passphrase must have at least 8 characters');
          if (v('passphrase') !== v('passphrase2')) throw new Error('Passphrases do not match');
        }
        return { id: repo.id, name: v('name').trim(), location: editing ? repo.location : v('location').trim(), encryption: v('encryption') || repo.encryption,
          passphrase: v('passphrase'), remote_path: v('remote_path').trim(), ssh_key: v('ssh_key').trim(), mode: state.mode };
      }
    };
  };

  BB.repoDialog = (repo) => new Promise(res => {
    const m = BB.modal({ title: repo ? 'Edit repository' : 'Add repository', wide: true, body: '<div></div>', onClose: () => res(null) });
    const f = BB.repoForm(m.body.firstChild, repo);
    m.setButtons([{ label: 'Cancel' }, { label: repo ? 'Save' : 'Add repository', click: async (mm, b) => {
      let data; try { data = f.get(); } catch (e) { return BB.err(e); }
      const r = await BB.busy(b, () => BB.api('repo_save', { repo: data })).catch(() => null);
      if (!r) return;
      BB.toast(repo ? 'Repository saved' : 'Repository ready');
      res(r.repo); m.close(); BB.refresh();
    } }]);
  });

  /* ============================== PAGES =============================== */

  /* ---------------------------- Dashboard ------------------------------ */
  BB.pages.dashboard = (root) => {
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const d = b.dataset;
      if (d.act === 'log') BB.showLog(d.log, d.title);
      if (d.act === 'run') BB.busy(b, () => BB.api('job_run', { id: d.id })).then(() => { BB.toast('Backup started'); BB.refresh(); });
      if (d.act === 'new') BB.wizard.open();
    });
    BB.onState(st => {
      const day = st.now - 86400;
      const recent = st.history.filter(h => h.ended > day);
      const cnt = s => recent.filter(h => h.status === s).length;
      const enabled = st.jobs.filter(j => j.enabled);
      const next = enabled.filter(j => j.next_run).sort((a, b) => a.next_run - b.next_run)[0];
      const total = st.repos.reduce((a, r) => a + ((r.info && r.info.deduplicated) || 0), 0);
      const failing = st.jobs.filter(j => j.last && ['failed', 'cancelled'].includes(j.last.status));
      root.innerHTML = `
        ${st.repos.length === 0 && st.jobs.length === 0 ? `<div class="bb-note">Welcome! Create a backup job – the wizard will help you pick a container, compose stack or folder and set up a repository. <button data-act="new">New backup job</button></div>` : ''}
        ${failing.length ? `<div class="bb-note err"><b>${failing.length} job(s) failed on their last run:</b> ${failing.map(j => BB.esc(j.name)).join(', ')}</div>` : ''}
        <div class="bb-cards">
          <div class="bb-card"><div class="bb-k">Jobs</div><div class="bb-v">${enabled.length}<span class="bb-s"> / ${st.jobs.length} enabled</span></div><div class="bb-s">${st.tasks.length} running now</div></div>
          <div class="bb-card"><div class="bb-k">Last 24 hours</div><div class="bb-v">${cnt('ok')} <span class="bb-s">ok</span></div>
            <div class="bb-s">${cnt('warning')} warning · ${cnt('failed') + cnt('cancelled')} failed</div></div>
          <div class="bb-card"><div class="bb-k">Repositories</div><div class="bb-v">${st.repos.length}</div><div class="bb-s">${BB.size(total)} stored (deduplicated)</div></div>
          <div class="bb-card"><div class="bb-k">Next backup</div><div class="bb-v" style="font-size:1.2em">${next ? BB.esc(next.name) : '–'}</div><div class="bb-s">${next ? BB.time(next.next_run) + ' (' + BB.ago(next.next_run) + ')' : 'nothing scheduled'}</div></div>
        </div>
        ${st.tasks.length ? `<div class="bb-h">Running</div>${st.tasks.map(t => `<div class="bb-task">
            <i class="fa ${BB.icon[t.kind] || 'fa-cog'}"></i>
            <div class="bb-grow"><b>${BB.esc(t.label)}</b><div class="bb-small bb-muted"><span class="bb-spin"></span> ${BB.esc(t.step)} · ${BB.dur(st.now - t.started)}</div></div>
            <button data-act="log" data-log="${BB.esc(t.log)}" data-title="${BB.esc(t.label)}">Live log</button></div>`).join('')}` : ''}
        <div class="bb-h">Backup jobs</div>
        ${st.jobs.length ? `<table class="bb-table"><thead><tr><th>Job</th><th>Last result</th><th>Last run</th><th>Next run</th><th></th></tr></thead><tbody>
          ${st.jobs.map(j => `<tr><td><i class="fa ${BB.icon[j.source.type]}"></i> ${BB.esc(j.name)} ${j.enabled ? '' : '<span class="bb-muted bb-small">(disabled)</span>'}</td>
            <td>${BB.badge(j.last && j.last.status, j.running)} <span class="bb-small bb-muted">${BB.esc(j.last && j.last.message || '')}</span></td>
            <td>${j.last ? BB.ago(j.last.ended) : '-'}</td><td>${j.next_run ? BB.time(j.next_run) : '<span class="bb-muted">' + BB.esc(j.schedule_text) + '</span>'}</td>
            <td class="bb-actions">${j.last ? `<button class="bb-link" data-act="log" data-log="${BB.esc(j.last.log)}" data-title="${BB.esc(j.name)}">log</button>` : ''}
              <button data-act="run" data-id="${j.id}" ${j.running ? 'disabled' : ''}>Run now</button></td></tr>`).join('')}
          </tbody></table>` : `<div class="bb-empty">No backup jobs yet. <button data-act="new">New backup job</button></div>`}
        <div class="bb-h">Recent activity</div>
        ${st.history.length ? `<table class="bb-table"><thead><tr><th>When</th><th>What</th><th>Result</th><th>Duration</th><th></th></tr></thead><tbody>
          ${st.history.slice(0, 15).map(h => `<tr><td title="${BB.time(h.ended)}">${BB.ago(h.ended)}</td>
            <td><i class="fa ${BB.icon[h.kind] || 'fa-cog'}"></i> ${BB.esc(h.name)}</td>
            <td>${BB.badge(h.status)} <span class="bb-small bb-muted">${BB.esc(h.message || '')}</span></td><td>${BB.dur(h.ended - h.started)}</td>
            <td class="bb-actions"><button class="bb-link" data-act="log" data-log="${BB.esc(h.log)}" data-title="${BB.esc(h.name)}">log</button></td></tr>`).join('')}
          </tbody></table>` : '<div class="bb-empty">Nothing has run yet.</div>'}`;
    });
  };

  /* ------------------------------- Jobs -------------------------------- */
  BB.pages.jobs = (root) => {
    root.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const d = b.dataset, job = BB.state.jobs.find(j => j.id === d.id);
      switch (d.act) {
        case 'new': BB.wizard.open(); break;
        case 'edit': BB.busy(b, () => BB.api('job_get', { id: d.id })).then(r => BB.wizard.open(r.job)); break;
        case 'run': BB.busy(b, () => BB.api('job_run', { id: d.id })).then(() => { BB.toast('Backup started'); BB.refresh(); }); break;
        case 'cancel': if (await BB.confirm('Cancel backup', `Stop <b>${BB.esc(job.name)}</b>? Stopped containers will be started again.`, 'Stop backup', true))
          BB.busy(b, () => BB.api('cancel', { key: 'job-' + d.id })).then(BB.refresh); break;
        case 'log': BB.showLog(d.log, job ? job.name : 'Log'); break;
        case 'history': showHistory('job', d.id, job.name); break;
        case 'delete':
          if (await BB.confirm('Delete job', `Delete <b>${BB.esc(job.name)}</b>? Existing archives in the repository are kept.`, 'Delete', true))
            BB.busy(b, () => BB.api('job_delete', { id: d.id })).then(() => { BB.toast('Job deleted'); BB.refresh(); });
          break;
      }
    });
    root.addEventListener('change', e => {
      if (e.target.dataset.act === 'toggle') BB.api('job_toggle', { id: e.target.dataset.id, enabled: e.target.checked }).then(BB.refresh).catch(BB.err);
    });
    const srcText = j => {
      const n = j.source.paths.filter(p => p.include).length;
      return `<i class="fa ${BB.icon[j.source.type]}"></i> ${j.source.type === 'custom' ? 'Custom paths' : BB.esc(j.source.name)}
        <div class="bb-small bb-muted">${n} path${n === 1 ? '' : 's'}${j.stop.enabled ? ' · stops containers' : ''}</div>`;
    };
    BB.onState(st => {
      root.innerHTML = `<div class="bb-spread"><span class="bb-muted">Each job backs up a container, compose stack or folders into a repository on a schedule.</span>
        <button data-act="new"><i class="fa fa-plus"></i> New backup job</button></div>
        ${st.jobs.length ? `<table class="bb-table"><thead><tr><th style="width:40px">On</th><th>Name</th><th>Source</th><th>Repository</th><th>Schedule</th><th>Last result</th><th></th></tr></thead><tbody>
        ${st.jobs.map(j => `<tr>
          <td><input type="checkbox" data-act="toggle" data-id="${j.id}" ${j.enabled ? 'checked' : ''} title="Enable schedule"></td>
          <td><b>${BB.esc(j.name)}</b><div class="bb-small bb-muted bb-mono">${BB.esc(j.prefix || '')}-*</div></td>
          <td>${srcText(j)}</td><td>${BB.esc(BB.repoName(j.repo_id))}</td>
          <td>${BB.esc(j.schedule_text)}<div class="bb-small bb-muted">${j.next_run ? 'next ' + BB.ago(j.next_run) : ''}</div></td>
          <td>${BB.badge(j.last && j.last.status, j.running)}<div class="bb-small bb-muted">${j.running ? BB.esc(j.running.step) : j.last ? BB.ago(j.last.ended) : ''}</div></td>
          <td class="bb-actions">
            ${j.running ? `<button data-act="log" data-id="${j.id}" data-log="${BB.esc(j.running.log)}">Live log</button><button class="bb-danger" data-act="cancel" data-id="${j.id}">Cancel</button>`
              : `<button data-act="run" data-id="${j.id}">Run</button>`}
            <button data-act="edit" data-id="${j.id}">Edit</button>
            <button class="bb-link" data-act="history" data-id="${j.id}">history</button>
            <button class="bb-link bb-danger" data-act="delete" data-id="${j.id}" ${j.running ? 'disabled' : ''}>delete</button></td></tr>`).join('')}
        </tbody></table>` : `<div class="bb-empty">No jobs yet.<br><br><button data-act="new"><i class="fa fa-plus"></i> Create your first backup job</button></div>`}`;
    });
  };

  /** History dialog for a job/test. */
  function showHistory(kind, ref, name) {
    const m = BB.modal({ title: 'History – ' + BB.esc(name), wide: true, body: '<span class="bb-spin"></span> Loading…' });
    BB.api('history', { kind, ref }).then(r => {
      m.body.innerHTML = r.history.length ? `<table class="bb-table"><thead><tr><th>Started</th><th>Result</th><th>Duration</th><th>Archive</th><th></th></tr></thead><tbody>
        ${r.history.map(h => `<tr><td>${BB.time(h.started)}</td><td>${BB.badge(h.status)} <span class="bb-small bb-muted">${BB.esc(h.message || '')}</span></td>
          <td>${BB.dur(h.ended - h.started)}</td><td class="bb-mono bb-small">${BB.esc(h.archive || '')}</td>
          <td class="bb-actions"><button class="bb-link" data-log="${BB.esc(h.log)}">log</button></td></tr>`).join('')}</tbody></table>` : '<div class="bb-empty">No runs yet.</div>';
      m.body.onclick = e => { const b = e.target.closest('[data-log]'); if (b) BB.showLog(b.dataset.log, name); };
    }).catch(e => m.body.textContent = e.message);
  }
  BB.showHistory = showHistory;

  /* --------------------------- Repositories ---------------------------- */
  BB.pages.repos = (root) => {
    root.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const d = b.dataset, repo = BB.state.repos.find(r => r.id === d.id);
      switch (d.act) {
        case 'add': BB.repoDialog(); break;
        case 'edit': BB.repoDialog(repo); break;
        case 'refresh': BB.busy(b, () => BB.api('repo_refresh', { id: d.id })).then(r => { if (!r.info.ok) BB.toast(r.info.error, 'err'); BB.refresh(); }); break;
        case 'browse': BB.restoreRepo = d.id; BB.gotoTab('Restore'); BB.pages.restoreSelect && BB.pages.restoreSelect(d.id); break;
        case 'key': {
          const r = await BB.busy(b, () => BB.api('repo_key', { id: d.id })).catch(() => null);
          if (r) BB.modal({ title: 'Repository key – ' + BB.esc(repo.name), wide: true,
            body: `<div class="bb-note warn">Store this key <b>and</b> the passphrase somewhere safe outside this server. If the repository key is damaged or you use keyfile mode and lose the flash drive, this is the only way back in.</div><pre class="bb-log" style="min-height:0">${BB.esc(r.key || '(repository is not encrypted)')}</pre>` });
          break;
        }
        case 'delete':
          if (await BB.confirm('Remove repository', `Remove <b>${BB.esc(repo.name)}</b> from the plugin?<br><br>The repository data at <code>${BB.esc(repo.location)}</code> is <b>not</b> deleted.`, 'Remove', true))
            BB.busy(b, () => BB.api('repo_delete', { id: d.id })).then(() => { BB.toast('Repository removed'); BB.refresh(); });
          break;
      }
    });
    BB.onState(st => {
      root.innerHTML = `<div class="bb-spread"><span class="bb-muted">Repositories are where Borg stores deduplicated, encrypted archives – local folders or remote SSH targets.</span>
        <button data-act="add"><i class="fa fa-plus"></i> Add repository</button></div>
        ${st.repos.length ? `<table class="bb-table"><thead><tr><th>Name</th><th>Location</th><th>Archives</th><th>Original</th><th>Stored</th><th>Last archive</th><th></th></tr></thead><tbody>
        ${st.repos.map(r => { const i = r.info || {}; const used = st.jobs.filter(j => j.repo_id === r.id).length; return `<tr>
          <td><b>${BB.esc(r.name)}</b><div class="bb-small bb-muted">${BB.esc(r.encryption)} · ${used} job${used === 1 ? '' : 's'}</div></td>
          <td class="bb-mono bb-small">${BB.esc(r.location)}${i.ok === false ? `<div class="bb-small" style="color:var(--bb-err)">${BB.esc(i.error)}</div>` : ''}</td>
          <td>${i.ok ? i.archives : '-'}</td><td>${i.ok ? BB.size(i.original) : '-'}</td><td>${i.ok ? BB.size(i.deduplicated) : '-'}</td>
          <td>${i.last_time ? BB.ago(i.last_time) : '-'}<div class="bb-small bb-muted">checked ${BB.ago(i.checked)}</div></td>
          <td class="bb-actions"><button data-act="browse" data-id="${r.id}">Browse</button><button data-act="refresh" data-id="${r.id}">Refresh</button>
            <button class="bb-link" data-act="key" data-id="${r.id}">export key</button><button class="bb-link" data-act="edit" data-id="${r.id}">edit</button>
            <button class="bb-link bb-danger" data-act="delete" data-id="${r.id}">remove</button></td></tr>`; }).join('')}
        </tbody></table>` : '<div class="bb-empty">No repositories yet. Add one here or create it while setting up a backup job.</div>'}`;
    });
  };

  /* ------------------------------ Restore ------------------------------ */
  BB.pages.restore = (root) => {
    const S = { repo: null, archives: [], archive: null, path: '', entries: [], selected: new Set(), loading: false };
    root.innerHTML = `<div class="bb-form" style="margin-bottom:14px"><label>Repository</label><select data-k="repo"></select></div>
      <div data-part="archives"></div><div data-part="browser"></div><div data-part="history"></div>`;
    const sel = root.querySelector('[data-k=repo]');
    const partA = root.querySelector('[data-part=archives]'), partB = root.querySelector('[data-part=browser]'), partH = root.querySelector('[data-part=history]');
    const jobForArchive = a => BB.state.jobs.find(j => j.repo_id === S.repo && j.prefix && a.startsWith(j.prefix + '-') && /^\d{4}-/.test(a.slice(j.prefix.length + 1)));

    async function loadArchives() {
      S.archive = null; partB.innerHTML = '';
      if (!S.repo) { partA.innerHTML = ''; return; }
      partA.innerHTML = '<span class="bb-spin"></span> Loading archives…';
      try {
        S.archives = (await BB.api('archives', { id: S.repo })).archives;
        renderArchives();
      } catch (e) { partA.innerHTML = `<div class="bb-note err">${BB.esc(e.message)}</div>`; }
    }
    function renderArchives() {
      partA.innerHTML = S.archives.length ? `<div class="bb-h">Archives (${S.archives.length})</div><div class="bb-list" style="max-height:260px">
        ${S.archives.map(a => { const j = jobForArchive(a.name); return `<div data-arch="${BB.esc(a.name)}" class="${a.name === S.archive ? 'on' : ''}">
          <i class="fa fa-archive"></i><span class="bb-mono" style="flex:1">${BB.esc(a.name)}</span>
          <span class="bb-small bb-muted">${j ? BB.esc(j.name) + ' · ' : ''}${BB.time(a.time)}</span>
          <button class="bb-link bb-danger" data-del="${BB.esc(a.name)}" title="Delete archive">delete</button></div>`; }).join('')}</div>`
        : '<div class="bb-empty">This repository has no archives yet.</div>';
    }
    async function browse(path) {
      S.path = path;
      partB.innerHTML = '<span class="bb-spin"></span> Reading archive (the first open of a large archive can take a while)…';
      try {
        S.entries = (await BB.api('archive_browse', { repo: S.repo, archive: S.archive, path })).entries;
        renderBrowser();
      } catch (e) { partB.innerHTML = `<div class="bb-note err">${BB.esc(e.message)}</div>`; }
    }
    function renderBrowser() {
      const parts = S.path ? S.path.split('/') : [];
      const job = jobForArchive(S.archive);
      const stopNames = job && job.stop.enabled ? (job.source.type === 'container' ? [job.source.name] : job.source.type === 'compose' ? ['all containers of ' + job.source.name] : job.stop.containers) : [];
      const def = (BB.settings && BB.settings.restore_dir || '/mnt/user/borg-restore') + '/' + S.archive.replace(/[:]/g, '-');
      partB.innerHTML = `<div class="bb-h">Browse <span class="bb-mono">${BB.esc(S.archive)}</span></div>
        <div class="bb-crumbs bb-mono" style="margin-bottom:6px"><span data-path="">archive</span>${parts.map((p, i) => ` / <span data-path="${BB.esc(parts.slice(0, i + 1).join('/'))}">${BB.esc(p)}</span>`).join('')}</div>
        <div class="bb-list" style="max-height:340px">${S.path ? '<div data-path="' + BB.esc(parts.slice(0, -1).join('/')) + '"><i class="fa fa-level-up"></i> ..</div>' : ''}
        ${S.entries.map(e => { const full = (S.path ? S.path + '/' : '') + e.name; return `<div ${e.dir ? `data-path="${BB.esc(full)}"` : ''}>
          <input type="checkbox" data-pick="${BB.esc(full)}" ${S.selected.has(full) ? 'checked' : ''}>
          <i class="fa ${e.dir ? 'fa-folder' : 'fa-file-o'}"></i><span style="flex:1">${BB.esc(e.name)}</span>
          <span class="bb-small bb-muted">${e.dir ? '' : BB.size(e.size)}</span></div>`; }).join('') || '<div class="bb-muted">Empty</div>'}</div>
        <div class="bb-h">Restore</div>
        <div class="bb-form">
          <label>What</label><div data-what></div>
          <label>Destination</label><div><label style="font-weight:normal"><input type="radio" name="bb-rmode" value="dir" checked> Restore into folder</label>
            <label style="font-weight:normal;margin-left:14px"><input type="radio" name="bb-rmode" value="original"> Original location (overwrite)</label></div>
          <label data-dest>Folder</label><input data-dest type="text" class="bb-mono" data-k="dest" value="${BB.esc(def)}">
          <div class="bb-help" data-dest>Files keep their full path below this folder, e.g. <code>…/mnt/user/appdata/app</code>.</div>
          ${stopNames.length ? `<label>Containers</label><label style="font-weight:normal"><input type="checkbox" data-k="stop" checked> Stop ${BB.esc(stopNames.join(', '))} while restoring</label>` : ''}
          <label></label><div><button data-restore><i class="fa fa-history"></i> Start restore</button></div>
        </div>`;
      const upd = () => { const orig = partB.querySelector('[name=bb-rmode]:checked').value === 'original'; partB.querySelectorAll('[data-dest]').forEach(x => x.style.display = orig ? 'none' : ''); };
      partB.querySelectorAll('[name=bb-rmode]').forEach(r => r.onchange = upd);
      renderWhat();
    }
    function renderWhat() {
      const w = partB.querySelector('[data-what]'); if (!w) return;
      w.innerHTML = S.selected.size
        ? `${S.selected.size} selected item(s): <span class="bb-mono bb-small">${[...S.selected].slice(0, 5).map(BB.esc).join(', ')}${S.selected.size > 5 ? ' …' : ''}</span> <button class="bb-link" data-clear>clear</button>`
        : '<b>Entire archive</b> <span class="bb-muted">(tick items above to restore only those)</span>';
    }
    partA.addEventListener('click', async e => {
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        if (await BB.confirm('Delete archive', `Permanently delete <code>${BB.esc(del.dataset.del)}</code>? This cannot be undone.`, 'Delete archive', true)) {
          await BB.busy(del, () => BB.api('archive_delete', { repo: S.repo, archive: del.dataset.del })).catch(() => null);
          loadArchives(); BB.refresh();
        }
        return;
      }
      const row = e.target.closest('[data-arch]');
      if (row) { S.archive = row.dataset.arch; S.selected.clear(); renderArchives(); browse(''); }
    });
    partB.addEventListener('click', async e => {
      if (e.target.matches('[data-pick]')) {
        const p = e.target.dataset.pick; e.target.checked ? S.selected.add(p) : S.selected.delete(p);
        renderWhat(); return;
      }
      if (e.target.closest('[data-clear]')) {
        S.selected.clear(); partB.querySelectorAll('[data-pick]').forEach(c => c.checked = false); renderWhat(); return;
      }
      const nav = e.target.closest('[data-path]');
      if (nav && !e.target.matches('input')) { browse(nav.dataset.path); return; }
      const go = e.target.closest('[data-restore]');
      if (go) {
        const mode = partB.querySelector('[name=bb-rmode]:checked').value;
        const dest = partB.querySelector('[data-k=dest]').value.trim();
        const stopBox = partB.querySelector('[data-k=stop]');
        const job = jobForArchive(S.archive);
        let stop = [];
        if (stopBox && stopBox.checked && job) {
          if (job.source.type === 'container') stop = [job.source.name];
          else if (job.source.type === 'compose') stop = (await BB.api('stacks')).stacks.filter(s => s.project === job.source.name).flatMap(s => s.containers.map(c => c.name));
          else stop = job.stop.containers;
        }
        const what = S.selected.size ? `${S.selected.size} item(s)` : 'the <b>entire archive</b>';
        const where = mode === 'original' ? '<b>their original location, overwriting existing files</b>' : `<code>${BB.esc(dest)}</code>`;
        if (!await BB.confirm('Start restore', `Restore ${what} from <code>${BB.esc(S.archive)}</code> to ${where}?`, 'Restore', mode === 'original')) return;
        const r = await BB.busy(go, () => BB.api('restore', { repo: S.repo, archive: S.archive, paths: [...S.selected], mode, dest, stop })).catch(() => null);
        if (r) { BB.toast('Restore started'); setTimeout(BB.refresh, 800); setTimeout(() => {
          const t = (BB.state.tasks || []).find(t => t.key === 'restore-' + r.id); if (t) BB.showLog(t.log, t.label); }, 1500); }
      }
    });
    sel.onchange = () => { S.repo = sel.value || null; loadArchives(); };
    BB.pages.restoreSelect = id => { sel.value = id; S.repo = id; loadArchives(); };
    BB.api('settings').then(r => BB.settings = r.settings).catch(() => {});
    let lastRepos = '';
    BB.onState(st => {
      const key = st.repos.map(r => r.id + r.name).join();
      if (key !== lastRepos) {
        lastRepos = key;
        sel.innerHTML = '<option value="">– choose a repository –</option>' + st.repos.map(r => `<option value="${r.id}" ${r.id === S.repo ? 'selected' : ''}>${BB.esc(r.name)}</option>`).join('');
      }
      const rs = st.history.filter(h => h.kind === 'restore').slice(0, 10);
      const running = st.tasks.filter(t => t.kind === 'restore');
      partH.innerHTML = (running.length || rs.length) ? `<div class="bb-h">Restore activity</div><table class="bb-table"><tbody>
        ${running.map(t => `<tr><td>${BB.ago(t.started)}</td><td>${BB.esc(t.label)}</td><td>${BB.badge(null, true)} <span class="bb-small bb-muted">${BB.esc(t.step)}</span></td>
          <td class="bb-actions"><button class="bb-link" data-log="${BB.esc(t.log)}">log</button></td></tr>`).join('')}
        ${rs.map(h => `<tr><td>${BB.ago(h.ended)}</td><td>${BB.esc(h.name)}</td><td>${BB.badge(h.status)} <span class="bb-small bb-muted">${BB.esc(h.message || '')}</span></td>
          <td class="bb-actions"><button class="bb-link" data-log="${BB.esc(h.log)}">log</button></td></tr>`).join('')}</tbody></table>` : '';
    });
    partH.addEventListener('click', e => { const b = e.target.closest('[data-log]'); if (b) BB.showLog(b.dataset.log, 'Restore'); });
  };

  /* ------------------------------- Tests ------------------------------- */
  const TEST_TYPES = {
    check: ['Consistency check', 'borg check – verifies repository structure and archive metadata. Fast.'],
    extract: ['Test restore (latest archive)', 'Extracts the newest archive in dry-run mode: every chunk is read, decrypted and checksummed, nothing is written.'],
    verify: ['Full data verification', 'borg check --verify-data – reads and verifies every chunk in the repository. Slow on large repos.'],
  };
  function testDialog(test) {
    test = Object.assign({ name: '', type: 'extract', repo_id: (BB.state.repos[0] || {}).id, job_id: '', enabled: true, schedule: { preset: 'weekly', time: '05:00', dow: 0 } }, test || {});
    const m = BB.modal({ title: test.id ? 'Edit test' : 'New test', wide: true, body: `<div class="bb-form">
      <label>Name</label><input type="text" data-k="name" value="${BB.esc(test.name)}" placeholder="e.g. Weekly restore test">
      <label>Repository</label><select data-k="repo_id">${BB.state.repos.map(r => `<option value="${r.id}" ${r.id === test.repo_id ? 'selected' : ''}>${BB.esc(r.name)}</option>`).join('')}</select>
      <label>Test type</label><select data-k="type">${Object.entries(TEST_TYPES).map(([k, v]) => `<option value="${k}" ${k === test.type ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
      <div class="bb-help" data-help></div>
      <label data-job>Archive of job</label><select data-k="job_id" data-job><option value="">Newest archive of any job</option></select>
      <label>Enabled</label><label style="font-weight:normal"><input type="checkbox" data-k="enabled" ${test.enabled ? 'checked' : ''}> Run on schedule</label>
      </div><div class="bb-h">Schedule</div><div data-sched></div>` });
    const q = s => m.body.querySelector(s);
    const getSched = BB.scheduleEditor(q('[data-sched]'), test.schedule);
    const fillJobs = () => { q('[data-k=job_id]').innerHTML = '<option value="">Newest archive of any job</option>' + BB.state.jobs.filter(j => j.repo_id === q('[data-k=repo_id]').value)
      .map(j => `<option value="${j.id}" ${j.id === test.job_id ? 'selected' : ''}>${BB.esc(j.name)}</option>`).join(''); };
    const upd = () => { const t = q('[data-k=type]').value; q('[data-help]').textContent = TEST_TYPES[t][1]; m.body.querySelectorAll('[data-job]').forEach(x => x.style.display = t === 'extract' ? '' : 'none'); };
    q('[data-k=type]').onchange = upd; q('[data-k=repo_id]').onchange = fillJobs; fillJobs(); upd();
    m.setButtons([{ label: 'Cancel' }, { label: 'Save', click: (mm, b) => {
      const data = { id: test.id, name: q('[data-k=name]').value, repo_id: q('[data-k=repo_id]').value, type: q('[data-k=type]').value,
        job_id: q('[data-k=job_id]').value, enabled: q('[data-k=enabled]').checked, schedule: getSched() };
      BB.busy(b, () => BB.api('test_save', { test: data })).then(() => { m.close(); BB.toast('Test saved'); BB.refresh(); }).catch(() => {});
    } }]);
  }
  BB.pages.tests = (root) => {
    root.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const d = b.dataset, t = BB.state.tests.find(x => x.id === d.id);
      if (d.act === 'new') { if (!BB.state.repos.length) return BB.toast('Add a repository first', 'err'); testDialog(); }
      if (d.act === 'edit') testDialog(t);
      if (d.act === 'run') BB.busy(b, () => BB.api('test_run', { id: d.id })).then(() => { BB.toast('Test started'); BB.refresh(); });
      if (d.act === 'cancel') BB.busy(b, () => BB.api('cancel', { key: 'test-' + d.id })).then(BB.refresh);
      if (d.act === 'log') BB.showLog(d.log, t.name);
      if (d.act === 'history') showHistory('test', d.id, t.name);
      if (d.act === 'delete' && await BB.confirm('Delete test', `Delete <b>${BB.esc(t.name)}</b>?`, 'Delete', true))
        BB.busy(b, () => BB.api('test_delete', { id: d.id })).then(BB.refresh);
    });
    BB.onState(st => {
      root.innerHTML = `<div class="bb-spread"><span class="bb-muted">A backup you have never restored is a hope, not a backup. Schedule regular checks and test restores.</span>
        <button data-act="new"><i class="fa fa-plus"></i> New test</button></div>
        ${st.tests.length ? `<table class="bb-table"><thead><tr><th>Name</th><th>Type</th><th>Repository</th><th>Schedule</th><th>Last result</th><th></th></tr></thead><tbody>
          ${st.tests.map(t => `<tr><td><b>${BB.esc(t.name)}</b>${t.enabled ? '' : ' <span class="bb-small bb-muted">(disabled)</span>'}</td>
            <td>${BB.esc(TEST_TYPES[t.type][0])}</td><td>${BB.esc(BB.repoName(t.repo_id))}</td>
            <td>${BB.esc(t.schedule_text)}<div class="bb-small bb-muted">${t.next_run ? 'next ' + BB.ago(t.next_run) : ''}</div></td>
            <td>${BB.badge(t.last && t.last.status, t.running)}<div class="bb-small bb-muted">${t.running ? BB.esc(t.running.step) : t.last ? BB.ago(t.last.ended) + (t.last.archive ? ' · ' + BB.esc(t.last.archive) : '') : ''}</div></td>
            <td class="bb-actions">${t.running ? `<button data-act="log" data-id="${t.id}" data-log="${BB.esc(t.running.log)}">Live log</button><button class="bb-danger" data-act="cancel" data-id="${t.id}">Cancel</button>`
              : `<button data-act="run" data-id="${t.id}">Run</button>`}
              <button data-act="edit" data-id="${t.id}">Edit</button>
              ${t.last ? `<button class="bb-link" data-act="log" data-id="${t.id}" data-log="${BB.esc(t.last.log)}">log</button>` : ''}
              <button class="bb-link" data-act="history" data-id="${t.id}">history</button>
              <button class="bb-link bb-danger" data-act="delete" data-id="${t.id}">delete</button></td></tr>`).join('')}
        </tbody></table>` : `<div class="bb-empty">No tests yet. ${st.repos.length ? '<br><br><button data-act="new"><i class="fa fa-plus"></i> Create a test</button>' : 'Add a repository first.'}</div>`}
        <div class="bb-h">Test types</div><div class="bb-kv">${Object.values(TEST_TYPES).map(v => `<div>${v[0]}</div><div>${v[1]}</div>`).join('')}</div>`;
    });
  };

  /* ------------------------------ Scripts ------------------------------ */
  const TEMPLATES = {
    'Empty': '#!/bin/bash\n# Describe what this script does\nset -e\n\n',
    'Dump MariaDB/MySQL container': '#!/bin/bash\n# Dump all databases of a MariaDB container before the backup\nset -euo pipefail\nCONTAINER=mariadb\nOUT=/mnt/user/appdata/mariadb-dumps\nmkdir -p "$OUT"\ndocker exec "$CONTAINER" sh -c \'exec mariadb-dump --all-databases -uroot -p"$MYSQL_ROOT_PASSWORD"\' | gzip > "$OUT/all-databases.sql.gz"\necho "Dump written to $OUT"\n',
    'Dump PostgreSQL container': '#!/bin/bash\n# Dump all databases of a PostgreSQL container before the backup\nset -euo pipefail\nCONTAINER=postgres\nOUT=/mnt/user/appdata/postgres-dumps\nmkdir -p "$OUT"\ndocker exec "$CONTAINER" pg_dumpall -U postgres | gzip > "$OUT/all.sql.gz"\necho "Dump written to $OUT"\n',
    'Ping healthchecks.io': '#!/bin/bash\n# Report the job result to healthchecks.io (use as post-backup script)\nURL="https://hc-ping.com/your-uuid"\nif [ "$BORG_JOB_STATUS" = "ok" ] || [ "$BORG_JOB_STATUS" = "warning" ]; then\n  curl -fsS -m 10 --retry 3 "$URL" >/dev/null\nelse\n  curl -fsS -m 10 --retry 3 "$URL/fail" >/dev/null\nfi\n',
  };
  BB.pages.scripts = (root) => {
    let current = null;
    root.innerHTML = `<div class="bb-split"><div><div class="bb-spread"><b>Library</b><button data-act="new"><i class="fa fa-plus"></i> New</button></div><div class="bb-list" data-list></div></div>
      <div data-editor><div class="bb-empty">Select a script or create a new one.</div></div></div>
      <div class="bb-h">Environment available to scripts</div><div class="bb-kv bb-small">
        <div class="bb-mono">BORG_PHASE</div><div><code>pre</code> or <code>post</code></div>
        <div class="bb-mono">BORG_JOB_ID / BORG_JOB_NAME</div><div>The job running the script</div>
        <div class="bb-mono">BORG_JOB_SOURCE</div><div>e.g. <code>container:plex</code>, <code>compose:immich</code>, <code>custom:</code></div>
        <div class="bb-mono">BORG_REPO_NAME / BORG_REPO_LOCATION</div><div>Target repository</div>
        <div class="bb-mono">BORG_JOB_STATUS</div><div>Post scripts only: <code>ok</code>, <code>warning</code>, <code>failed</code> or <code>cancelled</code></div>
        <div class="bb-mono">BORG_ARCHIVE</div><div>Post scripts only: name of the archive created (empty on failure)</div>
      </div><p class="bb-small bb-muted">Pre-backup scripts run before containers are stopped (so database dumps work); a non-zero exit aborts the backup unless disabled in the job. Post-backup scripts always run, after containers are started again.</p>`;
    const list = root.querySelector('[data-list]'), ed = root.querySelector('[data-editor]');
    const renderList = scripts => {
      list.innerHTML = scripts.length ? scripts.map(s => `<div data-name="${BB.esc(s.name)}" class="${s.name === current ? 'on' : ''}"><i class="fa fa-file-code-o"></i>
        <div style="min-width:0"><div class="bb-mono">${BB.esc(s.name)}</div><div class="bb-small bb-muted">${BB.esc(s.description)}</div></div></div>`).join('')
        : '<div class="bb-muted">No scripts yet</div>';
    };
    const openEditor = (name, content, isNew) => {
      current = isNew ? null : name;
      const used = isNew ? [] : BB.state.jobs.filter(j => (j.pre.type === 'script' && j.pre.script === name) || (j.post.type === 'script' && j.post.script === name));
      ed.innerHTML = `<div class="bb-row" style="margin-bottom:8px"><input type="text" class="bb-mono" data-k="name" value="${BB.esc(name)}" style="max-width:280px">
        ${isNew ? `<select data-k="tpl">${Object.keys(TEMPLATES).map(t => `<option>${BB.esc(t)}</option>`).join('')}</select>` : ''}
        <span class="bb-muted bb-small">${used.length ? 'Used by: ' + used.map(j => BB.esc(j.name)).join(', ') : ''}</span></div>
        <textarea data-k="content" rows="20" spellcheck="false">${BB.esc(content)}</textarea>
        <div class="bb-row" style="margin-top:8px"><button data-act="save">Save</button>${isNew ? '' : '<button data-act="test">Test run</button><button class="bb-danger" data-act="delete">Delete</button>'}</div>
        <pre class="bb-log" data-out style="display:none;margin-top:10px;min-height:0"></pre>`;
      const tpl = ed.querySelector('[data-k=tpl]');
      if (tpl) tpl.onchange = () => ed.querySelector('[data-k=content]').value = TEMPLATES[tpl.value];
      ed.dataset.old = isNew ? '' : name;
      renderList((BB.state && BB.state.scripts) || []);
    };
    list.onclick = e => {
      const d = e.target.closest('[data-name]'); if (!d) return;
      BB.api('script_get', { name: d.dataset.name }).then(r => openEditor(r.name, r.content, false)).catch(BB.err);
    };
    root.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const name = (ed.querySelector('[data-k=name]') || {}).value;
      if (b.dataset.act === 'new') openEditor('my-script.sh', TEMPLATES.Empty, true);
      if (b.dataset.act === 'save') {
        const r = await BB.busy(b, () => BB.api('script_save', { name, old: ed.dataset.old, content: ed.querySelector('[data-k=content]').value })).catch(() => null);
        if (r) { BB.state.scripts = r.scripts; current = name; ed.dataset.old = name; BB.toast('Script saved'); openEditor(name, ed.querySelector('[data-k=content]').value, false); BB.refresh(); }
      }
      if (b.dataset.act === 'delete' && await BB.confirm('Delete script', `Delete <code>${BB.esc(name)}</code>?`, 'Delete', true)) {
        const r = await BB.busy(b, () => BB.api('script_delete', { name })).catch(() => null);
        if (r) { current = null; ed.innerHTML = '<div class="bb-empty">Script deleted.</div>'; renderList(r.scripts); BB.refresh(); }
      }
      if (b.dataset.act === 'test') {
        if (!await BB.confirm('Test run', `Run <code>${BB.esc(name)}</code> now as root (max. 2 minutes)? Save first if you made changes.`, 'Run')) return;
        const r = await BB.busy(b, () => BB.api('script_test', { name })).catch(() => null);
        if (r) { const o = ed.querySelector('[data-out]'); o.style.display = ''; o.textContent = `exit code ${r.rc}\n\n${r.output || '(no output)'}`; }
      }
    });
    BB.onState(st => renderList(st.scripts));
  };

  /* ------------------------------ Settings ----------------------------- */
  BB.pages.settings = (root) => {
    root.innerHTML = '<span class="bb-spin"></span> Loading…';
    const render = r => {
      const s = r.settings;
      root.innerHTML = `
        ${r.borg_version ? `<div class="bb-note">${BB.esc(r.borg_version)} <span class="bb-muted bb-mono bb-small">(${BB.esc(r.borg_bin)})</span></div>`
          : `<div class="bb-note err">Borg was not found at <code>${BB.esc(r.borg_bin)}</code>. Reinstall the plugin or set the path below.</div>`}
        <div class="bb-h">General</div><div class="bb-form">
          <label>Borg binary</label><input type="text" class="bb-mono" data-k="borg_bin" value="${BB.esc(s.borg_bin)}" placeholder="auto (/usr/local/bin/borg)">
          <label>Cache folder</label><input type="text" class="bb-mono" data-k="cache_dir" value="${BB.esc(s.cache_dir)}">
          <div class="bb-help">Borg's file/chunk cache – keep it off the flash drive. Currently used: <code>${BB.esc(r.cache_effective)}</code></div>
          <label>Log folder</label><input type="text" class="bb-mono" data-k="log_dir" value="${BB.esc(s.log_dir)}">
          <div class="bb-help"><code>/var/log/…</code> is RAM and cleared on reboot. Use e.g. <code>/mnt/user/appdata/borg-backup/logs</code> to keep logs.</div>
          <label>Logs kept per job</label><input type="number" min="5" data-k="log_keep" value="${+s.log_keep}">
          <label>Default restore folder</label><input type="text" class="bb-mono" data-k="restore_dir" value="${BB.esc(s.restore_dir)}">
          <label>Default compression</label><select data-k="compression">${['lz4', 'zstd,3', 'zstd,6', 'zstd,10', 'zlib,6', 'lzma,6', 'none'].map(c => `<option ${c === s.compression ? 'selected' : ''}>${c}</option>`).join('')}</select>
          <label>Lock wait (seconds)</label><input type="number" min="1" data-k="lock_wait" value="${+s.lock_wait}">
          <div class="bb-help">How long a job waits when another job is using the same repository.</div>
        </div>
        <div class="bb-h">Notifications</div><div class="bb-form">
          <label>Unraid notifications</label><div>
            <label style="font-weight:normal"><input type="checkbox" data-k="notify_failure" ${s.notify_failure ? 'checked' : ''}> on failure</label>&nbsp;&nbsp;
            <label style="font-weight:normal"><input type="checkbox" data-k="notify_warning" ${s.notify_warning ? 'checked' : ''}> on warning</label>&nbsp;&nbsp;
            <label style="font-weight:normal"><input type="checkbox" data-k="notify_success" ${s.notify_success ? 'checked' : ''}> on success</label></div>
          <div class="bb-help">Delivered through Settings → Notifications (email, Pushover, Discord, …).</div>
        </div>
        <div class="bb-h">SSH (remote repositories)</div><div class="bb-form">
          <label>Private key</label><input type="text" class="bb-mono" data-k="ssh_key" value="${BB.esc(s.ssh_key)}">
          <label>Public key</label><div>${r.ssh_public_key ? `<textarea rows="3" readonly class="bb-mono">${BB.esc(r.ssh_public_key)}</textarea>
            <div class="bb-small bb-muted">Add this to <code>~/.ssh/authorized_keys</code> on the backup server (Hetzner Storage Box: <code>.ssh/authorized_keys</code>, port 23).</div>`
            : '<button data-act="keygen">Generate SSH key</button> <span class="bb-muted bb-small">No key found at that path.</span>'}</div>
        </div>
        <div class="bb-row" style="margin-top:18px"><button data-act="save">Apply</button></div>`;
    };
    const load = () => BB.api('settings').then(r => { BB.settings = r.settings; render(r); }).catch(e => root.innerHTML = `<div class="bb-note err">${BB.esc(e.message)}</div>`);
    root.addEventListener('click', async e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'keygen') { await BB.busy(b, () => BB.api('ssh_keygen')).catch(() => null); load(); }
      if (b.dataset.act === 'save') {
        const s = {};
        root.querySelectorAll('[data-k]').forEach(x => s[x.dataset.k] = x.type === 'checkbox' ? x.checked : x.value);
        const r = await BB.busy(b, () => BB.api('settings_save', { settings: s })).catch(() => null);
        if (r) { BB.toast('Settings saved'); load(); }
      }
    });
    load();
  };
})();
