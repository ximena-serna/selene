import {
  auth, db, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, orderBy, serverTimestamp, Timestamp
} from './src/firebase.js';
import { calcularEstadoCliente, formatMoney, formatFecha } from './src/logic.js';
import { leerComprobanteImagen, leerComprobanteTexto, fileToBase64 } from './src/ai-receipt.js';

const root = document.getElementById('app');

// ── STATE ──────────────────────────────────────────────────────────────
const S = {
  user: null, view: 'loading',
  grupos: [],       // { id, nombre, plazoSemanas, multaPorDia, clientes: [{id, nombre, producto, total, pagos:[], est:{}}] }
  grupoIdx: null,   // index into S.grupos
  clienteId: null,  // id of selected client
  loading: false, toast: null, modal: null,
  searchQ: '',
};

const get = {
  grupo: () => S.grupoIdx != null ? S.grupos[S.grupoIdx] : null,
  cliente: () => {
    const g = get.grupo();
    return g ? g.clientes.find(c => c.id === S.clienteId) : null;
  },
};

function set(patch) { Object.assign(S, patch); render(); }
function showToast(msg, ms=2600) {
  set({ toast: msg });
  setTimeout(() => { if (S.toast===msg) set({ toast: null }); }, ms);
}
function initials(n) { return (n||'?').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase(); }

// ── AUTH ───────────────────────────────────────────────────────────────
onAuthStateChanged(auth, u => {
  if (u) { set({ user: u, view: 'loading' }); loadAll(); }
  else set({ user: null, view: 'login' });
});

// ── FAST DATA LOAD: one pass for everything ────────────────────────────
async function loadAll() {
  set({ loading: true });
  // 1. Load all grupos
  const gSnap = await getDocs(query(collection(db, 'grupos'), orderBy('nombre')));
  const grupos = gSnap.docs.map(d => ({ id: d.id, ...d.data(), clientes: [] }));

  // 2. For each grupo, load clientes + pagos in parallel
  await Promise.all(grupos.map(async (g) => {
    const cSnap = await getDocs(query(collection(db, 'grupos', g.id, 'clientes'), orderBy('nombre')));
    await Promise.all(cSnap.docs.map(async (cd) => {
      const pSnap = await getDocs(query(collection(db, 'grupos', g.id, 'clientes', cd.id, 'pagos'), orderBy('fecha')));
      const pagos = pSnap.docs.map(p => ({
        id: p.id, monto: p.data().monto,
        fecha: p.data().fecha.toDate(),
        numeroPago: p.data().numeroPago ?? null,
        esAnticipo: p.data().esAnticipo ?? false,
        hora: p.data().hora ?? '',
        cuenta: p.data().cuenta ?? '',
      }));
      const est = calcularEstadoCliente(
        { total: cd.data().total, plazoSemanas: g.plazoSemanas || 10 },
        pagos, { multaPorDia: g.multaPorDia || 35 }
      );
      g.clientes.push({ id: cd.id, ...cd.data(), pagos, est });
    }));
    g.clientes.sort((a,b) => a.nombre.localeCompare(b.nombre));
  }));

  set({ grupos, loading: false, view: 'groups' });
}

async function reloadGroup(gid) {
  const g = S.grupos.find(x => x.id === gid);
  if (!g) return;
  const cSnap = await getDocs(query(collection(db, 'grupos', gid, 'clientes'), orderBy('nombre')));
  const clientes = [];
  await Promise.all(cSnap.docs.map(async (cd) => {
    const pSnap = await getDocs(query(collection(db, 'grupos', gid, 'clientes', cd.id, 'pagos'), orderBy('fecha')));
    const pagos = pSnap.docs.map(p => ({
      id: p.id, monto: p.data().monto, fecha: p.data().fecha.toDate(),
      numeroPago: p.data().numeroPago ?? null, esAnticipo: p.data().esAnticipo ?? false,
      hora: p.data().hora ?? '', cuenta: p.data().cuenta ?? '',
    }));
    const est = calcularEstadoCliente(
      { total: cd.data().total, plazoSemanas: g.plazoSemanas || 10 },
      pagos, { multaPorDia: g.multaPorDia || 35 }
    );
    clientes.push({ id: cd.id, ...cd.data(), pagos, est });
  }));
  clientes.sort((a,b) => a.nombre.localeCompare(b.nombre));
  g.clientes = clientes;
}

// ── CRUD ───────────────────────────────────────────────────────────────
async function deleteGroup(gid) {
  set({ loading: true, modal: null });
  const cs = await getDocs(collection(db, 'grupos', gid, 'clientes'));
  for (const c of cs.docs) {
    const ps = await getDocs(collection(db, 'grupos', gid, 'clientes', c.id, 'pagos'));
    for (const p of ps.docs) await deleteDoc(p.ref);
    await deleteDoc(c.ref);
  }
  await deleteDoc(doc(db, 'grupos', gid));
  S.grupos.splice(S.grupos.findIndex(g => g.id === gid), 1);
  showToast('Grupo eliminado');
  set({ view: 'groups', grupoIdx: null, loading: false });
}

async function deleteClient(gid, cid) {
  set({ loading: true, modal: null });
  const ps = await getDocs(collection(db, 'grupos', gid, 'clientes', cid, 'pagos'));
  for (const p of ps.docs) await deleteDoc(p.ref);
  await deleteDoc(doc(db, 'grupos', gid, 'clientes', cid));
  await reloadGroup(gid);
  showToast('Cliente eliminado');
  set({ view: 'group', clienteId: null, loading: false });
}

async function deletePago(gid, cid, pid) {
  await deleteDoc(doc(db, 'grupos', gid, 'clientes', cid, 'pagos', pid));
  await reloadGroup(gid);
  showToast('Pago eliminado');
  set({ modal: null });
}

