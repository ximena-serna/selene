import {
  auth, db, signInWithEmailAndPassword, onAuthStateChanged, signOut,
  collection, doc, getDoc, getDocs, addDoc, updateDoc, deleteDoc,
  query, orderBy, onSnapshot, serverTimestamp, Timestamp
} from './src/firebase.js';
import { calcularEstadoCliente, formatMoney, formatFecha } from './src/logic.js';
import { leerComprobanteImagen, leerComprobanteTexto, fileToBase64 } from './src/ai-receipt.js';

const root = document.getElementById('app');

const state = {
  user: null,
  view: 'loading', // loading | login | groups | group | client | addPayment | addClient | addGroup
  grupos: [],
  grupoActual: null,
  clientesGrupo: [],
  clienteActual: null,
  pagosCliente: [],
  loading: false,
  toast: null,
};

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function showToast(msg, ms = 2600) {
  setState({ toast: msg });
  setTimeout(() => { if (state.toast === msg) setState({ toast: null }); }, ms);
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// ---------- AUTH ----------
onAuthStateChanged(auth, (user) => {
  if (user) {
    setState({ user, view: 'groups' });
    cargarGrupos();
  } else {
    setState({ user: null, view: 'login' });
  }
});

async function handleLogin(email, password) {
  setState({ loading: true });
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    setState({ loading: false });
    showToast('Correo o contraseña incorrectos');
  }
}

function renderLogin() {
  const wrap = document.createElement('div');
  wrap.className = 'login-wrap';
  wrap.innerHTML = `
    <div class="brand" style="padding-top:0;">
      <div class="mark">Control de Ahorros</div>
      <div class="sub">Grupos · Pagos · Multas</div>
    </div>
    <div class="card">
      <div class="field">
        <label>Correo</label>
        <input type="email" id="login-email" placeholder="tucorreo@ejemplo.com" autocomplete="username">
      </div>
      <div class="field">
        <label>Contraseña</label>
        <input type="password" id="login-pass" placeholder="••••••••" autocomplete="current-password">
      </div>
      <button class="btn btn-primary btn-block" id="login-btn">
        ${state.loading ? '<div class="spinner"></div>' : 'Entrar'}
      </button>
      <div class="error-text" id="login-error" style="display:none;"></div>
    </div>
  `;
  wrap.querySelector('#login-btn').onclick = () => {
    const email = wrap.querySelector('#login-email').value.trim();
    const pass = wrap.querySelector('#login-pass').value;
    if (!email || !pass) { showToast('Completa correo y contraseña'); return; }
    handleLogin(email, pass);
  };
  return wrap;
}

// ---------- DATA LOADING ----------
async function cargarGrupos() {
  setState({ loading: true });
  const snap = await getDocs(query(collection(db, 'grupos'), orderBy('nombre')));
  const grupos = [];
  for (const d of snap.docs) {
    const data = d.data();
    const clientesSnap = await getDocs(collection(db, 'grupos', d.id, 'clientes'));
    let morosos = 0, total = clientesSnap.size;
    for (const c of clientesSnap.docs) {
      const pagosSnap = await getDocs(collection(db, 'grupos', d.id, 'clientes', c.id, 'pagos'));
      const pagos = pagosSnap.docs.map(p => ({ monto: p.data().monto, fecha: p.data().fecha.toDate() }));
      const est = calcularEstadoCliente(
        { total: c.data().total, plazoSemanas: data.plazoSemanas || 10 },
        pagos, { multaPorDia: data.multaPorDia || 35 }
      );
      if (est.estado === 'atrasado') morosos++;
    }
    grupos.push({ id: d.id, ...data, totalClientes: total, morosos });
  }
  setState({ grupos, loading: false });
}

