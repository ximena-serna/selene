// Lógica central de cálculo v2
// - Semana 1 arranca en el lunes de la semana del PAGO #1 (no anticipos)
// - Anticipos: pagos con numeroPago === 0 o tipo === 'anticipo' — cuentan para saldo pero no definen semanas
// - Multas: empiezan el DÍA SIGUIENTE al último día de la semana vencida (lunes siguiente al domingo de cierre)

export function mondayOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function daysBetween(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((a.getTime() - b.getTime()) / MS);
}

/**
 * @param {object} cliente { total, plazoSemanas }
 * @param {Array}  pagos   [{ monto, fecha(Date), numeroPago(number|null), esAnticipo(bool) }]
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
      totalPagado: 0, diasAtraso: 0, multa: 0,
      restante: total, estado: 'sin_pagos',
    };
  }

  const totalPagado = pagos.reduce((s, p) => s + p.monto, 0);

  // Pago #1: el primer pago que NO es anticipo (numeroPago >= 1 o esAnticipo === false)
  const pagosOrdenados = [...pagos].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const pago1 = pagosOrdenados.find(p => !p.esAnticipo && (p.numeroPago == null || p.numeroPago >= 1));
  
  // Si no hay Pago #1 todavía (solo anticipos), no hay semanas que contar aún
  if (!pago1) {
    return {
      primerPago: pagosOrdenados[0]?.fecha || null,
      inicioSemana1: null,
      semanasTranscurridas: 0,
      deberiaLlevar: 0,
      totalPagado,
      diasAtraso: 0,
      multa: 0,
      restante: Math.max(0, total - totalPagado),
      estado: 'sin_pagos',
    };
  }

  const inicioSemana1 = mondayOfWeek(new Date(pago1.fecha));

  const hoyMid = new Date(hoy);
  hoyMid.setHours(0, 0, 0, 0);

  const semanasTranscurridas = Math.max(1, Math.floor(daysBetween(hoyMid, inicioSemana1) / 7) + 1);
  const semanasContables = Math.min(semanasTranscurridas, plazoSemanas);
  const deberiaLlevar = semanasContables * cuotaSemanal;

  let diasAtraso = 0;
  if (totalPagado < deberiaLlevar) {
    const cuotasCompletas = Math.floor(totalPagado / cuotaSemanal);
    // La semana N termina el domingo = inicioSemana1 + N*7 - 1
    // Multa empieza el día SIGUIENTE = inicioSemana1 + N*7 (lunes de la semana siguiente)
    const fechaInicioMulta = new Date(inicioSemana1);
    fechaInicioMulta.setDate(fechaInicioMulta.getDate() + cuotasCompletas * 7);
    // El día de inicio de multa ya cuenta como día 1, por eso sumamos 1 si hoy >= fechaInicioMulta
    const diffDias = daysBetween(hoyMid, fechaInicioMulta);
    diasAtraso = diffDias >= 0 ? diffDias + 1 : 0;
  }

  const multa = diasAtraso > 0 ? diasAtraso * multaPorDia : 0;
  const restante = total + multa - totalPagado;

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
    diasAtraso,
    multa,
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