async function saveGroup(data, gid) {
  if (gid) {
    await updateDoc(doc(db, 'grupos', gid), data);
    const g = S.grupos.find(x => x.id === gid);
    if (g) Object.assign(g, data);
  } else {
    const ref = await addDoc(collection(db, 'grupos'), data);
    S.grupos.push({ id: ref.id, ...data, clientes: [] });
    S.grupos.sort((a,b) => a.nombre.localeCompare(b.nombre));
  }
  showToast(gid ? 'Grupo actualizado ✓' : 'Grupo creado ✓');
  set({ modal: null, view: 'groups' });
}

async function saveClient(gid, cid, data) {
  if (cid) await updateDoc(doc(db, 'grupos', gid, 'clientes', cid), data);
  else await addDoc(collection(db, 'grupos', gid, 'clientes'), data);
  await reloadGroup(gid);
  showToast(cid ? 'Cliente actualizado ✓' : 'Cliente agregado ✓');
  set({ modal: null });
}

async function savePago(gid, cid, monto, fechaStr, numeroPago, esAnticipo, hora, cuenta) {
  set({ loading: true });
  await addDoc(collection(db, 'grupos', gid, 'clientes', cid, 'pagos'), {
    monto, numeroPago: numeroPago ?? null, esAnticipo: !!esAnticipo,
    fecha: Timestamp.fromDate(new Date(fechaStr + 'T12:00:00')),
    hora: hora || '', cuenta: cuenta || '',
    registradoPor: S.user.email, creadoEn: serverTimestamp()
  });
  await reloadGroup(gid);
  showToast('Pago guardado ✓');
  set({ modal: null, loading: false });
}

// ── RENDER ─────────────────────────────────────────────────────────────
function render() {
  root.innerHTML = '';
  if (S.toast) root.appendChild(el('div', { className:'toast' }, S.toast));
  const views = { loading:rLoading, login:rLogin, groups:rGroups, group:rGroup, client:rClient, ingresos:rIngresos, cobros:rCobros };
  root.appendChild((views[S.view]||rLoading)());
  if (S.modal) root.appendChild(rModal());
}

function el(tag, props, ...ch) {
  const e = document.createElement(tag);
  if (props) Object.assign(e, props);
  ch.forEach(c => { if (c!=null) e.appendChild(typeof c==='string'?document.createTextNode(c):c); });
  return e;
}

function topbar(title, backFn, rightBtns=[]) {
  const bar = el('div',{className:'topbar'});
  const left = el('div',{className:'topbar-left'});
  if (backFn) {
    const b = el('button',{className:'back-btn'},'‹');
    b.onclick = backFn;
    left.appendChild(b);
  }
  left.appendChild(el('h1',null,title));
  bar.appendChild(left);
  const right = el('div',{className:'topbar-right'});
  rightBtns.forEach(b => right.appendChild(b));
  bar.appendChild(right);
  return bar;
}

function rLoading() {
  const d = el('div');
  d.style.cssText='display:flex;align-items:center;justify-content:center;min-height:100vh;';
  d.innerHTML='<div class="spinner spinner-blue" style="width:30px;height:30px;border-width:3px;"></div>';
  return d;
}

// ── LOGIN ──────────────────────────────────────────────────────────────
function rLogin() {
  const wrap = el('div',{className:'login-wrap'});
  const card = el('div',{className:'login-card'});
  card.innerHTML=`
    <div class="login-logo"><div class="mark">Control de Ahorros</div><div class="sub">Grupos · Pagos · Multas</div></div>
    <div class="field"><label>Correo</label><input type="email" id="em" placeholder="tucorreo@ejemplo.com" autocomplete="username"></div>
    <div class="field"><label>Contraseña</label><input type="password" id="pw" placeholder="••••••••" autocomplete="current-password"></div>`;
  const btn = el('button',{className:'btn btn-primary btn-block'},S.loading?'':'Entrar');
  if (S.loading) btn.appendChild(el('div',{className:'spinner'}));
  btn.onclick = async () => {
    const email=card.querySelector('#em').value.trim(), pass=card.querySelector('#pw').value;
    if (!email||!pass){showToast('Completa los campos');return;}
    set({loading:true});
    try { await signInWithEmailAndPassword(auth,email,pass); }
    catch { set({loading:false}); showToast('Correo o contraseña incorrectos'); }
  };
  card.appendChild(btn);
  wrap.appendChild(card);
  return wrap;
}

// ── SEARCH RESULTS (reusable, called without full re-render) ──────────
function buildSearchResults(searchQ) {
  const wrap = el('div');
  if (!searchQ || searchQ.trim().length === 0) return wrap;
  const q = searchQ.trim().toLowerCase();
  const results = [];
  S.grupos.forEach(g => {
    g.clientes.forEach(c => {
      if (c.nombre.toLowerCase().includes(q)||(c.producto||'').toLowerCase().includes(q)) {
        results.push({grupo:g,cliente:c});
      }
    });
  });
  const lbl = el('div',{className:'section-label'},`${results.length} resultado${results.length!==1?'s':''}`);
  wrap.appendChild(lbl);
  if (results.length===0) {
    wrap.appendChild(el('div',{className:'empty'},el('div',{className:'eicon'},'🔍'),el('p',null,'No se encontraron clientes.')));
  } else {
    const list = el('div',{className:'client-list'});
    results.forEach(({grupo:g,cliente:c}) => {
      const row = el('div',{className:'search-result-row'});
      const dot = c.est.estado==='atrasado'?'dot-alert':c.est.estado==='sin_pagos'?'dot-none':'dot-ok';
      const color = c.est.estado==='atrasado'?'var(--alert)':'var(--ink)';
      row.innerHTML=`
        <span class="status-dot ${dot}"></span>
        <div class="avatar">${initials(c.nombre)}</div>
        <div class="client-info">
          <div class="name">${c.nombre}</div>
          <div class="search-result-group">${g.nombre} · ${c.producto||''}</div>
        </div>
        <div class="client-amount">
          <div class="val num" style="color:${color}">${c.est.estado==='atrasado'?formatMoney(c.est.multa):formatMoney(c.est.restante)}</div>
          <div class="lbl">${c.est.estado==='atrasado'?'multa':'restante'}</div>
        </div>`;
      row.onclick=()=>{
        const idx=S.grupos.indexOf(g);
        set({grupoIdx:idx,clienteId:c.id,view:'client',searchQ:''});
      };
      list.appendChild(row);
    });
    wrap.appendChild(list);
  }
  return wrap;
}

