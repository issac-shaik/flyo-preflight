// Preflight dashboard (vanilla JS, no build step).
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const fmtDate = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '-');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const wall = (w) => (w ? `${w.slice(8, 10)} ${MONTHS[+w.slice(5, 7) - 1]}, ${w.slice(11, 16)}` : '-');
const DOT = ' \u00b7 ';
const ARROW = ' \u2192 ';

const state = { meta: null, bookings: [], selected: null, booking: null, docs: [], openApi: new Set() };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

const fileToPayload = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ name: file.name, mime: file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'), base64: String(r.result).split(',')[1] });
  r.onerror = reject;
  r.readAsDataURL(file);
});

// ------------------------------------------------------------------ meta / samples
async function loadMeta() {
  state.meta = await api('/api/meta');
  const m = state.meta;
  $('#modeChips').innerHTML = [
    `<li>Flyo API: <b>${m.flyo.mock ? 'mock (contract-faithful)' : esc(m.flyo.baseUrl)}</b></li>`,
    `<li>Vision LLM: <b>${esc(m.llm)}</b></li>`,
    `<li>WhatsApp: <b>${esc(m.messaging)}</b></li>`,
  ].join('');
  $('#sampleList').innerHTML = m.samples.map((s) => `
    <li class="sample">
      <button type="button" data-sample="${esc(s.id)}"><strong>${esc(s.label)}</strong><span>${esc(s.blurb)}</span></button>
      <a href="/api/samples/tickets/${esc(s.id)}.pdf" target="_blank" rel="noopener" aria-label="Open ${esc(s.label)} PDF">PDF</a>
    </li>`).join('');
}

// ------------------------------------------------------------------ ingest
const ingestForm = $('#ingestForm');
const fileInput = $('#ticketFile');
const dropZone = $('#dropZone');
const DROP_LABEL = '<strong>Drop an e-ticket PDF</strong> or click to choose';

async function ingest(body, btn) {
  $('#ingestError').textContent = '';
  const isMain = btn.id === 'ingestBtn';
  const original = btn.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  if (isMain) btn.textContent = 'Reading ticket\u2026';
  try {
    const res = await api('/api/ingest', { method: 'POST', body });
    await refreshList();
    ingestForm.reset();
    $('#dropLabel').innerHTML = DROP_LABEL;
    await select(res.bookings[0]);
  } catch (e) {
    $('#ingestError').textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.setAttribute('aria-busy', 'false');
    if (isMain) btn.textContent = original;
  }
}

const contactInput = () => ({ name: $('#contactName').value.trim(), phone: $('#contactPhone').value.trim() });

ingestForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  const text = $('#ticketText').value;
  if (!file && !text.trim()) { $('#ingestError').textContent = 'Choose a ticket file, paste the ticket text, or pick a demo ticket.'; return; }
  ingest({ text: file ? undefined : text, file: file ? await fileToPayload(file) : undefined, contact: contactInput() }, $('#ingestBtn'));
});
$('#sampleList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sample]');
  if (btn) ingest({ sample: btn.dataset.sample, contact: contactInput() }, btn);
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  $('#dropLabel').innerHTML = f ? `<strong>${esc(f.name)}</strong> selected` : DROP_LABEL;
});
['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('over'); }));
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; fileInput.dispatchEvent(new Event('change')); }
});

// ------------------------------------------------------------------ list
async function refreshList() {
  state.bookings = (await api('/api/bookings')).bookings;
  renderList();
}

const routeOf = (b) => [b.flights[0]?.origin, ...b.flights.map((l) => l.destination)].join(ARROW);

function renderList() {
  $('#bookingList').innerHTML = state.bookings.map((b) => {
    const r = b.readiness?.overall || 'none';
    const miss = b.flyo.missing_info?.length;
    return `<li><button type="button" class="bitem" data-id="${esc(b.id)}" aria-current="${b.id === state.selected}">
      <span class="route"><span class="dot ${r}" role="img" aria-label="Readiness ${r}"></span>${esc(routeOf(b))}</span>
      <span class="meta">
        <span>PNR ${esc(b.pnr || '?')}</span><span>${b.passengers.length} pax</span>
        ${b.journey_count > 1 ? `<span>leg ${b.journey_index + 1}/${b.journey_count}</span>` : ''}
        <span class="pill ${esc(b.flyo.status)}">${esc(b.flyo.status.replace(/_/g, ' '))}</span>
        ${miss ? `<span class="pill miss">${miss} missing</span>` : ''}
      </span>
    </button></li>`;
  }).join('');
}
$('#bookingList').addEventListener('click', (e) => {
  const btn = e.target.closest('.bitem');
  if (btn) select(btn.dataset.id);
});