async function abrirGrupo(grupoId) {
  setState({ loading: true, view: 'group' });
  const grupoDoc = await getDoc(doc(db, 'grupos', grupoId));
  const grupoData = { id: grupoId, ...grupoDoc.data() };
  const clientesSnap = await getDocs(query(collection(db, 'grupos', grupoId, 'clientes'), orderBy('nombre')));
  const clientes = [];
  for (const c of clientesSnap.docs) {
    const pagosSnap = await getDocs(collection(db, 'grupos', grupoId, 'clientes', c.id, 'pagos'));
    const pagos = pagosSnap.docs.map(p => ({ id: p.id, monto: p.data().monto, fecha: p.data().fecha.toDate() }));
    const est = calcularEstadoCliente(
      { total: c.data().total, plazoSemanas: grupoData.plazoSemanas || 10 },
      pagos, { multaPorDia: grupoData.multaPorDia || 35 }
    );
    clientes.push({ id: c.id, ...c.data(), pagos, est });
  }
  setState({ grupoActual: grupoData, clientesGrupo: clientes, loading: false });
}

async function abrirCliente(clienteId) {
  const cliente = state.clientesGrupo.find(c => c.id === clienteId);
  setState({ clienteActual: cliente, view: 'client' });
}

// ---------- RENDER ROUTER ----------
function render() {
  root.innerHTML = '';
  if (state.toast) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = state.toast;
    root.appendChild(t);
  }
  let screen;
  switch (state.view) {
    case 'loading': screen = renderLoading(); break;
    case 'login': screen = renderLogin(); break;
    case 'groups': screen = renderGroups(); break;
    case 'group': screen = renderGroupDetail(); break;
    case 'client': screen = renderClientDetail(); break;
    case 'addPayment': screen = renderAddPayment(); break;
    case 'addClient': screen = renderAddClient(); break;
    case 'addGroup': screen = renderAddGroup(); break;
    default: screen = renderLoading();
  }
  root.appendChild(screen);
}

function renderLoading() {
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:100vh;';
  d.innerHTML = '<div class="spinner spinner-dark" style="width:32px;height:32px;border-width:3px;"></div>';
  return d;
}


// ---------- SCREEN: GROUPS (dashboard) ----------
function renderGroups() {
  const wrap = document.createElement('div');

  const top = document.createElement('div');
  top.className = 'topbar';
  top.innerHTML = `
    <div class="spacer"></div>
    <h1>Mis grupos</h1>
    <button id="logout-btn" style="font-size:13px;color:var(--ink-soft);font-weight:600;">Salir</button>
  `;
  top.querySelector('#logout-btn').onclick = () => signOut(auth);
  wrap.appendChild(top);

  const screen = document.createElement('div');
  screen.className = 'screen';

  if (state.loading) {
    screen.innerHTML = '<div style="display:flex;justify-content:center;padding:60px 0;"><div class="spinner spinner-dark" style="width:28px;height:28px;"></div></div>';
    wrap.appendChild(screen);
    return wrap;
  }

  const totalMorosos = state.grupos.reduce((s, g) => s + g.morosos, 0);
  const totalClientes = state.grupos.reduce((s, g) => s + g.totalClientes, 0);

  const summary = document.createElement('div');
  summary.className = 'summary-row';
  summary.innerHTML = `
    <div class="summary-box"><div class="n">${state.grupos.length}</div><div class="l">Grupos</div></div>
    <div class="summary-box"><div class="n">${totalClientes}</div><div class="l">Clientes</div></div>
    <div class="summary-box"><div class="n" style="color:${totalMorosos > 0 ? 'var(--alert)' : 'var(--ok)'}">${totalMorosos}</div><div class="l">Atrasados</div></div>
  `;
  screen.appendChild(summary);

  if (state.grupos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `<div class="icon">📋</div><p>Aún no tienes grupos. Crea el primero para empezar a registrar clientes y pagos.</p>`;
    screen.appendChild(empty);
  } else {
    state.grupos.forEach(g => {
      const card = document.createElement('div');
      card.className = 'card group-card';
      card.innerHTML = `
        <div class="icon">${initials(g.nombre)}</div>
        <div class="info">
          <div class="name">${g.nombre}</div>
          <div class="meta">${g.totalClientes} cliente${g.totalClientes !== 1 ? 's' : ''}</div>
        </div>
        ${g.morosos > 0
          ? `<div class="badge badge-alert">${g.morosos} debe${g.morosos !== 1 ? 'n' : ''}</div>`
          : `<div class="badge badge-ok">Al corriente</div>`}
      `;
      card.onclick = () => abrirGrupo(g.id);
      screen.appendChild(card);
    });
  }

  wrap.appendChild(screen);

  const fabWrap = document.createElement('div');
  fabWrap.className = 'fab-wrap';
  fabWrap.innerHTML = `<button class="fab" id="add-group-fab">+</button>`;
  fabWrap.querySelector('#add-group-fab').onclick = () => setState({ view: 'addGroup' });
  wrap.appendChild(fabWrap);

  return wrap;
}