// ── GROUPS ─────────────────────────────────────────────────────────────
function rGroups() {
  const wrap = el('div');

  // Topbar
  const logoutBtn = el('button',{className:'btn btn-white btn-sm'},'Salir');
  logoutBtn.onclick = () => signOut(auth);
  const addBtn = el('button',{className:'btn btn-white btn-sm'},'+  Grupo');
  addBtn.onclick = () => set({modal:{type:'addGroup'}});
  const ingBtn = el('button',{className:'btn btn-white btn-sm'},'💰');
  ingBtn.title='Ver ingresos';
  ingBtn.onclick = () => set({view:'ingresos'});
  wrap.appendChild(topbar('Control de Ahorros', null, [ingBtn, addBtn, logoutBtn]));

  // Search bar
  const sw = el('div',{className:'search-wrap'});
  const swi = el('div',{className:'search-wrap-inner'});
  const searchIcon = el('span',{className:'search-icon'},'🔍');
  const searchInp = el('input',{className:'search-input', placeholder:'Buscar cliente en todos los grupos...'});
  searchInp.value = S.searchQ;
  searchInp.oninput = e => {
    S.searchQ = e.target.value;
    // Solo actualiza resultados sin redibujar todo el DOM (evita perder el foco)
    const resultsContainer = document.getElementById('search-results');
    if (resultsContainer) {
      const newResults = buildSearchResults(S.searchQ);
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(newResults);
    } else {
      render();
    }
  };
  // Mantener foco si ya estaba activo
  setTimeout(() => { if (S.searchQ) searchInp.focus(); }, 0);
  swi.appendChild(searchIcon); swi.appendChild(searchInp);
  sw.appendChild(swi);
  wrap.appendChild(sw);

  const screen = el('div',{className:'page'});

  if (S.loading) {
    screen.innerHTML='<div style="display:flex;justify-content:center;padding:60px"><div class="spinner spinner-blue" style="width:26px;height:26px;"></div></div>';
    wrap.appendChild(screen); return wrap;
  }

  // Search results container (updated in-place on input)
  const resultsDiv = el('div',{id:'search-results'});
  resultsDiv.appendChild(buildSearchResults(S.searchQ));
  screen.appendChild(resultsDiv);
  if (S.searchQ.trim().length > 0) {
    wrap.appendChild(screen);
    return wrap;
  }

  // Normal groups view
  const totalMorosos = S.grupos.reduce((s,g)=>s+g.clientes.filter(c=>c.est.estado==='atrasado').length,0);
  const totalClientes = S.grupos.reduce((s,g)=>s+g.clientes.length,0);

  const stats = el('div',{className:'stats-row'});
  stats.innerHTML=`
    <div class="stat-box"><div class="n">${S.grupos.length}</div><div class="l">Grupos</div></div>
    <div class="stat-box"><div class="n">${totalClientes}</div><div class="l">Clientes</div></div>
    <div class="stat-box"><div class="n" style="color:${totalMorosos>0?'var(--alert)':'var(--ok)'}">${totalMorosos}</div><div class="l">Atrasados</div></div>`;
  screen.appendChild(stats);

  if (S.grupos.length === 0) {
    screen.appendChild(el('div',{className:'empty'},el('div',{className:'eicon'},'📋'),el('p',null,'No tienes grupos. Toca "+ Grupo" para crear el primero.')));
  } else {
    S.grupos.forEach((g,idx) => {
      const morosos = g.clientes.filter(c=>c.est.estado==='atrasado').length;
      const card = el('div',{className:'group-card'});
      card.innerHTML=`
        <div class="group-icon">${initials(g.nombre)}</div>
        <div class="group-info"><div class="name">${g.nombre}</div><div class="meta">${g.clientes.length} cliente${g.clientes.length!==1?'s':''}</div></div>
        ${morosos>0?`<span class="badge badge-alert">${morosos} debe${morosos!==1?'n':''}</span>`:`<span class="badge badge-ok">Al corriente</span>`}`;
      card.onclick = () => set({ grupoIdx: idx, view: 'group' });
      screen.appendChild(card);
    });
  }
  wrap.appendChild(screen);
  return wrap;
}