// ------------------------------------------------------------------ detail
async function select(id) {
  state.selected = id;
  renderList();
  await loadBooking();
  state.docs = state.booking ? (await api(`/api/samples/docs?booking=${encodeURIComponent(id)}`)).docs : [];
  renderPhone();
}

async function loadBooking() {
  if (!state.selected) return;
  try {
    state.booking = await api(`/api/bookings/${encodeURIComponent(state.selected)}`);
  } catch {
    state.booking = null;
    state.selected = null;
  }
  renderDetail();
  renderPhone();
}

const ICON = { pass: '\u2713', warn: '!', fail: '\u2715', pending: '\u2026', info: 'i' };
const LEVEL_TEXT = { pass: 'OK', warn: 'Check', fail: 'Blocking', pending: 'Waiting', info: 'Info' };
const GROUPS = { itinerary: 'Itinerary', flyo: 'Flyo requirements', documents: 'Documents', entry: 'Entry', transit: 'Transit', timing: 'Timing' };

function renderChecks(b) {
  const r = b.readiness;
  const sections = [];
  const general = r.checks.filter((c) => c.passenger == null);
  const byGroup = (list) => Object.keys(GROUPS).map((g) => [g, list.filter((c) => c.group === g)]).filter(([, l]) => l.length);
  const item = (c) => `<li class="check ${c.level}"><span class="ic" aria-hidden="true">${ICON[c.level]}</span><div><b><span class="sr-only">${LEVEL_TEXT[c.level]}: </span>${esc(c.label)}</b><p>${esc(c.detail)}</p></div></li>`;
  for (const [g, list] of byGroup(general)) sections.push(`<h4>${GROUPS[g]}</h4>${list.map(item).join('')}`);
  b.passengers.forEach((p, i) => {
    const list = r.checks.filter((c) => c.passenger === i);
    if (list.length) sections.push(`<h4>${esc(p.first_name)} ${esc(p.last_name)}</h4>${list.map(item).join('')}`);
  });
  return `<ul class="checks">${sections.join('')}</ul>`;
}