// ---------- SCREEN: GROUP DETAIL ----------
function renderGroupDetail() {
  const wrap = document.createElement('div');
  const g = state.grupoActual;

  const top = document.createElement('div');
  top.className = 'topbar';
  top.innerHTML = `
    <button class="back" id="back-btn">‹</button>
    <h1>${g ? g.nombre : ''}</h1>
    <div class="spacer"></div>
  `;
  top.querySelector('#back-btn').onclick = () => { setState({ view: 'groups' }); cargarGrupos(); };
  wrap.appendChild(top);

  const screen = document.createElement('div');
  screen.className = 'screen';

  if (state.loading || !g) {
    screen.innerHTML = '<div style="display:flex;justify-content:center;padding:60px 0;"><div class="spinner spinner-dark" style="width:28px;height:28px;"></div></div>';
    wrap.appendChild(screen);
    return wrap;
  }

  const clientes = state.clientesGrupo;
  const atrasados = clientes.filter(c => c.est.estado === 'atrasado');
  const alCorriente = clientes.filter(c => c.est.estado !== 'atrasado');
  const multaTotal = clientes.reduce((s, c) => s + c.est.multa, 0);

  const summary = document.createElement('div');
  summary.className = 'summary-row';
  summary.innerHTML = `
    <div class="summary-box"><div class="n">${clientes.length}</div><div class="l">Clientes</div></div>
    <div class="summary-box"><div class="n" style="color:${atrasados.length > 0 ? 'var(--alert)' : 'var(--ok)'}">${atrasados.length}</div><div class="l">Atrasados</div></div>
    <div class="summary-box"><div class="n num" style="font-size:17px;color:var(--alert)">${formatMoney(multaTotal)}</div><div class="l">Multas</div></div>
  `;
  screen.appendChild(summary);

  function clientRow(c) {
    const row = document.createElement('div');
    row.className = 'client-row';
    const dot = c.est.estado === 'atrasado' ? 'dot-alert' : c.est.estado === 'sin_pagos' ? 'dot-none' : 'dot-ok';
    row.innerHTML = `
      <span class="status-dot ${dot}"></span>
      <div class="avatar">${initials(c.nombre)}</div>
      <div class="info">
        <div class="name">${c.nombre}</div>
        <div class="product">${c.producto || ''}</div>
      </div>
      <div class="amount">
        <div class="val" style="color:${c.est.estado === 'atrasado' ? 'var(--alert)' : 'var(--ink)'}">${c.est.estado === 'atrasado' ? formatMoney(c.est.multa) : formatMoney(c.est.restante)}</div>
        <div class="lbl">${c.est.estado === 'atrasado' ? 'multa' : 'restante'}</div>
      </div>
    `;
    row.onclick = () => abrirCliente(c.id);
    return row;
  }

  if (atrasados.length > 0) {
    const t = document.createElement('div');
    t.className = 'section-title';
    t.textContent = 'Atrasados';
    screen.appendChild(t);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '0';
    atrasados.forEach(c => card.appendChild(clientRow(c)));
    screen.appendChild(card);
  }

  const t2 = document.createElement('div');
  t2.className = 'section-title';
  t2.textContent = 'Al corriente';
  screen.appendChild(t2);
  if (alCorriente.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.style.padding = '24px';
    empty.innerHTML = `<p>Nadie más en este grupo todavía.</p>`;
    screen.appendChild(empty);
  } else {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '0';
    alCorriente.forEach(c => card.appendChild(clientRow(c)));
    screen.appendChild(card);
  }

  const addClientBtn = document.createElement('button');
  addClientBtn.className = 'btn btn-secondary btn-block';
  addClientBtn.style.marginTop = '18px';
  addClientBtn.textContent = '+ Agregar cliente a este grupo';
  addClientBtn.onclick = () => setState({ view: 'addClient' });
  screen.appendChild(addClientBtn);

  wrap.appendChild(screen);

  const fabWrap = document.createElement('div');
  fabWrap.className = 'fab-wrap';
  fabWrap.innerHTML = `<button class="fab" id="add-payment-fab">＋</button>`;
  fabWrap.querySelector('#add-payment-fab').onclick = () => setState({ view: 'addPayment', clienteActual: null });
  wrap.appendChild(fabWrap);

  return wrap;
}