// ── GROUP DETAIL ───────────────────────────────────────────────────────
function rGroup() {
  const g = get.grupo();
  const wrap = el('div');

  const editBtn = el('button',{className:'btn btn-white btn-sm'},'✏️');
  editBtn.onclick = () => set({modal:{type:'editGroup',data:g}});
  const delBtn = el('button',{className:'btn btn-white btn-sm'},'🗑️');
  delBtn.onclick = () => set({modal:{type:'confirmDeleteGroup',data:g}});
  const cobrosBtn = el('button',{className:'btn btn-white btn-sm'},'📋');
  cobrosBtn.title='Cobros masivos';
  cobrosBtn.onclick = () => set({view:'cobros'});
  wrap.appendChild(topbar(g?.nombre||'', ()=>set({view:'groups'}), [cobrosBtn,editBtn,delBtn]));

  const screen = el('div',{className:'page'});
  if (!g) { wrap.appendChild(screen); return wrap; }

  const atrasados = g.clientes.filter(c=>c.est.estado==='atrasado');
  const resto = g.clientes.filter(c=>c.est.estado!=='atrasado');
  const multaTotal = g.clientes.reduce((s,c)=>s+c.est.multa,0);

  const stats = el('div',{className:'stats-row'});
  stats.innerHTML=`
    <div class="stat-box"><div class="n">${g.clientes.length}</div><div class="l">Clientes</div></div>
    <div class="stat-box"><div class="n" style="color:${atrasados.length>0?'var(--alert)':'var(--ok)'}">${atrasados.length}</div><div class="l">Atrasados</div></div>
    <div class="stat-box"><div class="n num" style="font-size:16px;color:var(--alert)">${formatMoney(multaTotal)}</div><div class="l">Multas</div></div>`;
  screen.appendChild(stats);

  function cRow(c) {
    const row = el('div',{className:'client-row'});
    const dot = c.est.estado==='atrasado'?'dot-alert':c.est.estado==='sin_pagos'?'dot-none':'dot-ok';
    const color = c.est.estado==='atrasado'?'var(--alert)':'var(--ink)';
    row.innerHTML=`
      <span class="status-dot ${dot}"></span>
      <div class="avatar">${initials(c.nombre)}</div>
      <div class="client-info"><div class="name">${c.nombre}</div><div class="product">${c.producto||''}</div></div>
      <div class="client-amount">
        <div class="val num" style="color:${color}">${c.est.estado==='atrasado'?formatMoney(c.est.multa):formatMoney(c.est.restante)}</div>
        <div class="lbl">${c.est.estado==='atrasado'?'multa':'restante'}</div>
      </div>`;
    row.onclick = () => set({clienteId:c.id, view:'client'});
    return row;
  }

  if (atrasados.length > 0) {
    screen.appendChild(el('div',{className:'section-label'},'⚠️ Atrasados'));
    const list = el('div',{className:'client-list'});
    atrasados.forEach(c=>list.appendChild(cRow(c)));
    screen.appendChild(list);
  }

  screen.appendChild(el('div',{className:'section-label'},atrasados.length>0?'Al corriente':'Clientes'));
  if (resto.length===0 && atrasados.length===0) {
    screen.appendChild(el('div',{className:'empty'},el('p',null,'Sin clientes aún.')));
  } else if (resto.length > 0) {
    const list2 = el('div',{className:'client-list'});
    resto.forEach(c=>list2.appendChild(cRow(c)));
    screen.appendChild(list2);
  }

  const addBtn = el('button',{className:'btn btn-secondary btn-block',style:'margin-top:14px;'},'+ Agregar cliente');
  addBtn.onclick = () => set({modal:{type:'addClient'}});
  screen.appendChild(addBtn);
  wrap.appendChild(screen);

  const fab = el('div',{className:'fab-wrap'});
  const fabBtn = el('button',{className:'fab'},'+');
  fabBtn.onclick = () => set({modal:{type:'addPayment',data:{clienteId:null}}});
  fab.appendChild(fabBtn);
  wrap.appendChild(fab);
  return wrap;
}