function renderDetail() {
  const b = state.booking;
  $('#emptyState').hidden = Boolean(b);
  $('#detailBody').hidden = !b;
  if (!b) return;
  const r = b.readiness;
  const f = b.flyo;
  const alerts = b.alerts.filter((a) => !a.resolved);

  const legsRows = b.flights.map((l, i) => {
    const next = b.flights[i + 1];
    const lay = next && l.arrival_utc ? (new Date(next.departure_utc) - new Date(l.arrival_utc)) / 60000 : null;
    return `<tr><td><b>${esc(l.airline)} ${esc(l.flight_number)}</b></td>
      <td><span class="code">${esc(l.origin)}</span><small>${esc(wall(l.departure_datetime))} local</small></td>
      <td><span class="code">${esc(l.destination)}</span><small>${esc(wall(l.arrival_datetime))} local</small></td>
      <td><small>${l.departure_utc ? `${esc(new Date(l.departure_utc).toISOString().slice(11, 16))} UTC` : ''}</small></td></tr>
      ${lay != null ? `<tr class="layover"><td colspan="4">Layover at ${esc(l.destination)}: ${Math.floor(lay / 60)}h ${Math.round(lay % 60)}m</td></tr>` : ''}`;
  }).join('');

  const pax = b.passengers.map((p, i) => {
    const pp = p.passport;
    const visas = (p.documents || []).filter((d) => d.type === 'VISA');
    const mrz = pp?.mrz_valid === true ? `${DOT}MRZ \u2713` : pp?.mrz_valid === false ? `${DOT}MRZ \u2715` : '';
    return `<article class="pax"><header><b>${esc(p.first_name)} ${esc(p.last_name)}</b><button class="btn small" data-edit="${i}">Edit</button></header>
      <dl class="kv">
        <dt>Email</dt><dd>${esc(p.email || '-')}</dd>
        <dt>Passport</dt><dd>${pp ? `${esc(pp.number || '?')}${DOT}${esc(pp.nationality || '?')}${DOT}exp ${esc(fmtDate(pp.expiry_date))}${DOT}issued ${esc(pp.place_of_issue || '?')}${mrz}` : '-'}</dd>
        ${pp?.fileId ? `<dt>Scan</dt><dd><a href="/api/files/${esc(pp.fileId)}" target="_blank" rel="noopener">view</a> <small>(${esc(pp.source || '')})</small></dd>` : ''}
        <dt>Visas</dt><dd>${visas.length ? visas.map((v) => `${esc(v.issuing_country)} ${esc(v.visa_type || '')} until ${esc(fmtDate(v.expiry_date))}`).join('<br>') : '-'}</dd>
      </dl></article>`;
  }).join('');

  // "Held" = Flyo is still waiting for data we already have, because the traveller isn't ready to fly.
  const held = (r.flyoReady && r.holdReasons.length && f.checkin_id && f.missing_info?.length) || (r.holdReasons.length && b.override);
  const apiHtml = [...b.api].reverse().map((c) => {
    const key = `${c.at}-${c.path}`;
    const ok = typeof c.status === 'number' && c.status < 400;
    return `<details data-key="${esc(key)}" ${state.openApi.has(key) ? 'open' : ''}><summary><span class="st ${ok ? 'ok' : 'bad'}">${esc(c.status)}</span>${esc(c.method)} ${esc(c.path.replace('/extPartner/api/webcheckin', '\u2026'))}${c.repeat ? ` <small>\u00d7${esc(c.repeat)}</small>` : ''}<small style="margin-left:auto">${esc(fmtTime(c.at))}${DOT}${esc(c.ms)}ms</small></summary>
      ${c.request ? `<pre aria-label="Request">${esc(JSON.stringify(c.request, null, 2))}</pre>` : ''}<pre aria-label="Response">${esc(JSON.stringify(c.response, null, 2))}</pre></details>`;
  }).join('');

  $('#detailBody').innerHTML = `
    <div class="stack">
      <div class="card">
        <div class="dhead">
          <div><h2>${esc(routeOf(b))}</h2>
            <p>PNR <b>${esc(b.pnr || '?')}</b>${DOT}${b.passengers.length} passenger(s)${DOT}${r.international ? 'International' : 'Domestic'}${DOT}read by ${esc(b.source.extractor === 'llm' ? 'vision LLM' : 'built-in parser')} from ${esc(b.source.kind)}${b.source.fileId ? ` (<a href="/api/files/${esc(b.source.fileId)}" target="_blank" rel="noopener">original</a>)` : ''}${b.journey_count > 1 ? `${DOT}one-way journey ${b.journey_index + 1} of ${b.journey_count}` : ''}</p></div>
          <button class="btn small danger" id="deleteBtn">Delete</button>
        </div>
        <table class="legs"><thead><tr><th scope="col">Flight</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Departs</th></tr></thead><tbody>${legsRows}</tbody></table>
        ${b.source.warnings?.length ? `<p class="fine">Extraction notes: ${esc(b.source.warnings.join('; '))}</p>` : ''}
      </div>
      ${alerts.map((a) => `<div class="alert ${esc(a.level)}" role="status"><span aria-hidden="true">${a.level === 'fail' ? '\u26d4' : '\u26a0\ufe0f'}</span><span class="grow">${esc(a.text)}</span><button class="btn small" data-resolve="${esc(a.id)}">Dismiss</button></div>`).join('')}
      <div class="grid2">
        <div class="stack">
          <section class="card" aria-labelledby="rdyTitle">
            <div class="readiness-head"><span class="badge ${r.overall}">${r.overall.toUpperCase()}</span><h2 id="rdyTitle" style="margin:0">Readiness: ${esc(r.summary)}</h2></div>
            ${renderChecks(b)}
            ${held ? `<div class="hold"><span>${b.override ? '<b>Override on:</b> sent to Flyo despite open issues.' : '<b>Holding the Flyo update.</b> Flyo has what it needs, but the traveller is not ready to fly yet, so automation stays paused.'}</span>
              <button class="btn small warn" id="overrideBtn" data-on="${b.override ? '0' : '1'}">${b.override ? 'Re-enable hold' : 'Send to Flyo anyway'}</button></div>` : ''}
            <p class="fine">Entry/transit rules: ${esc(r.rulesAsOf)}. Production would use IATA Timatic.</p>
          </section>
          <section class="card" aria-labelledby="paxTitle"><h2 id="paxTitle">Passengers</h2>${pax}</section>
        </div>
        <div class="stack">
          <section class="card" aria-labelledby="flyoTitle">
            <h2 id="flyoTitle">Flyo Web Check-in</h2>
            <div class="flyo-ids">
              <div><small>status</small><strong><span class="pill ${esc(f.status)}">${esc(f.status.replace(/_/g, ' '))}</span></strong></div>
              <div><small>checkin_id</small><strong>${esc(f.checkin_id || '-')}</strong></div>
              <div><small>booking_id</small><strong>${esc(f.booking_id ?? '-')}</strong></div>
            </div>
            <dl class="kv">
              <dt>sub_status</dt><dd>${esc(f.sub_status || '-')}</dd>
              <dt>message</dt><dd>${esc(f.checkin_message || '-')}</dd>
              <dt>missing_info</dt><dd>${f.missing_info?.length ? f.missing_info.map((m) => `<span class="pill miss">${esc(m.type)}</span>`).join(' ') : '-'}</dd>
              ${f.quota ? `<dt>quota</dt><dd>${esc(f.quota.consumed_units)} / ${esc(f.quota.included_units)} units</dd>` : ''}
            </dl>
            ${f.error ? `<p class="err">${esc(f.error)}</p>` : ''}
            ${f.history.length ? `<ol class="timeline">${f.history.map((h) => `<li><time>${esc(fmtTime(h.at))}</time><b>${esc(h.status)}</b>${h.sub_status ? ` / ${esc(h.sub_status)}` : ''} <small>via ${esc(h.source)}</small></li>`).join('')}</ol>` : ''}
            ${f.boarding_passes.length ? `<div class="passes">${f.boarding_passes.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Boarding pass ${i + 1}"></a>`).join('')}</div>` : ''}
            <div class="actions">
              <button class="btn small" id="refreshBtn">Refresh status</button>
              ${!f.checkin_id || ['FAILED', 'CANCELLED'].includes(f.status) ? '<button class="btn small" id="retryBtn">Retry subscribe</button>' : ''}
            </div>
          </section>
          <section class="card" aria-labelledby="actTitle"><h2 id="actTitle">Activity</h2>
            <ol class="log">${[...b.activity].reverse().map((a) => `<li><time>${esc(fmtTime(a.at))}</time><span class="k-${esc(a.kind)}">${esc(a.text)}</span></li>`).join('')}</ol>
          </section>
          <section class="card api" aria-labelledby="apiTitle"><h2 id="apiTitle">Flyo API calls</h2>${apiHtml || '<p class="fine">No calls yet.</p>'}</section>
        </div>
      </div>
    </div>`;
}

$('#detailBody').addEventListener('toggle', (e) => {
  const d = e.target.closest?.('details[data-key]');
  if (!d) return;
  if (d.open) state.openApi.add(d.dataset.key); else state.openApi.delete(d.dataset.key);
}, true);

$('#detailBody').addEventListener('click', async (e) => {
  const b = state.booking;
  const t = e.target.closest('button');
  if (!b || !t) return;
  try {
    if (t.dataset.resolve) await api(`/api/bookings/${b.id}/alerts/${t.dataset.resolve}/resolve`, { method: 'POST' });
    else if (t.dataset.edit) { openEdit(Number(t.dataset.edit)); return; }
    else if (t.id === 'overrideBtn') { t.disabled = true; await api(`/api/bookings/${b.id}/override`, { method: 'POST', body: { on: t.dataset.on === '1' } }); }
    else if (t.id === 'refreshBtn') { t.disabled = true; await api(`/api/bookings/${b.id}/refresh`, { method: 'POST' }); }
    else if (t.id === 'retryBtn') { t.disabled = true; await api(`/api/bookings/${b.id}/retry`, { method: 'POST' }); }
    else if (t.id === 'deleteBtn') {
      if (!confirm('Delete this booking from Preflight? (It is not cancelled at Flyo.)')) return;
      await api(`/api/bookings/${b.id}`, { method: 'DELETE' });
      state.selected = null;
      state.booking = null;
      renderDetail();
      renderPhone();
      await refreshList();
      return;
    }
    await loadBooking();
  } catch (err) {
    alert(err.message);
  }
});

// ------------------------------------------------------------------ edit dialog
const dialog = $('#editDialog');
let editing = null;
function openEdit(i) {
  editing = i;
  const p = state.booking.passengers[i];
  const f = $('#editForm');
  const pp = p.passport || {};
  const set = (n, v) => { f.elements[n].value = v || ''; };
  set('first_name', p.first_name); set('last_name', p.last_name); set('email', p.email); set('phone', p.phone);
  set('pp_number', pp.number); set('pp_nationality', pp.nationality || p.nationality); set('pp_date_of_issue', pp.date_of_issue);
  set('pp_expiry_date', pp.expiry_date); set('pp_place_of_issue', pp.place_of_issue); set('pp_surname', pp.surname); set('pp_given_names', pp.given_names);
  $('#editTitle').textContent = `Edit ${p.first_name} ${p.last_name}`;
  dialog.showModal();
}
dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'save' || editing == null) return;
  const f = $('#editForm').elements;
  const v = (n) => f[n].value.trim();
  const passport = { number: v('pp_number').toUpperCase(), nationality: v('pp_nationality').toUpperCase(), date_of_issue: v('pp_date_of_issue'), expiry_date: v('pp_expiry_date'), place_of_issue: v('pp_place_of_issue').toUpperCase(), surname: v('pp_surname').toUpperCase(), given_names: v('pp_given_names').toUpperCase() };
  const hasPassport = Object.values(passport).some(Boolean);
  try {
    await api(`/api/bookings/${state.booking.id}/passengers/${editing}`, { method: 'POST', body: { first_name: v('first_name'), last_name: v('last_name'), email: v('email'), phone: v('phone'), ...(hasPassport ? { passport } : {}) } });
    await loadBooking();
  } catch (e) { alert(e.message); }
});

// ------------------------------------------------------------------ phone
const chat = $('#chat');
function renderPhone() {
  const b = state.booking;
  const enabled = Boolean(b);
  $('#chatText').disabled = !enabled;
  $('#chatSend').disabled = !enabled;
  if (!b) {
    $('#phoneTitle').textContent = "Traveller's WhatsApp";
    $('#phoneSub').textContent = 'Select a booking';
    $('#phoneAvatar').textContent = '?';
    chat.innerHTML = '';
    $('#docTray').innerHTML = '';
    return;
  }
  // The conversation lives on the first journey of a ticket (outbound), shared by its return journey.
  const primary = state.bookings.find((x) => x.group === b.group && x.journey_index === 0) || b;
  const thread = (primary.id === b.id ? b.thread : primary.thread) || [];
  const name = b.contact?.name || `${b.passengers[0].first_name} ${b.passengers[0].last_name}`;
  $('#phoneTitle').textContent = name;
  $('#phoneAvatar').textContent = name.slice(0, 1).toUpperCase();
  $('#phoneSub').textContent = `${b.contact?.phone || 'no number'}${DOT}${state.meta?.messaging === 'twilio' ? 'live WhatsApp (Twilio)' : 'simulated WhatsApp'}`;
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  chat.innerHTML = thread.map((m) => `<li class="msg ${m.dir}">${(m.media || []).map((x) => (x.mime?.startsWith('image/')
    ? `<a href="${esc(x.url)}" target="_blank" rel="noopener"><img src="${esc(x.url)}" alt="${esc(x.name || 'attachment')}"></a>`
    : `<a class="file" href="${esc(x.url)}" target="_blank" rel="noopener">\ud83d\udcc4 ${esc(x.name || 'file')}</a>`)).join('')}${esc(m.text)}<time>${esc(fmtTime(m.at).slice(0, 5))}</time></li>`).join('');
  if (atBottom || thread.length < 4) chat.scrollTop = chat.scrollHeight;
  $('#docTray').innerHTML = state.docs.length
    ? `<span class="tray-label">Send as traveller:</span>${state.docs.map((d) => `<button type="button" data-doc="${esc(d.id)}">\ud83d\udcce ${esc(d.label)}</button>`).join('')}`
    : '';
}

async function sendChat(body) {
  if (!state.booking) return;
  $('#chatSend').disabled = true;
  const typing = document.createElement('li');
  typing.className = 'typing';
  typing.textContent = 'Assistant is reading\u2026';
  chat.appendChild(typing);
  chat.scrollTop = chat.scrollHeight;
  try {
    await api(`/api/bookings/${state.booking.id}/chat`, { method: 'POST', body });
  } catch (e) {
    alert(e.message);
  } finally {
    typing.remove();
    $('#chatSend').disabled = false;
    await refreshList();
    await loadBooking();
    chat.scrollTop = chat.scrollHeight;
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chatText').value.trim();
  if (!text) return;
  $('#chatText').value = '';
  sendChat({ text });
});
$('#chatFile').addEventListener('change', async () => {
  const f = $('#chatFile').files[0];
  if (!f) return;
  const payload = await fileToPayload(f);
  $('#chatFile').value = '';
  sendChat({ file: payload });
});
$('#docTray').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-doc]');
  if (btn) sendChat({ sampleDoc: btn.dataset.doc });
});

// ------------------------------------------------------------------ live updates (SSE)
let refreshTimer = null;
function connect() {
  const es = new EventSource('/api/events');
  es.onmessage = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await refreshList();
      if (state.selected) await loadBooking();
    }, 150);
  };
}

await loadMeta();
await refreshList();
if (state.bookings[0]) await select(state.bookings[0].id);
connect();
