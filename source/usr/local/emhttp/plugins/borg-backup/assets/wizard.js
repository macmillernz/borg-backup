/* Borg Backup for Unraid - job wizard (create + edit). */
(function () {
  'use strict';
  const BB = window.BB;
  const esc = s => BB.esc(s);
  const STEPS = ['Source', 'Containers', 'Repository', 'Schedule', 'Scripts', 'Review'];

  /** Convert a saved job into wizard state (or defaults for a new job). */
  function initialState(job) {
    if (!job) return {
      id: null, name: '', nameTouched: false, enabled: true, type: null, sourceName: '', paths: [], excludes: '',
      stop: { enabled: true, timeout: 60, containers: [] },
      repoMode: BB.state.repos.length ? 'existing' : 'new', repo_id: (BB.state.repos[0] || {}).id || null,
      schedule: { preset: 'daily', time: '03:00' }, retention: { hourly: 0, daily: 7, weekly: 4, monthly: 6, yearly: 0 }, compression: '',
      pre: { type: 'none', script: '', inline: '', abort: true }, post: { type: 'none', script: '', inline: '' },
    };
    return {
      id: job.id, name: job.name, nameTouched: true, enabled: job.enabled, type: job.source.type, sourceName: job.source.name,
      paths: job.source.paths.map(p => Object.assign({ exists: true, saved: true }, p)), excludes: (job.excludes || []).join('\n'),
      stop: Object.assign({ enabled: false, timeout: 60, containers: [] }, job.stop),
      repoMode: 'existing', repo_id: job.repo_id, schedule: job.schedule, retention: job.retention, compression: job.compression || '',
      pre: Object.assign({ type: 'none', script: '', inline: '', abort: true }, job.pre), post: Object.assign({ type: 'none', script: '', inline: '' }, job.post),
    };
  }

  BB.wizard = {
    open(job) {
      const W = initialState(job);
      const cache = {};
      let step = 0, maxStep = job ? STEPS.length - 1 : 0, readStep = null;
      const m = BB.modal({ title: job ? 'Edit backup job' : 'New backup job', wide: true, body: '<div class="bb-steps"></div><div data-step></div>' });
      const stepsEl = m.body.querySelector('.bb-steps'), body = m.body.querySelector('[data-step]');

      stepsEl.onclick = e => {
        const i = [...stepsEl.children].indexOf(e.target.closest('div'));
        if (i >= 0 && i <= maxStep && i !== step) { if (readStep) readStep(); go(i); }
      };

      function go(i) {
        step = i; maxStep = Math.max(maxStep, i);
        stepsEl.innerHTML = STEPS.map((s, k) => `<div class="${k === step ? 'on' : k <= maxStep ? 'done' : ''}" style="${k <= maxStep ? 'cursor:pointer' : ''}">${k + 1}. ${s}</div>`).join('');
        readStep = null;
        [stepSource, stepStop, stepRepo, stepSchedule, stepScripts, stepReview][i]();
        const last = i === STEPS.length - 1;
        m.setButtons([
          { label: 'Cancel', left: true },
          ...(i > 0 ? [{ label: '<i class="fa fa-chevron-left"></i> Back', click: () => { if (readStep) readStep(); go(i - 1); } }] : []),
          ...(last ? [{ label: 'Save', click: (mm, b) => save(b, false) }, { label: '<i class="fa fa-play"></i> Save &amp; run now', click: (mm, b) => save(b, true) }]
            : [{ label: 'Next <i class="fa fa-chevron-right"></i>', click: (mm, b) => next(b) }]),
        ]);
        m.body.scrollTop = 0;
      }

      async function next(btn) {
        try {
          if (readStep) readStep();
          await BB.busy(btn, () => validate(step));
          go(step + 1);
        } catch (e) { /* toast already shown */ }
      }

      async function validate(i) {
        if (i === 0) {
          if (!W.type) throw new Error('Choose what to back up');
          if (W.type !== 'custom' && !W.sourceName) throw new Error(W.type === 'container' ? 'Select a container' : 'Select a compose stack');
          if (!W.paths.some(p => p.include)) throw new Error('Tick at least one path to back up');
          if (!W.name.trim()) throw new Error('Enter a job name');
        }
        if (i === 1 && W.type === 'custom' && W.stop.enabled && !W.stop.containers.length) throw new Error('Select the containers to stop, or turn stopping off');
        if (i === 2) {
          if (W.repoMode === 'new') {
            const data = W.repoForm.get();
            const r = await BB.api('repo_save', { repo: data });
            BB.toast('Repository created');
            await BB.refresh();
            W.repo_id = r.repo.id; W.repoMode = 'existing';
          }
          if (!W.repo_id) throw new Error('Select a repository');
        }
        if (i === 4) for (const k of ['pre', 'post']) {
          if (W[k].type === 'script' && !W[k].script) throw new Error(`Choose a library script for the ${k}-backup step`);
          if (W[k].type === 'inline' && !W[k].inline.trim()) throw new Error(`The ${k}-backup script is empty`);
        }
      }

      async function save(btn, run) {
        const payload = {
          id: W.id, name: W.name.trim(), enabled: W.enabled,
          source: { type: W.type, name: W.type === 'custom' ? '' : W.sourceName, paths: W.paths.map(p => ({ path: p.path, include: !!p.include, target: p.target || '', type: p.type || 'bind' })) },
          stop: { enabled: W.stop.enabled, timeout: W.stop.timeout, containers: W.type === 'custom' ? W.stop.containers : [] },
          repo_id: W.repo_id, schedule: W.schedule, retention: W.retention, compression: W.compression,
          excludes: W.excludes.split('\n').map(s => s.trim()).filter(Boolean), pre: W.pre, post: W.post,
        };
        const r = await BB.busy(btn, () => BB.api('job_save', { job: payload, run })).catch(() => null);
        if (!r) return;
        BB.toast(run ? 'Job saved – backup started' : 'Job saved');
        m.close(); BB.refresh();
      }

      /* ---------------------------- Step 1 ---------------------------- */
      function stepSource() {
        const card = (t, icon, title, text) => `<div class="bb-choice ${W.type === t ? 'on' : ''}" data-type="${t}"><b><i class="fa ${icon}"></i>${title}</b><span class="bb-small bb-muted">${text}</span></div>`;
        body.innerHTML = `<div class="bb-choices">
          ${card('container', 'fa-cube', 'Container', 'A Docker container – its mapped paths are detected automatically.')}
          ${card('compose', 'fa-cubes', 'Compose stack', 'A Docker Compose stack – mounts are resolved from the compose file and .env.')}
          ${card('custom', 'fa-folder-open', 'Custom', 'Any folders or files on the server.')}
        </div><div data-src></div>
        <div data-paths></div>
        <div class="bb-form" style="margin-top:14px" data-namerow><label>Job name</label><input type="text" data-k="name" value="${esc(W.name)}" placeholder="e.g. Nextcloud"></div>
        <details style="margin-top:10px" ${W.excludes ? 'open' : ''}><summary class="bb-muted" style="cursor:pointer">Exclude patterns (optional)</summary>
          <textarea data-k="excludes" rows="4" placeholder="One pattern per line, e.g.\n*/cache/*\nsh:**/Transcodes/**\n*.tmp" style="margin-top:6px">${esc(W.excludes)}</textarea>
          <div class="bb-small bb-muted">Borg pattern syntax – folders containing a <code>CACHEDIR.TAG</code> file are skipped automatically.</div></details>`;
        const src = body.querySelector('[data-src]'), pathsEl = body.querySelector('[data-paths]'), nameEl = body.querySelector('[data-k=name]');
        nameEl.oninput = () => { W.name = nameEl.value; W.nameTouched = true; };
        readStep = () => { W.name = nameEl.value; W.excludes = body.querySelector('[data-k=excludes]').value; };
        const setName = n => { if (!W.nameTouched || !W.name) { W.name = n; nameEl.value = n; } };

        body.querySelector('.bb-choices').onclick = e => {
          const c = e.target.closest('[data-type]'); if (!c || c.dataset.type === W.type) return;
          readStep();
          W.type = c.dataset.type; W.sourceName = ''; W.paths = []; W.stop.enabled = W.type !== 'custom'; W.stop.containers = [];
          if (!W.nameTouched) W.name = '';
          stepSource();
        };
        if (W.type === 'container') renderContainers(src, pathsEl, setName);
        if (W.type === 'compose') renderStacks(src, pathsEl, setName);
        if (W.type === 'custom') renderCustom(src, pathsEl);
        if (W.type && W.paths.length) renderPaths(pathsEl);
        body.querySelector('[data-namerow]').style.display = W.type ? '' : 'none';
      }

      /** Merge freshly resolved mounts with saved selections (when editing). */
      function mergeMounts(mounts) {
        const saved = Object.fromEntries(W.paths.map(p => [p.path, p]));
        const editing = W.paths.length > 0;
        // when editing, newly discovered mounts are shown (badge "new") but not ticked automatically
        const merged = mounts.map(mt => saved[mt.path] ? Object.assign({}, mt, { include: saved[mt.path].include })
          : Object.assign(mt, editing ? { fresh: true, include: false } : {}));
        // keep saved paths that are no longer mounted (e.g. container removed) and manual extras
        W.paths.forEach(p => { if (!merged.find(x => x.path === p.path)) merged.push(Object.assign({}, p, { origin: p.origin || 'saved' })); });
        W.paths = merged;
      }

      async function renderContainers(src, pathsEl, setName) {
        src.innerHTML = '<span class="bb-spin"></span> Loading containers…';
        try { cache.containers = cache.containers || (await BB.api('containers')).containers; } catch (e) { src.innerHTML = `<div class="bb-note err">${esc(e.message)}</div>`; return; }
        const list = cache.containers;
        if (!list.length) { src.innerHTML = '<div class="bb-note warn">No containers found. Is the Docker service running?</div>'; return; }
        src.innerHTML = `<input type="text" data-k="filter" placeholder="Filter containers…" style="width:100%;margin-bottom:6px"><div class="bb-list" style="max-height:220px">
          ${list.map(c => `<div data-name="${esc(c.name)}" class="${c.name === W.sourceName ? 'on' : ''}"><i class="fa fa-cube"></i><b style="flex:0 0 auto">${esc(c.name)}</b>
            <span class="bb-small bb-muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.image)}${c.project ? ' · stack ' + esc(c.project) : ''}</span>
            <span class="bb-badge ${c.state === 'running' ? 'ok' : ''}">${esc(c.state)}</span></div>`).join('')}</div>`;
        const listEl = src.querySelector('.bb-list');
        src.querySelector('[data-k=filter]').oninput = e => { const f = e.target.value.toLowerCase(); listEl.querySelectorAll('[data-name]').forEach(r => r.style.display = r.textContent.toLowerCase().includes(f) ? '' : 'none'); };
        const pick = async (name, keep) => {
          listEl.querySelectorAll('[data-name]').forEach(r => r.classList.toggle('on', r.dataset.name === name));
          if (!keep) W.paths = [];
          W.sourceName = name; setName(name);
          pathsEl.innerHTML = '<span class="bb-spin"></span> Resolving mounts…';
          try { mergeMounts((await BB.api('container_mounts', { name })).mounts); renderPaths(pathsEl); }
          catch (e) { pathsEl.innerHTML = `<div class="bb-note err">${esc(e.message)}</div>`; }
        };
        listEl.onclick = e => { const r = e.target.closest('[data-name]'); if (r && r.dataset.name !== W.sourceName) pick(r.dataset.name, false); };
        if (W.sourceName && !W.resolved) { W.resolved = true; pick(W.sourceName, true); }
      }

      async function renderStacks(src, pathsEl, setName) {
        src.innerHTML = '<span class="bb-spin"></span> Looking for compose stacks…';
        try { cache.stacks = cache.stacks || (await BB.api('stacks')).stacks; } catch (e) { src.innerHTML = `<div class="bb-note err">${esc(e.message)}</div>`; return; }
        const list = cache.stacks;
        if (!list.length) { src.innerHTML = '<div class="bb-note warn">No compose stacks found. Stacks from the Compose Manager plugin and any running compose project are detected.</div>'; return; }
        src.innerHTML = `<div class="bb-list" style="max-height:220px">${list.map(s => {
          const up = s.containers.filter(c => c.state === 'running').length;
          return `<div data-name="${esc(s.project)}" class="${s.project === W.sourceName ? 'on' : ''}"><i class="fa fa-cubes"></i><b>${esc(s.name)}</b>
            <span class="bb-small bb-muted" style="flex:1">${esc(s.source)}${s.files.length ? ' · ' + esc(s.files[0]) : ''}</span>
            <span class="bb-badge ${up ? 'ok' : ''}">${up}/${s.containers.length} running</span></div>`; }).join('')}</div>`;
        const listEl = src.querySelector('.bb-list');
        const pick = async (project, keep) => {
          listEl.querySelectorAll('[data-name]').forEach(r => r.classList.toggle('on', r.dataset.name === project));
          if (!keep) W.paths = [];
          const s = list.find(x => x.project === project);
          W.sourceName = project; setName(s ? s.name : project);
          pathsEl.innerHTML = '<span class="bb-spin"></span> Resolving mounts from compose file…';
          try {
            const r = await BB.api('stack_mounts', { project });
            mergeMounts(r.mounts);
            // offer the stack folder itself (compose file, .env) as an extra path
            if (s && s.dir && !W.paths.find(p => p.path === s.dir)) W.paths.push({ path: s.dir, target: 'compose project folder', type: 'bind', origin: 'stack', exists: true, include: !keep });
            renderPaths(pathsEl, r.error ? `Resolved with ${r.method} because docker compose config failed: ${r.error}` : `Resolved with ${r.method}.`);
          } catch (e) { pathsEl.innerHTML = `<div class="bb-note err">${esc(e.message)}</div>`; }
        };
        listEl.onclick = e => { const r = e.target.closest('[data-name]'); if (r && r.dataset.name !== W.sourceName) pick(r.dataset.name, false); };
        if (W.sourceName && !W.resolved) { W.resolved = true; pick(W.sourceName, true); }
      }

      function renderCustom(src) {
        src.innerHTML = `<div class="bb-row"><input type="text" class="bb-mono" data-k="add" placeholder="/mnt/user/documents" style="flex:1;min-width:240px">
          <button data-add>Add path</button><button data-browse><i class="fa fa-folder-open-o"></i> Browse…</button></div><div data-browser style="margin-top:8px"></div>`;
        const input = src.querySelector('[data-k=add]');
        src.querySelector('[data-add]').onclick = () => addPath(input.value.trim(), () => { input.value = ''; });
        input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); src.querySelector('[data-add]').click(); } };
        src.querySelector('[data-browse]').onclick = () => folderBrowser(src.querySelector('[data-browser]'), input.value.trim() || '/mnt/user', p => addPath(p));
      }

      function addPath(p, done) {
        if (!p || p[0] !== '/') return BB.toast('Enter an absolute path, e.g. /mnt/user/documents', 'err');
        p = p.replace(/\/+$/, '') || '/';
        if (!W.paths.find(x => x.path === p)) W.paths.push({ path: p, target: '', type: 'bind', origin: 'custom', exists: true, include: true });
        renderPaths(body.querySelector('[data-paths]'));
        if (done) done();
      }

      /** Inline folder browser using the API's browse action. */
      async function folderBrowser(el, start, onPick) {
        const load = async path => {
          el.innerHTML = '<span class="bb-spin"></span>';
          let r;
          try { r = await BB.api('browse', { path }); } catch (e) { if (path !== '/mnt') return load('/mnt'); el.textContent = e.message; return; }
          el.innerHTML = `<div class="bb-row bb-small" style="margin-bottom:4px"><b class="bb-mono" style="flex:1">${esc(r.path)}</b>
              <button data-pick="${esc(r.path)}">Add this folder</button><button class="bb-link" data-close>close</button></div>
            <div class="bb-list" style="max-height:230px">${r.parent !== null ? `<div data-go="${esc(r.parent)}"><i class="fa fa-level-up"></i> ..</div>` : ''}
            ${r.dirs.map(d => { const full = (r.path === '/' ? '' : r.path) + '/' + d; return `<div data-go="${esc(full)}"><i class="fa fa-folder"></i><span style="flex:1">${esc(d)}</span>
              <button class="bb-link" data-pick="${esc(full)}">add</button></div>`; }).join('')}
            ${r.files ? `<div class="bb-muted bb-small" style="cursor:default">${r.files} file(s)</div>` : ''}</div>`;
        };
        el.onclick = e => {
          const pk = e.target.closest('[data-pick]'); if (pk) { e.stopPropagation(); onPick(pk.dataset.pick); return; }
          if (e.target.closest('[data-close]')) { el.innerHTML = ''; return; }
          const g = e.target.closest('[data-go]'); if (g) load(g.dataset.go);
        };
        load(start);
      }

      /** Path table with include tickboxes. */
      function renderPaths(el, note) {
        if (!W.paths.length) {
          el.innerHTML = W.type === 'custom' ? '<div class="bb-empty" style="margin-top:10px">Add one or more paths to back up.</div>'
            : `<div class="bb-note warn">${W.type === 'compose' ? 'This stack' : 'This container'} has no host paths mounted. You can still add paths manually below.</div>` + extraRow();
          bindExtra(el); return;
        }
        const ticked = W.paths.filter(p => p.include).length;
        el.innerHTML = `${note ? `<div class="bb-small bb-muted" style="margin:6px 0">${esc(note)}</div>` : ''}
          <div class="bb-spread" style="margin:10px 0 4px"><b>Paths to back up</b><span class="bb-small bb-muted">${ticked} of ${W.paths.length} selected
            · <button class="bb-link" data-all="1">all</button><button class="bb-link" data-all="0">none</button></span></div>
          <table class="bb-table"><thead><tr><th style="width:30px"></th><th>Host path</th>${W.type === 'custom' ? '' : '<th>Mounted at</th><th>From</th>'}<th></th></tr></thead><tbody>
          ${W.paths.map((p, i) => `<tr><td><input type="checkbox" data-i="${i}" ${p.include ? 'checked' : ''}></td>
            <td class="bb-mono">${esc(p.path)} ${p.exists === false ? '<span class="bb-badge warning">missing</span>' : ''} ${p.fresh ? '<span class="bb-badge running">new</span>' : ''}</td>
            ${W.type === 'custom' ? '' : `<td class="bb-mono bb-small">${esc(p.target || '')} ${p.ro ? '<span class="bb-badge">ro</span>' : ''} ${p.type === 'volume' ? '<span class="bb-badge">volume</span>' : ''}</td><td class="bb-small bb-muted">${esc(p.origin || '')}</td>`}
            <td class="bb-actions">${['custom', 'manual', 'saved'].includes(p.origin) ? `<button class="bb-link bb-danger" data-rm="${i}">remove</button>` : ''}</td></tr>`).join('')}
          </tbody></table>
          ${W.type === 'custom' ? '' : extraRow()}
          ${W.type !== 'custom' ? '<div class="bb-small bb-muted">App data folders and Docker volumes are ticked by default; media shares and system paths are not.</div>' : ''}`;
        el.onchange = e => { if (e.target.dataset.i != null) { W.paths[+e.target.dataset.i].include = e.target.checked; renderPaths(el, note); } };
        el.onclick = e => {
          const a = e.target.closest('[data-all]'); if (a) { W.paths.forEach(p => p.include = a.dataset.all === '1'); renderPaths(el, note); }
          const r = e.target.closest('[data-rm]'); if (r) { W.paths.splice(+r.dataset.rm, 1); renderPaths(el, note); }
        };
        bindExtra(el);
      }
      const extraRow = () => `<div class="bb-row" style="margin-top:4px"><input type="text" class="bb-mono" data-extra placeholder="Add another host path (optional)" style="flex:1;min-width:240px"><button data-extra-add>Add</button></div>`;
      function bindExtra(el) {
        const b = el.querySelector('[data-extra-add]'); if (!b) return;
        b.onclick = () => {
          const v = el.querySelector('[data-extra]').value.trim();
          if (!v || v[0] !== '/') return BB.toast('Enter an absolute path', 'err');
          if (!W.paths.find(x => x.path === v)) W.paths.push({ path: v.replace(/\/+$/, ''), target: '', type: 'bind', origin: 'manual', exists: true, include: true });
          renderPaths(el);
        };
      }

      /* ---------------------------- Step 2 ---------------------------- */
      async function stepStop() {
        if (W.type === 'custom') {
          body.innerHTML = `<p>Should any containers be stopped while these folders are backed up? This is useful when the folders hold a database or app data.</p>
            <label style="font-weight:normal"><input type="checkbox" data-k="stop" ${W.stop.enabled ? 'checked' : ''}> Stop containers during the backup</label>
            <div data-list style="margin-top:8px"></div>${timeoutRow()}`;
          const listEl = body.querySelector('[data-list]');
          const renderList = async () => {
            if (!W.stop.enabled) { listEl.innerHTML = ''; return; }
            listEl.innerHTML = '<span class="bb-spin"></span>';
            try { cache.containers = cache.containers || (await BB.api('containers')).containers; } catch (e) { listEl.textContent = e.message; return; }
            listEl.innerHTML = `<div class="bb-list">${cache.containers.map(c => `<div><label><input type="checkbox" data-c="${esc(c.name)}" ${W.stop.containers.includes(c.name) ? 'checked' : ''}>
              <b>${esc(c.name)}</b><span class="bb-small bb-muted" style="flex:1">${esc(c.image)}</span><span class="bb-badge ${c.state === 'running' ? 'ok' : ''}">${esc(c.state)}</span></label></div>`).join('')}</div>`;
          };
          body.querySelector('[data-k=stop]').onchange = e => { W.stop.enabled = e.target.checked; renderList(); };
          readStep = () => {
            W.stop.containers = [...body.querySelectorAll('[data-c]:checked')].map(x => x.dataset.c);
            readTimeout();
          };
          renderList();
          return;
        }
        const what = W.type === 'container' ? `the container <b>${esc(W.sourceName)}</b>` : `all containers of the stack <b>${esc(W.sourceName)}</b>`;
        body.innerHTML = `<p>Should ${what} be stopped while the backup runs?</p>
          <div class="bb-choices">
            <div class="bb-choice ${W.stop.enabled ? 'on' : ''}" data-v="1"><b><i class="fa fa-stop-circle-o"></i>Stop during backup</b><span class="bb-small bb-muted">Recommended. Files and databases are consistent. ${W.type === 'compose' ? 'Containers are stopped in dependency order and' : 'The container is'} started again afterwards – even if the backup fails.</span></div>
            <div class="bb-choice ${W.stop.enabled ? '' : 'on'}" data-v="0"><b><i class="fa fa-play-circle-o"></i>Keep running</b><span class="bb-small bb-muted">No downtime, but files that change during the backup (databases!) may be inconsistent. Use a pre-backup script to dump databases.</span></div>
          </div><div data-who class="bb-small bb-muted"></div>${timeoutRow()}`;
        body.querySelector('.bb-choices').onclick = e => {
          const c = e.target.closest('[data-v]'); if (!c) return;
          W.stop.enabled = c.dataset.v === '1';
          body.querySelectorAll('.bb-choice').forEach(x => x.classList.toggle('on', x === c));
          body.querySelector('[data-timeout]').style.display = W.stop.enabled ? '' : 'none';
        };
        readStep = readTimeout;
        if (W.type === 'compose') {
          const s = (cache.stacks || []).find(x => x.project === W.sourceName);
          if (s) body.querySelector('[data-who]').innerHTML = 'Containers: ' + s.containers.map(c => `${esc(c.name)} (${esc(c.state)})`).join(', ');
        }
      }
      const timeoutRow = () => `<div class="bb-form" data-timeout style="margin-top:12px;${W.stop.enabled ? '' : 'display:none'}"><label>Stop timeout (seconds)</label>
        <input type="number" min="5" max="600" data-k="timeout" value="${+W.stop.timeout || 60}"><div class="bb-help">Time a container gets to shut down cleanly before it is killed.</div></div>`;
      const readTimeout = () => { const t = body.querySelector('[data-k=timeout]'); if (t) W.stop.timeout = +t.value || 60; };

      /* ---------------------------- Step 3 ---------------------------- */
      function stepRepo() {
        const repos = BB.state.repos;
        body.innerHTML = `<div class="bb-seg" data-g="mode"><span data-v="existing" class="${W.repoMode === 'existing' ? 'on' : ''}">Existing repository</span><span data-v="new" class="${W.repoMode === 'new' ? 'on' : ''}">New repository</span></div><div data-part></div>`;
        const part = body.querySelector('[data-part]');
        const render = () => {
          if (W.repoMode === 'existing') {
            part.innerHTML = repos.length ? `<div class="bb-list">${repos.map(r => { const i = r.info || {}; return `<div data-id="${r.id}" class="${r.id === W.repo_id ? 'on' : ''}">
              <i class="fa fa-database"></i><div style="flex:1;min-width:0"><b>${esc(r.name)}</b><div class="bb-small bb-muted bb-mono">${esc(r.location)}</div></div>
              <span class="bb-small bb-muted">${i.ok ? `${i.archives} archives · ${BB.size(i.deduplicated)}` : i.ok === false ? '<span style="color:var(--bb-err)">unreachable</span>' : ''}</span></div>`; }).join('')}</div>`
              : '<div class="bb-empty">No repositories yet – create a new one.</div>';
            part.onclick = e => { const d = e.target.closest('[data-id]'); if (!d) return; W.repo_id = d.dataset.id; part.querySelectorAll('[data-id]').forEach(x => x.classList.toggle('on', x === d)); };
            W.repoForm = null;
          } else {
            part.innerHTML = '<div></div><p class="bb-small bb-muted">The repository is initialised (or opened) when you click Next.</p>';
            part.onclick = null;
            W.repoForm = BB.repoForm(part.firstChild, { name: '' });
          }
        };
        body.querySelector('.bb-seg').onclick = e => {
          const s = e.target.closest('span'); if (!s) return;
          W.repoMode = s.dataset.v; body.querySelectorAll('.bb-seg span').forEach(x => x.classList.toggle('on', x === s)); render();
        };
        render();
      }

      /* ---------------------------- Step 4 ---------------------------- */
      function stepSchedule() {
        const r = W.retention;
        body.innerHTML = `<div data-sched></div>
          <div class="bb-h">Keep archives</div>
          <div class="bb-row">${[['hourly', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']].map(([k, t]) =>
            `<label style="font-weight:normal">${t} <input type="number" min="0" max="1000" data-ret="${k}" value="${+r[k] || 0}" style="width:70px"></label>`).join('')}</div>
          <div class="bb-small bb-muted" style="margin-top:4px">After each backup, older archives of this job are pruned (0 = don't keep by that rule; all zero = keep everything) and the repository is compacted.</div>
          <div class="bb-h">Compression</div>
          <select data-k="compression"><option value="">Default from settings</option>${['lz4', 'zstd,3', 'zstd,6', 'zstd,10', 'zlib,6', 'lzma,6', 'none'].map(c => `<option ${c === W.compression ? 'selected' : ''}>${c}</option>`).join('')}</select>`;
        const get = BB.scheduleEditor(body.querySelector('[data-sched]'), W.schedule);
        readStep = () => {
          W.schedule = get();
          body.querySelectorAll('[data-ret]').forEach(x => W.retention[x.dataset.ret] = +x.value || 0);
          W.compression = body.querySelector('[data-k=compression]').value;
        };
      }

      /* ---------------------------- Step 5 ---------------------------- */
      function stepScripts() {
        const scripts = BB.state.scripts || [];
        const block = (k, title, help) => {
          const s = W[k];
          return `<div class="bb-h">${title}</div><div class="bb-small bb-muted" style="margin-bottom:6px">${help}</div>
          <div class="bb-seg" data-seg="${k}">${[['none', 'None'], ['script', 'From library'], ['inline', 'Write script']].map(([v, t]) => `<span data-v="${v}" class="${s.type === v ? 'on' : ''}">${t}</span>`).join('')}</div>
          <div data-pane="${k}-script" style="${s.type === 'script' ? '' : 'display:none'}">${scripts.length
            ? `<select data-k="${k}-script"><option value="">– choose –</option>${scripts.map(x => `<option value="${esc(x.name)}" ${x.name === s.script ? 'selected' : ''}>${esc(x.name)}${x.description ? ' – ' + esc(x.description) : ''}</option>`).join('')}</select>`
            : '<span class="bb-muted">The library is empty – add scripts on the Scripts tab, or write one here.</span>'}</div>
          <div data-pane="${k}-inline" style="${s.type === 'inline' ? '' : 'display:none'}"><textarea data-k="${k}-inline" rows="7" spellcheck="false" placeholder="#!/bin/bash\n# runs as root on the host">${esc(s.inline || '')}</textarea></div>
          ${k === 'pre' ? `<label style="font-weight:normal;${s.type === 'none' ? 'display:none' : ''}" data-pane="pre-abort"><input type="checkbox" data-k="pre-abort" ${s.abort !== false ? 'checked' : ''}> Abort the backup if this script fails</label>` : ''}`;
        };
        body.innerHTML = block('pre', 'Pre-backup script', 'Runs before containers are stopped – e.g. dump a database or pause a service.')
          + block('post', 'Post-backup script', 'Runs at the very end, after containers are started again. <code>$BORG_JOB_STATUS</code> holds ok, warning, failed or cancelled.');
        body.querySelectorAll('[data-seg]').forEach(seg => seg.onclick = e => {
          const s = e.target.closest('span'); if (!s) return;
          const k = seg.dataset.seg; W[k].type = s.dataset.v;
          seg.querySelectorAll('span').forEach(x => x.classList.toggle('on', x === s));
          body.querySelector(`[data-pane=${k}-script]`).style.display = W[k].type === 'script' ? '' : 'none';
          body.querySelector(`[data-pane=${k}-inline]`).style.display = W[k].type === 'inline' ? '' : 'none';
          const ab = body.querySelector(`[data-pane=${k}-abort]`); if (ab) ab.style.display = W[k].type === 'none' ? 'none' : '';
        });
        readStep = () => {
          for (const k of ['pre', 'post']) {
            const sel = body.querySelector(`[data-k=${k}-script]`); if (sel) W[k].script = sel.value;
            W[k].inline = body.querySelector(`[data-k=${k}-inline]`).value;
          }
          W.pre.abort = body.querySelector('[data-k=pre-abort]').checked;
        };
      }

      /* ---------------------------- Step 6 ---------------------------- */
      function stepReview() {
        const repo = BB.state.repos.find(r => r.id === W.repo_id) || {};
        const inc = W.paths.filter(p => p.include);
        const ret = Object.entries(W.retention).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(', ') || 'keep everything';
        const scr = s => s.type === 'none' ? 'none' : s.type === 'script' ? 'library: ' + esc(s.script) : 'inline (' + s.inline.split('\n').length + ' lines)';
        const stopTxt = !W.stop.enabled ? 'no – keep running' : W.type === 'custom' ? esc(W.stop.containers.join(', ')) : 'yes – ' + (W.type === 'container' ? esc(W.sourceName) : 'all containers of the stack');
        const sched = { manual: 'Manual only', hourly: `Hourly at :${String(W.schedule.minute || 0).padStart(2, '0')}`, daily: `Daily at ${W.schedule.time}`,
          weekly: `Weekly (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][W.schedule.dow || 0]}) at ${W.schedule.time}`, monthly: `Monthly on day ${W.schedule.dom} at ${W.schedule.time}`, custom: 'cron: ' + W.schedule.cron }[W.schedule.preset];
        body.innerHTML = `<div class="bb-kv">
          <div>Job name</div><div><b>${esc(W.name)}</b></div>
          <div>Source</div><div><i class="fa ${BB.icon[W.type]}"></i> ${W.type === 'custom' ? 'Custom paths' : esc(W.type + ': ' + W.sourceName)}</div>
          <div>Paths (${inc.length})</div><div class="bb-mono bb-small">${inc.map(p => esc(p.path)).join('<br>')}</div>
          ${W.excludes.trim() ? `<div>Excludes</div><div class="bb-mono bb-small">${esc(W.excludes).replace(/\n/g, '<br>')}</div>` : ''}
          <div>Stop containers</div><div>${stopTxt}</div>
          <div>Repository</div><div>${esc(repo.name)} <span class="bb-mono bb-small bb-muted">${esc(repo.location)}</span></div>
          <div>Schedule</div><div>${esc(sched)}</div>
          <div>Retention</div><div>${esc(ret)}</div>
          <div>Pre-backup</div><div>${scr(W.pre)}</div>
          <div>Post-backup</div><div>${scr(W.post)}</div>
        </div>
        <p style="margin-top:14px"><label style="font-weight:normal"><input type="checkbox" data-k="enabled" ${W.enabled ? 'checked' : ''}> Enable the schedule</label></p>
        <div class="bb-note bb-small">Order of a run: pre-backup script → stop containers → borg create → start containers → prune &amp; compact → post-backup script.</div>`;
        const en = body.querySelector('[data-k=enabled]');
        en.onchange = () => W.enabled = en.checked;
      }

      go(0);
    }
  };
})();