// ── CLIENT DETAIL ──────────────────────────────────────────────────────
function rClient() {
  const c = get.cliente();
  const g = get.grupo();
  const wrap = el('div');

  const editBtn = el('button',{className:'btn btn-white btn-sm'},'✏️');
  editBtn.onclick = () => set({modal:{type:'editClient',data:c}});
  const delBtn = el('button',{className:'btn btn-white btn-sm'},'🗑️');
  delBtn.onclick = () => set({modal:{type:'confirmDeleteClient',data:c}});
  const msgBtn = el('button',{className:'btn btn-white btn-sm'},'💬');
  msgBtn.onclick = () => set({modal:{type:'mensajeCobro',data:c}});
  wrap.appendChild(topbar(c?.nombre||'', ()=>set({view:'group'}), [msgBtn,editBtn,delBtn]));

  if (!c) { wrap.appendChild(el('div',{className:'page'})); return wrap; }

  const est = c.est;
  const screen = el('div',{className:'page'});

  const statusColor = est.estado==='atrasado'?'var(--alert)':est.estado==='sin_pagos'?'var(--ink-soft)':'var(--ok)';
  const statusLabel = est.estado==='atrasado'?`⚠️ Atrasada(o) ${est.diasAtraso} día(s)`:est.estado==='sin_pagos'?'Sin pagos registrados':'✅ Al corriente';

  const detCard = el('div',{className:'card card-body'});
  detCard.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
      <div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:2px;">${c.producto||''}</div>
        <div style="font-weight:700;font-size:13px;color:${statusColor};">${statusLabel}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-weight:800;font-size:24px;" class="num">${formatMoney(est.restante)}</div>
        <div style="font-size:11px;color:var(--ink-soft);">restante</div>
      </div>
    </div>
    <div class="info-grid">
      <div class="info-box"><div class="iv num">${formatMoney(c.total)}</div><div class="il">Total</div></div>
      <div class="info-box"><div class="iv num">${formatMoney(est.totalPagado)}</div><div class="il">Pagado</div></div>
      <div class="info-box" style="${est.multa>0?'background:var(--alert-soft);':''}">
        <div class="iv num" style="color:${est.multa>0?'var(--alert)':'var(--ink)'}">${formatMoney(est.multa)}</div>
        <div class="il">Multa</div>
      </div>
    </div>
    ${est.inicioSemana1?`<div class="hint" style="border-top:1px solid var(--line);padding-top:10px;margin-top:4px;">
      Semana 1: <strong>${formatFecha(est.inicioSemana1)}</strong> · ${est.semanasTranscurridas} sem. transcurridas · Debería llevar <strong>${formatMoney(est.deberiaLlevar)}</strong>
    </div>`:''}`;
  screen.appendChild(detCard);

  const payBtn = el('button',{className:'btn btn-primary btn-block',style:'margin:12px 0;'},'+ Registrar pago');
  payBtn.onclick = () => set({modal:{type:'addPayment',data:{clienteId:c.id}}});
  screen.appendChild(payBtn);

  if (est.estado==='atrasado') {
    const msgBtn2 = el('button',{className:'btn btn-success btn-block',style:'margin-bottom:12px;'},'💬 Generar mensaje de cobro');
    msgBtn2.onclick = () => set({modal:{type:'mensajeCobro',data:c}});
    screen.appendChild(msgBtn2);
  }

  screen.appendChild(el('div',{className:'section-label'},'Historial de pagos'));
  const histCard = el('div',{className:'card card-body'});
  if (!c.pagos||c.pagos.length===0) {
    histCard.innerHTML='<div style="text-align:center;color:var(--ink-soft);font-size:13px;">Sin pagos registrados.</div>';
  } else {
    [...c.pagos].sort((a,b)=>b.fecha-a.fecha).forEach(p => {
      const row = el('div',{className:'history-row'});
      const lbl = p.esAnticipo?'Anticipo':p.numeroPago?'Pago #'+p.numeroPago:'Pago';
      const meta = [p.hora,p.cuenta].filter(Boolean).join(' · ');
      const delBtn2 = el('button',{className:'del-btn'},'×');
      delBtn2.onclick = e => { e.stopPropagation(); set({modal:{type:'confirmDeletePago',data:{pago:p,clienteId:c.id}}}); };
      row.innerHTML=`<div><div class="hl">${lbl}</div><div class="hd">${formatFecha(p.fecha)}${meta?' · '+meta:''}</div></div><div style="display:flex;align-items:center;gap:8px;"><div class="hr num">${formatMoney(p.monto)}</div></div>`;
      row.querySelector('div:last-child').appendChild(delBtn2);
      histCard.appendChild(row);
    });
  }
  screen.appendChild(histCard);
  wrap.appendChild(screen);
  return wrap;
}

// ── MODALS ─────────────────────────────────────────────────────────────
function rModal() {
  const overlay = el('div',{className:'modal-overlay'});
  overlay.onclick = e => { if(e.target===overlay) set({modal:null}); };
  const sheet = el('div',{className:'modal-sheet'});
  sheet.innerHTML='<div class="modal-handle"></div>';
  const {type,data} = S.modal;

  if (type==='addGroup'||type==='editGroup') {
    const isEdit=type==='editGroup';
    sheet.innerHTML+=`<div class="modal-title">${isEdit?'Editar grupo':'Nuevo grupo'}</div>
      <div class="field"><label>Nombre</label><input id="mg-n" value="${isEdit?data.nombre:''}"></div>
      <div class="gap-row">
        <div class="field"><label>Plazo (semanas)</label><input type="number" id="mg-p" value="${isEdit?data.plazoSemanas:10}"></div>
        <div class="field"><label>Multa/día ($)</label><input type="number" id="mg-m" value="${isEdit?data.multaPorDia:35}"></div>
      </div>`;
    const btn=el('button',{className:'btn btn-primary btn-block'},isEdit?'Guardar':'Crear grupo');
    btn.onclick=async()=>{
      const nombre=sheet.querySelector('#mg-n').value.trim();
      const plazoSemanas=parseInt(sheet.querySelector('#mg-p').value)||10;
      const multaPorDia=parseFloat(sheet.querySelector('#mg-m').value)||35;
      if(!nombre){showToast('Ponle un nombre');return;}
      await saveGroup({nombre,plazoSemanas,multaPorDia},isEdit?data.id:null);
    };
    sheet.appendChild(btn);
  }

  else if (type==='addClient'||type==='editClient') {
    const isEdit=type==='editClient';
    sheet.innerHTML+=`<div class="modal-title">${isEdit?'Editar cliente':'Nuevo cliente'}</div>
      <div class="field"><label>Nombre</label><input id="mc-n" value="${isEdit?data.nombre:''}"></div>
      <div class="field"><label>Producto</label><input id="mc-p" value="${isEdit?data.producto||'':''}"></div>
      <div class="field"><label>Total a pagar</label><input type="number" id="mc-t" value="${isEdit?data.total:''}"></div>`;
    const btn=el('button',{className:'btn btn-primary btn-block'},isEdit?'Guardar':'Agregar');
    btn.onclick=async()=>{
      const nombre=sheet.querySelector('#mc-n').value.trim();
      const producto=sheet.querySelector('#mc-p').value.trim();
      const total=parseFloat(sheet.querySelector('#mc-t').value);
      if(!nombre||!total){showToast('Nombre y total son obligatorios');return;}
      await saveClient(get.grupo()?.id,isEdit?data.id:null,{nombre,producto,total});
    };
    sheet.appendChild(btn);
  }

  else if (type==='addPayment') {
    let ps={modo:null,img64:null,imgType:null,imgPreview:null,texto:'',propuesta:null,leyendo:false,clienteId:data?.clienteId||get.cliente()?.id||null};
    const g=get.grupo();
    sheet.innerHTML+='<div class="modal-title">Registrar pago</div><div id="pb"></div>';
    const render2=()=>{
      const body=sheet.querySelector('#pb');
      body.innerHTML='';
      if(!g) return;

      if(!ps.clienteId){
        const f=el('div',{className:'field'});
        f.innerHTML=`<label>Cliente</label><select id="cs"><option value="">Selecciona...</option>${g.clientes.map(c=>`<option value="${c.id}">${c.nombre}</option>`).join('')}</select>`;
        f.querySelector('select').onchange=e=>{ps.clienteId=e.target.value;};
        body.appendChild(f);
      } else {
        const cNombre=g.clientes.find(c=>c.id===ps.clienteId)?.nombre||'';
        body.innerHTML+=`<div class="field"><label>Cliente</label><div style="padding:10px 13px;background:var(--bg);border-radius:8px;font-size:14px;">${cNombre}</div></div>`;
      }

      if(!ps.propuesta){
        const tabs=el('div',{className:'pill-tabs'});
        tabs.innerHTML=`<button id="tf" class="${ps.modo==='foto'?'active':''}">📷 Captura</button><button id="tt" class="${ps.modo==='texto'?'active':''}">💬 Mensaje</button><button id="tm2" class="${ps.modo==='manual'?'active':''}">✍️ Manual</button>`;
        tabs.querySelector('#tf').onclick=()=>{ps.modo='foto';render2();};
        tabs.querySelector('#tt').onclick=()=>{ps.modo='texto';render2();};
        tabs.querySelector('#tm2').onclick=()=>{ps.modo='manual';render2();};
        body.appendChild(tabs);

        if(ps.modo==='foto'){
          if(ps.imgPreview){
            body.innerHTML+=`<img src="${ps.imgPreview}" class="preview-img">`;
            const rb=el('button',{className:'btn btn-primary btn-block'});
            rb.innerHTML=ps.leyendo?'<div class="spinner"></div>':'Leer con IA';
            rb.disabled=ps.leyendo;
            rb.onclick=async()=>{
              ps.leyendo=true;render2();
              try{const r=await leerComprobanteImagen(ps.img64,ps.imgType);if(!r.fecha)r.fecha=new Date().toISOString().slice(0,10);ps.propuesta=r;}
              catch{showToast('No se pudo leer. Prueba manual.');}
              ps.leyendo=false;render2();
            };
            body.appendChild(rb);
            const rt=el('button',{className:'btn btn-ghost btn-block',style:'margin-top:6px;'},'Cambiar foto');
            rt.onclick=()=>{ps.imgPreview=null;ps.img64=null;render2();};
            body.appendChild(rt);
          } else {
            const zone=el('div',{className:'upload-zone'});
            zone.innerHTML='<div style="font-size:28px;margin-bottom:8px;">📷</div><div>Toca para subir la captura</div>';
            const inp=el('input');inp.type='file';inp.accept='image/*';inp.style.display='none';
            inp.onchange=async e=>{
              const file=e.target.files[0];if(!file)return;
              ps.img64=await fileToBase64(file);ps.imgType=file.type;
              ps.imgPreview=`data:${file.type};base64,${ps.img64}`;render2();
            };
            zone.onclick=()=>inp.click();
            body.appendChild(zone);body.appendChild(inp);
          }
          body.appendChild(el('div',{className:'hint',style:'text-align:center;margin-top:8px;'},'La IA propone — tú confirmas antes de guardar.'));
        }

        if(ps.modo==='texto'){
          const f=el('div',{className:'field'});
          f.innerHTML=`<label>Mensaje de Messenger</label><input type="text" id="ti" placeholder='Ej: "ya te pagué 200"' value="${ps.texto}">`;
          body.appendChild(f);
          const rb=el('button',{className:'btn btn-primary btn-block'});
          rb.innerHTML=ps.leyendo?'<div class="spinner"></div>':'Interpretar';
          rb.disabled=ps.leyendo;
          rb.onclick=async()=>{
            ps.texto=body.querySelector('#ti').value;
            if(!ps.texto.trim()){showToast('Escribe el mensaje');return;}
            ps.leyendo=true;render2();
            try{const r=await leerComprobanteTexto(ps.texto);if(!r.fecha)r.fecha=new Date().toISOString().slice(0,10);ps.propuesta=r;}
            catch{showToast('No se pudo interpretar. Prueba manual.');}
            ps.leyendo=false;render2();
          };
          body.appendChild(rb);
        }

        if(ps.modo==='manual'){
          body.innerHTML+=`
            <div class="gap-row">
              <div class="field"><label>Monto</label><input type="number" id="mm" placeholder="0"></div>
              <div class="field"><label>Pago #</label><input type="number" id="mn" placeholder="1" min="1"></div>
            </div>
            <div class="field"><label>¿Es anticipo?</label>
              <select id="ma"><option value="no">No — pago numerado</option><option value="si">Sí — anticipo</option></select>
            </div>
            <div class="field"><label>Fecha</label><input type="date" id="mf" value="${new Date().toISOString().slice(0,10)}"></div>
            <div class="gap-row">
              <div class="field"><label>Hora</label><input type="time" id="mh"></div>
              <div class="field"><label>Cuenta</label><input type="text" id="mc3" placeholder="BBVA 1234"></div>
            </div>`;
          const cb=el('button',{className:'btn btn-primary btn-block'},'Continuar');
          cb.onclick=()=>{
            const m=parseFloat(body.querySelector('#mm').value);
            const f=body.querySelector('#mf').value;
            const n=parseInt(body.querySelector('#mn').value)||null;
            const esA=body.querySelector('#ma').value==='si';
            const hora=body.querySelector('#mh').value;
            const cuenta=body.querySelector('#mc3').value;
            if(!m||m<=0){showToast('Ingresa un monto');return;}
            ps.propuesta={monto:m,fecha:f,confianza:'manual',notas:'',numeroPago:esA?null:n,esAnticipo:esA,hora,cuenta};
            render2();
          };
          body.appendChild(cb);
        }
      } else {
        const p=ps.propuesta;
        if(ps.imgPreview) body.innerHTML+=`<img src="${ps.imgPreview}" class="preview-img">`;
        if(p.confianza&&p.confianza!=='manual'){
          const cb2=el('div',{className:'confirm-alert'});
          cb2.textContent=`${p.confianza==='alta'?'✅ Confianza alta':p.confianza==='media'?'⚠️ Confianza media — revisa':'⚠️ Confianza baja'}: ${p.notas||''}`;
          body.appendChild(cb2);
        }
        const esA2=p.esAnticipo??false;
        body.innerHTML+=`
          <div class="gap-row">
            <div class="field" style="flex:2"><label>Monto</label><input type="number" id="cm" value="${p.monto??''}"></div>
            <div class="field" style="flex:1"><label>Pago #</label><input type="number" id="cn" value="${p.numeroPago??''}" placeholder="1"></div>
          </div>
          <div class="field"><label>¿Es anticipo?</label>
            <select id="ca"><option value="no" ${!esA2?'selected':''}>No</option><option value="si" ${esA2?'selected':''}>Sí — anticipo</option></select>
          </div>
          <div class="field"><label>Fecha</label><input type="date" id="cf" value="${p.fecha||new Date().toISOString().slice(0,10)}"></div>
          <div class="gap-row">
            <div class="field"><label>Hora</label><input type="time" id="ch" value="${p.hora||''}"></div>
            <div class="field"><label>Cuenta</label><input type="text" id="cc" value="${p.cuenta||''}" placeholder="BBVA 1234"></div>
          </div>`;
        if(p.nombreDetectado) body.innerHTML+=`<div class="hint">Nombre en comprobante: <strong>${p.nombreDetectado}</strong></div>`;
        const cfb=el('button',{className:'btn btn-primary btn-block',style:'margin-top:10px;'},'Confirmar y guardar pago');
        cfb.onclick=async()=>{
          const monto=parseFloat(body.querySelector('#cm').value);
          const fecha=body.querySelector('#cf').value;
          const esA3=body.querySelector('#ca').value==='si';
          const numeroPago=esA3?null:(parseInt(body.querySelector('#cn').value)||null);
          const hora=body.querySelector('#ch').value;
          const cuenta=body.querySelector('#cc').value;
          const cid=ps.clienteId;
          if(!cid){showToast('Selecciona un cliente');return;}
          if(!monto||monto<=0){showToast('Monto inválido');return;}
          if(!fecha){showToast('Selecciona una fecha');return;}
          await savePago(g.id,cid,monto,fecha,numeroPago,esA3,hora,cuenta);
        };
        body.appendChild(cfb);
        const rb2=el('button',{className:'btn btn-ghost btn-block',style:'margin-top:6px;'},'Volver a intentar');
        rb2.onclick=()=>{ps.propuesta=null;render2();};
        body.appendChild(rb2);
      }
    };
    setTimeout(()=>render2(),0);
  }

  else if (type==='mensajeCobro') {
    const c=data, est=c.est, g2=get.grupo();
    const hoy=new Date().toLocaleDateString('es-MX',{day:'2-digit',month:'long',year:'numeric'});
    const msg=`Hola ${c.nombre.split(' ')[0]} 👋\n\nTe recuerdo que tienes un pago pendiente de tu ahorro:\n\n• Producto: ${c.producto||'tu artículo'}\n• Total pagado: ${formatMoney(est.totalPagado)} de ${formatMoney(c.total)}\n• Días de atraso: ${est.diasAtraso}\n• Multa acumulada: ${formatMoney(est.multa)}\n• Total que debes hoy (${hoy}): ${formatMoney(est.restante)}\n\nPor favor realiza tu pago a la brevedad para evitar más multas ($${g2?.multaPorDia||35}/día).\n\n¡Gracias! 🙏`;
    sheet.innerHTML+=`<div class="modal-title">💬 Mensaje de cobro</div><div class="msg-box">${msg.replace(/\n/g,'<br>')}</div>`;
    const cb3=el('button',{className:'btn btn-primary btn-block',style:'margin-top:12px;'},'Copiar mensaje');
    cb3.onclick=()=>{navigator.clipboard.writeText(msg);showToast('Mensaje copiado ✓');};
    sheet.appendChild(cb3);
  }

  else if (type==='confirmDeleteGroup') {
    sheet.innerHTML+=`<div class="modal-title">¿Eliminar grupo?</div><div class="danger-alert">Esto borrará <strong>${data.nombre}</strong> con todos sus clientes y pagos. No se puede deshacer.</div>`;
    const gap=el('div',{className:'gap-row'});
    const c1=el('button',{className:'btn btn-secondary'},'Cancelar');c1.onclick=()=>set({modal:null});
    const d1=el('button',{className:'btn btn-danger'},'Sí, eliminar');d1.onclick=()=>deleteGroup(data.id);
    gap.append(c1,d1);sheet.appendChild(gap);
  }

  else if (type==='confirmDeleteClient') {
    sheet.innerHTML+=`<div class="modal-title">¿Eliminar cliente?</div><div class="danger-alert">Se eliminará a <strong>${data.nombre}</strong> y todos sus pagos.</div>`;
    const gap=el('div',{className:'gap-row'});
    const c2=el('button',{className:'btn btn-secondary'},'Cancelar');c2.onclick=()=>set({modal:null});
    const d2=el('button',{className:'btn btn-danger'},'Sí, eliminar');d2.onclick=()=>deleteClient(get.grupo()?.id,data.id);
    gap.append(c2,d2);sheet.appendChild(gap);
  }

  else if (type==='confirmDeletePago') {
    const {pago,clienteId}=data;
    sheet.innerHTML+=`<div class="modal-title">¿Eliminar pago?</div><div class="danger-alert">Se eliminará el pago de <strong>${formatMoney(pago.monto)}</strong> del ${formatFecha(pago.fecha)}. Recalculará multas automáticamente.</div>`;
    const gap=el('div',{className:'gap-row'});
    const c3=el('button',{className:'btn btn-secondary'},'Cancelar');c3.onclick=()=>set({modal:null});
    const d3=el('button',{className:'btn btn-danger'},'Sí, eliminar');d3.onclick=()=>deletePago(get.grupo()?.id,clienteId,pago.id);
    gap.append(c3,d3);sheet.appendChild(gap);
  }

  overlay.appendChild(sheet);
  return overlay;
}

render();

// ── INGRESOS ───────────────────────────────────────────────────────────
function rIngresos() {
  const wrap = el('div');
  wrap.appendChild(topbar('💰 Ingresos', () => set({view:'groups'})));
  const screen = el('div',{className:'page'});

  const totalGeneral = S.grupos.reduce((s,g) =>
    s + g.clientes.reduce((s2,c) => s2 + c.pagos.reduce((s3,p) => s3 + p.monto, 0), 0), 0);
  const totalPendiente = S.grupos.reduce((s,g) =>
    s + g.clientes.reduce((s2,c) => s2 + Math.max(0, c.est.restante), 0), 0);
  const totalMultas = S.grupos.reduce((s,g) =>
    s + g.clientes.reduce((s2,c) => s2 + c.est.multa, 0), 0);

  // General summary
  const sumCard = el('div',{className:'card card-body',style:'margin-bottom:14px;'});
  sumCard.innerHTML = `
    <div style="font-weight:700;font-size:15px;margin-bottom:12px;">Resumen general</div>
    <div class="info-grid" style="grid-template-columns:repeat(3,1fr);">
      <div class="info-box"><div class="iv num" style="color:var(--ok)">${formatMoney(totalGeneral)}</div><div class="il">Cobrado</div></div>
      <div class="info-box"><div class="iv num" style="color:var(--accent)">${formatMoney(totalPendiente)}</div><div class="il">Pendiente</div></div>
      <div class="info-box"><div class="iv num" style="color:var(--alert)">${formatMoney(totalMultas)}</div><div class="il">Multas</div></div>
    </div>`;
  screen.appendChild(sumCard);

  // Per group breakdown
  screen.appendChild(el('div',{className:'section-label'},'Por grupo'));

  const list = el('div',{className:'card',style:'overflow:hidden;'});
  S.grupos.forEach((g, idx) => {
    const cobrado = g.clientes.reduce((s,c) => s + c.pagos.reduce((s2,p) => s2 + p.monto, 0), 0);
    const esperado = g.clientes.reduce((s,c) => s + c.total, 0);
    const multas = g.clientes.reduce((s,c) => s + c.est.multa, 0);
    const pct = esperado > 0 ? Math.round((cobrado/esperado)*100) : 0;

    const row = el('div',{style:'padding:13px 16px;border-bottom:1px solid var(--line);cursor:pointer;'});
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-weight:600;font-size:14px;">${g.nombre}</div>
        <div style="font-weight:700;font-size:14px;color:var(--ok);">${formatMoney(cobrado)}</div>
      </div>
      <div style="background:var(--line);border-radius:4px;height:5px;margin-bottom:6px;">
        <div style="background:var(--ok);height:5px;border-radius:4px;width:${pct}%;transition:width 0.3s;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--ink-soft);">
        <span>${pct}% de ${formatMoney(esperado)}</span>
        ${multas>0?`<span style="color:var(--alert);">+${formatMoney(multas)} multas</span>`:''}
      </div>`;
    row.onclick = () => set({grupoIdx: idx, view:'group'});
    list.appendChild(row);
  });
  screen.appendChild(list);
  wrap.appendChild(screen);
  return wrap;
}