// ---------- SCREEN: CLIENT DETAIL ----------
function renderClientDetail() {
  const wrap = document.createElement('div');
  const c = state.clienteActual;
  const g = state.grupoActual;

  const top = document.createElement('div');
  top.className = 'topbar';
  top.innerHTML = `
    <button class="back" id="back-btn">‹</button>
    <h1>${c ? c.nombre : ''}</h1>
    <div class="spacer"></div>
  `;
  top.querySelector('#back-btn').onclick = () => setState({ view: 'group' });
  wrap.appendChild(top);

  const screen = document.createElement('div');
  screen.className = 'screen';

  if (!c) { wrap.appendChild(screen); return wrap; }

  const est = c.est;
  const statusColor = est.estado === 'atrasado' ? 'var(--alert)' : est.estado === 'sin_pagos' ? 'var(--ink-soft)' : 'var(--ok)';
  const statusLabel = est.estado === 'atrasado' ? `Atrasada(o) — ${est.diasAtraso} día(s)` : est.estado === 'sin_pagos' ? 'Sin pagos registrados' : 'Al corriente';

  const statusCard = document.createElement('div');
  statusCard.className = 'card';
  statusCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">
      <div>
        <div style="font-size:12px;color:var(--ink-soft);margin-bottom:2px;">${c.producto || ''}</div>
        <div style="font-weight:700;font-size:13.5px;color:${statusColor};">${statusLabel}</div>
      </div>
      <div style="text-align:right;">
        <div class="display num" style="font-size:24px;">${formatMoney(est.restante)}</div>
        <div style="font-size:11.5px;color:var(--ink-soft);">restante</div>
      </div>
    </div>
    <div style="display:flex;gap:10px;">
      <div style="flex:1;background:var(--bg);border-radius:10px;padding:10px;text-align:center;">
        <div class="num" style="font-weight:700;font-size:15px;">${formatMoney(c.total)}</div>
        <div style="font-size:10.5px;color:var(--ink-soft);">total</div>
      </div>
      <div style="flex:1;background:var(--bg);border-radius:10px;padding:10px;text-align:center;">
        <div class="num" style="font-weight:700;font-size:15px;">${formatMoney(est.totalPagado)}</div>
        <div style="font-size:10.5px;color:var(--ink-soft);">pagado</div>
      </div>
      <div style="flex:1;background:${est.multa > 0 ? 'var(--alert-soft)' : 'var(--bg)'};border-radius:10px;padding:10px;text-align:center;">
        <div class="num" style="font-weight:700;font-size:15px;color:${est.multa > 0 ? 'var(--alert)' : 'var(--ink)'}">${formatMoney(est.multa)}</div>
        <div style="font-size:10.5px;color:var(--ink-soft);">multa</div>
      </div>
    </div>
  `;
  screen.appendChild(statusCard);

  if (est.inicioSemana1) {
    const infoCard = document.createElement('div');
    infoCard.className = 'card';
    infoCard.innerHTML = `
      <div style="font-size:12.5px;color:var(--ink-soft);line-height:1.6;">
        Primer pago: <strong style="color:var(--ink);">${formatFecha(est.primerPago)}</strong><br>
        Inicio Semana 1 (lunes): <strong style="color:var(--ink);">${formatFecha(est.inicioSemana1)}</strong><br>
        Semanas transcurridas: <strong style="color:var(--ink);">${est.semanasTranscurridas}</strong> ·
        Debería llevar: <strong style="color:var(--ink);">${formatMoney(est.deberiaLlevar)}</strong>
      </div>
    `;
    screen.appendChild(infoCard);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'btn btn-primary btn-block';
  addBtn.style.margin = '14px 0';
  addBtn.textContent = '+ Registrar pago';
  addBtn.onclick = () => setState({ view: 'addPayment' });
  screen.appendChild(addBtn);

  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = 'Historial de pagos';
  screen.appendChild(t);

  const histCard = document.createElement('div');
  histCard.className = 'card';
  if (!c.pagos || c.pagos.length === 0) {
    histCard.innerHTML = `<div style="text-align:center;color:var(--ink-soft);font-size:13px;padding:10px 0;">Sin pagos todavía.</div>`;
  } else {
    const ordenados = [...c.pagos].sort((a, b) => b.fecha - a.fecha);
    ordenados.forEach(p => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div class="l">Pago<br><span class="d">${formatFecha(p.fecha)}</span></div>
        <div class="r num">${formatMoney(p.monto)}</div>
      `;
      histCard.appendChild(item);
    });
  }
  screen.appendChild(histCard);

  wrap.appendChild(screen);
  return wrap;
}

