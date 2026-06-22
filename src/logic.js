// Lógica central de cálculo — replica exacta de las fórmulas validadas en el Excel.
// Semana ancla en lunes desde el primer pago de cada cliente. Multa $X/día sin tope,
// sin importar qué día de la semana se haga el pago.

/** Devuelve el lunes (00:00) de la semana de calendario en que cae `date`. */
export function mondayOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=domingo,1=lunes,...6=sábado
  const diff = day === 0 ? -6 : 1 - day; // si es domingo, retrocede 6 días
  d.setDate(d.getDate() + diff);
  return d;
}

function daysBetween(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((a.getTime() - b.getTime()) / MS);
}

/**
 * Calcula el estado de pago de un cliente.
 * @param {object} cliente { total, plazoSemanas }
 * @param {Array}  pagos   [{ monto, fecha (Date) }, ...]
 * @param {object} params  { multaPorDia }
 * @param {Date}   hoy
 */
export function calcularEstadoCliente(cliente, pagos, params, hoy = new Date()) {
  const { total, plazoSemanas } = cliente;
  const { multaPorDia } = params;
  const cuotaSemanal = total / plazoSemanas;

  if (!pagos || pagos.length === 0) {
    return {
      primerPago: null,
      inicioSemana1: null,
      semanasTranscurridas: 0,
      deberiaLlevar: 0,
      totalPagado: 0,
      diasAtraso: 0,
      multa: 0,
      restante: total,
      estado: 'sin_pagos',
    };
  }

  const totalPagado = pagos.reduce((s, p) => s + p.monto, 0);
  const fechasOrdenadas = pagos.map(p => new Date(p.fecha)).sort((a, b) => a - b);
  const primerPago = fechasOrdenadas[0];
  const inicioSemana1 = mondayOfWeek(primerPago);

  const hoyMid = new Date(hoy);
  hoyMid.setHours(0, 0, 0, 0);

  const semanasTranscurridas = Math.max(1, Math.floor(daysBetween(hoyMid, inicioSemana1) / 7) + 1);
  const semanasContables = Math.min(semanasTranscurridas, plazoSemanas);
  const deberiaLlevar = semanasContables * cuotaSemanal;

  let diasAtraso = 0;
  if (totalPagado < deberiaLlevar) {
    const cuotasCompletas = Math.floor(totalPagado / cuotaSemanal);
    const fechaVencimiento = new Date(inicioSemana1);
    fechaVencimiento.setDate(fechaVencimiento.getDate() + cuotasCompletas * 7);
    diasAtraso = Math.max(0, daysBetween(hoyMid, fechaVencimiento));
  }

  const multa = diasAtraso > 0 ? diasAtraso * multaPorDia : 0;
  const restante = total + multa - totalPagado;

  let estado;
  if (restante <= 0) estado = 'pagado';
  else if (diasAtraso > 0) estado = 'atrasado';
  else estado = 'al_corriente';

  return {
    primerPago,
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