// ── COBROS MASIVOS ─────────────────────────────────────────────────────
function rCobros() {
  const g = get.grupo();
  const wrap = el('div');
  wrap.appendChild(topbar('📋 Cobros pendientes', () => set({view:'group'})));
  const screen = el('div',{className:'page'});

  if (!g) { wrap.appendChild(screen); return wrap; }

  const atrasados = g.clientes.filter(c => c.est.estado === 'atrasado');
  const hoy = new Date().toLocaleDateString('es-MX',{day:'2-digit',month:'long',year:'numeric'});

  if (atrasados.length === 0) {
    screen.appendChild(el('div',{className:'empty'},
      el('div',{className:'eicon'},'✅'),
      el('p',null,'¡Todos al corriente en este grupo!')
    ));
    wrap.appendChild(screen);
    return wrap;
  }

  // Generate all messages
  const mensajes = atrasados.map(c => {
    const est = c.est;
    return `Hola ${c.nombre.split(' ')[0]} 👋\n\nTe recuerdo que tienes un pago pendiente de tu ahorro:\n\n• Producto: ${c.producto||'tu artículo'}\n• Total pagado: ${formatMoney(est.totalPagado)} de ${formatMoney(c.total)}\n• Días de atraso: ${est.diasAtraso}\n• Multa acumulada: ${formatMoney(est.multa)}\n• Total que debes hoy (${hoy}): ${formatMoney(est.restante)}\n\nPor favor realiza tu pago a la brevedad para evitar más multas ($${g.multaPorDia||35}/día).\n\n¡Gracias! 🙏`;
  });

  const todosMsg = mensajes.join('\n\n─────────────────────\n\n');

  const copyAllBtn = el('button',{className:'btn btn-primary btn-block',style:'margin-bottom:14px;'},
    `📋 Copiar todos los mensajes (${atrasados.length})`);
  copyAllBtn.onclick = () => {
    navigator.clipboard.writeText(todosMsg);
    showToast(`${atrasados.length} mensajes copiados ✓`);
  };
  screen.appendChild(copyAllBtn);

  screen.appendChild(el('div',{className:'section-label'},`${atrasados.length} clientes atrasados`));

  atrasados.forEach((c, i) => {
    const card = el('div',{className:'card card-body',style:'margin-bottom:10px;'});
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div>
          <div style="font-weight:700;font-size:14px;">${c.nombre}</div>
          <div style="font-size:12px;color:var(--ink-soft);">${c.est.diasAtraso} día(s) · ${formatMoney(c.est.multa)} multa</div>
        </div>
        <div style="font-weight:800;font-size:15px;color:var(--alert);">${formatMoney(c.est.restante)}</div>
      </div>`;
    const copyBtn = el('button',{className:'btn btn-secondary btn-block btn-sm'},'Copiar mensaje individual');
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(mensajes[i]);
      showToast(`Mensaje de ${c.nombre.split(' ')[0]} copiado ✓`);
    };
    card.appendChild(copyBtn);
    screen.appendChild(card);
  });

  wrap.appendChild(screen);
  return wrap;
}
