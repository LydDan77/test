/* Disneyland Family HQ: app logic.
   Shared plan  = the JSON embedded in the page (#plan-data). Organizers edit it and save a new page version.
   Personal bits = this device only (localStorage): budget numbers, savings log, packing ticks, ride stars. */
(function () {
  'use strict';
  var G = window.GUIDE || {};
  var SHELL = window.TRIP_SHELL;
  var app = document.getElementById('app');
  var HOSTED = !!(window.claude && typeof window.claude.use === 'function');
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var SPARK = ['#FFC83D', '#FF8AC2', '#7FE3FF', '#FFFFFF', '#B79CFF', '#8CF5B0'];

  /* ---------------- utilities ---------------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function uid() { return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function pd(s) { var m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +(m[3] || 1)) : null; }
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function dayDiff(a, b) { return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmt(d, long) { return d ? (long ? DOW[d.getDay()] + ', ' : '') + MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() : ''; }
  function fmtShort(d) { return d ? MON[d.getMonth()] + ' ' + d.getDate() : ''; }
  function fmtRange(a, b) {
    if (!a) return '';
    if (!b) return fmt(a, true);
    if (a.getFullYear() !== b.getFullYear()) return fmt(a) + ' to ' + fmt(b);
    return fmtShort(a) + ' to ' + (a.getMonth() === b.getMonth() ? b.getDate() : fmtShort(b)) + ', ' + b.getFullYear();
  }
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : (d == null ? 0 : d); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function httpsLink(u) { return /^https:\/\//i.test(u || '') ? u : ''; }

  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('dlhq.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('dlhq.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable: carry on */ } },
    del: function (k) { try { localStorage.removeItem('dlhq.' + k); } catch (e) { /* ignore */ } }
  };

  /* ---------------- state ---------------- */
  function normalize(p) {
    p = p || {};
    p.trip = p.trip || {};
    ['crew', 'candidates', 'customTasks', 'lodging', 'bookings', 'itinerary', 'updates'].forEach(function (k) { if (!Array.isArray(p[k])) p[k] = []; });
    ['tasks', 'decisions', 'roles', 'info'].forEach(function (k) { if (!p[k] || typeof p[k] !== 'object') p[k] = {}; });
    p.rev = p.rev || 1;
    return p;
  }
  var published;
  try { published = normalize(JSON.parse(document.getElementById('plan-data').textContent)); } catch (e) { published = normalize({}); }
  var plan = clone(published);
  var L = LS.get('me', {});
  L.est = L.est || {}; L.saved = L.saved || []; L.pack = L.pack || {}; L.dayof = L.dayof || {}; L.stars = L.stars || {}; L.sub = L.sub || {};
  function saveL() { LS.set('me', L); }
  // Updates this visitor has not seen. A first visit flags nothing; later visits flag what is new.
  var unseen = {};
  if (L.seenUpdates) plan.updates.forEach(function (u) { if (!L.seenUpdates[u.id]) unseen[u.id] = true; });
  function markUpdatesSeen() {
    var m = {}; plan.updates.forEach(function (u) { m[u.id] = true; });
    if (JSON.stringify(m) !== JSON.stringify(L.seenUpdates || null)) { L.seenUpdates = m; saveL(); }
  }

  var S = {
    route: 'hq',
    mode: HOSTED ? 'checking' : 'local',   // checking | owner | viewer | local
    artifact: null, dirty: false, saving: false, stale: null,
    taskFilter: 'open', ridePark: 'all', rideFit: 'all'
  };
  function canEdit() { return S.mode === 'owner' || (S.mode === 'local' && L.localEdit === true); }

  var NAV = [['hq', 'HQ'], ['when', 'When to go'], ['plan', 'Countdown'], ['money', 'Budget'], ['stay', 'Stay & travel'], ['parks', 'Parks'], ['fun', 'Fun zone'], ['crew', 'Crew'], ['trip', 'Trip days']];

  /* ---------------- saving ---------------- */
  function commit(msg) {
    if (S.mode === 'owner') { S.dirty = true; LS.set('draft', { base: published.rev, plan: plan }); }
    else if (S.mode === 'local') { LS.set('localplan', { base: published.rev, plan: plan }); }
    render();
    if (msg) toast(msg);
  }
  function restoreLocal() {
    var lp = LS.get('localplan', null);
    if (L.localEdit && lp && lp.base === published.rev && lp.plan) plan = normalize(lp.plan);
  }
  function restoreDraft() {
    var d = LS.get('draft', null);
    if (!d || !d.plan) return;
    if (d.pending && d.pending === published.rev) { LS.del('draft'); toast('Saved for everyone'); return; }
    if (d.base === published.rev) { plan = normalize(d.plan); S.dirty = true; }
    else S.stale = d;
  }
  function saveForEveryone() {
    if (!S.artifact || S.saving) return;
    var next = clone(plan);
    next.rev = (published.rev || 1) + 1;
    next.saved = iso(today());
    S.saving = true; render();
    LS.set('draft', { base: published.rev, plan: plan, pending: next.rev });
    var attempt = function (retry) {
      return S.artifact.publish(SHELL.fullDocument(next)).then(function () {
        LS.del('draft'); S.dirty = false; S.saving = false; S.blocked = false;
        published = next; plan = clone(next); render(); toast('Saved for everyone');
      }, function (err) {
        var code = err && err.code;
        if ((code === 'upstream_error' || !code) && retry) return new Promise(function (r) { setTimeout(r, 900 + Math.random() * 900); }).then(function () { return attempt(false); });
        S.saving = false;
        LS.set('draft', { base: published.rev, plan: plan });
        if (code === 'conflict') toast('Someone else saved first. Loading their version.');
        else if (code === 'rate_limited') toast('Saving too often. Wait a minute, then save again.');
        else if (code === 'too_large' || code === 'invalid_content' || code === 'transform_error') toast('The plan could not be saved. Shorten long notes and try again.');
        else if (code === 'not_writer' || code === 'not_granted' || code === 'not_declared' || code === 'consent_required' || code === 'capability_disabled' || code === 'capability_removed') { S.blocked = true; toast('This page could not save here. Your edits are safe on this device.'); }
        else toast('Could not save right now. Your edits are kept on this device.');
        render();
      });
    };
    attempt(true);
  }
  function resolveHost() {
    var done = false;
    var settle = function (mode, art) { if (done) return; done = true; S.mode = mode; S.artifact = art || null; if (mode === 'owner') restoreDraft(); render(); };
    setTimeout(function () { settle('viewer'); }, 12000);
    Promise.all([window.claude.use('user'), window.claude.use('artifact')]).then(function (r) {
      if (!r[0] || !r[1]) return settle('viewer');
      return r[0].canEdit().then(function (ok) { settle(ok ? 'owner' : 'viewer', r[1]); });
    }).catch(function () { settle('viewer'); });
  }

  /* ---------------- derived facts ---------------- */
  function tripStart() { return pd(plan.trip.start); }
  function tripEnd() { return pd(plan.trip.end) || tripStart(); }
  function refDate() {
    var s = tripStart(); if (s) return s;
    var c = plan.candidates.filter(function (x) { return x.status !== 'out' && pd(x.start); })[0];
    return c ? pd(c.start) : null;
  }
  function ageOn(birth, on) {
    var b = pd(birth); if (!b || !on) return null;
    var a = on.getFullYear() - b.getFullYear();
    if (on.getMonth() < b.getMonth() || (on.getMonth() === b.getMonth() && on.getDate() < b.getDate())) a--;
    return a;
  }
  function ticketClass(m, on) {
    var a = ageOn(m.birth, on);
    if (a != null) return a < 3 ? 'free' : a < 10 ? 'child' : 'adult';
    return m.role === 'baby' ? 'free' : m.role === 'kid' ? 'child' : 'adult';
  }
  var CLASS_LABEL = { free: 'Free (under 3)', child: 'Child ticket (3 to 9)', adult: 'Adult ticket (10+)' };
  var ROLE_LABEL = { grandparent: 'Grandparent', parent: 'Parent', adult: 'Adult', kid: 'Kid', baby: 'Baby' };
  function isChild(m) { return m.role === 'kid' || m.role === 'baby'; }
  function heightAtTrip(m) {
    var h = num(m.height, 0); if (!h) return null;
    var on = refDate(), meas = pd(m.measured);
    if (!on || !meas || on <= meas) return { h: h, est: false };
    var yrs = dayDiff(meas, on) / 365.25, age = ageOn(m.birth, meas);
    var rate = age != null && age < 4 ? 3.5 : 2.3;   // typical inches per year
    return { h: Math.round((h + rate * yrs) * 2) / 2, est: true };
  }
  function crewCounts(on) {
    var c = { free: 0, child: 0, adult: 0 };
    plan.crew.forEach(function (m) { c[ticketClass(m, on)]++; });
    return c;
  }
  function allTasks() {
    var s = tripStart();
    var list = (G.tasks || []).map(function (t) { return { id: t.id, ph: t.ph, off: t.off, t: t.t, d: t.d, go: t.go, custom: false }; });
    plan.customTasks.forEach(function (t) { list.push({ id: t.id, ph: t.ph || 'now', t: t.t, d: t.d, fixed: t.due, custom: true }); });
    list.forEach(function (t) {
      var st = plan.tasks[t.id] || {};
      t.done = !!st.done; t.owner = st.owner || ''; t.note = st.note || '';
      t.due = t.fixed ? pd(t.fixed) : (s && t.off != null ? addDays(s, -t.off) : null);
    });
    return list;
  }
  function phaseOrder(id) { var i = (G.phases || []).findIndex(function (p) { return p.id === id; }); return i < 0 ? 99 : i; }
  function nextTasks(n) {
    var rank = function (t) { return t.ph === 'now' ? 0 : t.due ? 1 : 2; };
    return allTasks().filter(function (t) { return !t.done; }).sort(function (a, b) {
      var ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 1) return a.due - b.due;
      return phaseOrder(a.ph) - phaseOrder(b.ph);
    }).slice(0, n);
  }
  function duePill(t) {
    if (t.done) return '<span class="pill good">Done</span>';
    if (!t.due) return t.ph === 'now' ? '<span class="pill poppy">Do now</span>' : '';
    var n = dayDiff(today(), t.due);
    if (n < 0) return '<span class="pill warn">Catch up: was ' + fmtShort(t.due) + '</span>';
    if (n <= 21) return '<span class="pill poppy">By ' + fmtShort(t.due) + '</span>';
    return '<span class="pill">By ' + fmt(t.due) + '</span>';
  }
  function phaseIndex() {
    var s = tripStart(), e = tripEnd(), td = today();
    if (!s) return plan.candidates.length ? 1 : 0;
    if (td > e) return 5;
    if (td >= s) return 4;
    return dayDiff(td, s) > 75 ? 2 : 3;
  }

  /* ---------------- small render helpers ---------------- */
  var HERO = null;   // each view names its page here; render() paints it into the night-sky hero
  function head(eyebrow, title, lede) { HERO = { eyebrow: eyebrow, title: title, lede: lede || '' }; return ''; }
  function sec(title, intro, body, action) {
    return '<section class="sec"><div class="sec-head"><div class="sec-top"><h2>' + esc(title) + '</h2>' + (action || '') + '</div>' + (intro ? '<p>' + esc(intro) + '</p>' : '') + '</div>' + body + '</section>';
  }
  function editBtn(act, label, attrs) { return canEdit() ? '<button class="btn sm" data-act="' + act + '"' + (attrs || '') + '>' + esc(label) + '</button>' : ''; }
  function bullets(a) { return a && a.length ? '<ul class="dots">' + a.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : ''; }
  function tipCards(list, cls) {
    return '<div class="grid ' + (cls || '') + '">' + (list || []).map(function (x) {
      return '<div class="card">' + (x.tag ? '<span class="pill teal" style="align-self:flex-start">' + esc(x.tag) + '</span>' : '') + '<h3>' + esc(x.t) + '</h3>' + (x.d ? '<p>' + esc(x.d) + '</p>' : '') + bullets(x.list) + '</div>';
    }).join('') + '</div>';
  }
  function faq(list) {
    return '<div class="card">' + (list || []).map(function (x) {
      return '<details class="more"><summary>' + esc(x.t) + '</summary><div>' + (x.d ? '<p>' + esc(x.d) + '</p>' : '') + bullets(x.list) + '</div></details>';
    }).join('') + '</div>';
  }
  function sources(key) {
    var s = (G.sources || []).filter(function (x) { return x.sec === key; });
    if (!s.length) return '';
    return '<p class="src">Sources, checked ' + esc(G.asOfLabel || '') + ': ' + s.map(function (x) { return '<a href="' + esc(x.u) + '" target="_blank" rel="noopener">' + esc(x.t) + '</a>'; }).join(' · ') + '</p>';
  }
  function crowdPill(n) {
    var w = ['', 'Very light', 'Light', 'Moderate', 'Busy', 'Packed'][n] || '';
    return '<span class="pill ' + (n <= 2 ? 'good' : n === 3 ? 'sun' : n === 4 ? 'warn' : 'bad') + '">Crowds: ' + w + '</span>';
  }
  function seg(key, cur, opts, act) {
    return '<div class="seg" role="group">' + opts.map(function (o) { return '<button data-act="' + (act || 'sub') + '" data-k="' + key + '" data-v="' + o[0] + '" aria-pressed="' + (cur === o[0]) + '">' + esc(o[1]) + '</button>'; }).join('') + '</div>';
  }
  function toast(msg) {
    var old = document.querySelector('.toast'); if (old) old.remove();
    var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3600);
  }
  function copyText(text, okMsg) {
    var fallback = function () { openForm({ title: 'Copy this text', intro: 'Select all of it, then copy.', fields: [{ k: 'x', label: 'Text', type: 'textarea' }], values: { x: text }, saveLabel: 'Done', onSave: function () {} }); };
    try { navigator.clipboard.writeText(text).then(function () { toast(okMsg || 'Copied'); }, fallback); } catch (e) { fallback(); }
  }

  /* ---------------- form dialog ---------------- */
  function openForm(o) {
    var d = document.createElement('dialog');
    var fields = o.fields.map(function (x) {
      var id = 'f-' + x.k, v = o.values && o.values[x.k] != null ? o.values[x.k] : (x.def != null ? x.def : '');
      if (x.type === 'checkbox') return '<label class="rowflex"><input type="checkbox" id="' + id + '" name="' + x.k + '"' + (v ? ' checked' : '') + ' style="width:22px;height:22px;accent-color:var(--poppy)"><span>' + esc(x.label) + '</span></label>';
      var ctl;
      if (x.type === 'select') ctl = '<select id="' + id + '" name="' + x.k + '">' + x.opts.map(function (op) { var val = Array.isArray(op) ? op[0] : op, lab = Array.isArray(op) ? op[1] : op; return '<option value="' + esc(val) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(lab) + '</option>'; }).join('') + '</select>';
      else if (x.type === 'textarea') ctl = '<textarea id="' + id + '" name="' + x.k + '" placeholder="' + esc(x.ph || '') + '">' + esc(v) + '</textarea>';
      else ctl = '<input type="' + (x.type || 'text') + '" id="' + id + '" name="' + x.k + '" value="' + esc(v) + '" placeholder="' + esc(x.ph || '') + '"' + (x.req ? ' required' : '') + (x.step ? ' step="' + x.step + '"' : '') + (x.type === 'number' ? ' inputmode="decimal"' : '') + '>';
      return '<label class="field" for="' + id + '"><span>' + esc(x.label) + '</span>' + ctl + (x.help ? '<small>' + esc(x.help) + '</small>' : '') + '</label>';
    }).join('');
    d.innerHTML = '<form class="dlg" method="dialog"><h2>' + esc(o.title) + '</h2>' + (o.intro ? '<p class="muted">' + esc(o.intro) + '</p>' : '') + '<div class="stack">' + fields + '</div><div class="dlg-actions">' +
      (o.onDelete ? '<button type="button" class="btn danger" data-x="del">Delete</button>' : '') + '<span class="spacer"></span><button type="button" class="btn" data-x="cancel">Cancel</button><button type="submit" class="btn primary">' + esc(o.saveLabel || 'Save') + '</button></div></form>';
    document.body.appendChild(d);
    var form = d.querySelector('form');
    var close = function () { try { d.close(); } catch (e) { /* already closed */ } d.remove(); };
    d.addEventListener('cancel', function (ev) { ev.preventDefault(); close(); });
    d.querySelector('[data-x="cancel"]').addEventListener('click', close);
    var del = d.querySelector('[data-x="del"]');
    if (del) del.addEventListener('click', function () { if (del.dataset.armed) { close(); o.onDelete(); } else { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; } });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!form.reportValidity()) return;
      var vals = {};
      o.fields.forEach(function (x) { var el = form.elements[x.k]; vals[x.k] = x.type === 'checkbox' ? el.checked : String(el.value).trim(); });
      close(); o.onSave(vals);
    });
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  function upsert(arr, id, vals, defaults) {
    var item = arr.find(function (x) { return x.id === id; });
    if (!item) { item = Object.assign({ id: uid() }, defaults || {}); arr.push(item); }
    Object.assign(item, vals); delete item.example;
    return item;
  }
  function removeById(arr, id) { var i = arr.findIndex(function (x) { return x.id === id; }); if (i >= 0) arr.splice(i, 1); }

  /* ---------------- chrome ---------------- */
  function chrome() {
    var s = tripStart(), e = tripEnd(), td = today(), w;
    var chip = function (l1, l2, n, href) { return '<a class="wait" href="' + href + '" aria-label="' + esc(l1 + ' ' + l2 + ': ' + n) + '"><span class="wait-l"><span>' + esc(l1) + '</span><span>' + esc(l2) + '</span></span><span class="wait-n">' + esc(n) + '</span></a>'; };
    if (!s) w = chip('Trip', 'dates', 'TBD', '#when');
    else if (td < s) w = chip('Days', 'to go', dayDiff(td, s), '#plan');
    else if (td <= e) w = chip('Trip', 'day', dayDiff(s, td) + 1, '#trip');
    else w = chip('Our', 'trip', 'Done', '#hq');
    var fresh = plan.updates.some(function (u) { return unseen[u.id]; });
    var tabs = NAV.map(function (n) { return '<a class="tab" href="#' + n[0] + '"' + (S.route === n[0] ? ' aria-current="page"' : '') + '>' + n[1] + (n[0] === 'hq' && fresh && S.route !== 'hq' ? '<span class="dot" title="New update"></span><span class="sr">, new update</span>' : '') + '</a>'; }).join('');
    var bar = '';
    if (S.mode === 'local' && L.localEdit) bar = '<div class="modebar"><div class="wrap"><span><b>Editing a copy on this device.</b> Nobody else sees these changes.</span><span class="rowflex"><button class="btn sm" data-act="copy-plan">Copy plan data</button><button class="btn sm" data-act="local-off">Stop editing</button></span></div></div>';
    if (S.stale) bar = '<div class="modebar"><div class="wrap"><span><b>You have unsaved edits from an earlier visit,</b> and the plan has been saved since then.</span><span class="rowflex"><button class="btn sm" data-act="stale-keep">Keep my edits</button><button class="btn sm" data-act="stale-drop">Discard them</button></span></div></div>';
    return '<header class="top"><div class="wrap"><div class="top-in"><a class="brand" href="#hq"><span class="brand-mark" aria-hidden="true"></span><span style="min-width:0"><span class="brand-name">' + esc(plan.trip.name || 'Our Disneyland Adventure') + '</span><span class="brand-sub">Family trip headquarters</span></span></a>' + w + '</div><nav class="tabs" aria-label="Sections">' + tabs + '</nav></div></header>' + bar;
  }
  function footer() {
    var who = S.mode === 'owner' ? 'You can edit this plan. Changes reach everyone when you press Save for everyone.' :
      S.mode === 'viewer' ? 'The trip organizers keep this plan up to date. Your budget numbers, packing ticks and ride stars are saved on this device only.' :
      S.mode === 'local' ? (L.localEdit ? '' : 'You are viewing the shared plan. <button class="linkbtn" data-act="local-on">Edit a copy on this device</button>') : '';
    return '<footer class="foot"><div class="stack tight"><p>' + who + '</p><p>Plan last saved ' + esc(fmt(pd(plan.saved)) || 'not yet') + '. Research checked ' + esc(G.asOfLabel || '') + '. Prices and rules change often, so confirm on disneyland.com before paying for anything.</p><p>An unofficial family planner. Not affiliated with or endorsed by The Walt Disney Company.</p></div></footer>';
  }
  function saveBar() {
    if (S.mode !== 'owner' || !S.dirty) return '';
    if (S.blocked) return '<div class="savebar"><div class="savebar-in"><span><b>Saving from this page did not work.</b> Your edits are safe on this device. Copy the plan data, paste it to Claude and ask it to publish your changes.</span><span class="rowflex"><button class="btn ghost" data-act="discard">Discard</button><button class="btn ghost" data-act="save">Try again</button><button class="btn primary" data-act="copy-plan">Copy plan data</button></span></div></div>';
    return '<div class="savebar"><div class="savebar-in"><span><b>Unsaved changes.</b> Only you can see them so far.</span><span class="rowflex"><button class="btn ghost" data-act="discard"' + (S.saving ? ' disabled' : '') + '>Discard</button><button class="btn primary" data-act="save"' + (S.saving ? ' disabled' : '') + '>' + (S.saving ? 'Saving…' : 'Save for everyone') + '</button></span></div></div>';
  }
  /* ---------------- the night sky: stars, skyline, fireworks ---------------- */
  var Sky = (function () {
    var cv = null, c = null, w = 0, h = 0, big = false, stars = [], rockets = [], sparks = [], raf = 0, nextAt = 0, onScreen = true, io = null, ro = null;
    function size() {
      if (!cv) return;
      var r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, r.width); h = Math.max(1, r.height);
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); c.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = [];
      for (var i = 0, n = Math.round(w * h / 5200); i < n; i++) stars.push({ x: Math.random() * w, y: Math.random() * h * 0.8, r: Math.random() * 1.2 + 0.3, p: Math.random() * 6.28, s: 0.6 + Math.random() * 1.8 });
    }
    function skyline() {
      var u = big ? (w < 560 ? 70 : 84) : 52, g = h, s = u / 90, i;
      c.fillStyle = '#060924';
      c.beginPath(); c.moveTo(0, g); c.lineTo(0, g - u * 0.2);
      c.quadraticCurveTo(w * 0.25, g - u * 0.46, w * 0.5, g - u * 0.22);
      c.quadraticCurveTo(w * 0.78, g - u * 0.02, w, g - u * 0.3); c.lineTo(w, g); c.closePath(); c.fill();
      [0.04, 0.24, 0.3, 0.52, 0.58, 0.9, 0.96].forEach(function (f, k) { var x = w * f, r = u * (0.13 + (k % 3) * 0.03), y = g - u * 0.3; c.beginPath(); c.arc(x, y - r * 0.6, r, 0, 6.3); c.fill(); c.fillRect(x - 1.5, y, 3, u * 0.3); });
      if (w > 420) {   // an observation wheel
        var fx = w * 0.13, R0 = u * 0.62, fy = g - u * 0.3 - R0;
        c.strokeStyle = '#060924'; c.lineWidth = Math.max(2, 3 * s);
        c.beginPath(); c.arc(fx, fy, R0, 0, 6.3); c.stroke();
        for (i = 0; i < 8; i++) { var a = i * Math.PI / 4; c.beginPath(); c.moveTo(fx, fy); c.lineTo(fx + Math.cos(a) * R0, fy + Math.sin(a) * R0); c.stroke(); c.beginPath(); c.arc(fx + Math.cos(a) * R0, fy + Math.sin(a) * R0, 3.4 * s + 1, 0, 6.3); c.fill(); }
        c.beginPath(); c.moveTo(fx, fy); c.lineTo(fx - R0 * 0.5, g); c.lineTo(fx + R0 * 0.5, g); c.closePath(); c.fill();
      }
      if (w > 640) {   // a snowy peak
        var mx = w * 0.42, mb = g - u * 0.2;
        c.beginPath(); c.moveTo(mx - u * 0.85, mb); c.lineTo(mx - u * 0.2, mb - u * 0.78); c.lineTo(mx - u * 0.05, mb - u * 0.62); c.lineTo(mx + u * 0.12, mb - u * 0.95); c.lineTo(mx + u * 0.9, mb); c.closePath(); c.fill();
      }
      // a storybook castle of our own
      var cx = w * (w > 700 ? 0.76 : 0.74), b = g - u * 0.16;
      var rect = function (x, y, ww, hh) { c.fillRect(cx + x * s, b - (y + hh) * s, ww * s, hh * s + 1); };
      var cone = function (x, y, ww, hh) { c.beginPath(); c.moveTo(cx + (x - ww / 2) * s, b - y * s + 0.5); c.lineTo(cx + x * s, b - (y + hh) * s); c.lineTo(cx + (x + ww / 2) * s, b - y * s + 0.5); c.closePath(); c.fill(); };
      rect(-46, 0, 92, 34);
      for (i = 0; i < 7; i++) rect(-46 + i * 14, 34, 8, 6);
      rect(-58, 0, 18, 52); cone(-49, 52, 26, 26);
      rect(40, 0, 18, 52); cone(49, 52, 26, 26);
      rect(-32, 34, 12, 22); cone(-26, 56, 18, 20);
      rect(20, 34, 12, 22); cone(26, 56, 18, 20);
      rect(-16, 34, 32, 34); cone(0, 68, 42, 38);
      rect(-0.75, 106, 1.5, 12);
      c.fillStyle = '#FFC83D';
      c.beginPath(); c.moveTo(cx + 0.75 * s, b - 118 * s); c.lineTo(cx + 12 * s, b - 114 * s); c.lineTo(cx + 0.75 * s, b - 110 * s); c.closePath(); c.fill();
      rect(-51, 30, 4, 7); rect(47, 30, 4, 7); rect(-2.5, 46, 5, 9); rect(-28, 42, 4, 6); rect(24, 42, 4, 6);
      c.beginPath(); c.arc(cx, b - 14 * s, 7 * s, Math.PI, 0); c.fill(); rect(-7, 0, 14, 14);
    }
    function burst(x, y, col) {
      var n = w < 560 ? 54 : 90, alt = SPARK[Math.floor(Math.random() * SPARK.length)];
      for (var i = 0; i < n; i++) { var a = Math.random() * 6.283, v = (0.35 + Math.random()) * (big ? 3.1 : 2.3); sparks.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 60 + Math.random() * 50, r: Math.random() * 1.7 + 1, col: i % 4 ? col : alt }); }
    }
    function draw(t, still) {
      var i, p;
      // A still frame is wiped clean. A moving frame only fades the last one, which gives every spark a tail.
      if (still) c.clearRect(0, 0, w, h);
      else { c.globalCompositeOperation = 'destination-out'; c.fillStyle = 'rgba(0,0,0,0.2)'; c.fillRect(0, 0, w, h); c.globalCompositeOperation = 'source-over'; }
      for (i = 0; i < stars.length; i++) { p = stars[i]; c.globalAlpha = still ? 0.8 : 0.08 + 0.5 * (0.5 + 0.5 * Math.sin(t / 1000 * p.s + p.p)); c.fillStyle = i % 9 ? '#FFFFFF' : '#FFE9A8'; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.3); c.fill(); }
      c.globalCompositeOperation = 'lighter';
      for (i = rockets.length - 1; i >= 0; i--) {
        p = rockets[i]; p.y += p.vy; p.vy *= 0.985;
        c.globalAlpha = 1; c.fillStyle = p.col; c.beginPath(); c.arc(p.x, p.y, 2.2, 0, 6.3); c.fill();
        if (p.y <= p.ty || p.vy > -0.6) { burst(p.x, p.y, p.col); rockets.splice(i, 1); }
      }
      for (i = sparks.length - 1; i >= 0; i--) {
        p = sparks[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.028; p.vx *= 0.985; p.vy *= 0.985; p.life -= 1;
        if (p.life <= 0) { sparks.splice(i, 1); continue; }
        c.globalAlpha = Math.min(1, p.life / 45); c.fillStyle = p.col; c.beginPath(); c.arc(p.x, p.y, p.r, 0, 6.3); c.fill();
      }
      c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      skyline();
    }
    function launch(x, ty) {
      if (REDUCED || !cv || sparks.length > 700) return;
      rockets.push({ x: x, y: h - 20, ty: ty, vy: -Math.max(5, (h - 20 - ty) / 26), col: SPARK[Math.floor(Math.random() * SPARK.length)] });
      run();
    }
    function loop(t) {
      if (!cv || !cv.isConnected) { raf = 0; return; }
      var live = !REDUCED && onScreen && !document.hidden;
      if (big && live && t > nextAt) { nextAt = t + 700 + Math.random() * 1500; launch(w * (0.08 + Math.random() * 0.84), h * (0.1 + Math.random() * 0.34)); }
      draw(t, REDUCED);
      raf = live && (big || rockets.length || sparks.length) ? requestAnimationFrame(loop) : 0;
    }
    function run() { if (!raf) raf = requestAnimationFrame(loop); }
    function start(canvas, isBig) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0; if (io) io.disconnect(); if (ro) ro.disconnect();
      cv = canvas; c = cv.getContext('2d'); big = isBig; rockets = []; sparks = []; nextAt = 0; onScreen = true;
      size(); draw(performance.now(), true);
      if (window.IntersectionObserver) { io = new IntersectionObserver(function (en) { onScreen = en[0].isIntersecting; if (onScreen) run(); }); io.observe(cv); }
      if (window.ResizeObserver) { ro = new ResizeObserver(function () { var r = cv.getBoundingClientRect(); if (Math.abs(r.width - w) > 1 || Math.abs(r.height - h) > 1) { size(); draw(performance.now(), true); run(); } }); ro.observe(cv); }
      cv.parentNode.addEventListener('pointerdown', function (ev) {
        if (ev.target.closest('a,button,input,select')) return;
        var r = cv.getBoundingClientRect(); launch(ev.clientX - r.left, Math.max(20, ev.clientY - r.top));
      });
      if (big) run();
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden && cv) run(); });
    return { start: start };
  })();

  /* ---------------- sparkle bursts for small wins ---------------- */
  var FX = (function () {
    var cv = null, c = null, parts = [], raf = 0;
    function fit() { var d = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.round(window.innerWidth * d); cv.height = Math.round(window.innerHeight * d); c.setTransform(d, 0, 0, d, 0, 0); }
    function ensure() { if (cv) return; cv = document.createElement('canvas'); cv.className = 'fx'; cv.setAttribute('aria-hidden', 'true'); document.body.appendChild(cv); c = cv.getContext('2d'); fit(); window.addEventListener('resize', fit); }
    function step() {
      c.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (var i = parts.length - 1; i >= 0; i--) {
        var p = parts[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.16; p.vx *= 0.985; p.rot += p.vr; p.life -= 1;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        c.save(); c.globalAlpha = Math.min(1, p.life / 24); c.translate(p.x, p.y); c.rotate(p.rot); c.fillStyle = p.col;
        if (p.star) { c.beginPath(); for (var k = 0; k < 8; k++) { var rr = k % 2 ? p.size * 0.38 : p.size, a = k * Math.PI / 4; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } c.closePath(); c.fill(); }
        else c.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        c.restore();
      }
      raf = parts.length ? requestAnimationFrame(step) : 0;
    }
    function burst(x, y, n) {
      if (REDUCED) return;
      ensure();
      for (var i = 0; i < (n || 26); i++) { var a = Math.random() * 6.283, v = 2 + Math.random() * 5.5; parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2.5, rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.4, life: 46 + Math.random() * 34, size: 5 + Math.random() * 7, col: SPARK[i % SPARK.length], star: i % 3 === 0 }); }
      if (!raf) raf = requestAnimationFrame(step);
    }
    function at(el, n) { if (!el) return; var r = el.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, n); }
    function show() { if (REDUCED) return; for (var i = 0; i < 7; i++) setTimeout(function () { burst(window.innerWidth * (0.12 + Math.random() * 0.76), window.innerHeight * (0.15 + Math.random() * 0.45), 46); }, i * 230); }
    return { burst: burst, at: at, show: show };
  })();

  /* ---------------- page regions, hero and countdown ---------------- */
  app.innerHTML = '<div id="r-top"></div><div id="r-hero"></div><main><div class="wrap" id="r-view"></div></main><div id="r-bars"></div>';
  var R = { top: document.getElementById('r-top'), hero: document.getElementById('r-hero'), view: document.getElementById('r-view'), bars: document.getElementById('r-bars') };
  var heroSig = '';
  function countTarget() {
    var s = tripStart(); if (s) return { d: s, real: true };
    var w = (G.windows || [])[0], d = w && pd(w.start);
    return d ? { d: d, real: false, title: w.title } : null;
  }
  function heroExtra() {
    var s = tripStart(), e = tripEnd(), td = today(), t = countTarget();
    if (s && td >= s && td <= e) return '<p class="bignum" style="color:var(--gold)">We are here! Day ' + (dayDiff(s, td) + 1) + '</p>';
    if (s && td > e) return '<p>What a trip. Time to share the photos.</p>';
    if (!t) return '';
    var unit = function (k, l) { return '<div class="flip-u"><span class="flip-n" data-u="' + k + '">--</span><span class="flip-l">' + l + '</span></div>'; };
    return '<div class="flip" id="flip" role="timer" aria-label="Countdown to ' + esc(fmt(t.d)) + '">' + unit('d', 'days') + unit('h', 'hours') + unit('m', 'minutes') + unit('s', 'seconds') + '</div>' +
      '<p class="hint">' + (t.real ? 'Until we walk through the gates on ' + esc(fmt(t.d, true)) + '.' : 'A dream countdown to our top-ranked window, ' + esc(t.title) + '. Lock real dates on the When to go page to make it official.') + (REDUCED ? '' : ' Tap the sky to set off a firework.') + '</p>';
  }
  function tickFlip(quiet) {
    var el = document.getElementById('flip'), t = el && countTarget(); if (!t) return;
    var ms = Math.max(0, t.d.getTime() - Date.now());
    var v = { d: Math.floor(ms / 864e5), h: Math.floor(ms / 36e5) % 24, m: Math.floor(ms / 6e4) % 60, s: Math.floor(ms / 1e3) % 60 };
    ['d', 'h', 'm', 's'].forEach(function (k) {
      var n = el.querySelector('[data-u="' + k + '"]'), txt = k === 'd' ? String(v[k]) : String(v[k]).padStart(2, '0');
      if (n.textContent === txt) return;
      n.textContent = txt;
      if (!REDUCED && quiet !== true) { n.classList.remove('tick'); void n.offsetWidth; n.classList.add('tick'); }
    });
  }
  setInterval(tickFlip, 1000);
  function renderHero() {
    var hd = HERO || { eyebrow: '', title: plan.trip.name || 'Our Disneyland Adventure', lede: '' }, big = S.route === 'hq', extra = big ? heroExtra() : '';
    var sig = S.route + '|' + JSON.stringify(hd) + '|' + extra;
    if (sig === heroSig) return;
    heroSig = sig;
    R.hero.innerHTML = '<section class="hero' + (big ? ' big' : '') + '"><canvas class="sky" aria-hidden="true"></canvas><div class="wrap hero-in"><span class="eyebrow">' + esc(hd.eyebrow) + '</span><h1>' + esc(hd.title) + '</h1>' + (hd.lede ? '<p>' + esc(hd.lede) + '</p>' : '') + extra + '</div></section>';
    Sky.start(R.hero.querySelector('canvas'), big);
    tickFlip(true);
  }
  var V = {};
  function render() {
    HERO = null;
    var view = (V[S.route] || V.hq)();
    if (S.route === 'hq') markUpdatesSeen();
    R.top.innerHTML = chrome();
    renderHero();
    R.view.innerHTML = view + footer();
    R.bars.innerHTML = saveBar();
    var cur = R.top.querySelector('.tab[aria-current="page"]');
    if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* older browsers */ } }
    drawWheel();
  }
  function dayOfYear() { var t = today(); return dayDiff(new Date(t.getFullYear(), 0, 1), t); }

  /* ---------------- view: HQ ---------------- */
  V.hq = function () {
    var t = plan.trip, s = tripStart(), e = tripEnd(), td = today(), ph = phaseIndex();
    var names = ['Dream', 'Decide', 'Book', 'Get ready', 'Go', 'Remember'];
    var lede = s ? fmtRange(s, e) + ' · ' + plural(num(t.nights, dayDiff(s, e)), 'night') + ' · ' + plural(num(t.parkDays, 0), 'park day') :
      'No dates picked yet. Start with the When to go page, then lock a window so every booking date below can be worked out.';
    var h = head('Family trip headquarters', t.name || 'Our Disneyland Adventure', lede);

    if (s && td >= s && td <= e) {
      var day = plan.itinerary.find(function (d) { return d.date === iso(td); });
      h += '<section class="sec"><div class="ticket pick"><div class="ticket-stub"><span class="ticket-letter">' + (dayDiff(s, td) + 1) + '</span><span class="ticket-cap">Trip day</span></div><div class="ticket-body"><h2>Today' + (day ? ': ' + esc(day.title || day.park || '') : '') + '</h2>' + (day ? dayItems(day) : '<p class="muted">No plan saved for today.</p>') + '<a class="btn sm" href="#trip" style="align-self:flex-start">Open trip days</a></div></div></section>';
    }

    var tasks = allTasks(), done = tasks.filter(function (x) { return x.done; }).length;
    h += '<section class="sec"><div class="card"><div class="rowflex between"><h2>Where we are: ' + names[ph] + '</h2>' + editBtn('edit-trip', s ? 'Change trip details' : 'Set trip dates') + '</div><div class="phases">' +
      names.map(function (n, i) { return '<div class="phase ' + (i < ph ? 'done' : i === ph ? 'now' : '') + '">' + n + '</div>'; }).join('') + '</div>' +
      '<div class="rowflex" style="gap:22px 34px;margin-top:6px">' +
      '<div class="stat"><span class="stat-n">' + (s ? (td < s ? dayDiff(td, s) : td <= e ? 'Here' : 'Done') : 'TBD') + '</span><span class="stat-l">' + (s && td < s ? 'days until we leave' : 'trip dates') + '</span></div>' +
      '<div class="stat"><span class="stat-n">' + plan.crew.length + '</span><span class="stat-l">in the crew</span></div>' +
      '<div class="stat"><span class="stat-n">' + done + '/' + tasks.length + '</span><span class="stat-l">countdown jobs done</span></div>' +
      '<div class="stat grow" style="min-width:160px"><div class="meter poppy" role="img" aria-label="' + done + ' of ' + tasks.length + ' jobs done"><i style="width:' + (tasks.length ? Math.round(done / tasks.length * 100) : 0) + '%"></i></div><span class="stat-l">' + (tasks.length ? Math.round(done / tasks.length * 100) : 0) + '% of the plan complete</span></div></div></div></section>';

    var nx = nextTasks(5);
    var nextCard = '<div class="card"><div class="rowflex between"><h3>Next up</h3><a href="#plan" class="small">Full countdown</a></div><div>' + (nx.length ? nx.map(function (x) {
      return '<div class="check"><div class="check-main"><span class="check-t">' + esc(x.t) + '</span><span class="check-meta">' + duePill(x) + (x.owner ? '<span class="pill teal">' + esc(x.owner) + '</span>' : '') + '</span></div></div>';
    }).join('') : '<p class="muted">Everything is ticked off.</p>') + '</div></div>';
    var decs = (G.decisions || []);
    var decCard = '<div class="card"><div class="rowflex between"><h3>Big decisions</h3><span class="small muted">' + decs.filter(function (d) { return (plan.decisions[d.id] || {}).done; }).length + ' of ' + decs.length + ' settled</span></div><div class="rows">' + decs.map(function (d) {
      var st = plan.decisions[d.id] || {};
      return '<div class="row"><div class="row-main"><b>' + esc(d.q) + '</b><span class="small ' + (st.a ? '' : 'muted') + '">' + esc(st.a || d.help) + '</span></div><div class="row-side">' + (st.done ? '<span class="pill good">Settled</span>' : '<span class="pill warn">Open</span>') + (canEdit() ? '<button class="btn sm" data-act="edit-decision" data-id="' + d.id + '">Edit</button>' : (d.go ? '<a class="small" href="#' + d.go + '">Read up</a>' : '')) + '</div></div>';
    }).join('') + '</div></div>';
    var cc = crewCounts(refDate() || td);
    var crewCard = '<div class="card"><div class="rowflex between"><h3>The crew</h3><a href="#crew" class="small">Roster and jobs</a></div><div class="rowflex" style="gap:14px 28px"><div class="stat"><span class="stat-n">' + cc.adult + '</span><span class="stat-l">adult tickets</span></div><div class="stat"><span class="stat-n">' + cc.child + '</span><span class="stat-l">child tickets</span></div><div class="stat"><span class="stat-n">' + cc.free + '</span><span class="stat-l">free, under 3</span></div></div>' + (plan.crew.some(function (m) { return m.example; }) ? '<p class="small muted">Some names are still placeholders. Add the real crew, with the kids\' birth months and heights, to get exact ticket counts and the ride chart.</p>' : '') + '</div>';
    h += '<section class="sec"><div class="grid two" style="align-items:start"><div class="stack">' + nextCard + crewCard + '</div>' + decCard + '</div></section>';

    var daily = G.daily || [], di = daily.length ? (dayOfYear() + (S.dailyShift || 0)) % daily.length : 0;
    h += '<section class="sec"><div class="grid two"><div class="card gold"><span class="eyebrow">Today\'s bit of magic</span><p style="font-size:1.12rem">' + esc(daily[di] || '') + '</p><button class="btn sm" data-act="daily-next" style="align-self:flex-start">Show me another</button></div>' +
      '<div class="card night"><span class="eyebrow" style="color:var(--gold)">Fun zone</span><h3>Games for the countdown</h3><p>See who is tall enough, spin the ride wheel, settle a ride showdown and test the family on park trivia.</p><a class="btn primary" href="#fun" style="align-self:flex-start">Play</a></div></div></section>';

    if (!s) {
      h += sec('Best windows from the research', 'The short list. The When to go page has the full picture and the dates to avoid.',
        '<div class="grid">' + (G.windows || []).slice(0, 3).map(function (w) { return '<div class="card"><span class="eyebrow">' + esc(w.grade) + ' ticket</span><h3>' + esc(w.title) + '</h3><p class="small">' + esc(w.summary) + '</p>' + crowdPill(w.crowd) + '</div>'; }).join('') + '</div>',
        '<a class="btn sm" href="#when">Compare windows</a>');
    }

    var ups = plan.updates.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    h += sec('Family updates', 'News from the organizers, newest first.',
      ups.length ? '<div class="card"><div class="rows">' + ups.map(function (u) {
        return '<div class="row"><span class="time">' + esc(fmtShort(pd(u.date))) + '<br>' + esc((pd(u.date) || today()).getFullYear()) + '</span><div class="row-main"><b>' + esc(u.title) + (unseen[u.id] ? ' <span class="pill poppy">New</span>' : '') + '</b><span>' + esc(u.body) + '</span></div>' + (canEdit() ? '<div class="row-side"><button class="btn sm" data-act="edit-update" data-id="' + u.id + '">Edit</button></div>' : '') + '</div>';
      }).join('') + '</div></div>' : '<div class="empty">No updates yet. Organizers post news here: dates locked, hotel booked, tickets bought.</div>',
      editBtn('add-update', 'Post an update'));
    return h;
  };

  /* ---------------- view: When ---------------- */
  V.when = function () {
    var h = head('When to go', 'When should we go?', G.whenLede || '');
    if (G.verdict) h += '<section class="sec"><div class="callout sun prose"><b>The short answer</b>' + G.verdict.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div></section>';

    h += sec('Ranked windows', 'In the park\'s old ticket-book days an E ticket got you on the best rides. E-ticket windows here are the best fits for our crew.',
      '<div class="grid two">' + (G.windows || []).map(function (w, i, all) {
        return '<div class="ticket ' + (w.grade === 'E' ? 'pick' : '') + (i === 0 && all.length % 2 ? ' wide' : '') + '"><div class="ticket-stub"><span class="ticket-letter">' + esc(w.grade) + '</span><span class="ticket-cap">ticket</span></div><div class="ticket-body"><h3>' + esc(w.title) + '</h3><div class="rowflex">' + crowdPill(w.crowd) + (w.tag ? '<span class="pill">' + esc(w.tag) + '</span>' : '') + '</div><p>' + esc(w.summary) + '</p>' +
          '<details class="more"><summary>Why, and what to watch</summary><div><b class="small">For it</b>' + bullets(w.pros) + '<b class="small">Against it</b>' + bullets(w.cons) + (w.school ? '<p class="small muted">' + esc(w.school) + '</p>' : '') + '</div></details>' +
          (canEdit() ? '<button class="btn sm" data-act="add-window" data-id="' + w.id + '" style="align-self:flex-start">Add to our shortlist</button>' : '') + '</div></div>';
      }).join('') + '</div>');

    var cands = plan.candidates;
    var stLabel = { option: ['Option', ''], fav: ['Front-runner', 'poppy'], out: ['Ruled out', 'bad'], chosen: ['Chosen', 'good'] };
    h += sec('Our shortlist', 'The windows our family is weighing. Organizers add options, then lock one to switch on the countdown dates.',
      cands.length ? '<div class="card"><div class="rows">' + cands.map(function (c) {
        var a = pd(c.start), b = pd(c.end), st = stLabel[c.status] || stLabel.option;
        return '<div class="row"><div class="row-main"><b>' + esc(c.label || 'Option') + '</b><span>' + esc(fmtRange(a, b) || 'Dates to be set') + (a && b ? ' · ' + plural(dayDiff(a, b), 'night') : '') + '</span>' + (c.note ? '<span class="small muted">' + esc(c.note) + '</span>' : '') + '</div><div class="row-side"><span class="pill ' + st[1] + '">' + st[0] + '</span>' +
          (canEdit() ? '<span class="rowflex"><button class="btn sm" data-act="edit-cand" data-id="' + c.id + '">Edit</button>' + (a && b && c.status !== 'chosen' ? '<button class="btn sm primary" data-act="lock-cand" data-id="' + c.id + '">Lock these dates</button>' : '') + '</span>' : '') + '</div></div>';
      }).join('') + '</div></div>' : '<div class="empty">Nothing on the shortlist yet.' + (canEdit() ? ' Add one of the ranked windows above, or enter your own dates.' : ' The organizers will add options here.') + '</div>',
      editBtn('add-cand', 'Add dates'));

    var mi = L.month == null ? -1 : L.month, mo = (G.months || [])[mi];
    h += sec('The year at a glance', 'Typical crowds by month. Tap a month for what is on and the weeks to pick or skip.',
      '<div class="scroll"><div class="heat">' + (G.months || []).map(function (m, i) {
        return '<button class="heat-m lv' + m.crowd + '" data-act="month" data-i="' + i + '" aria-pressed="' + (i === mi) + '"><b>' + esc(m.k) + '</b><em>' + ['', 'Very light', 'Light', 'Moderate', 'Busy', 'Packed'][m.crowd] + '</em><span>' + esc(m.hi + '° / ' + m.lo + '°') + '</span><span>' + esc(m.rain) + '</span></button>';
      }).join('') + '</div></div><div class="legend"><span><i class="lv1"></i>Very light</span><span><i class="lv2"></i>Light</span><span><i class="lv3"></i>Moderate</span><span><i class="lv4"></i>Busy</span><span><i class="lv5"></i>Packed</span><span>Darker means busier. Each month shows high / low °F and typical rain.</span></div>' +
      (mo ? '<div class="card"><h3>' + esc(mo.name) + '</h3><dl class="kv plain"><dt>Crowds</dt><dd>' + esc(mo.crowdNote) + '</dd><dt>Best bets</dt><dd>' + esc(mo.best) + '</dd><dt>Skip</dt><dd>' + esc(mo.worst) + '</dd><dt>What is on</dt><dd>' + esc(mo.on) + '</dd></dl></div>' : ''));

    var cols = G.ageDates || [];
    var withBirth = plan.crew.filter(function (m) { return pd(m.birth); });
    h += sec('2027 or 2028?', 'The trade-offs between the two years.',
      '<div class="card"><div class="scroll"><table class="tbl"><thead><tr><th></th><th>2027</th><th>2028</th></tr></thead><tbody>' + (G.yearCompare || []).map(function (r) { return '<tr><td><b>' + esc(r.topic) + '</b></td><td>' + esc(r.a) + '</td><td>' + esc(r.b) + '</td></tr>'; }).join('') + '</tbody></table></div></div>' +
      '<div class="card"><h3>Our crew\'s ages and ticket types by window</h3>' + (withBirth.length ? '<div class="scroll"><table class="tbl"><thead><tr><th>Who</th>' + cols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' + withBirth.map(function (m) {
        return '<tr><td><b>' + esc(m.name) + '</b></td>' + cols.map(function (c) { var on = pd(c.date), a = ageOn(m.birth, on), k = ticketClass(m, on); return '<td>' + (a < 0 ? 'Not born' : 'Age ' + a + ' · <span class="' + (k === 'free' ? 'yes' : k === 'adult' ? 'almost' : '') + '">' + (k === 'free' ? 'Free' : k === 'child' ? 'Child' : 'Adult') + '</span>') + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' : '<p class="muted">Add birth months on the Crew page to see who is free, who needs a child ticket and who pays the adult price in each window.</p>') +
      '<p class="small muted">' + esc(G.ageNote || '') + '</p></div>');

    h += sec('Dates to skip', '', tipCards(G.avoid, 'sm'));
    if (G.newStuff) h += sec('What is opening and closing', 'Construction and closures that could shape which year we pick.', faq(G.newStuff));
    if (G.events) h += sec('Seasons and special events', '', '<div class="card"><div class="rows">' + G.events.map(function (e) { return '<div class="row"><div class="row-main"><b>' + esc(e.t) + '</b><span class="small">' + esc(e.d) + '</span></div><div class="row-side"><span class="pill">' + esc(e.when) + '</span></div></div>'; }).join('') + '</div></div>');
    return h + sources('when');
  };

  /* ---------------- view: Countdown plan ---------------- */
  V.plan = function () {
    var s = tripStart(), tasks = allTasks(), done = tasks.filter(function (x) { return x.done; }).length;
    var h = head('Countdown', 'What to do, and when', s ? 'Every date below is worked out from our trip start, ' + fmt(s, true) + '.' : 'Jobs are grouped by how far ahead they happen. Once the organizers lock trip dates, each one gets a real due date.');
    h += '<section class="sec"><div class="rowflex between">' + seg('taskFilter', S.taskFilter, [['open', 'To do'], ['all', 'Everything'], ['done', 'Done']], 'task-filter') + '<span class="rowflex"><span class="muted small">' + done + ' of ' + tasks.length + ' done</span>' + editBtn('add-task', 'Add a job') + '</span></div></section>';
    (G.phases || []).forEach(function (p) {
      var list = tasks.filter(function (t) { return t.ph === p.id && (S.taskFilter === 'all' || (S.taskFilter === 'done') === t.done); });
      if (!list.length) return;
      var all = tasks.filter(function (t) { return t.ph === p.id; });
      var when = '';
      if (s && p.off != null) when = p.id === 'during' ? fmtRange(s, tripEnd()) : 'Around ' + fmt(addDays(s, -p.off));
      h += '<section class="sec"><div class="sec-head"><div class="sec-top"><h2>' + esc(p.label) + '</h2><span class="pill">' + all.filter(function (t) { return t.done; }).length + '/' + all.length + (when ? ' · ' + esc(when) : '') + '</span></div>' + (p.hint ? '<p>' + esc(p.hint) + '</p>' : '') + '</div><div class="card">' + list.map(function (t) {
        return '<div class="check ' + (t.done ? 'done' : '') + '"><input type="checkbox" id="t-' + esc(t.id) + '" data-chg="task" data-id="' + esc(t.id) + '"' + (t.done ? ' checked' : '') + (canEdit() ? '' : ' disabled') + ' aria-label="' + esc(t.t) + '"><div class="check-main"><label class="check-t" for="t-' + esc(t.id) + '">' + esc(t.t) + '</label>' + (t.d ? '<span class="small muted">' + esc(t.d) + '</span>' : '') + (t.note ? '<span class="small">Note: ' + esc(t.note) + '</span>' : '') + '<span class="check-meta">' + duePill(t) + (t.owner ? '<span class="pill teal">' + esc(t.owner) + '</span>' : '') + (t.go ? '<a class="small" href="#' + esc(t.go) + '">Details</a>' : '') + '</span></div>' + (canEdit() ? '<button class="btn sm" data-act="edit-task" data-id="' + esc(t.id) + '">' + (t.custom ? 'Edit' : 'Assign') + '</button>' : '') + '</div>';
      }).join('') + '</div></section>';
    });
    if (S.taskFilter === 'open' && done === tasks.length) h += '<div class="empty">Every job is done.</div>';
    if (G.records) h += sec('Keep these in one place', 'The paperwork a big group ends up hunting for.', '<div class="card">' + bullets(G.records) + '</div>');
    return h + sources('plan');
  };

  /* ---------------- view: Budget ---------------- */
  function estDefaults() {
    var e = L.est, t = plan.trip, c = G.costs || {};
    var d = { adults: 2, kids: 2, babies: 0, nights: num(t.nights, 5), days: Math.min(5, num(t.parkDays, 4)), when: defaultWhen(), lodge: (c.lodging || [{}])[0].id, rooms: 1, nightly: '', hopper: false, llDays: 1, travel: 'fly', flightPP: c.flightPP || 390, drive: 300, ground: c.ground || 150, food: 'mix', extras: 75 };
    Object.keys(d).forEach(function (k) { if (e[k] == null) e[k] = d[k]; });
    return e;
  }
  function defaultWhen() { var s = refDate(); if (!s) return '1'; return s < new Date(2027, 9, 6) ? '0' : s < new Date(2028, 9, 6) ? '1' : '2'; }
  function estimate(over) {
    var e = Object.assign({}, estDefaults(), over || {}), c = G.costs || {}, bumps = num(e.when, 1);
    var tk = Math.pow(1 + (c.bumpTickets || 0.05), bumps), ot = Math.pow(1 + (c.bumpOther || 0.04), bumps);
    var days = Math.max(1, Math.min(5, Math.round(num(e.days, 4)))), nights = Math.max(0, num(e.nights, 5));
    var A = Math.max(0, num(e.adults)), K = Math.max(0, num(e.kids)), B = Math.max(0, num(e.babies));
    var ad = (e.hopper ? c.hopAdult : c.adult) || {}, ch = (e.hopper ? c.hopChild : c.child) || {};
    var tickets = (A * (ad[days] || 0) + K * (ch[days] || 0)) * tk;
    var ll = Math.min(days, Math.max(0, num(e.llDays))) * (A + K) * (c.ll || 35) * tk;
    var tier = (c.lodging || []).find(function (x) { return x.id === e.lodge; }) || { night: 0 };
    var rate = e.nightly !== '' && e.nightly != null ? num(e.nightly) : tier.night * ot;
    var lodging = rate * Math.max(1, num(e.rooms, 1)) * nights * (1 + (c.tax || 0));
    var ft = (c.food || []).find(function (x) { return x.id === e.food; }) || { adult: 0, child: 0, baby: 0 };
    var food = (A * ft.adult + K * ft.child + B * (ft.baby || 0)) * (nights + 1) * ot;
    var travel = e.travel === 'fly' ? (A + K) * num(e.flightPP) : e.travel === 'drive' ? num(e.drive) : 0;
    var ground = num(e.ground), extras = (A + K) * num(e.extras);
    var rows = [['Park tickets, ' + days + '-day' + (e.hopper ? ' Park Hopper' : ''), tickets], ['Lightning Lane Multi Pass', ll], ['Lodging, ' + plural(nights, 'night') + ' incl. tax', lodging], ['Food', food], [e.travel === 'fly' ? 'Flights' : 'Driving', travel], ['Airport rides, parking, strollers', ground], ['Souvenirs and extras', extras]];
    var sub = rows.reduce(function (a, r) { return a + r[1]; }, 0), cushion = sub * 0.1;
    return { rows: rows, cushion: cushion, total: sub + cushion, people: A + K + B, rate: rate, tierRate: tier.night * ot };
  }
  function needBy() {
    var s = tripStart(); if (s) return addDays(s, -45);
    return [new Date(2027, 6, 1), new Date(2028, 1, 1), new Date(2028, 9, 1)][num(estDefaults().when, 1)] || new Date(2028, 1, 1);
  }
  function estOut() {
    var r = estimate();
    return '<div class="scroll"><table class="tbl"><tbody>' + r.rows.map(function (x) { return '<tr><td>' + esc(x[0]) + '</td><td class="num">' + money(x[1]) + '</td></tr>'; }).join('') + '<tr><td>Cushion for surprises (10%)</td><td class="num">' + money(r.cushion) + '</td></tr><tr class="total"><td>Estimated total</td><td class="num">' + money(r.total) + '</td></tr></tbody></table></div><p class="small muted">About ' + money(r.total / Math.max(1, r.people)) + ' per person. Room rate used: ' + money(r.rate) + ' a night before tax.</p>';
  }
  function crewOut(g, cc) {
    return '<div class="rowflex" style="gap:18px 30px"><div class="stat"><span class="stat-n">' + money(g.total) + '</span><span class="stat-l">for everyone, cushion included</span></div><div class="stat"><span class="stat-n">' + money(g.total / Math.max(1, g.people)) + '</span><span class="stat-l">per person</span></div><div class="stat"><span class="stat-n">' + cc.adult + ' + ' + cc.child + '</span><span class="stat-l">adult and child tickets' + (cc.free ? ', ' + cc.free + ' free' : '') + '</span></div></div>' +
      '<div class="scroll"><table class="tbl"><tbody>' + g.rows.map(function (x) { return '<tr><td>' + esc(x[0]) + '</td><td class="num">' + money(x[1]) + '</td></tr>'; }).join('') + '<tr><td>Cushion for surprises (10%)</td><td class="num">' + money(g.cushion) + '</td></tr></tbody></table></div>';
  }
  function crewEstimate() {
    var e = estDefaults(), cc = crewCounts(refDate() || today()), people = cc.adult + cc.child + cc.free, rooms = Math.max(1, Math.ceil(people / 4));
    return crewOut(estimate({ adults: cc.adult, kids: cc.child, babies: cc.free, rooms: rooms, nightly: '', ground: num(e.ground) * rooms, drive: num(e.drive) * rooms }), cc);
  }
  var MILES = [[25, 'A quarter there'], [50, 'Halfway'], [75, 'Nearly there'], [100, 'Fully funded']];
  function saveOut() {
    var r = estimate(), saved = L.saved.reduce(function (a, x) { return a + num(x.amt); }, 0), left = Math.max(0, r.total - saved);
    var by = needBy(), days = Math.max(7, dayDiff(today(), by)), months = Math.max(1, days / 30.44);
    return '<div class="rowflex" style="gap:18px 30px"><div class="stat"><span class="stat-n">' + money(left / months) + '</span><span class="stat-l">to set aside each month</span></div><div class="stat"><span class="stat-n">' + money(left / (days / 7)) + '</span><span class="stat-l">or each week</span></div><div class="stat"><span class="stat-n">' + money(saved) + '</span><span class="stat-l">saved so far of ' + money(r.total) + '</span></div></div><div class="meter" role="img" aria-label="Savings progress"><i style="width:' + Math.min(100, Math.round(saved / Math.max(1, r.total) * 100)) + '%"></i></div><div class="miles">' + MILES.map(function (m) { return '<div class="mile' + (saved / Math.max(1, r.total) * 100 >= m[0] ? ' on' : '') + '"><i></i><span>' + m[1] + '</span></div>'; }).join('') + '</div><p class="small muted">Aiming to have it all by ' + fmt(by) + (tripStart() ? ', 45 days before we leave, when final payments start to fall due.' : ', based on the travel period chosen above.') + '</p>';
  }
  V.money = function () {
    var e = estDefaults(), c = G.costs || {};
    var n = function (k, label, extra) { return '<label class="field" for="e-' + k + '"><span>' + label + '</span><input type="number" id="e-' + k + '" data-inp="est" data-k="' + k + '" value="' + esc(e[k]) + '" min="0" inputmode="decimal" ' + (extra || '') + '></label>'; };
    var sel = function (k, label, opts) { return '<label class="field" for="e-' + k + '"><span>' + label + '</span><select id="e-' + k + '" data-inp="est" data-k="' + k + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(e[k]) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>'; };
    var h = head('Budget', 'What it costs, and how to save for it', G.moneyLede || '');
    h += sec('Your household\'s estimate', 'Change the numbers to match your household. This is private: it stays on this device and nobody else sees it.',
      '<div class="grid two"><div class="card"><div class="fgrid">' + n('adults', 'Adults and kids 10+') + n('kids', 'Kids 3 to 9') + n('babies', 'Under 3 (free)') + n('nights', 'Hotel nights') + n('days', 'Park days (1 to 5)', 'max="5"') + n('rooms', 'Rooms') + '</div>' +
      sel('when', 'When we travel', [['0', 'Before October 2027 (today\'s prices)'], ['1', 'October 2027 to September 2028'], ['2', 'October 2028 or later']]) +
      sel('lodge', 'Where we stay', (c.lodging || []).map(function (x) { return [x.id, x.label]; })) +
      '<div class="fgrid">' + n('nightly', 'Or your own nightly rate', 'placeholder="auto"') + n('llDays', 'Lightning Lane days') + '</div>' +
      '<label class="rowflex" for="e-hopper"><input type="checkbox" id="e-hopper" data-inp="est" data-k="hopper"' + (e.hopper ? ' checked' : '') + ' style="width:22px;height:22px;accent-color:var(--poppy)"><span>Park Hopper tickets (both parks on the same day)</span></label>' +
      sel('food', 'How we eat', (c.food || []).map(function (x) { return [x.id, x.label]; })) +
      sel('travel', 'Getting there', [['fly', 'Flying'], ['drive', 'Driving'], ['none', 'No travel cost']]) +
      '<div class="fgrid">' + n('flightPP', 'Flight per person') + n('drive', 'Driving total') + n('ground', 'Airport rides, parking') + n('extras', 'Souvenirs per person') + '</div></div>' +
      '<div class="stack"><div class="card lift" id="est-out">' + estOut() + '</div><div class="card" id="save-out">' + '<h3>Your savings plan</h3>' + saveOut() + '</div>' +
      '<div class="card"><div class="rowflex between"><h3>Savings log</h3><button class="btn sm" data-act="add-saved">Add money saved</button></div>' + (L.saved.length ? '<div class="rows">' + L.saved.map(function (x, i) { return '<div class="row"><div class="row-main"><b>' + money(num(x.amt)) + '</b><span class="small muted">' + esc(x.note || '') + ' ' + esc(fmt(pd(x.date))) + '</span></div><div class="row-side"><button class="btn sm" data-act="del-saved" data-i="' + i + '">Remove</button></div></div>'; }).join('') + '</div>' : '<p class="muted small">Log each deposit or gift card you put toward the trip and watch the bar fill.</p>') + '</div></div></div>');
    var cc = crewCounts(refDate() || today()), people = cc.adult + cc.child + cc.free, rooms = Math.max(1, Math.ceil(people / 4));
    if (people > 1) {
      var g = estimate({ adults: cc.adult, kids: cc.child, babies: cc.free, rooms: rooms, nightly: '', ground: num(e.ground) * rooms, drive: num(e.drive) * rooms });
      h += sec('The whole crew', 'All ' + people + ' of us, worked out from the Crew page with the same choices as the estimate above and ' + rooms + ' rooms. Change a choice up there and this follows.',
        '<div class="card gold" id="crew-out">' + crewOut(g, cc) + '</div>');
    }
    if (G.prices) h += sec('Real prices right now', 'As of ' + (G.asOfLabel || '') + '. Disneyland has raised prices every October for five years running.', '<div class="card"><div class="scroll"><table class="tbl"><thead><tr><th>What</th><th class="num">Price</th><th>Good to know</th></tr></thead><tbody>' + G.prices.map(function (p) { return '<tr><td><b>' + esc(p.item) + '</b></td><td class="num">' + esc(p.price) + '</td><td class="small">' + esc(p.note || '') + '</td></tr>'; }).join('') + '</tbody></table></div></div>');
    if (G.benchmarks) h += sec('What other families spend', '', tipCards(G.benchmarks, 'sm'));
    h += sec('Ways to save', 'The tactics the Disneyland money guides agree on.', tipCards(G.saving));
    if (G.savingPlan) h += sec('Building the trip fund', '', faq(G.savingPlan));
    if (G.moneyRules) h += sec('Money and a big group', 'Settle these early and nobody has to have an awkward talk in a churro line.', tipCards(G.moneyRules, 'sm'));
    return h + sources('money');
  };

  /* ---------------- view: Stay & travel ---------------- */
  V.stay = function () {
    var s = tripStart();
    var h = head('Stay and travel', 'Where we sleep and how we get there', G.stayLede || '');
    h += sec('Four ways to house a big crew', 'Rough totals for our 15 for 5 nights, in 2027 dollars.', '<div class="grid two">' + (G.lodgingPlans || []).map(function (p, i) {
      return '<div class="ticket ' + (i === 0 ? 'pick' : '') + '"><div class="ticket-stub"><span class="ticket-letter">' + (i + 1) + '</span><span class="ticket-cap">' + (i === 0 ? 'Top pick' : 'Option') + '</span></div><div class="ticket-body"><h3>' + esc(p.t) + '</h3><span class="pill sun" style="align-self:flex-start">' + esc(p.cost) + '</span><p>' + esc(p.d) + '</p><details class="more"><summary>For and against</summary><div><b class="small">For it</b>' + bullets(p.pros) + '<b class="small">Against it</b>' + bullets(p.cons) + '</div></details></div></div>';
    }).join('') + '</div>');
    h += sec('Hotels worth a look', 'Walk times are to the main gate. Rates move a lot by date, so treat them as a starting point.', '<div class="card"><div class="scroll"><table class="tbl"><thead><tr><th>Hotel</th><th>Walk</th><th>Big-family rooms</th><th>Perks</th><th>Watch for</th></tr></thead><tbody>' + (G.hotels || []).map(function (x) {
      return '<tr><td><b>' + esc(x.n) + '</b>' + (x.tag ? '<br><span class="pill teal">' + esc(x.tag) + '</span>' : '') + '</td><td>' + esc(x.walk) + '</td><td>' + esc(x.rooms) + '</td><td>' + esc(x.perks) + '</td><td class="small">' + esc(x.watch) + '</td></tr>';
    }).join('') + '</tbody></table></div></div>');

    var stL = { idea: ['Idea', ''], front: ['Front-runner', 'poppy'], booked: ['Booked', 'good'], out: ['Ruled out', 'bad'] };
    h += sec('Our lodging shortlist', 'Places the family is considering.',
      plan.lodging.length ? '<div class="card"><div class="rows">' + plan.lodging.map(function (x) {
        var st = stL[x.status] || stL.idea, u = httpsLink(x.link);
        return '<div class="row"><div class="row-main"><b>' + esc(x.name) + '</b><span class="small">' + esc([x.price, x.note].filter(Boolean).join(' · ')) + '</span>' + (u ? '<a class="small" href="' + esc(u) + '" target="_blank" rel="noopener">Open listing</a>' : '') + '</div><div class="row-side"><span class="pill ' + st[1] + '">' + st[0] + '</span>' + (canEdit() ? '<button class="btn sm" data-act="edit-lodge" data-id="' + x.id + '">Edit</button>' : '') + '</div></div>';
      }).join('') + '</div></div>' : '<div class="empty">No places saved yet.</div>', editBtn('add-lodge', 'Add a place'));

    h += sec('When each thing can be booked', s ? 'Worked out from our trip start, ' + fmt(s) + '.' : 'Lock trip dates to turn these into calendar dates.',
      '<div class="card"><div class="rows">' + (G.bookWindows || []).map(function (b) {
        var when = b.when;
        if (s && b.off != null) { var d = addDays(s, -b.off); when = (d < today() ? 'Open now (since ' + fmt(d) + ')' : 'Opens ' + fmt(d)); }
        return '<div class="row"><div class="row-main"><b>' + esc(b.t) + '</b><span class="small">' + esc(b.d) + '</span></div><div class="row-side"><span class="pill ' + (s && b.off != null ? 'poppy' : '') + '">' + esc(when) + '</span></div></div>';
      }).join('') + '</div></div>');

    h += sec('What is booked', 'Confirmed reservations. Anyone with the link can read this page, so keep full confirmation numbers and card details out of it.',
      plan.bookings.length ? '<div class="card"><div class="rows">' + plan.bookings.map(function (b) {
        return '<div class="row"><div class="row-main"><b>' + esc(b.title) + '</b><span class="small">' + esc([b.kind, fmt(pd(b.when)), b.who].filter(Boolean).join(' · ')) + '</span>' + (b.detail ? '<span class="small muted">' + esc(b.detail) + '</span>' : '') + '</div>' + (canEdit() ? '<div class="row-side"><button class="btn sm" data-act="edit-booking" data-id="' + b.id + '">Edit</button></div>' : '') + '</div>';
      }).join('') + '</div></div>' : '<div class="empty">Nothing booked yet. The first entry here will probably be a refundable hotel hold.</div>', editBtn('add-booking', 'Add a booking'));

    h += sec('Which airport', '', '<div class="card"><div class="scroll"><table class="tbl"><thead><tr><th>Airport</th><th>Drive to the parks</th><th>Ride cost</th><th>Verdict</th></tr></thead><tbody>' + (G.airports || []).map(function (a) { return '<tr><td><b>' + esc(a.code) + '</b><br><span class="small">' + esc(a.name) + '</span></td><td>' + esc(a.drive) + '</td><td>' + esc(a.ride) + '</td><td class="small">' + esc(a.note) + '</td></tr>'; }).join('') + '</tbody></table></div></div>');
    h += sec('Getting around', '', tipCards(G.transport));
    return h + sources('stay');
  };

  /* ---------------- view: Parks ---------------- */
  function rideKey(r) { return r.p + ':' + r.n; }
  V.parks = function () {
    var sub = L.sub.parks || 'rides';
    var h = head('Parks', 'Rides, food and a game plan', G.parksLede || '');
    h += '<section class="sec">' + seg('parks', sub, [['rides', 'Rides and heights'], ['little', 'Baby and little kids'], ['grand', 'Grandparents'], ['food', 'Food'], ['plan', 'Game plan']]) + '</section>';
    if (sub === 'rides') h += parksRides();
    if (sub === 'little') h += sec('August and the under-fives', 'Disneyland is the easier of the two Disney resorts with a baby: the parks are compact and far more rides have no height rule.', tipCards(G.little)) + sec('For the elementary crowd', '', tipCards(G.kids));
    if (sub === 'grand') h += sec('Making it easy on the grandparents', '', tipCards(G.grand));
    if (sub === 'food') h += sec('Meals worth booking', 'Dining reservations open 60 days ahead at 6 a.m. Pacific. Character meals go first.', '<div class="card"><div class="scroll"><table class="tbl"><thead><tr><th>Where</th><th>What</th><th>Cost</th><th>Good to know</th></tr></thead><tbody>' + (G.dining || []).map(function (d) { return '<tr><td><b>' + esc(d.n) + '</b><br><span class="small">' + esc(d.where) + '</span></td><td>' + esc(d.kind) + '</td><td>' + esc(d.price) + '</td><td class="small">' + esc(d.note) + '</td></tr>'; }).join('') + '</tbody></table></div></div>') + sec('Feeding a crowd', '', tipCards(G.foodTips));
    if (sub === 'plan') h += sec('How to tour with a big group', '', tipCards(G.strategy)) + sec('Lightning Lane, plainly', '', faq(G.llGuide)) + sec('Sample days', 'Starting points to bend around naps and energy.', '<div class="grid two">' + (G.sampleDays || []).map(function (d) { return '<div class="card"><h3>' + esc(d.t) + '</h3>' + (d.d ? '<p class="small muted">' + esc(d.d) + '</p>' : '') + '<div class="rows">' + d.steps.map(function (s) { return '<div class="row" style="padding:7px 0"><span class="time">' + esc(s[0]) + '</span><div class="row-main"><span>' + esc(s[1]) + '</span></div></div>'; }).join('') + '</div></div>'; }).join('') + '</div>') + sec('Shows and parades', '', tipCards(G.entertainment, 'sm'));
    return h + sources('parks');
  };
  function parksRides() {
    var rides = G.rides || [], kids = plan.crew.filter(isChild).map(function (m) { return { m: m, h: heightAtTrip(m) }; }).filter(function (k) { return k.h; });
    var marks = []; rides.forEach(function (r) { if (r.h && marks.indexOf(r.h) < 0) marks.push(r.h); }); marks.sort(function (a, b) { return a - b; });
    var pos = function (v) { return Math.max(0, Math.min(100, (v - 30) / 26 * 100)); };
    var h = '';
    var ruler = '<div class="scroll"><div class="ruler" role="img" aria-label="Height ruler from 30 to 56 inches with ride height rules">' +
      '<div class="ruler-bar"></div>' + marks.map(function (m) { var c = rides.filter(function (r) { return r.h === m; }).length; return '<div class="ruler-tick" style="left:' + pos(m) + '%"><b>' + m + '"</b>' + c + (c === 1 ? ' ride' : ' rides') + '</div>'; }).join('') +
      kids.map(function (k) { return '<div class="ruler-kid" style="left:' + pos(k.h.h) + '%"><span>' + esc(k.m.name) + ' ' + k.h.h + '"' + (k.h.est ? '*' : '') + '</span><i></i></div>'; }).join('') + '</div></div>';
    var body = ruler;
    if (kids.length) {
      var gated = rides.filter(function (r) { return r.h; }).sort(function (a, b) { return a.h - b.h; });
      body += '<div class="scroll"><table class="tbl"><thead><tr><th>Ride</th><th class="num">Rule</th>' + kids.map(function (k) { return '<th>' + esc(k.m.name) + '</th>'; }).join('') + '</tr></thead><tbody>' + gated.map(function (r) {
        return '<tr><td><b>' + esc(r.n) + '</b> <span class="small muted">' + esc(r.p) + '</span></td><td class="num">' + r.h + '"</td>' + kids.map(function (k) { var d = k.h.h - r.h; return '<td class="' + (d >= 0 ? 'yes' : d >= -1.5 ? 'almost' : 'no') + '">' + (d >= 0 ? 'Yes' : d >= -1.5 ? 'Close' : 'Not yet') + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div><p class="small muted">' + (kids.some(function (k) { return k.h.est; }) ? '* Estimated height at trip time, assuming typical growth since the date measured. ' : '') + 'Cast members measure at the ride with shoes on. "Close" means within an inch and a half: measure again nearer the trip, and never promise a ride.</p>';
    } else {
      body += '<p class="muted">Add each child\'s height on the Crew page and this turns into a chart of exactly who can ride what. ' + rides.filter(function (r) { return !r.h; }).length + ' of ' + rides.length + ' attractions listed here have no height rule at all.</p>';
    }
    h += sec('Who can ride what', 'Every ride with a height rule, lined up against our kids.', '<div class="card">' + body + '</div>');

    var list = rides.filter(function (r) { return (S.ridePark === 'all' || r.p === S.ridePark) && (S.rideFit === 'all' || (S.rideFit === 'any' ? !r.h : S.rideFit === 'tall' ? !!r.h : !!L.stars[rideKey(r)])); });
    var starCount = Object.keys(L.stars).filter(function (k) { return L.stars[k]; }).length;
    h += sec('Every ride', 'Star your must-dos. Stars are saved on this device; copy your list and send it to the organizers.',
      '<div class="rowflex">' + seg('ridePark', S.ridePark, [['all', 'Both parks'], ['DL', 'Disneyland Park'], ['DCA', 'California Adventure']], 'ride-filter') + seg('rideFit', S.rideFit, [['all', 'All'], ['any', 'No height rule'], ['tall', 'Height rule'], ['star', 'My stars (' + starCount + ')']], 'ride-filter') + (starCount ? '<button class="btn sm" data-act="copy-stars">Copy my list</button>' : '') + '</div>' +
      '<div class="card"><div class="scroll"><table class="tbl"><thead><tr><th></th><th>Ride</th><th>Land</th><th class="num">Height</th><th>Kind</th><th>Skip the line</th></tr></thead><tbody>' + (list.length ? list.map(function (r) {
        var on = !!L.stars[rideKey(r)];
        return '<tr><td><button class="btn sm" data-act="star" data-id="' + esc(rideKey(r)) + '" aria-pressed="' + on + '" aria-label="' + (on ? 'Remove star from ' : 'Star ') + esc(r.n) + '"' + (on ? ' style="background:var(--sun);color:#14213D;border-color:var(--sun)"' : '') + '>' + (on ? 'Starred' : 'Star') + '</button></td><td><b>' + esc(r.n) + '</b>' + (r.note ? '<br><span class="small muted">' + esc(r.note) + '</span>' : '') + '</td><td class="small">' + esc(r.land) + '<br><span class="muted">' + (r.p === 'DL' ? 'Disneyland Park' : 'California Adventure') + '</span></td><td class="num">' + (r.h ? r.h + '"' : 'Any') + '</td><td class="small">' + esc(r.type) + '</td><td class="small">' + esc(r.ll || 'Standby only') + '</td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted">No rides match.</td></tr>') + '</tbody></table></div></div>');
    if (G.rideNotes) h += sec('Good to know about rides', '', faq(G.rideNotes));
    return h;
  }

  /* ---------------- view: Fun zone ---------------- */
  var FUN_TABS = [['height', 'Am I tall enough?'], ['wheel', 'Ride wheel'], ['duel', 'Ride showdown'], ['quiz', 'Trivia'], ['movies', 'Movie nights']];
  V.fun = function () {
    var sub = L.sub.fun || 'height';
    var h = head('Fun zone', 'Play your way to the park', 'Games and gadgets for the countdown. Everything here saves on this device only, so every kid gets their own.');
    h += '<section class="sec">' + seg('fun', sub, FUN_TABS) + '</section>';
    return h + ({ height: funHeight, wheel: funWheel, duel: funDuel, quiz: funQuiz, movies: funMovies }[sub] || funHeight)();
  };

  // --- Am I tall enough?
  function hcValue() { return Math.max(30, Math.min(56, num(L.hc, 40))); }
  function hcPos(x) { return Math.max(0, Math.min(100, (x - 30) / 26 * 100)); }
  function hcOut() {
    var v = hcValue(), rides = G.rides || [], ok = rides.filter(function (r) { return r.h <= v; }), gated = rides.filter(function (r) { return r.h; });
    var mine = gated.filter(function (r) { return r.h <= v; }).sort(function (a, b) { return b.h - a.h; }), not = gated.filter(function (r) { return r.h > v; }).sort(function (a, b) { return a.h - b.h; });
    var top = mine.length ? mine[0].h : 0, next = not[0];
    return '<div class="rowflex" style="gap:8px 26px;align-items:baseline"><span class="bignum">' + v + ' in</span><span><b>' + ok.length + ' of ' + rides.length + '</b> rides and shows are yours</span></div>' +
      '<div class="meter" role="img" aria-label="' + ok.length + ' of ' + rides.length + ' rides"><i style="width:' + Math.round(ok.length / Math.max(1, rides.length) * 100) + '%"></i></div>' +
      (next ? '<p><b>Next unlock at ' + next.h + ' in:</b> ' + esc(not.filter(function (r) { return r.h === next.h; }).map(function (r) { return r.n; }).join(', ')) + '. Just ' + (Math.round((next.h - v) * 2) / 2) + ' in to go.</p>' : '<p><b>Every single ride is unlocked.</b> Nothing in either park is off limits.</p>') +
      (mine.length ? '<div><p class="small muted" style="margin-bottom:6px">Height-rule rides you can do. Gold is your newest unlock.</p><div class="chips">' + mine.map(function (r) { return '<span class="chip' + (r.h === top ? ' new' : '') + '">' + esc(r.n) + ' ' + r.h + '"</span>'; }).join('') + '</div></div>' : '') +
      (not.length ? '<div><p class="small muted" style="margin-bottom:6px">Not yet</p><div class="chips">' + not.map(function (r) { return '<span class="chip no">' + esc(r.n) + ' ' + r.h + '"</span>'; }).join('') + '</div></div>' : '');
  }
  function updateHc() {
    var v = hcValue(), out = document.getElementById('hc-out'), fill = document.getElementById('hc-fill'), me = document.getElementById('hc-me'), tag = document.getElementById('hc-tag');
    if (out) out.innerHTML = hcOut();
    if (fill) fill.style.height = hcPos(v) + '%';
    if (me) me.style.bottom = hcPos(v) + '%';
    if (tag) tag.textContent = v + '"';
  }
  function funHeight() {
    var v = hcValue(), marks = [];
    (G.rides || []).forEach(function (r) { if (r.h && marks.indexOf(r.h) < 0) marks.push(r.h); });
    var kids = plan.crew.filter(isChild).map(function (m) { return { m: m, h: heightAtTrip(m) }; }).filter(function (k) { return k.h; });
    return sec('Am I tall enough?', 'Slide to your height and watch the rides unlock. Cast members measure at the ride with shoes on.',
      '<div class="card"><div class="tool split"><div class="stick" aria-hidden="true"><div class="stick-fill" id="hc-fill" style="height:' + hcPos(v) + '%"></div>' + marks.map(function (m) { return '<span class="stick-tick" style="bottom:' + hcPos(m) + '%">' + m + '"</span>'; }).join('') + '<div class="stick-me" id="hc-me" style="bottom:' + hcPos(v) + '%"><span id="hc-tag">' + v + '"</span></div></div>' +
      '<div class="stack"><label class="field" for="hc"><span>My height in inches</span><input type="range" id="hc" min="30" max="56" step="0.5" value="' + v + '" data-inp="hc"></label>' +
      (kids.length ? '<div class="rowflex"><span class="small muted">Jump to</span>' + kids.map(function (k) { return '<button class="btn sm" data-act="hc-set" data-v="' + k.h.h + '">' + esc(k.m.name) + ' ' + k.h.h + '"</button>'; }).join('') + '</div>' : '') +
      '<div class="stack" id="hc-out">' + hcOut() + '</div></div></div></div>');
  }

  // --- Ride wheel
  var WHEEL_COL = ['#FFC83D', '#C4287C', '#2B3FD0', '#7FE3FF', '#45288A', '#FF8AC2', '#F0A20A', '#1D1968', '#8CF5B0', '#5C62D8'];
  var WHEEL_INK = ['#1A1446', '#FFFFFF', '#FFFFFF', '#1A1446', '#FFFFFF', '#1A1446', '#1A1446', '#FFFFFF', '#1A1446', '#FFFFFF'];
  var W = { slices: null, angle: 0, result: null, busy: false, sig: '' };
  function shortest() { var hs = plan.crew.filter(isChild).map(heightAtTrip).filter(Boolean).map(function (x) { return x.h; }); return hs.length ? Math.min.apply(null, hs) : null; }
  function wheelPool() {
    var park = L.wheelPark || 'all', fit = L.wheelFit || 'all', sh = shortest();
    return (G.rides || []).filter(function (r) { return (park === 'all' || r.p === park) && (fit === 'all' || (fit === 'any' ? !r.h : fit === 'crew' ? r.h <= (sh || 0) : !!L.stars[rideKey(r)])); });
  }
  function wheelDeal() { W.slices = shuffle(wheelPool().slice()).slice(0, 10); W.result = null; W.angle = 0; }
  function wheelOut() {
    if (W.busy) return '<h3>Round and round it goes...</h3>';
    if (!W.result) return '<h3>On this wheel</h3><div class="chips">' + (W.slices || []).map(function (r, i) { return '<span class="chip" style="background:' + WHEEL_COL[i % 10] + ';color:' + WHEEL_INK[i % 10] + '">' + esc(r.n) + '</span>'; }).join('') + '</div><p class="small muted">Ten rides are dealt at random from the ones that match.</p>';
    var r = W.result, on = !!L.stars[rideKey(r)];
    return '<span class="eyebrow">The wheel says</span><p class="bignum" style="font-size:clamp(1.8rem,1.4rem + 2vw,2.6rem)">' + esc(r.n) + '</p><div class="rowflex"><span class="pill teal">' + esc(r.land) + ', ' + (r.p === 'DL' ? 'Disneyland Park' : 'California Adventure') + '</span><span class="pill">' + (r.h ? r.h + ' in or taller' : 'Any height') + '</span><span class="pill">' + esc(r.type) + '</span></div>' + (r.note ? '<p class="small muted">' + esc(r.note) + '</p>' : '') + '<div class="rowflex"><button class="btn sm" data-act="star" data-id="' + esc(rideKey(r)) + '">' + (on ? 'Starred' : 'Star this ride') + '</button></div>';
  }
  function funWheel() {
    var sig = (L.wheelPark || 'all') + '|' + (L.wheelFit || 'all');
    if (!W.slices || W.sig !== sig) { W.sig = sig; wheelDeal(); }
    var fits = [['all', 'Any ride'], ['any', 'No height rule']];
    if (shortest()) fits.push(['crew', 'Our shortest rider can go']);
    fits.push(['star', 'My starred rides']);
    return sec('Ride wheel', 'Cannot agree on what to ride next? Let the wheel decide.',
      '<div class="rowflex">' + seg('wheelPark', L.wheelPark || 'all', [['all', 'Both parks'], ['DL', 'Disneyland Park'], ['DCA', 'California Adventure']], 'wheel-set') + seg('wheelFit', L.wheelFit || 'all', fits, 'wheel-set') + '</div>' +
      '<div class="card"><div class="tool half"><div class="stack" style="align-items:center">' + (W.slices.length >= 2 ? '<div class="wheel-wrap"><span class="wheel-pin" aria-hidden="true"></span><canvas id="wheel" width="680" height="680" role="img" aria-label="A wheel of ' + W.slices.length + ' rides"></canvas><span class="wheel-hub" aria-hidden="true"></span></div><div class="rowflex" style="justify-content:center"><button class="btn primary big" data-act="wheel-spin">Spin the wheel</button><button class="btn" data-act="wheel-deal">Deal new rides</button></div>' : '<div class="empty">Not enough rides match. Loosen the filters, or star a few rides on the Parks page.</div>') + '</div>' +
      '<div class="stack" id="wheel-out" aria-live="polite">' + wheelOut() + '</div></div></div>');
  }
  function drawWheel() {
    var cv = document.getElementById('wheel'); if (!cv || !W.slices) return;
    var c = cv.getContext('2d'), n = W.slices.length, R0 = 340, a = Math.PI * 2 / n;
    c.clearRect(0, 0, 680, 680);
    for (var i = 0; i < n; i++) {
      c.beginPath(); c.moveTo(R0, R0); c.arc(R0, R0, R0, i * a, (i + 1) * a); c.closePath(); c.fillStyle = WHEEL_COL[i % 10]; c.fill();
      c.strokeStyle = '#0B1140'; c.lineWidth = 3; c.stroke();
      c.save(); c.translate(R0, R0); c.rotate(i * a + a / 2); c.fillStyle = WHEEL_INK[i % 10]; c.font = '600 25px Fredoka, "Trebuchet MS", sans-serif'; c.textAlign = 'right'; c.textBaseline = 'middle';
      var label = W.slices[i].n; if (label.length > 22) label = label.slice(0, 20).trim() + '...';
      c.fillText(label, R0 - 22, 0); c.restore();
    }
    cv.style.transition = 'none'; cv.style.transform = 'rotate(' + W.angle + 'deg)';
  }

  // --- Ride showdown
  var DUEL_ROUNDS = 15, duelPair = null;
  function duelState() { if (!L.duel) L.duel = { r: {}, seen: {}, n: 0 }; return L.duel; }
  function duelNext() {
    var d = duelState(), rides = (G.rides || []).map(function (r) { return { r: r, k: (d.seen[rideKey(r)] || 0) + Math.random() }; }).sort(function (a, b) { return a.k - b.k; });
    duelPair = [rides[0].r, rides[1].r];
  }
  function duelTop(n) { var d = duelState(); return (G.rides || []).filter(function (r) { return d.seen[rideKey(r)]; }).sort(function (a, b) { return (d.r[rideKey(b)] || 1000) - (d.r[rideKey(a)] || 1000); }).slice(0, n); }
  function funDuel() {
    var d = duelState(); if (!duelPair) duelNext();
    var card = function (r, side) { return '<button data-act="duel" data-w="' + side + '"><span class="eyebrow">' + esc(r.land) + '</span><b>' + esc(r.n) + '</b><span class="rowflex" style="justify-content:center"><span class="pill">' + (r.h ? r.h + ' in or taller' : 'Any height') + '</span><span class="pill teal">' + esc(r.type) + '</span></span></button>'; };
    var done = d.n >= DUEL_ROUNDS, top = duelTop(8);
    var h = sec('Ride showdown', 'Two rides, one pick: which would you rather ride? After ' + DUEL_ROUNDS + ' rounds you get your own top list to send to the organizers.',
      '<div class="card"><div class="rowflex between"><span class="pill sun">' + (done ? 'Bonus round ' + (d.n - DUEL_ROUNDS + 1) : 'Round ' + (d.n + 1) + ' of ' + DUEL_ROUNDS) + '</span><button class="btn sm" data-act="duel-skip">Skip this pair</button></div><div class="duel">' + card(duelPair[0], 0) + '<span class="vs" aria-hidden="true">or</span>' + card(duelPair[1], 1) + '</div><div class="meter" role="img" aria-label="Round ' + Math.min(d.n, DUEL_ROUNDS) + ' of ' + DUEL_ROUNDS + '"><i style="width:' + Math.min(100, Math.round(d.n / DUEL_ROUNDS * 100)) + '%"></i></div></div>');
    if (top.length >= 3) h += sec(done ? 'My top rides' : 'My top rides so far', done ? 'Keep playing to sharpen the list, or send it to the organizers now.' : '',
      '<div class="card"><ol class="rank">' + top.map(function (r) { return '<li><span>' + esc(r.n) + '</span></li>'; }).join('') + '</ol><div class="rowflex"><button class="btn primary" data-act="duel-copy">Copy my list</button><button class="btn" data-act="duel-star">Star my top five</button><button class="btn" data-act="duel-reset">Start over</button></div></div>');
    return h;
  }

  // --- Trivia
  var Q = null;
  function funQuiz() {
    var bank = G.trivia || [];
    if (!Q) return sec('Trivia challenge', 'Ten questions about the park. Read them out at dinner and see who knows the most.',
      '<div class="card gold"><div class="rowflex" style="gap:18px 30px"><div class="stat"><span class="stat-n">' + (L.quizBest != null ? L.quizBest + '/10' : 'None yet') + '</span><span class="stat-l">best score on this device</span></div><div class="stat"><span class="stat-n">' + bank.length + '</span><span class="stat-l">questions in the vault</span></div></div><button class="btn primary big" data-act="quiz-start" style="align-self:flex-start">Start a round</button></div>');
    if (Q.i >= Q.order.length) {
      var msg = Q.score >= 9 ? 'Park historian. You could lead the tour.' : Q.score >= 7 ? 'So close to perfect.' : Q.score >= 4 ? 'A solid start. Another round will lift it.' : 'Plenty left to discover, which is half the fun.';
      return sec('Trivia challenge', '', '<div class="card gold"><span class="eyebrow">Final score</span><p class="bignum">' + Q.score + ' out of ' + Q.order.length + '</p><p>' + msg + '</p><p class="small muted">Best on this device: ' + L.quizBest + ' out of 10.</p><button class="btn primary" data-act="quiz-start" style="align-self:flex-start">Play again</button></div>');
    }
    var q = bank[Q.order[Q.i]], picked = Q.pick != null;
    return sec('Trivia challenge', '', '<div class="card"><div class="rowflex between"><span class="pill sun">Question ' + (Q.i + 1) + ' of ' + Q.order.length + '</span><span class="pill">Score ' + Q.score + '</span></div><h3 style="font-size:1.35rem">' + esc(q.q) + '</h3><div class="quiz-opts">' + q.a.map(function (opt, i) {
      var cls = !picked ? '' : i === q.c ? ' right' : i === Q.pick ? ' wrong' : '';
      return '<button class="quiz-opt' + cls + '" data-act="quiz-pick" data-i="' + i + '"' + (picked ? ' disabled' : '') + '>' + esc(opt) + (picked && i === q.c ? ' (correct)' : '') + '</button>';
    }).join('') + '</div>' + (picked ? '<div class="callout' + (Q.pick === q.c ? ' sun' : '') + '" role="status"><b>' + (Q.pick === q.c ? 'Correct!' : 'Not quite.') + '</b><p>' + esc(q.f) + '</p></div><button class="btn primary" data-act="quiz-next" style="align-self:flex-start">' + (Q.i + 1 >= Q.order.length ? 'See my score' : 'Next question') + '</button>' : '') + '</div>');
  }

  // --- Movie nights
  function funMovies() {
    var list = G.movies || [], seen = list.filter(function (m, i) { return L.movies && L.movies[i]; }).length;
    return sec('Movie nights', seen + ' of ' + list.length + ' watched. Every film here has a ride or a place waiting for it in the parks.',
      '<div class="card"><div class="meter" role="img" aria-label="' + seen + ' of ' + list.length + ' watched"><i style="width:' + Math.round(seen / Math.max(1, list.length) * 100) + '%"></i></div><div>' + list.map(function (m, i) {
        var on = !!(L.movies && L.movies[i]);
        return '<div class="check' + (on ? ' done' : '') + '"><input type="checkbox" id="mv-' + i + '" data-chg="movie" data-i="' + i + '"' + (on ? ' checked' : '') + '><div class="check-main"><label class="check-t" for="mv-' + i + '">' + esc(m.m) + '</label><span class="small muted">' + esc(m.r) + '</span></div></div>';
      }).join('') + '</div></div>');
  }

  /* ---------------- view: Crew ---------------- */
  V.crew = function () {
    var on = refDate(), c = crewCounts(on || today());
    var h = head('Crew', 'Who is coming', 'Everyone on the trip, the jobs that keep a big group moving, and ways to build the excitement.');
    var groups = {}; plan.crew.forEach(function (m) { var g = m.group || 'Household not set'; (groups[g] = groups[g] || []).push(m); });
    h += sec('The roster', 'Ages and ticket types are worked out for ' + (on ? fmt(on) : 'today, until trip dates are picked') + '. First names are plenty: anyone with the link can read this page.',
      '<div class="card"><div class="rowflex" style="gap:18px 30px"><div class="stat"><span class="stat-n">' + c.adult + '</span><span class="stat-l">adult tickets (age 10+)</span></div><div class="stat"><span class="stat-n">' + c.child + '</span><span class="stat-l">child tickets (3 to 9)</span></div><div class="stat"><span class="stat-n">' + c.free + '</span><span class="stat-l">free (under 3)</span></div></div></div>' +
      Object.keys(groups).map(function (g) {
        return '<div class="card"><h3>' + esc(g) + '</h3><div class="rows">' + groups[g].map(function (m) {
          var age = ageOn(m.birth, on || today()), ht = heightAtTrip(m), k = ticketClass(m, on || today());
          return '<div class="row"><div class="row-main"><b>' + esc(m.name) + '</b><span class="small">' + esc([ROLE_LABEL[m.role] || 'Adult', age != null ? 'age ' + age : (isChild(m) ? 'birth month not set' : ''), ht ? ht.h + '" tall' + (ht.est ? ' (est.)' : '') : (isChild(m) ? 'height not set' : '')].filter(Boolean).join(' · ')) + '</span>' + (m.notes ? '<span class="small muted">' + esc(m.notes) + '</span>' : '') + (m.example ? '<span class="small muted">Placeholder: replace with a real name.</span>' : '') + '</div><div class="row-side"><span class="pill ' + (k === 'free' ? 'good' : '') + '">' + CLASS_LABEL[k] + '</span>' + (canEdit() ? '<button class="btn sm" data-act="edit-crew" data-id="' + m.id + '">Edit</button>' : '') + '</div></div>';
        }).join('') + '</div></div>';
      }).join(''), editBtn('add-crew', 'Add a person'));

    h += sec('Trip jobs', 'Spread the work. One name per job, and the captain is not allowed to do all of them.',
      '<div class="card"><div class="rows">' + (G.roles || []).map(function (r) {
        var who = plan.roles[r.id];
        return '<div class="row"><div class="row-main"><b>' + esc(r.t) + '</b><span class="small">' + esc(r.d) + '</span></div><div class="row-side">' + (who ? '<span class="pill teal">' + esc(who) + '</span>' : '<span class="pill warn">Open</span>') + '</div></div>';
      }).join('') + '</div></div>', editBtn('edit-roles', 'Assign jobs'));

    var nm = pd(plan.trip.nextMeeting);
    h += sec('Family check-ins', 'Short, regular, and always ending with who does what next.',
      '<div class="card"><div class="rowflex between"><div class="stat"><span class="stat-n">' + (nm ? fmtShort(nm) : 'Not set') + '</span><span class="stat-l">next check-in' + (nm ? ', ' + nm.getFullYear() : '') + '</span></div>' + editBtn('edit-meeting', 'Set the date') + '</div></div>' + tipCards(G.meetings, 'sm'));
    h += sec('Ground rules for a happy group', '', tipCards(G.groupRules, 'sm'));
    h += sec('Building the excitement', 'A long countdown is half the fun for the kids.', tipCards(G.hype, 'sm'));
    return h + sources('crew');
  };

  /* ---------------- view: Trip days ---------------- */
  function dayItems(d) {
    var lines = String(d.items || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    if (!lines.length) return '<p class="muted small">No details yet.</p>';
    return '<div class="rows">' + lines.map(function (l) {
      var m = /^(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)\s*[-–:]?\s+(.*)$/i.exec(l);
      return '<div class="row" style="padding:7px 0"><span class="time">' + esc(m ? m[1] : '') + '</span><div class="row-main"><span>' + esc(m ? m[2] : l) + '</span></div></div>';
    }).join('') + '</div>';
  }
  V.trip = function () {
    var info = plan.info;
    var h = head('Trip days', 'The plan for each day', 'The itinerary, where to meet, and the lists for the morning of and the suitcase.');
    var days = plan.itinerary.slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; });
    h += sec('Day by day', 'One anchor for the whole group each day, and room around it.',
      days.length ? '<div class="grid two">' + days.map(function (d) {
        return '<div class="card"><div class="dayhead"><h3>' + esc(d.title || 'Day') + '</h3>' + (d.date ? '<span class="pill">' + esc(fmt(pd(d.date), true)) + '</span>' : '') + (d.park ? '<span class="pill teal">' + esc(d.park) + '</span>' : '') + '</div>' + dayItems(d) + (canEdit() ? '<button class="btn sm" data-act="edit-day" data-id="' + d.id + '" style="align-self:flex-start">Edit day</button>' : '') + '</div>';
      }).join('') + '</div>' : '<div class="empty">The day-by-day plan appears here once the organizers build it. The Parks page has sample days to start from.</div>', editBtn('add-day', 'Add a day'));

    var rows = [['Where we are staying', info.hotel], ['Meeting spot, Disneyland Park', info.meetDL], ['Meeting spot, California Adventure', info.meetDCA], ['If someone gets separated', info.lost], ['Other notes', info.notes]];
    h += sec('Key info', 'The answers everyone asks for at 7 in the morning.',
      '<div class="card"><dl class="kv">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd' + (r[1] ? '' : ' class="muted" style="font-weight:400"') + '>' + esc(r[1] || 'Not set yet') + '</dd>'; }).join('') + '</dl></div>', editBtn('edit-info', 'Edit key info'));

    var dayof = G.dayOf || [];
    h += sec('Every park morning', 'Tick these off before leaving the room. Ticks are saved on this device.',
      '<div class="card">' + dayof.map(function (t, i) { var on = !!L.dayof[i]; return '<div class="check ' + (on ? 'done' : '') + '"><input type="checkbox" id="do-' + i + '" data-chg="dayof" data-i="' + i + '"' + (on ? ' checked' : '') + '><div class="check-main"><label class="check-t" for="do-' + i + '">' + esc(t) + '</label></div></div>'; }).join('') + '</div>',
      '<button class="btn sm" data-act="reset-dayof">Clear for a new day</button>');

    var packed = 0, total = 0;
    var pk = (G.packing || []).map(function (cat, ci) {
      return '<div class="card"><h3>' + esc(cat.cat) + '</h3><div>' + cat.items.map(function (it, ii) { var k = ci + '.' + ii, on = !!L.pack[k]; total++; if (on) packed++; return '<div class="check ' + (on ? 'done' : '') + '" style="padding:7px 0"><input type="checkbox" id="pk-' + ci + '-' + ii + '" data-chg="pack" data-k="' + k + '"' + (on ? ' checked' : '') + '><div class="check-main"><label for="pk-' + ci + '-' + ii + '" class="check-t" style="font-weight:400">' + esc(it) + '</label></div></div>'; }).join('') + '</div></div>';
    }).join('');
    h += sec('Packing list', packed + ' of ' + total + ' packed. Saved on this device, so each household keeps its own.', '<div class="grid">' + pk + '</div>', '<button class="btn sm" data-act="reset-pack">Start over</button>');
    h += sec('Keeping everyone safe and found', '', tipCards(G.safety, 'sm'));
    return h + sources('trip');
  };

  /* ---------------- actions ---------------- */
  var CREW_FIELDS = [
    { k: 'name', label: 'First name', req: true }, { k: 'group', label: 'Household', ph: 'e.g. Grandma and Grandpa', help: 'People with the same household name are listed together.' },
    { k: 'role', label: 'Role', type: 'select', opts: [['grandparent', 'Grandparent'], ['parent', 'Parent'], ['adult', 'Other adult'], ['kid', 'Kid'], ['baby', 'Baby or toddler']] },
    { k: 'birth', label: 'Birth month (kids)', type: 'month', ph: 'YYYY-MM', help: 'Month and year is enough. It sets the ticket type at trip time.' },
    { k: 'height', label: 'Height in inches (kids)', type: 'number', step: '0.5' }, { k: 'measured', label: 'Date measured', type: 'date', help: 'Lets the ride chart estimate growth by the trip.' },
    { k: 'notes', label: 'Notes', type: 'textarea', ph: 'Allergies, fears, must-do rides, mobility needs' }
  ];
  var A = {
    'edit-trip': function () {
      openForm({ title: 'Trip details', fields: [{ k: 'name', label: 'Trip name' }, { k: 'start', label: 'First day', type: 'date' }, { k: 'end', label: 'Last day', type: 'date' }, { k: 'nights', label: 'Hotel nights', type: 'number' }, { k: 'parkDays', label: 'Park days', type: 'number' }], values: plan.trip,
        onSave: function (v) { Object.assign(plan.trip, v); commit('Trip details updated'); } });
    },
    'add-update': function () { A['edit-update']({ dataset: {} }); },
    'edit-update': function (el) {
      var u = plan.updates.find(function (x) { return x.id === el.dataset.id; });
      openForm({ title: u ? 'Edit update' : 'Post an update', fields: [{ k: 'date', label: 'Date', type: 'date', def: iso(today()) }, { k: 'title', label: 'Headline', req: true }, { k: 'body', label: 'Details', type: 'textarea' }], values: u,
        onSave: function (v) { upsert(plan.updates, u && u.id, v); commit('Update posted'); }, onDelete: u ? function () { removeById(plan.updates, u.id); commit('Update removed'); } : null });
    },
    'edit-decision': function (el) {
      var d = (G.decisions || []).find(function (x) { return x.id === el.dataset.id; }), st = plan.decisions[d.id] || {};
      openForm({ title: d.q, intro: d.help, fields: [{ k: 'a', label: 'Our answer', type: 'textarea' }, { k: 'done', label: 'This is settled', type: 'checkbox' }], values: st, onSave: function (v) { plan.decisions[d.id] = v; commit('Decision saved'); } });
    },
    'task-filter': function (el) { S.taskFilter = el.dataset.v; render(); },
    'add-task': function () {
      openForm({ title: 'Add a job', fields: [{ k: 't', label: 'What needs doing', req: true }, { k: 'd', label: 'Details', type: 'textarea' }, { k: 'ph', label: 'When', type: 'select', opts: (G.phases || []).map(function (p) { return [p.id, p.label]; }) }, { k: 'due', label: 'Due date (optional)', type: 'date' }],
        onSave: function (v) { plan.customTasks.push(Object.assign({ id: uid() }, v)); commit('Job added'); } });
    },
    'edit-task': function (el) {
      var id = el.dataset.id, ct = plan.customTasks.find(function (x) { return x.id === id; }), st = plan.tasks[id] || {};
      var fields = [{ k: 'owner', label: 'Who is on it', ph: 'A name' }, { k: 'note', label: 'Note', type: 'textarea' }];
      if (ct) fields = [{ k: 't', label: 'What needs doing', req: true }, { k: 'd', label: 'Details', type: 'textarea' }, { k: 'due', label: 'Due date (optional)', type: 'date' }].concat(fields);
      openForm({ title: ct ? 'Edit job' : 'Assign this job', fields: fields, values: Object.assign({}, ct || {}, st),
        onSave: function (v) { if (ct) Object.assign(ct, { t: v.t, d: v.d, due: v.due }); plan.tasks[id] = Object.assign({}, plan.tasks[id], { owner: v.owner, note: v.note }); commit('Saved'); },
        onDelete: ct ? function () { removeById(plan.customTasks, id); delete plan.tasks[id]; commit('Job removed'); } : null });
    },
    'add-window': function (el) {
      var w = (G.windows || []).find(function (x) { return x.id === el.dataset.id; }); if (!w) return;
      plan.candidates.push({ id: uid(), label: w.title, start: w.start || '', end: w.end || '', note: '', status: 'option' }); commit('Added to the shortlist');
    },
    'add-cand': function () { A['edit-cand']({ dataset: {} }); },
    'edit-cand': function (el) {
      var c = plan.candidates.find(function (x) { return x.id === el.dataset.id; });
      openForm({ title: c ? 'Edit option' : 'Add dates to the shortlist', fields: [{ k: 'label', label: 'Name', req: true, ph: 'e.g. Early December 2027' }, { k: 'start', label: 'Arrive', type: 'date' }, { k: 'end', label: 'Leave', type: 'date' }, { k: 'status', label: 'Status', type: 'select', opts: [['option', 'Option'], ['fav', 'Front-runner'], ['out', 'Ruled out']] }, { k: 'note', label: 'Notes', type: 'textarea', ph: 'School calendars, work, prices found' }], values: c,
        onSave: function (v) { upsert(plan.candidates, c && c.id, v); commit('Shortlist updated'); }, onDelete: c ? function () { removeById(plan.candidates, c.id); commit('Option removed'); } : null });
    },
    'lock-cand': function (el) {
      var c = plan.candidates.find(function (x) { return x.id === el.dataset.id; }); if (!c) return;
      plan.candidates.forEach(function (x) { if (x.status === 'chosen') x.status = 'option'; });
      c.status = 'chosen'; plan.trip.start = c.start; plan.trip.end = c.end; plan.trip.nights = dayDiff(pd(c.start), pd(c.end));
      plan.decisions.when = { a: c.label + ': ' + fmtRange(pd(c.start), pd(c.end)), done: true };
      commit('Dates locked. The countdown is official.'); FX.show();
    },
    'month': function (el) { var i = +el.dataset.i; L.month = L.month === i ? null : i; saveL(); render(); },
    'add-crew': function () { A['edit-crew']({ dataset: {} }); },
    'edit-crew': function (el) {
      var m = plan.crew.find(function (x) { return x.id === el.dataset.id; });
      openForm({ title: m ? 'Edit ' + m.name : 'Add a person', fields: CREW_FIELDS, values: m,
        onSave: function (v) { upsert(plan.crew, m && m.id, v); commit('Crew updated'); }, onDelete: m ? function () { removeById(plan.crew, m.id); commit('Removed from the crew'); } : null });
    },
    'edit-roles': function () {
      openForm({ title: 'Assign trip jobs', fields: (G.roles || []).map(function (r) { return { k: r.id, label: r.t, ph: 'A name' }; }), values: plan.roles, onSave: function (v) { plan.roles = v; commit('Jobs assigned'); } });
    },
    'edit-meeting': function () {
      openForm({ title: 'Next family check-in', fields: [{ k: 'nextMeeting', label: 'Date', type: 'date' }], values: plan.trip, onSave: function (v) { plan.trip.nextMeeting = v.nextMeeting; commit('Check-in date set'); } });
    },
    'add-lodge': function () { A['edit-lodge']({ dataset: {} }); },
    'edit-lodge': function (el) {
      var x = plan.lodging.find(function (y) { return y.id === el.dataset.id; });
      openForm({ title: x ? 'Edit place' : 'Add a place to stay', fields: [{ k: 'name', label: 'Name', req: true }, { k: 'price', label: 'Price found', ph: 'e.g. $289 a night, sleeps 6' }, { k: 'link', label: 'Link (https://)' }, { k: 'status', label: 'Status', type: 'select', opts: [['idea', 'Idea'], ['front', 'Front-runner'], ['booked', 'Booked'], ['out', 'Ruled out']] }, { k: 'note', label: 'Notes', type: 'textarea' }], values: x,
        onSave: function (v) { upsert(plan.lodging, x && x.id, v); commit('Lodging shortlist updated'); }, onDelete: x ? function () { removeById(plan.lodging, x.id); commit('Place removed'); } : null });
    },
    'add-booking': function () { A['edit-booking']({ dataset: {} }); },
    'edit-booking': function (el) {
      var b = plan.bookings.find(function (y) { return y.id === el.dataset.id; });
      openForm({ title: b ? 'Edit booking' : 'Add a booking', intro: 'Keep full confirmation numbers in your own records.', fields: [{ k: 'title', label: 'What', req: true, ph: 'e.g. Four family suites, 5 nights' }, { k: 'kind', label: 'Type', type: 'select', opts: ['Lodging', 'Flights', 'Park tickets', 'Dining', 'Car or shuttle', 'Stroller or scooter', 'Other'] }, { k: 'when', label: 'Date', type: 'date' }, { k: 'who', label: 'Booked by' }, { k: 'detail', label: 'Details', type: 'textarea', ph: 'Cancel-by date, what is still owed' }], values: b,
        onSave: function (v) { upsert(plan.bookings, b && b.id, v); commit('Booking saved'); }, onDelete: b ? function () { removeById(plan.bookings, b.id); commit('Booking removed'); } : null });
    },
    'add-day': function () { A['edit-day']({ dataset: {} }); },
    'edit-day': function (el) {
      var d = plan.itinerary.find(function (y) { return y.id === el.dataset.id; });
      openForm({ title: d ? 'Edit day' : 'Add a day', fields: [{ k: 'title', label: 'Name', req: true, ph: 'e.g. Day 2: Fantasyland morning' }, { k: 'date', label: 'Date', type: 'date' }, { k: 'park', label: 'Where', type: 'select', opts: ['', 'Disneyland Park', 'California Adventure', 'Both parks', 'Travel day', 'Rest day'] }, { k: 'items', label: 'The plan, one line each', type: 'textarea', ph: '7:30 Leave hotel\n8:00 Peter Pan, then Dumbo\n12:30 Lunch, then naps', help: 'Start a line with a time and it lines up as a schedule.' }], values: d,
        onSave: function (v) { upsert(plan.itinerary, d && d.id, v); commit('Day saved'); }, onDelete: d ? function () { removeById(plan.itinerary, d.id); commit('Day removed'); } : null });
    },
    'edit-info': function () {
      openForm({ title: 'Key info', intro: 'Anyone with the link can read this. Leave out room numbers and phone numbers if the link is shared widely.', fields: [{ k: 'hotel', label: 'Where we are staying' }, { k: 'meetDL', label: 'Meeting spot, Disneyland Park' }, { k: 'meetDCA', label: 'Meeting spot, California Adventure' }, { k: 'lost', label: 'If someone gets separated', type: 'textarea' }, { k: 'notes', label: 'Other notes', type: 'textarea' }], values: plan.info, onSave: function (v) { plan.info = v; commit('Key info saved'); } });
    },
    'sub': function (el) { L.sub[el.dataset.k] = el.dataset.v; saveL(); render(); },
    'ride-filter': function (el) { S[el.dataset.k] = el.dataset.v; render(); },
    'star': function (el) { var k = el.dataset.id, r = el.getBoundingClientRect(); L.stars[k] = !L.stars[k]; saveL(); render(); if (L.stars[k]) FX.burst(r.left + r.width / 2, r.top + r.height / 2, 16); },
    'daily-next': function () { S.dailyShift = (S.dailyShift || 0) + 1; render(); },
    'hc-set': function (el) { L.hc = num(el.dataset.v, 40); saveL(); render(); },
    'wheel-set': function (el) { L[el.dataset.k] = el.dataset.v; saveL(); W.slices = null; render(); },
    'wheel-deal': function () { if (W.busy) return; wheelDeal(); render(); },
    'wheel-spin': function () {
      var cv = document.getElementById('wheel'), out = document.getElementById('wheel-out');
      if (!cv || W.busy || !W.slices || W.slices.length < 2) return;
      var n = W.slices.length, k = Math.floor(Math.random() * n), step = 360 / n;
      var base = (((-90 - (k * step + step / 2)) % 360) + 360) % 360;
      var target = Math.ceil((W.angle + 1440 - base) / 360) * 360 + base + (Math.random() - 0.5) * step * 0.6;
      var done = function () { W.busy = false; W.angle = target; W.result = W.slices[k]; var o = document.getElementById('wheel-out'); if (o) o.innerHTML = wheelOut(); FX.at(document.querySelector('.wheel-pin'), 40); };
      W.busy = true; W.result = null; if (out) out.innerHTML = wheelOut();
      if (REDUCED) { cv.style.transform = 'rotate(' + target + 'deg)'; return done(); }
      cv.style.transition = 'transform 4.4s cubic-bezier(.12, .7, .08, 1)'; cv.style.transform = 'rotate(' + target + 'deg)';
      setTimeout(done, 4500);
    },
    'duel': function (el) {
      var d = duelState(), w = +el.dataset.w, a = rideKey(duelPair[w]), b = rideKey(duelPair[1 - w]), r = el.getBoundingClientRect();
      var ra = d.r[a] || 1000, rb = d.r[b] || 1000, ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
      d.r[a] = ra + 32 * (1 - ea); d.r[b] = rb - 32 * (1 - ea);
      d.seen[a] = (d.seen[a] || 0) + 1; d.seen[b] = (d.seen[b] || 0) + 1; d.n++;
      saveL(); duelNext(); render();
      if (d.n === DUEL_ROUNDS) { FX.show(); toast('Your top rides are in'); } else FX.burst(r.left + r.width / 2, r.top + r.height / 2, 14);
    },
    'duel-skip': function () { duelNext(); render(); },
    'duel-copy': function () { copyText('My top Disneyland rides:\n' + duelTop(8).map(function (r, i) { return (i + 1) + '. ' + r.n; }).join('\n'), 'List copied. Paste it into a text to the organizers.'); },
    'duel-star': function () { duelTop(5).forEach(function (r) { L.stars[rideKey(r)] = true; }); saveL(); render(); toast('Top five starred on the Parks page'); },
    'duel-reset': function () { L.duel = null; duelPair = null; saveL(); render(); },
    'quiz-start': function () { Q = { order: shuffle((G.trivia || []).map(function (x, i) { return i; })).slice(0, 10), i: 0, score: 0, pick: null }; render(); },
    'quiz-pick': function (el) {
      if (!Q || Q.pick != null) return;
      var q = G.trivia[Q.order[Q.i]], i = +el.dataset.i, r = el.getBoundingClientRect();
      Q.pick = i; if (i === q.c) Q.score++;
      render(); if (i === q.c) FX.burst(r.left + r.width / 2, r.top + r.height / 2, 22);
    },
    'quiz-next': function () {
      if (!Q) return;
      Q.i++; Q.pick = null;
      if (Q.i >= Q.order.length) { if (L.quizBest == null || Q.score > L.quizBest) { L.quizBest = Q.score; saveL(); } if (Q.score >= 8) FX.show(); }
      render();
    },
    'copy-stars': function () {
      var names = (G.rides || []).filter(function (r) { return L.stars[rideKey(r)]; }).map(function (r) { return '- ' + r.n + ' (' + (r.p === 'DL' ? 'Disneyland Park' : 'California Adventure') + ')'; });
      copyText('My Disneyland must-dos:\n' + names.join('\n'), 'List copied. Paste it into a text to the organizers.');
    },
    'copy-plan': function () { copyText('Disneyland Family HQ plan data:\n' + JSON.stringify(plan), 'Plan data copied. Paste it to Claude.'); },
    'add-saved': function () {
      openForm({ title: 'Add money saved', fields: [{ k: 'amt', label: 'Amount in dollars', type: 'number', req: true }, { k: 'note', label: 'Note', ph: 'e.g. December transfer, gift card from Grandma' }], onSave: function (v) {
        var total = Math.max(1, estimate().total), sum = function () { return L.saved.reduce(function (a, x) { return a + num(x.amt); }, 0); }, before = sum() / total * 100;
        L.saved.push({ amt: num(v.amt), note: v.note, date: iso(today()) }); saveL(); render();
        var after = sum() / total * 100, hit = MILES.filter(function (m) { return before < m[0] && after >= m[0]; }).pop();
        if (hit) { FX.show(); toast('Milestone: ' + hit[1].toLowerCase() + '!'); }
      } });
    },
    'del-saved': function (el) { L.saved.splice(+el.dataset.i, 1); saveL(); render(); },
    'reset-dayof': function () { L.dayof = {}; saveL(); render(); },
    'reset-pack': function () { L.pack = {}; saveL(); render(); },
    'save': saveForEveryone,
    'discard': function () { LS.del('draft'); plan = clone(published); S.dirty = false; S.blocked = false; render(); toast('Changes discarded'); },
    'stale-keep': function () { plan = normalize(S.stale.plan); S.stale = null; S.dirty = true; LS.set('draft', { base: published.rev, plan: plan }); render(); },
    'stale-drop': function () { S.stale = null; LS.del('draft'); render(); },
    'local-on': function () { L.localEdit = true; saveL(); restoreLocal(); render(); toast('Editing a copy on this device'); },
    'local-off': function () { L.localEdit = false; saveL(); plan = clone(published); render(); }
  };
  var C = {
    task: function (el) { var id = el.dataset.id, on = el.checked, r = el.getBoundingClientRect(); plan.tasks[id] = Object.assign({}, plan.tasks[id], { done: on }); commit(); if (on) FX.burst(r.left + r.width / 2, r.top + r.height / 2, 24); },
    movie: function (el) { var on = el.checked, r = el.getBoundingClientRect(); L.movies = L.movies || {}; L.movies[el.dataset.i] = on; saveL(); render(); if (on) FX.burst(r.left + r.width / 2, r.top + r.height / 2, 18); },
    dayof: function (el) { L.dayof[el.dataset.i] = el.checked; saveL(); render(); },
    pack: function (el) { L.pack[el.dataset.k] = el.checked; saveL(); render(); }
  };
  app.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]'); if (!el || el.disabled) return;
    var fn = A[el.dataset.act]; if (fn) fn(el, ev);
  });
  app.addEventListener('change', function (ev) {
    var el = ev.target.closest('[data-chg]'); if (el && C[el.dataset.chg]) C[el.dataset.chg](el, ev);
  });
  app.addEventListener('input', function (ev) {
    var el = ev.target.closest('[data-inp]'); if (!el) return;
    if (el.dataset.inp === 'hc') { L.hc = num(el.value, 40); saveL(); updateHc(); return; }
    L.est[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; saveL();
    var a = document.getElementById('est-out'), b = document.getElementById('save-out');
    if (a) a.innerHTML = estOut();
    if (b) b.innerHTML = '<h3>Your savings plan</h3>' + saveOut();
    var g = document.getElementById('crew-out'); if (g) g.innerHTML = crewEstimate();
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { drawWheel(); });

  /* ---------------- boot ---------------- */
  function onRoute() {
    var r = (location.hash || '').replace('#', '');
    var next = NAV.some(function (n) { return n[0] === r; }) ? r : 'hq';
    var changed = next !== S.route; S.route = next; render();
    if (changed) window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', onRoute);
  if (S.mode === 'local') restoreLocal();
  onRoute();
  if (HOSTED) resolveHost();
})();
