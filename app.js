import {
  auth, db, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, orderBy, serverTimestamp, Timestamp
} from './src/firebase.js';
import { calcularEstadoCliente, formatMoney, formatFecha } from './src/logic.js';
import { leerComprobanteImagen, leerComprobanteTexto, fileToBase64 } from './src/ai-receipt.js';

const root = document.getElementById('app');

// ── STATE ──────────────────────────────────────────────
const S = {
  user: null, view: 'loading',
  grupos: [], grupoActual: null,
  clientesGrupo: [], clienteActual: null,
  loading: false, toast: null,
  modal: null, // { type, data }
};

function set(patch) { Object.assign(S, patch); render(); }
function showToast(msg, ms = 2800) {
  set({ toast: msg });
  setTimeout(() => { if (S.toast === msg) set({ toast: null }); }, ms);
}
function initials(n) { return (n||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase(); }

// ── AUTH ───────────────────────────────────────────────
onAuthStateChanged(auth, u => {
  if (u) { set({ user: u, view: 'groups' }); loadGroups(); }
  else set({ user: null, view: 'login' });
});

// ── DATA ───────────────────────────────────────────────
async function loadGroups() {
  set({ loading: true });
  const snap = await getDocs(query(collection(db, 'grupos'), orderBy('nombre')));
  const grupos = [];
  for (const d of snap.docs) {
    const data = d.data();
    const cs = await getDocs(collection(db, 'grupos', d.id, 'clientes'));
    let morosos = 0;
    for (const c of cs.docs) {
      const ps = await getDocs(collection(db, 'grupos', d.id, 'clientes', c.id, 'pagos'));
      const pagos = ps.docs.map(p => ({ monto: p.data().monto, fecha: p.data().fecha.toDate() }));
      const est = calcularEstadoCliente({ total: c.data().total, plazoSemanas: data.plazoSemanas||10 }, pagos, { multaPorDia: data.multaPorDia||35 });
      if (est.estado === 'atrasado') morosos++;
    }
    grupos.push({ id: d.id, ...data, totalClientes: cs.size, morosos });
  }
  set({ grupos, loading: false });
}

async function openGroup(gid) {
  set({ loading: true, view: 'group' });
  const gd = await getDoc(doc(db, 'grupos', gid));
  const grupo = { id: gid, ...gd.data() };
  const cs = await getDocs(query(collection(db, 'grupos', gid, 'clientes'), orderBy('nombre')));
  const clientes = [];
  for (const c of cs.docs) {
    const ps = await getDocs(query(collection(db, 'grupos', gid, 'clientes', c.id, 'pagos'), orderBy('fecha')));
    const pagos = ps.docs.map(p => ({ id: p.id, monto: p.data().monto, fecha: p.data().fecha.toDate() }));
    const est = calcularEstadoCliente({ total: c.data().total, plazoSemanas: grupo.plazoSemanas||10 }, pagos, { multaPorDia: grupo.multaPorDia||35 });
    clientes.push({ id: c.id, ...c.data(), pagos, est });
  }
  set({ grupoActual: grupo, clientesGrupo: clientes, loading: false });
}

async function openClient(cid) {
  set({ clienteActual: S.clientesGrupo.find(c => c.id === cid), view: 'client' });
}

// ── CRUD ───────────────────────────────────────────────
async function deleteGroup(gid) {
  set({ loading: true, modal: null });
  // delete subcollections
  const cs = await getDocs(collection(db, 'grupos', gid, 'clientes'));
  for (const c of cs.docs) {
    const ps = await getDocs(collection(db, 'grupos', gid, 'clientes', c.id, 'pagos'));
    for (const p of ps.docs) await deleteDoc(p.ref);
    await deleteDoc(c.ref);
  }
  await deleteDoc(doc(db, 'grupos', gid));
  showToast('Grupo eliminado');
  await loadGroups();
  set({ view: 'groups' });
}

async function deleteClient(gid, cid) {
  set({ loading: true, modal: null });
  const ps = await getDocs(collection(db, 'grupos', gid, 'clientes', cid, 'pagos'));
  for (const p of ps.docs) await deleteDoc(p.ref);
  await deleteDoc(doc(db, 'grupos', gid, 'clientes', cid));
  showToast('Cliente eliminado');
  await openGroup(gid);
  set({ view: 'group' });
}

async function deletePago(gid, cid, pid) {
  await deleteDoc(doc(db, 'grupos', gid, 'clientes', cid, 'pagos', pid));
  showToast('Pago eliminado');
  await openGroup(gid);
  set({ clienteActual: S.clientesGrupo.find(c => c.id === cid), view: 'client' });
}

async function saveClient(gid, cid, data) {
  if (cid) await updateDoc(doc(db, 'grupos', gid, 'clientes', cid), data);
  else await addDoc(collection(db, 'grupos', gid, 'clientes'), data);
  showToast(cid ? 'Cliente actualizado ✓' : 'Cliente agregado ✓');
  await openGroup(gid);
}

async function saveGroup(data, gid) {
  if (gid) await updateDoc(doc(db, 'grupos', gid), data);
  else await addDoc(collection(db, 'grupos'), data);
  showToast(gid ? 'Grupo actualizado ✓' : 'Grupo creado ✓');
  await loadGroups();
  set({ view: 'groups' });
}

async function savePago(gid, cid, monto, fechaStr) {
  set({ loading: true });
  await addDoc(collection(db, 'grupos', gid, 'clientes', cid, 'pagos'), {
    monto, fecha: Timestamp.fromDate(new Date(fechaStr + 'T12:00:00')),
    registradoPor: S.user.email, creadoEn: serverTimestamp()
  });
  showToast('Pago guardado ✓');
  await openGroup(gid);
  set({ clienteActual: S.clientesGrupo.find(c => c.id === cid), view: 'client', modal: null });
}

// ── RENDER ─────────────────────────────────────────────
function render() {
  root.innerHTML = '';
  if (S.toast) {
    const t = el('div', { className: 'toast' }, S.toast);
    root.appendChild(t);
  }
  const screens = { loading: rLoading, login: rLogin, groups: rGroups, group: rGroup, client: rClient };
  root.appendChild((screens[S.view] || rLoading)());
  if (S.modal) root.appendChild(rModal());
}

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) Object.assign(e, props);
  children.forEach(c => { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return e;
}

function rLoading() {
  const d = el('div');
  d.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:100vh;';
  d.innerHTML = '<div class="spinner spinner-blue" style="width:32px;height:32px;border-width:3px;"></div>';
  return d;
}

// ── LOGIN ──────────────────────────────────────────────
function rLogin() {
  const wrap = el('div', { className: 'login-wrap' });
  wrap.innerHTML = `
    <div class="login-card">
      <div style="text-align:center;margin-bottom:32px;">
        <div style="font-family:Fraunces,serif;font-size:28px;color:var(--accent);font-weight:700;margin-bottom:6px;">Control de Ahorros</div>
        <div style="font-size:13px;color:var(--ink-soft);">Grupos · Pagos · Multas</div>
      </div>
      <div class="card card-body">
        <div class="field"><label>Correo</label><input type="email" id="em" placeholder="tucorreo@ejemplo.com" autocomplete="username"></div>
        <div class="field"><label>Contraseña</label><input type="password" id="pw" placeholder="••••••••" autocomplete="current-password"></div>
        <button class="btn btn-primary btn-block" id="login-btn">${S.loading ? '<div class="spinner"></div>' : 'Entrar'}</button>
      </div>
    </div>`;
  wrap.querySelector('#login-btn').onclick = async () => {
    const email = wrap.querySelector('#em').value.trim();
    const pass = wrap.querySelector('#pw').value;
    if (!email || !pass) { showToast('Completa los campos'); return; }
    set({ loading: true });
    try { await signInWithEmailAndPassword(auth, email, pass); }
    catch { set({ loading: false }); showToast('Correo o contraseña incorrectos'); }
  };
  return wrap;
}

// ── GROUPS ─────────────────────────────────────────────
function rGroups() {
  const wrap = el('div');
  const top = el('div', { className: 'topbar' });
  top.innerHTML = `<div class="topbar-left"><span class="brand">Control de Ahorros</span></div><div style="display:flex;gap:8px;"></div>`;
  const logoutBtn = el('button', { className: 'btn btn-ghost btn-sm' }, 'Salir');
  logoutBtn.onclick = () => signOut(auth);
  top.querySelector('div:last-child').appendChild(logoutBtn);
  wrap.appendChild(top);

  const screen = el('div', { className: 'page screen' });
  if (S.loading) { screen.innerHTML = '<div style="display:flex;justify-content:center;padding:60px"><div class="spinner spinner-blue" style="width:28px;height:28px;"></div></div>'; wrap.appendChild(screen); return wrap; }

  const morosos = S.grupos.reduce((s, g) => s + g.morosos, 0);
  const clientes = S.grupos.reduce((s, g) => s + g.totalClientes, 0);
  screen.innerHTML = `
    <div class="stats-row">
      <div class="stat-box"><div class="n">${S.grupos.length}</div><div class="l">Grupos</div></div>
      <div class="stat-box"><div class="n">${clientes}</div><div class="l">Clientes</div></div>
      <div class="stat-box"><div class="n" style="color:${morosos>0?'var(--alert)':'var(--ok)'}">${morosos}</div><div class="l">Atrasados</div></div>
    </div>`;

  if (S.grupos.length === 0) {
    screen.innerHTML += `<div class="empty"><div class="eicon">📋</div><p>No tienes grupos aún. Toca + para crear el primero.</p></div>`;
  } else {
    const grid = el('div', { className: 'groups-grid' });
    S.grupos.forEach(g => {
      const card = el('div', { className: 'group-card' });
      card.innerHTML = `
        <div class="group-icon">${initials(g.nombre)}</div>
        <div class="group-info"><div class="name">${g.nombre}</div><div class="meta">${g.totalClientes} cliente${g.totalClientes!==1?'s':''}</div></div>
        ${g.morosos>0 ? `<span class="badge badge-alert">${g.morosos} debe${g.morosos!==1?'n':''}</span>` : `<span class="badge badge-ok">Al corriente</span>`}`;
      card.onclick = () => openGroup(g.id);
      grid.appendChild(card);
    });
    screen.appendChild(grid);
  }
  wrap.appendChild(screen);

  const fab = el('div', { className: 'fab-wrap' });
  const fabBtn = el('button', { className: 'fab' }, '+');
  fabBtn.onclick = () => set({ modal: { type: 'addGroup' } });
  fab.appendChild(fabBtn);
  wrap.appendChild(fab);
  return wrap;
}

// ── GROUP DETAIL ───────────────────────────────────────
function rGroup() {
  const g = S.grupoActual;
  const wrap = el('div');
  const top = el('div', { className: 'topbar' });
  top.innerHTML = `<div class="topbar-left"><button class="back-btn" id="back">‹</button><h1>${g?.nombre||''}</h1></div><div style="display:flex;gap:6px;"></div>`;
  top.querySelector('#back').onclick = () => { set({ view: 'groups' }); loadGroups(); };

  if (g) {
    const editBtn = el('button', { className: 'btn btn-ghost btn-sm' }, '✏️ Editar');
    editBtn.onclick = () => set({ modal: { type: 'editGroup', data: g } });
    const delBtn = el('button', { className: 'btn btn-danger btn-sm' }, '🗑️');
    delBtn.onclick = () => set({ modal: { type: 'confirmDeleteGroup', data: g } });
    top.querySelector('div:last-child').appendChild(editBtn);
    top.querySelector('div:last-child').appendChild(delBtn);
  }
  wrap.appendChild(top);

  const screen = el('div', { className: 'page screen' });
  if (S.loading || !g) { screen.innerHTML = '<div style="display:flex;justify-content:center;padding:60px"><div class="spinner spinner-blue" style="width:28px;height:28px;"></div></div>'; wrap.appendChild(screen); return wrap; }

  const atrasados = S.clientesGrupo.filter(c => c.est.estado === 'atrasado');
  const resto = S.clientesGrupo.filter(c => c.est.estado !== 'atrasado');
  const multaTotal = S.clientesGrupo.reduce((s, c) => s + c.est.multa, 0);

  screen.innerHTML = `
    <div class="stats-row">
      <div class="stat-box"><div class="n">${S.clientesGrupo.length}</div><div class="l">Clientes</div></div>
      <div class="stat-box"><div class="n" style="color:${atrasados.length>0?'var(--alert)':'var(--ok)'}">${atrasados.length}</div><div class="l">Atrasados</div></div>
      <div class="stat-box"><div class="n num" style="font-size:18px;color:var(--alert)">${formatMoney(multaTotal)}</div><div class="l">Multas</div></div>
    </div>`;

  function clientRow(c) {
    const row = el('div', { className: 'client-row' });
    const dot = c.est.estado==='atrasado'?'dot-alert':c.est.estado==='sin_pagos'?'dot-none':'dot-ok';
    const color = c.est.estado==='atrasado'?'var(--alert)':c.est.estado==='pagado'?'var(--ok)':'var(--ink)';
    row.innerHTML = `
      <span class="status-dot ${dot}"></span>
      <div class="avatar">${initials(c.nombre)}</div>
      <div class="client-info"><div class="name">${c.nombre}</div><div class="product">${c.producto||''}</div></div>
      <div class="client-amount">
        <div class="val num" style="color:${color}">${c.est.estado==='atrasado'?formatMoney(c.est.multa):formatMoney(c.est.restante)}</div>
        <div class="lbl">${c.est.estado==='atrasado'?'multa':'restante'}</div>
      </div>`;
    row.onclick = () => openClient(c.id);
    return row;
  }

  if (atrasados.length > 0) {
    const lbl = el('div', { className: 'section-label' }, 'Atrasados');
    const list = el('div', { className: 'client-list' });
    atrasados.forEach(c => list.appendChild(clientRow(c)));
    screen.appendChild(lbl); screen.appendChild(list);
  }

  const lbl2 = el('div', { className: 'section-label' }, atrasados.length > 0 ? 'Al corriente' : 'Clientes');
  screen.appendChild(lbl2);
  if (resto.length === 0 && atrasados.length === 0) {
    screen.appendChild(el('div', { className: 'empty' }, el('p', null, 'Sin clientes aún.')));
  } else {
    const list2 = el('div', { className: 'client-list' });
    resto.forEach(c => list2.appendChild(clientRow(c)));
    screen.appendChild(list2);
  }

  const addBtn = el('button', { className: 'btn btn-secondary btn-block', style: 'margin-top:16px;' }, '+ Agregar cliente');
  addBtn.onclick = () => set({ modal: { type: 'addClient' } });
  screen.appendChild(addBtn);
  wrap.appendChild(screen);

  const fab = el('div', { className: 'fab-wrap' });
  const fabBtn = el('button', { className: 'fab' }, '+');
  fabBtn.onclick = () => set({ modal: { type: 'addPayment', data: { clienteId: null } } });
  fab.appendChild(fabBtn);
  wrap.appendChild(fab);
  return wrap;
}

// ── CLIENT DETAIL ──────────────────────────────────────
function rClient() {
  const c = S.clienteActual;
  const g = S.grupoActual;
  const wrap = el('div');
  const top = el('div', { className: 'topbar' });
  top.innerHTML = `<div class="topbar-left"><button class="back-btn" id="back">‹</button><h1>${c?.nombre||''}</h1></div><div style="display:flex;gap:6px;"></div>`;
  top.querySelector('#back').onclick = () => set({ view: 'group' });

  if (c && g) {
    const editBtn = el('button', { className: 'btn btn-ghost btn-sm' }, '✏️');
    editBtn.onclick = () => set({ modal: { type: 'editClient', data: c } });
    const delBtn = el('button', { className: 'btn btn-danger btn-sm' }, '🗑️');
    delBtn.onclick = () => set({ modal: { type: 'confirmDeleteClient', data: c } });
    const msgBtn = el('button', { className: 'btn btn-ghost btn-sm' }, '💬');
    msgBtn.onclick = () => set({ modal: { type: 'mensajeCobro', data: c } });
    top.querySelector('div:last-child').append(msgBtn, editBtn, delBtn);
  }
  wrap.appendChild(top);

  if (!c) { wrap.appendChild(el('div', { className: 'page screen' })); return wrap; }
  const est = c.est;
  const screen = el('div', { className: 'page screen' });

  const statusColor = est.estado==='atrasado'?'var(--alert)':est.estado==='sin_pagos'?'var(--ink-soft)':'var(--ok)';
  const statusLabel = est.estado==='atrasado'?`⚠️ Atrasada(o) ${est.diasAtraso} día(s)`:est.estado==='sin_pagos'?'Sin pagos':'✅ Al corriente';

  const detailCard = el('div', { className: 'card card-body' });
  detailCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">
      <div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:3px;">${c.producto||''}</div>
        <div style="font-weight:700;font-size:13px;color:${statusColor};">${statusLabel}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-family:Fraunces,serif;font-size:26px;font-weight:700;">${formatMoney(est.restante)}</div>
        <div style="font-size:11px;color:var(--ink-soft);">restante</div>
      </div>
    </div>
    <div class="info-grid">
      <div class="info-box"><div class="iv num">${formatMoney(c.total)}</div><div class="il">Total</div></div>
      <div class="info-box"><div class="iv num">${formatMoney(est.totalPagado)}</div><div class="il">Pagado</div></div>
      <div class="info-box" style="${est.multa>0?'background:var(--alert-soft);border:1px solid rgba(239,68,68,0.2);':''}">
        <div class="iv num" style="color:${est.multa>0?'var(--alert)':'var(--ink)'}">${formatMoney(est.multa)}</div>
        <div class="il">Multa</div>
      </div>
    </div>`;

  if (est.inicioSemana1) {
    detailCard.innerHTML += `<div class="hint" style="border-top:1px solid var(--line);padding-top:10px;margin-top:4px;">
      Semana 1: <strong>${formatFecha(est.inicioSemana1)}</strong> · ${est.semanasTranscurridas} semanas transcurridas · Debería llevar <strong>${formatMoney(est.deberiaLlevar)}</strong>
    </div>`;
  }
  screen.appendChild(detailCard);

  const payBtn = el('button', { className: 'btn btn-primary btn-block', style: 'margin:14px 0;' }, '+ Registrar pago');
  payBtn.onclick = () => set({ modal: { type: 'addPayment', data: { clienteId: c.id } } });
  screen.appendChild(payBtn);

  if (est.estado === 'atrasado') {
    const msgBtn = el('button', { className: 'btn btn-success btn-block', style: 'margin-bottom:14px;' }, '💬 Generar mensaje de cobro');
    msgBtn.onclick = () => set({ modal: { type: 'mensajeCobro', data: c } });
    screen.appendChild(msgBtn);
  }

  const lbl = el('div', { className: 'section-label' }, 'Historial de pagos');
  screen.appendChild(lbl);

  const histCard = el('div', { className: 'card card-body' });
  if (!c.pagos || c.pagos.length === 0) {
    histCard.innerHTML = '<div style="text-align:center;color:var(--ink-soft);font-size:13px;padding:8px 0;">Sin pagos registrados.</div>';
  } else {
    const ordenados = [...c.pagos].sort((a, b) => b.fecha - a.fecha);
    ordenados.forEach(p => {
      const row = el('div', { className: 'history-row' });
      const delBtn = el('button', { className: 'del-btn' }, '×');
      delBtn.onclick = (e) => { e.stopPropagation(); set({ modal: { type: 'confirmDeletePago', data: { pago: p, clienteId: c.id } } }); };
      row.innerHTML = `<div><div class="hl">Pago</div><div class="hd">${formatFecha(p.fecha)}</div></div><div style="display:flex;align-items:center;gap:10px;"><div class="hr num">${formatMoney(p.monto)}</div></div>`;
      row.querySelector('div:last-child').appendChild(delBtn);
      histCard.appendChild(row);
    });
  }
  screen.appendChild(histCard);
  wrap.appendChild(screen);
  return wrap;
}

// ── MODALS ─────────────────────────────────────────────
function rModal() {
  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => { if (e.target === overlay) set({ modal: null }); };
  const sheet = el('div', { className: 'modal-sheet' });
  sheet.innerHTML = '<div class="modal-handle"></div>';

  const { type, data } = S.modal;

  if (type === 'addGroup' || type === 'editGroup') {
    const isEdit = type === 'editGroup';
    sheet.innerHTML += `<div class="modal-title">${isEdit ? 'Editar grupo' : 'Nuevo grupo'}</div>
      <div class="field"><label>Nombre</label><input id="mg-nombre" value="${isEdit ? data.nombre : ''}"></div>
      <div class="gap-row">
        <div class="field" style="flex:1"><label>Plazo (semanas)</label><input type="number" id="mg-plazo" value="${isEdit ? data.plazoSemanas : 10}"></div>
        <div class="field" style="flex:1"><label>Multa/día ($)</label><input type="number" id="mg-multa" value="${isEdit ? data.multaPorDia : 35}"></div>
      </div>`;
    const btn = el('button', { className: 'btn btn-primary btn-block' }, isEdit ? 'Guardar cambios' : 'Crear grupo');
    btn.onclick = async () => {
      const nombre = sheet.querySelector('#mg-nombre').value.trim();
      const plazoSemanas = parseInt(sheet.querySelector('#mg-plazo').value) || 10;
      const multaPorDia = parseFloat(sheet.querySelector('#mg-multa').value) || 35;
      if (!nombre) { showToast('Ponle un nombre'); return; }
      await saveGroup({ nombre, plazoSemanas, multaPorDia }, isEdit ? data.id : null);
    };
    sheet.appendChild(btn);
  }

  else if (type === 'addClient' || type === 'editClient') {
    const isEdit = type === 'editClient';
    sheet.innerHTML += `<div class="modal-title">${isEdit ? 'Editar cliente' : 'Nuevo cliente'}</div>
      <div class="field"><label>Nombre</label><input id="mc-nombre" value="${isEdit ? data.nombre : ''}"></div>
      <div class="field"><label>Producto</label><input id="mc-producto" value="${isEdit ? data.producto||'' : ''}"></div>
      <div class="field"><label>Total a pagar</label><input type="number" id="mc-total" value="${isEdit ? data.total : ''}"></div>`;
    const btn = el('button', { className: 'btn btn-primary btn-block' }, isEdit ? 'Guardar cambios' : 'Agregar cliente');
    btn.onclick = async () => {
      const nombre = sheet.querySelector('#mc-nombre').value.trim();
      const producto = sheet.querySelector('#mc-producto').value.trim();
      const total = parseFloat(sheet.querySelector('#mc-total').value);
      if (!nombre || !total) { showToast('Nombre y total son obligatorios'); return; }
      await saveClient(S.grupoActual.id, isEdit ? data.id : null, { nombre, producto, total });
      set({ modal: null });
    };
    sheet.appendChild(btn);
  }

  else if (type === 'addPayment') {
    let pagoState = { modo: null, img64: null, imgType: null, imgPreview: null, texto: '', propuesta: null, leyendo: false, clienteId: data?.clienteId || null };

    function renderPayModal() {
      const body = sheet.querySelector('#pay-body');
      body.innerHTML = '';

      if (!S.grupoActual) return;

      // Client selector
      if (!S.clienteActual && !pagoState.clienteId) {
        const field = el('div', { className: 'field' });
        field.innerHTML = `<label>Cliente</label><select id="cs"><option value="">Selecciona...</option>${S.clientesGrupo.map(c=>`<option value="${c.id}">${c.nombre}</option>`).join('')}</select>`;
        field.querySelector('select').onchange = e => { pagoState.clienteId = e.target.value; };
        body.appendChild(field);
      } else if (S.clienteActual) {
        pagoState.clienteId = S.clienteActual.id;
        const info = el('div', { className: 'field' });
        info.innerHTML = `<label>Cliente</label><div style="padding:11px 14px;background:var(--surface2);border-radius:10px;font-size:14px;">${S.clienteActual.nombre}</div>`;
        body.appendChild(info);
      }

      if (!pagoState.propuesta) {
        const tabs = el('div', { className: 'pill-tabs' });
        tabs.innerHTML = `<button id="t-foto" class="${pagoState.modo==='foto'?'active':''}">📷 Captura</button><button id="t-texto" class="${pagoState.modo==='texto'?'active':''}">💬 Mensaje</button><button id="t-manual" class="${pagoState.modo==='manual'?'active':''}">✍️ Manual</button>`;
        tabs.querySelector('#t-foto').onclick = () => { pagoState.modo='foto'; renderPayModal(); };
        tabs.querySelector('#t-texto').onclick = () => { pagoState.modo='texto'; renderPayModal(); };
        tabs.querySelector('#t-manual').onclick = () => { pagoState.modo='manual'; renderPayModal(); };
        body.appendChild(tabs);

        if (pagoState.modo === 'foto') {
          if (pagoState.imgPreview) {
            body.innerHTML += `<img src="${pagoState.imgPreview}" class="preview-img">`;
            const readBtn = el('button', { className: 'btn btn-primary btn-block' });
            readBtn.innerHTML = pagoState.leyendo ? '<div class="spinner"></div>' : 'Leer con IA';
            readBtn.disabled = pagoState.leyendo;
            readBtn.onclick = async () => {
              pagoState.leyendo = true; renderPayModal();
              try {
                const r = await leerComprobanteImagen(pagoState.img64, pagoState.imgType);
                if (!r.fecha) r.fecha = new Date().toISOString().slice(0,10);
                pagoState.propuesta = r;
              } catch { showToast('No se pudo leer la imagen. Prueba manual.'); }
              pagoState.leyendo = false; renderPayModal();
            };
            body.appendChild(readBtn);
          } else {
            const zone = el('div', { className: 'upload-zone' });
            zone.innerHTML = '<div class="icon">📷</div><div>Toca para subir la captura</div>';
            const inp = el('input'); inp.type='file'; inp.accept='image/*'; inp.style.display='none';
            inp.onchange = async e => {
              const file = e.target.files[0]; if (!file) return;
              pagoState.img64 = await fileToBase64(file);
              pagoState.imgType = file.type;
              pagoState.imgPreview = `data:${file.type};base64,${pagoState.img64}`;
              renderPayModal();
            };
            zone.onclick = () => inp.click();
            body.appendChild(zone); body.appendChild(inp);
          }
          body.appendChild(el('div', { className: 'hint', style: 'text-align:center;margin-top:8px;' }, 'La IA propone — tú confirmas antes de guardar.'));
        }

        if (pagoState.modo === 'texto') {
          const field = el('div', { className: 'field' });
          field.innerHTML = `<label>Mensaje de Messenger</label><input type="text" id="tm" placeholder='Ej: "ya te pagué 200"' value="${pagoState.texto}">`;
          body.appendChild(field);
          const readBtn = el('button', { className: 'btn btn-primary btn-block' });
          readBtn.innerHTML = pagoState.leyendo ? '<div class="spinner"></div>' : 'Interpretar';
          readBtn.disabled = pagoState.leyendo;
          readBtn.onclick = async () => {
            pagoState.texto = body.querySelector('#tm').value;
            if (!pagoState.texto.trim()) { showToast('Escribe el mensaje'); return; }
            pagoState.leyendo = true; renderPayModal();
            try {
              const r = await leerComprobanteTexto(pagoState.texto);
              if (!r.fecha) r.fecha = new Date().toISOString().slice(0,10);
              pagoState.propuesta = r;
            } catch { showToast('No se pudo interpretar. Prueba manual.'); }
            pagoState.leyendo = false; renderPayModal();
          };
          body.appendChild(readBtn);
        }

        if (pagoState.modo === 'manual') {
          body.innerHTML += `<div class="field"><label>Monto</label><input type="number" id="mm" placeholder="0"></div><div class="field"><label>Fecha</label><input type="date" id="mf" value="${new Date().toISOString().slice(0,10)}"></div>`;
          const btn = el('button', { className: 'btn btn-primary btn-block' }, 'Continuar');
          btn.onclick = () => {
            const m = parseFloat(body.querySelector('#mm').value);
            const f = body.querySelector('#mf').value;
            if (!m || m <= 0) { showToast('Ingresa un monto'); return; }
            pagoState.propuesta = { monto: m, fecha: f, confianza: 'manual', notas: '' };
            renderPayModal();
          };
          body.appendChild(btn);
        }
      } else {
        // Confirmation step
        const p = pagoState.propuesta;
        if (pagoState.imgPreview) body.innerHTML += `<img src="${pagoState.imgPreview}" class="preview-img">`;
        if (p.confianza && p.confianza !== 'manual') {
          const conf = el('div', { className: 'confirm-alert' });
          conf.textContent = `${p.confianza==='alta'?'✅ Confianza alta':p.confianza==='media'?'⚠️ Confianza media — revisa':'⚠️ Confianza baja — revisa con cuidado'}: ${p.notas||''}`;
          body.appendChild(conf);
        }
        body.innerHTML += `<div class="field"><label>Monto</label><input type="number" id="cm" value="${p.monto??''}"></div><div class="field"><label>Fecha</label><input type="date" id="cf" value="${p.fecha||new Date().toISOString().slice(0,10)}"></div>`;
        if (p.nombreDetectado) body.innerHTML += `<div class="hint">Nombre en comprobante: <strong>${p.nombreDetectado}</strong></div>`;

        const confirmBtn = el('button', { className: 'btn btn-primary btn-block', style: 'margin-top:12px;' }, 'Confirmar y guardar pago');
        confirmBtn.onclick = async () => {
          const monto = parseFloat(body.querySelector('#cm').value);
          const fecha = body.querySelector('#cf').value;
          const cid = S.clienteActual ? S.clienteActual.id : pagoState.clienteId;
          if (!cid) { showToast('Selecciona un cliente'); return; }
          if (!monto || monto <= 0) { showToast('Monto inválido'); return; }
          if (!fecha) { showToast('Selecciona una fecha'); return; }
          await savePago(S.grupoActual.id, cid, monto, fecha);
        };
        body.appendChild(confirmBtn);

        const retryBtn = el('button', { className: 'btn btn-ghost btn-block', style: 'margin-top:6px;' }, 'Volver a intentar');
        retryBtn.onclick = () => { pagoState.propuesta = null; renderPayModal(); };
        body.appendChild(retryBtn);
      }
    }

    sheet.innerHTML += '<div class="modal-title">Registrar pago</div><div id="pay-body"></div>';
    setTimeout(() => renderPayModal(), 0);
  }

  else if (type === 'mensajeCobro') {
    const c = data;
    const est = c.est;
    const hoy = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
    const msg = `Hola ${c.nombre.split(' ')[0]} 👋\n\nTe recuerdo que tienes un pago pendiente de tu ahorro:\n\n• Producto: ${c.producto||'tu artículo'}\n• Total pagado: ${formatMoney(est.totalPagado)} de ${formatMoney(c.total)}\n• Días de atraso: ${est.diasAtraso}\n• Multa acumulada: ${formatMoney(est.multa)}\n• Total que debes hoy (${hoy}): ${formatMoney(est.restante)}\n\nPor favor realiza tu pago a la brevedad para evitar más multas ($${S.grupoActual?.multaPorDia||35}/día).\n\n¡Gracias! 🙏`;
    sheet.innerHTML += `<div class="modal-title">💬 Mensaje de cobro</div><div class="msg-box" id="msg-txt">${msg.replace(/\n/g,'<br>')}</div>`;
    const copyBtn = el('button', { className: 'btn btn-primary btn-block', style: 'margin-top:14px;' }, 'Copiar mensaje');
    copyBtn.onclick = () => { navigator.clipboard.writeText(msg); showToast('Mensaje copiado ✓'); };
    sheet.appendChild(copyBtn);
  }

  else if (type === 'confirmDeleteGroup') {
    sheet.innerHTML += `<div class="modal-title">¿Eliminar grupo?</div><div class="confirm-alert">Esto borrará el grupo <strong>${data.nombre}</strong> con todos sus clientes y pagos. Esta acción no se puede deshacer.</div>`;
    const gap = el('div', { className: 'gap-row' });
    const cancel = el('button', { className: 'btn btn-secondary' }, 'Cancelar');
    cancel.onclick = () => set({ modal: null });
    const del = el('button', { className: 'btn btn-danger' }, 'Sí, eliminar');
    del.onclick = () => deleteGroup(data.id);
    gap.append(cancel, del);
    sheet.appendChild(gap);
  }

  else if (type === 'confirmDeleteClient') {
    sheet.innerHTML += `<div class="modal-title">¿Eliminar cliente?</div><div class="confirm-alert">Se eliminará a <strong>${data.nombre}</strong> y todos sus pagos del grupo.</div>`;
    const gap = el('div', { className: 'gap-row' });
    const cancel = el('button', { className: 'btn btn-secondary' }, 'Cancelar');
    cancel.onclick = () => set({ modal: null });
    const del = el('button', { className: 'btn btn-danger' }, 'Sí, eliminar');
    del.onclick = () => deleteClient(S.grupoActual.id, data.id);
    gap.append(cancel, del);
    sheet.appendChild(gap);
  }

  else if (type === 'confirmDeletePago') {
    const { pago, clienteId } = data;
    sheet.innerHTML += `<div class="modal-title">¿Eliminar pago?</div><div class="confirm-alert">Se eliminará el pago de <strong>${formatMoney(pago.monto)}</strong> del ${formatFecha(pago.fecha)}. Esto recalculará el estado y la multa del cliente.</div>`;
    const gap = el('div', { className: 'gap-row' });
    const cancel = el('button', { className: 'btn btn-secondary' }, 'Cancelar');
    cancel.onclick = () => set({ modal: null });
    const del = el('button', { className: 'btn btn-danger' }, 'Sí, eliminar');
    del.onclick = () => deletePago(S.grupoActual.id, clienteId, pago.id);
    gap.append(cancel, del);
    sheet.appendChild(gap);
  }

  overlay.appendChild(sheet);
  return overlay;
}

render();