// ---------- SCREEN: ADD PAYMENT (con lectura IA + confirmación obligatoria) ----------
let pagoTemp = { modo: null, imagenBase64: null, imagenMediaType: null, imagenPreview: null, texto: '', propuesta: null, leyendo: false, clienteId: null, monto: '', fecha: '' };

function resetPagoTemp() {
  pagoTemp = { modo: null, imagenBase64: null, imagenMediaType: null, imagenPreview: null, texto: '', propuesta: null, leyendo: false, clienteId: state.clienteActual ? state.clienteActual.id : null, monto: '', fecha: new Date().toISOString().slice(0, 10) };
}

function renderAddPayment() {
  if (pagoTemp.modo === null) resetPagoTemp();
  if (state.clienteActual && pagoTemp.clienteId !== state.clienteActual.id && !pagoTemp.propuesta) {
    pagoTemp.clienteId = state.clienteActual.id;
  }
  const wrap = document.createElement('div');

  const top = document.createElement('div');
  top.className = 'topbar';
  top.innerHTML = `
    <button class="back" id="back-btn">‹</button>
    <h1>Registrar pago</h1>
    <div class="spacer"></div>
  `;
  top.querySelector('#back-btn').onclick = () => {
    setState({ view: state.clienteActual ? 'client' : 'group' });
  };
  wrap.appendChild(top);

  const screen = document.createElement('div');
  screen.className = 'screen';

  // Selector de cliente si venimos del FAB del grupo (sin cliente preseleccionado)
  const clienteSel = document.createElement('div');
  if (!state.clienteActual) {
    const field = document.createElement('div');
    field.className = 'field';
    field.innerHTML = `<label>Cliente</label>
      <select id="cliente-select">
        <option value="">Selecciona...</option>
        ${state.clientesGrupo.map(c => `<option value="${c.id}" ${pagoTemp.clienteId === c.id ? 'selected' : ''}>${c.nombre}</option>`).join('')}
      </select>`;
    field.querySelector('select').onchange = (e) => { pagoTemp.clienteId = e.target.value; };
    clienteSel.appendChild(field);
  }
  screen.appendChild(clienteSel);

  if (!pagoTemp.propuesta) {
    // Paso 1: elegir cómo capturar
    const tabs = document.createElement('div');
    tabs.className = 'pill-tabs';
    tabs.innerHTML = `
      <button id="tab-foto" class="${pagoTemp.modo === 'foto' ? 'active' : ''}">📷 Captura</button>
      <button id="tab-texto" class="${pagoTemp.modo === 'texto' ? 'active' : ''}">💬 Mensaje</button>
      <button id="tab-manual" class="${pagoTemp.modo === 'manual' ? 'active' : ''}">✍️ Manual</button>
    `;
    tabs.querySelector('#tab-foto').onclick = () => { pagoTemp.modo = 'foto'; render(); };
    tabs.querySelector('#tab-texto').onclick = () => { pagoTemp.modo = 'texto'; render(); };
    tabs.querySelector('#tab-manual').onclick = () => { pagoTemp.modo = 'manual'; render(); };
    screen.appendChild(tabs);

    if (pagoTemp.modo === 'foto') {
      const card = document.createElement('div');
      card.className = 'card';
      if (pagoTemp.imagenPreview) {
        card.innerHTML = `<img src="${pagoTemp.imagenPreview}" class="preview-img">`;
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary btn-block';
        btn.innerHTML = pagoTemp.leyendo ? '<div class="spinner"></div>' : 'Leer comprobante con IA';
        btn.disabled = pagoTemp.leyendo;
        btn.onclick = () => procesarImagen();
        card.appendChild(btn);
        const retake = document.createElement('button');
        retake.className = 'btn btn-ghost btn-block';
        retake.textContent = 'Cambiar foto';
        retake.style.marginTop = '6px';
        retake.onclick = () => { pagoTemp.imagenPreview = null; pagoTemp.imagenBase64 = null; render(); };
        card.appendChild(retake);
      } else {
        card.innerHTML = `<div class="upload-zone"><div class="icon">📷</div>Toca para subir la captura del comprobante</div>`;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        input.onchange = (e) => handleFileSelect(e.target.files[0]);
        card.querySelector('.upload-zone').onclick = () => input.click();
        card.appendChild(input);
      }
      screen.appendChild(card);
      screen.appendChild(hintNote('La IA solo va a PROPONER los datos — tú los revisas y corriges antes de guardar nada.'));
    }

    if (pagoTemp.modo === 'texto') {
      const card = document.createElement('div');
      card.className = 'card';
      const field = document.createElement('div');
      field.className = 'field';
      field.innerHTML = `<label>Pega el mensaje de Messenger</label>
        <input type="text" id="texto-input" placeholder='Ej: "ya te pagué 200"' value="${pagoTemp.texto}">`;
      card.appendChild(field);
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-block';
      btn.innerHTML = pagoTemp.leyendo ? '<div class="spinner"></div>' : 'Interpretar mensaje';
      btn.disabled = pagoTemp.leyendo;
      btn.onclick = () => { pagoTemp.texto = card.querySelector('#texto-input').value; procesarTexto(); };
      card.appendChild(btn);
      screen.appendChild(card);
      screen.appendChild(hintNote('La IA solo va a PROPONER los datos — tú los revisas y corriges antes de guardar nada.'));
    }

    if (pagoTemp.modo === 'manual') {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="field"><label>Monto</label><input type="number" id="m-monto" placeholder="0" value="${pagoTemp.monto}"></div>
        <div class="field"><label>Fecha</label><input type="date" id="m-fecha" value="${pagoTemp.fecha}"></div>
      `;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-block';
      btn.textContent = 'Continuar';
      btn.onclick = () => {
        pagoTemp.monto = card.querySelector('#m-monto').value;
        pagoTemp.fecha = card.querySelector('#m-fecha').value;
        if (!pagoTemp.monto) { showToast('Ingresa un monto'); return; }
        pagoTemp.propuesta = { monto: parseFloat(pagoTemp.monto), fecha: pagoTemp.fecha, confianza: 'manual', notas: '' };
        render();
      };
      card.appendChild(btn);
      screen.appendChild(card);
    }
  } else {
    // Paso 2: SIEMPRE confirmar/editar antes de guardar
    const p = pagoTemp.propuesta;
    if (pagoTemp.imagenPreview) {
      const img = document.createElement('img');
      img.src = pagoTemp.imagenPreview;
      img.className = 'preview-img';
      screen.appendChild(img);
    }

    if (p.confianza && p.confianza !== 'manual') {
      const confBox = document.createElement('div');
      confBox.className = 'confirm-box';
      const confLabel = p.confianza === 'alta' ? '✅ Confianza alta' : p.confianza === 'media' ? '⚠️ Confianza media — revisa bien' : '⚠️ Confianza baja — revisa con cuidado';
      confBox.innerHTML = `<div class="label">${confLabel}</div><p>${p.notas || 'Revisa que los datos sean correctos antes de guardar.'}</p>`;
      screen.appendChild(confBox);
    }

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="field"><label>Monto</label><input type="number" id="c-monto" value="${p.monto ?? ''}"></div>
      <div class="field"><label>Fecha</label><input type="date" id="c-fecha" value="${p.fecha || new Date().toISOString().slice(0,10)}"></div>
      ${p.nombreDetectado ? `<div class="hint-text">Nombre detectado en el comprobante: <strong>${p.nombreDetectado}</strong></div>` : ''}
    `;
    screen.appendChild(card);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn btn-primary btn-block';
    confirmBtn.style.marginTop = '14px';
    confirmBtn.textContent = 'Confirmar y guardar pago';
    confirmBtn.onclick = () => {
      const monto = parseFloat(card.querySelector('#c-monto').value);
      const fecha = card.querySelector('#c-fecha').value;
      const clienteId = state.clienteActual ? state.clienteActual.id : pagoTemp.clienteId;
      if (!clienteId) { showToast('Selecciona un cliente'); return; }
      if (!monto || monto <= 0) { showToast('Ingresa un monto válido'); return; }
      if (!fecha) { showToast('Ingresa una fecha'); return; }
      guardarPago(clienteId, monto, fecha);
    };
    screen.appendChild(confirmBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost btn-block';
    cancelBtn.textContent = 'Volver a intentar';
    cancelBtn.onclick = () => { pagoTemp.propuesta = null; render(); };
    screen.appendChild(cancelBtn);
  }

  wrap.appendChild(screen);
  return wrap;
}

function hintNote(text) {
  const d = document.createElement('div');
  d.className = 'hint-text';
  d.style.textAlign = 'center';
  d.style.marginTop = '10px';
  d.textContent = text;
  return d;
}

async function handleFileSelect(file) {
  if (!file) return;
  const base64 = await fileToBase64(file);
  pagoTemp.imagenBase64 = base64;
  pagoTemp.imagenMediaType = file.type;
  pagoTemp.imagenPreview = `data:${file.type};base64,${base64}`;
  render();
}

async function procesarImagen() {
  pagoTemp.leyendo = true; render();
  try {
    const resultado = await leerComprobanteImagen(pagoTemp.imagenBase64, pagoTemp.imagenMediaType);
    if (!resultado.fecha) resultado.fecha = new Date().toISOString().slice(0, 10);
    pagoTemp.propuesta = resultado;
  } catch (e) {
    showToast('No se pudo leer la imagen. Intenta de nuevo o captúralo manual.');
  }
  pagoTemp.leyendo = false; render();
}

async function procesarTexto() {
  if (!pagoTemp.texto.trim()) { showToast('Escribe el mensaje'); return; }
  pagoTemp.leyendo = true; render();
  try {
    const resultado = await leerComprobanteTexto(pagoTemp.texto);
    if (!resultado.fecha) resultado.fecha = new Date().toISOString().slice(0, 10);
    pagoTemp.propuesta = resultado;
  } catch (e) {
    showToast('No se pudo interpretar el mensaje. Intenta manual.');
  }
  pagoTemp.leyendo = false; render();
}

async function guardarPago(clienteId, monto, fechaStr) {
  setState({ loading: true });
  try {
    const fecha = Timestamp.fromDate(new Date(fechaStr + 'T12:00:00'));
    await addDoc(collection(db, 'grupos', state.grupoActual.id, 'clientes', clienteId, 'pagos'), {
      monto, fecha, registradoPor: state.user.email, creadoEn: serverTimestamp()
    });
    showToast('Pago guardado ✓');
    resetPagoTemp();
    await abrirGrupo(state.grupoActual.id);
    if (state.clienteActual) await abrirCliente(clienteId);
  } catch (e) {
    setState({ loading: false });
    showToast('Error al guardar. Intenta de nuevo.');
  }
}

// ---------- SCREEN: ADD CLIENT ----------
function renderAddClient() {
  const wrap = document.createElement('div');
  const top = document.createElement('div');
  top.className = 'topbar';
  top.innerHTML = `<button class="back" id="back-btn">‹</button><h1>Nuevo cliente</h1><div class="spacer"></div>`;
  top.querySelector('#back-btn').onclick = () => setState({ view: 'group' });
  wrap.appendChild(top);

  const screen = document.createElement('div');
  screen.className = 'screen';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="field"><label>Nombre completo</label><input type="text" id="nc-nombre" placeholder="Ej. Ana Campos Díaz"></div>
    <div class="field"><label>Producto</label><input type="text" id="nc-producto" placeholder="Ej. Bolsa COACH"></div>
    <div class="field"><label>Total a pagar</label><input type="number" id="nc-total" placeholder="0"></div>
  `;
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-block';
  btn.textContent = 'Agregar cliente';
  btn.onclick = async () => {
    const nombre = card.querySelector('#nc-nombre').value.trim();
    const producto = card.querySelector('#nc-producto').value.trim();
    const total = parseFloat(card.querySelector('#nc-total').value);
    if (!nombre || !total) { showToast('Completa nombre y total'); return; }
    setState({ loading: true });
    await addDoc(collection(db, 'grupos', state.grupoActual.id, 'clientes'), { nombre, producto, total });
    showToast('Cliente agregado ✓');
    await abrirGrupo(state.grupoActual.id);
  };
  card.appendChild(btn);
  screen.appendChild(card);
  wrap.appendChild(screen);
  return wrap;
}

// ---------- SCREEN: ADD GROUP ----------
function renderAddGroup() {
  const wrap = document.createElement('div');
  const top = document.createElement('div');
  top.className = 'topbar';
  top.innerHTML = `<button class="back" id="back-btn">‹</button><h1>Nuevo grupo</h1><div class="spacer"></div>`;
  top.querySelector('#back-btn').onclick = () => setState({ view: 'groups' });
  wrap.appendChild(top);

  const screen = document.createElement('div');
  screen.className = 'screen';
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="field"><label>Nombre del grupo</label><input type="text" id="ng-nombre" placeholder="Ej. Ahorro 16"></div>
    <div class="field"><label>Plazo (semanas)</label><input type="number" id="ng-plazo" value="10"></div>
    <div class="field"><label>Multa por día de atraso</label><input type="number" id="ng-multa" value="35"></div>
  `;
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-block';
  btn.textContent = 'Crear grupo';
  btn.onclick = async () => {
    const nombre = card.querySelector('#ng-nombre').value.trim();
    const plazoSemanas = parseInt(card.querySelector('#ng-plazo').value) || 10;
    const multaPorDia = parseFloat(card.querySelector('#ng-multa').value) || 35;
    if (!nombre) { showToast('Ponle un nombre al grupo'); return; }
    setState({ loading: true });
    await addDoc(collection(db, 'grupos'), { nombre, plazoSemanas, multaPorDia });
    showToast('Grupo creado ✓');
    await cargarGrupos();
    setState({ view: 'groups' });
  };
  card.appendChild(btn);
  screen.appendChild(card);
  wrap.appendChild(screen);
  return wrap;
}

window.__app = { setState, state, showToast, abrirGrupo, abrirCliente, cargarGrupos, signOut: () => signOut(auth) };

render();
