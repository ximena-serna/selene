// Lógica central v3
// Monto = pago total incluyendo multa
// Multa = porción del monto que es multa pagada
// Abono al producto = monto - multa
// Semana 1 = lunes de la semana del Pago #1 (no anticipos)
// Multa arranca el LUNES SIGUIENTE a la semana que cerró sin pagar

export function mondayOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * @param {object} cliente { total, plazoSemanas }
 * @param {Array}  pagos   [{ monto, multa, fecha(Date), numeroPago, esAnticipo }]
 * @param {object} params  { multaPorDia }
 * @param {Date}   hoy
 */
export function calcularEstadoCliente(cliente, pagos, params, hoy = new Date()) {
  const { total, plazoSemanas } = cliente;
  const { multaPorDia } = params;
  const cuotaSemanal = total / plazoSemanas;

  if (!pagos || pagos.length === 0) {
    return {
      primerPago: null, inicioSemana1: null,
      semanasTranscurridas: 0, deberiaLlevar: 0,
      totalPagado: 0, multaPagada: 0, abonoProducto: 0,
      diasAtraso: 0, multa: 0, multaPendiente: 0,
      restante: total, estado: 'sin_pagos',
    };
  }

  // Separar abono al producto vs multa pagada
  const totalPagado = pagos.reduce((s, p) => s + p.monto, 0);
  const multaPagada = pagos.reduce((s, p) => s + (p.multa || 0), 0);
  const abonoProducto = totalPagado - multaPagada;

  // Pago #1: primer pago NO anticipo
  const pagosOrdenados = [...pagos].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const pago1 = pagosOrdenados.find(p => !p.esAnticipo && (p.numeroPago == null || p.numeroPago >= 1));

  if (!pago1) {
    return {
      primerPago: pagosOrdenados[0]?.fecha || null,
      inicioSemana1: null,
      semanasTranscurridas: 0, deberiaLlevar: 0,
      totalPagado, multaPagada, abonoProducto,
      diasAtraso: 0, multa: 0, multaPendiente: 0,
      restante: Math.max(0, total - abonoProducto),
      estado: 'sin_pagos',
    };
  }

  const inicioSemana1 = mondayOfWeek(new Date(pago1.fecha));
  const hoyMid = new Date(hoy);
  hoyMid.setHours(0, 0, 0, 0);

  const semanasTranscurridas = Math.max(1, Math.floor(daysBetween(hoyMid, inicioSemana1) / 7) + 1);
  const semanasContables = Math.min(semanasTranscurridas, plazoSemanas);
  const deberiaLlevar = semanasContables * cuotaSemanal;

  // Días de atraso basados en abonoProducto (sin contar la multa)
  let diasAtraso = 0;
  if (abonoProducto < deberiaLlevar) {
    const cuotasCompletas = Math.floor(abonoProducto / cuotaSemanal);
    const fechaInicioMulta = new Date(inicioSemana1);
    fechaInicioMulta.setDate(fechaInicioMulta.getDate() + (cuotasCompletas + 1) * 7);
    const diff = daysBetween(hoyMid, fechaInicioMulta);
    diasAtraso = diff >= 0 ? diff + 1 : 0;
  }

  const multa = diasAtraso > 0 ? diasAtraso * multaPorDia : 0;
  // Multa pendiente = lo que falta pagar de multa (ya descontando lo que pagó)
  const multaPendiente = Math.max(0, multa - multaPagada);
  const restante = Math.max(0, (total - abonoProducto) + multaPendiente);

  let estado;
  if (restante <= 0) estado = 'pagado';
  else if (diasAtraso > 0) estado = 'atrasado';
  else estado = 'al_corriente';

  return {
    primerPago: new Date(pago1.fecha),
    inicioSemana1,
    semanasTranscurridas: semanasContables,
    deberiaLlevar,
    totalPagado,
    multaPagada,
    abonoProducto,
    diasAtraso,
    multa,
    multaPendiente,
    restante,
    estado,
  };
}

export function formatMoney(n) {
  return '$' + Math.round(n).toLocaleString('es-MX');
}

export function formatFecha(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
