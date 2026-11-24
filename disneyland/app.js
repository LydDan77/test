/* Disneyland Family HQ: app logic.
   Shared plan  = the JSON embedded in the page (#plan-data). Organizers edit it and save a new page version.
   Personal bits = this device only (localStorage): budget numbers, savings log, packing ticks, ride stars. */
(function () {
  'use strict';
  var G = window.GUIDE || {};
  var SHELL = window.TRIP_SHELL;
  var app = document.getElementById('app');
  var HOSTED = !!(window.claude && typeof window.claude.use === 'function');

  /* ---------------- utilities ---------------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
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

  var S = {
    route: 'hq',
    mode: HOSTED ? 'checking' : 'local',   // checking | owner | viewer | local
    artifact: null, dirty: false, saving: false, stale: null,
    taskFilter: 'open', ridePark: 'all', rideFit: 'all'
  };
  function canEdit() { return S.mode === 'owner' || (S.mode === 'local' && L.localEdit === true); }

  var NAV = [['hq', 'HQ'], ['when', 'When to go'], ['plan', 'Countdown'], ['money', 'Budget'], ['stay', 'Stay & travel'], ['parks', 'Parks'], ['crew', 'Crew'], ['trip', 'Trip days']];

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
        LS.del('draft'); S.dirty = false; S.saving = false;
        published = next; plan = clone(next); render(); toast('Saved for everyone');
      }, function (err) {
        var code = err && err.code;
        if ((code === 'upstream_error' || !code) && retry) return new Promise(function (r) { setTimeout(r, 900 + Math.random() * 900); }).then(function () { return attempt(false); });
        S.saving = false;
        LS.set('draft', { base: published.rev, plan: plan });
        if (code === 'conflict') toast('Someone else saved first. Loading their version.');
        else if (code === 'rate_limited') toast('Saving too often. Wait a minute, then save again.');
        else if (code === 'too_large' || code === 'invalid_content' || code === 'transform_error') toast('The plan could not be saved. Shorten long notes and try again.');
        else if (code === 'not_writer' || code === 'not_granted' || code === 'not_declared' || code === 'consent_required' || code === 'capability_disabled' || code === 'capability_removed') { S.mode = 'viewer'; S.dirty = false; toast('This view cannot save changes. Your edits are kept on this device.'); }
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
    return allTasks().filter(function (t) { return !t.done; }).sort(function (a, b) {
      if (a.due && b.due) return a.due - b.due;
      if (!a.due && !b.due) return phaseOrder(a.ph) - phaseOrder(b.ph);
      return a.due ? (a.ph === 'now' ? -1 : 1) : (a.ph === 'now' ? -1 : (b.ph === 'now' ? 1 : -1));
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
  function head(eyebrow, title, lede) {
    return '<div class="view-head"><span class="eyebrow">' + esc(eyebrow) + '</span><h1>' + esc(title) + '</h1>' + (lede ? '<p>' + esc(lede) + '</p>' : '') + '</div>';
  }
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
    var chip = function (label, n, href) { return '<a class="wait" href="' + href + '" aria-label="' + esc(label + ': ' + n) + '"><span class="wait-l">' + label.split(' ').map(esc).join('<br>') + '</span><span class="wait-n">' + esc(n) + '</span></a>'; };
    if (!s) w = chip('Trip dates', 'TBD', '#when');
    else if (td < s) w = chip('Days to go', dayDiff(td, s), '#plan');
    else if (td <= e) w = chip('Trip day', dayDiff(s, td) + 1, '#trip');
    else w = chip('Trip', 'Done', '#hq');
    var tabs = NAV.map(function (n) { return '<a class="tab" href="#' + n[0] + '"' + (S.route === n[0] ? ' aria-current="page"' : '') + '>' + n[1] + '</a>'; }).join('');
    var bar = '';
    if (S.mode === 'local' && L.localEdit) bar = '<div class="modebar"><div class="wrap"><span><b>Editing a copy on this device.</b> Nobody else sees these changes.</span><span class="rowflex"><button class="btn sm" data-act="copy-plan">Copy plan data</button><button class="btn sm" data-act="local-off">Stop editing</button></span></div></div>';
    if (S.stale) bar = '<div class="modebar"><div class="wrap"><span><b>You have unsaved edits from an earlier visit,</b> and the plan has been saved since then.</span><span class="rowflex"><button class="btn sm" data-act="stale-keep">Keep my edits</button><button class="btn sm" data-act="stale-drop">Discard them</button></span></div></div>';
    return '<header class="top"><div class="wrap"><div class="top-in"><a class="brand" href="#hq"><span class="brand-mark" aria-hidden="true">HQ</span><span style="min-width:0"><span class="brand-name" style="display:block">' + esc(plan.trip.name || 'Our Disneyland Adventure') + '</span><span class="brand-sub" style="display:block">Family trip headquarters</span></span></a>' + w + '</div><nav class="tabs" aria-label="Sections">' + tabs + '</nav></div></header>' + bar;
  }
  function footer() {
    var who = S.mode === 'owner' ? 'You can edit this plan. Changes reach everyone when you press Save for everyone.' :
      S.mode === 'viewer' ? 'The trip organizers keep this plan up to date. Your budget numbers, packing ticks and ride stars are saved on this device only.' :
      S.mode === 'local' ? (L.localEdit ? '' : 'You are viewing the shared plan. <button class="linkbtn" data-act="local-on">Edit a copy on this device</button>') : '';
    return '<footer class="foot"><div class="stack tight"><p>' + who + '</p><p>Plan last saved ' + esc(fmt(pd(plan.saved)) || 'not yet') + '. Research checked ' + esc(G.asOfLabel || '') + '. Prices and rules change often, so confirm on disneyland.com before paying for anything.</p><p>An unofficial family planner. Not affiliated with or endorsed by The Walt Disney Company.</p></div></footer>';
  }
  function saveBar() {
    if (S.mode !== 'owner' || !S.dirty) return '';
    return '<div class="savebar"><div class="savebar-in"><span><b>Unsaved changes.</b> Only you can see them so far.</span><span class="rowflex"><button class="btn ghost" data-act="discard"' + (S.saving ? ' disabled' : '') + '>Discard</button><button class="btn primary" data-act="save"' + (S.saving ? ' disabled' : '') + '>' + (S.saving ? 'Saving…' : 'Save for everyone') + '</button></span></div></div>';
  }
  var V = {};
  function render() {
    var view = (V[S.route] || V.hq)();
    app.innerHTML = chrome() + '<main><div class="wrap">' + view + footer() + '</div></main>' + saveBar();
    var cur = app.querySelector('.tab[aria-current="page"]');
    if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* older browsers */ } }
  }

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
    h += '<section class="sec"><div class="card lift"><div class="rowflex between"><h2>Where we are: ' + names[ph] + '</h2>' + editBtn('edit-trip', s ? 'Change trip details' : 'Set trip dates') + '</div><div class="phases">' +
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

    if (!s) {
      h += sec('Best windows from the research', 'The short list. The When to go page has the full picture and the dates to avoid.',
        '<div class="grid">' + (G.windows || []).slice(0, 3).map(function (w) { return '<div class="card"><span class="eyebrow">' + esc(w.grade) + ' ticket</span><h3>' + esc(w.title) + '</h3><p class="small">' + esc(w.summary) + '</p>' + crowdPill(w.crowd) + '</div>'; }).join('') + '</div>',
        '<a class="btn sm" href="#when">Compare windows</a>');
    }

    var ups = plan.updates.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    h += sec('Family updates', 'News from the organizers, newest first.',
      ups.length ? '<div class="card"><div class="rows">' + ups.map(function (u) {
        return '<div class="row"><span class="time">' + esc(fmtShort(pd(u.date))) + '<br>' + esc((pd(u.date) || today()).getFullYear()) + '</span><div class="row-main"><b>' + esc(u.title) + '</b><span>' + esc(u.body) + '</span></div>' + (canEdit() ? '<div class="row-side"><button class="btn sm" data-act="edit-update" data-id="' + u.id + '">Edit</button></div>' : '') + '</div>';
      }).join('') + '</div></div>' : '<div class="empty">No updates yet. Organizers post news here: dates locked, hotel booked, tickets bought.</div>',
      editBtn('add-update', 'Post an update'));
    return h;
  };

  /* ---------------- view: When ---------------- */
  V.when = function () {
    var h = head('When to go', 'When should we go?', G.whenLede || '');
    if (G.verdict) h += '<section class="sec"><div class="callout sun prose"><b>The short answer</b>' + G.verdict.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div></section>';

    h += sec('Ranked windows', 'In the park\'s old ticket-book days an E ticket got you on the best rides. E-ticket windows here are the best fits for our crew.',
      '<div class="grid two">' + (G.windows || []).map(function (w) {
        return '<div class="ticket ' + (w.grade === 'E' ? 'pick' : '') + '"><div class="ticket-stub"><span class="ticket-letter">' + esc(w.grade) + '</span><span class="ticket-cap">ticket</span></div><div class="ticket-body"><h3>' + esc(w.title) + '</h3><div class="rowflex">' + crowdPill(w.crowd) + (w.tag ? '<span class="pill">' + esc(w.tag) + '</span>' : '') + '</div><p>' + esc(w.summary) + '</p>' +
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
    h += sec('The year at a glance', 'Typical crowds by month. Tap a month for weather, what is on, and the weeks to pick or skip.',
      '<div class="scroll"><div class="heat">' + (G.months || []).map(function (m, i) {
        return '<button class="heat-m lv' + m.crowd + '" data-act="month" data-i="' + i + '" aria-pressed="' + (i === mi) + '"><b>' + esc(m.k) + '</b><span>' + esc(m.hi + '° / ' + m.lo + '°') + '</span><span>' + esc(m.rain) + '</span></button>';
      }).join('') + '</div></div><div class="legend"><span><i class="lv1"></i>Very light</span><span><i class="lv2"></i>Light</span><span><i class="lv3"></i>Moderate</span><span><i class="lv4"></i>Busy</span><span><i class="lv5"></i>Packed</span><span>High / low °F and typical rain</span></div>' +
      (mo ? '<div class="card"><h3>' + esc(mo.name) + '</h3><dl class="kv"><dt>Crowds</dt><dd>' + esc(mo.crowdNote) + '</dd><dt>Best bets</dt><dd>' + esc(mo.best) + '</dd><dt>Skip</dt><dd>' + esc(mo.worst) + '</dd><dt>What is on</dt><dd>' + esc(mo.on) + '</dd></dl></div>' : ''));

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
  function estimate() {
    var e = estDefaults(), c = G.costs || {}, bumps = num(e.when, 1);
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
  function saveOut() {
    var r = estimate(), saved = L.saved.reduce(function (a, x) { return a + num(x.amt); }, 0), left = Math.max(0, r.total - saved);
    var by = needBy(), days = Math.max(7, dayDiff(today(), by)), months = Math.max(1, days / 30.44);
    return '<div class="rowflex" style="gap:18px 30px"><div class="stat"><span class="stat-n">' + money(left / months) + '</span><span class="stat-l">to set aside each month</span></div><div class="stat"><span class="stat-n">' + money(left / (days / 7)) + '</span><span class="stat-l">or each week</span></div><div class="stat"><span class="stat-n">' + money(saved) + '</span><span class="stat-l">saved so far of ' + money(r.total) + '</span></div></div><div class="meter" role="img" aria-label="Savings progress"><i style="width:' + Math.min(100, Math.round(saved / Math.max(1, r.total) * 100)) + '%"></i></div><p class="small muted">Aiming to have it all by ' + fmt(by) + (tripStart() ? ', 45 days before we leave, when final payments start to fall due.' : ', based on the travel period chosen above.') + '</p>';
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
    h += sec('Four ways to house a big crew', 'Rough totals for about 14 people for 5 nights, in 2027 dollars.', '<div class="grid two">' + (G.lodgingPlans || []).map(function (p, i) {
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
      commit('Dates locked. The countdown now has real due dates.');
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
    'star': function (el) { var k = el.dataset.id; L.stars[k] = !L.stars[k]; saveL(); render(); },
    'copy-stars': function () {
      var names = (G.rides || []).filter(function (r) { return L.stars[rideKey(r)]; }).map(function (r) { return '- ' + r.n + ' (' + (r.p === 'DL' ? 'Disneyland Park' : 'California Adventure') + ')'; });
      copyText('My Disneyland must-dos:\n' + names.join('\n'), 'List copied. Paste it into a text to the organizers.');
    },
    'copy-plan': function () { copyText(JSON.stringify(plan, null, 2), 'Plan data copied'); },
    'add-saved': function () {
      openForm({ title: 'Add money saved', fields: [{ k: 'amt', label: 'Amount in dollars', type: 'number', req: true }, { k: 'note', label: 'Note', ph: 'e.g. December transfer, gift card from Grandma' }], onSave: function (v) { L.saved.push({ amt: num(v.amt), note: v.note, date: iso(today()) }); saveL(); render(); } });
    },
    'del-saved': function (el) { L.saved.splice(+el.dataset.i, 1); saveL(); render(); },
    'reset-dayof': function () { L.dayof = {}; saveL(); render(); },
    'reset-pack': function () { L.pack = {}; saveL(); render(); },
    'save': saveForEveryone,
    'discard': function () { LS.del('draft'); plan = clone(published); S.dirty = false; render(); toast('Changes discarded'); },
    'stale-keep': function () { plan = normalize(S.stale.plan); S.stale = null; S.dirty = true; LS.set('draft', { base: published.rev, plan: plan }); render(); },
    'stale-drop': function () { S.stale = null; LS.del('draft'); render(); },
    'local-on': function () { L.localEdit = true; saveL(); restoreLocal(); render(); toast('Editing a copy on this device'); },
    'local-off': function () { L.localEdit = false; saveL(); plan = clone(published); render(); }
  };
  var C = {
    task: function (el) { var id = el.dataset.id; plan.tasks[id] = Object.assign({}, plan.tasks[id], { done: el.checked }); commit(); },
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
    var el = ev.target.closest('[data-inp="est"]'); if (!el) return;
    L.est[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; saveL();
    var a = document.getElementById('est-out'), b = document.getElementById('save-out');
    if (a) a.innerHTML = estOut();
    if (b) b.innerHTML = '<h3>Your savings plan</h3>' + saveOut();
  });

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
