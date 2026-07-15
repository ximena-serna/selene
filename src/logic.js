// Lógica central v7 - FINAL
// La multa HISTÓRICA ya está registrada en el campo `multa` de cada pago.
// El sistema solo calcula la multa PENDIENTE de las semanas actuales sin cubrir.
// Estado general: si abonoProducto >= total Y no hay semanas abiertas sin cubrir → pagado/al_corriente

export function mondayOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

function daysBetween(a, b) {
  return Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

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
      restante: total, estado: 'sin_pagos', semanas: [],
    };
  }

  const totalPagado = pagos.reduce((s, p) => s + p.monto, 0);
  const multaPagada = pagos.reduce((s, p) => s + (p.multa || 0), 0);
  const abonoProducto = totalPagado - multaPagada;

  const pagosOrdenados = [...pagos].sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  const pago1 = pagosOrdenados.find(p => !p.esAnticipo && (p.numeroPago == null || p.numeroPago >= 1));

  if (!pago1) {
    return {
      primerPago: null, inicioSemana1: null,
      semanasTranscurridas: 0, deberiaLlevar: 0,
      totalPagado, multaPagada, abonoProducto,
      diasAtraso: 0, multa: 0, multaPendiente: 0,
      restante: Math.max(0, total - abonoProducto),
      estado: 'sin_pagos', semanas: [],
    };
  }

  const inicioSemana1 = mondayOfWeek(new Date(pago1.fecha));
  const hoyMid = new Date(hoy);
  hoyMid.setHours(0, 0, 0, 0);

  const semanasTranscurridas = Math.max(1, Math.floor(daysBetween(hoyMid, inicioSemana1) / 7) + 1);
  const semanasContables = Math.min(semanasTranscurridas, plazoSemanas);
  const deberiaLlevar = semanasContables * cuotaSemanal;

  // Saldo acumulado al final de cada semana (usando todas las fechas de pago)
  const abonosOrdenados = pagosOrdenados.map(p => ({
    fecha: new Date(p.fecha),
    abono: p.monto - (p.multa || 0),
  })).filter(p => p.abono > 0);

  // La última fecha de pago
  const ultimoPago = pagosOrdenados[pagosOrdenados.length - 1];
  const fechaUltimoPago = new Date(ultimoPago.fecha);
  fechaUltimoPago.setHours(0, 0, 0, 0);

  let multaActiva = 0; // solo multa de semanas SIN cubrir hasta hoy
  let diasAtraso = 0;
  const semanas = [];

  for (let i = 0; i < semanasContables; i++) {
    const lunesSemana = new Date(inicioSemana1);
    lunesSemana.setDate(lunesSemana.getDate() + i * 7);
    const domingoSemana = new Date(lunesSemana);
    domingoSemana.setDate(domingoSemana.getDate() + 6);
    domingoSemana.setHours(23, 59, 59);
    const lunesSiguiente = new Date(lunesSemana);
    lunesSiguiente.setDate(lunesSiguiente.getDate() + 7);

    // Saldo acumulado al cierre del domingo de esta semana
    const saldoAlCierre = abonosOrdenados
      .filter(p => p.fecha <= domingoSemana)
      .reduce((s, p) => s + p.abono, 0);

    const cubierta = saldoAlCierre >= (i + 1) * cuotaSemanal - 0.01;
    const semanaCerrada = hoyMid > domingoSemana;

    // ¿Hay algún pago posterior a esta semana? (la "cubrió" aunque sea tarde)
    const hayPagoPosterior = abonosOrdenados.some(p => {
      const fd = new Date(p.fecha);
      fd.setHours(0,0,0,0);
      return fd > domingoSemana;
    }) && (() => {
      // Verificar que el saldo total EVENTUAL cubra esta semana
      const saldoTotal = abonosOrdenados.reduce((s,p) => s+p.abono, 0);
      return saldoTotal >= (i+1) * cuotaSemanal - 0.01;
    })();

    let multaSemana = 0;
    let diasMulta = 0;

    if (!cubierta && semanaCerrada && !hayPagoPosterior) {
      // Semana genuinamente sin cubrir hasta hoy → multa activa
      const diff = daysBetween(hoyMid, lunesSiguiente);
      diasMulta = Math.max(0, diff + 1);
      multaSemana = diasMulta * multaPorDia;
      if (diasMulta > diasAtraso) diasAtraso = diasMulta;
    }

    multaActiva += multaSemana;
    semanas.push({
      numero: i + 1, lunes: lunesSemana,
      saldoAlCierre, cubierta, cerrada: semanaCerrada,
      hayPagoPosterior, multaSemana, diasMulta,
    });
  }

  // Multa total = multa ya pagada (histórica) + multa activa pendiente
  const multaTotal = multaPagada + multaActiva;
  const multaPendiente = multaActiva; // lo que falta pagar de multa nueva

  const productoCubierto = abonoProducto >= total - 0.01;
  const restante = productoCubierto && multaPendiente <= 0
    ? 0
    : Math.max(0, (total - abonoProducto) + multaPendiente);

  let estado;
  if (restante <= 0) estado = 'pagado';
  else if (multaPendiente > 0 || semanas.some(s => !s.cubierta && s.cerrada && !s.hayPagoPosterior)) estado = 'atrasado';
  else estado = 'al_corriente';

  return {
    primerPago: new Date(pago1.fecha),
    inicioSemana1, semanasTranscurridas: semanasContables,
    deberiaLlevar, totalPagado, multaPagada, abonoProducto,
    diasAtraso, multa: multaTotal, multaPendiente, restante, estado, semanas,
  };
}

export function formatMoney(n) {
  return '$' + Math.round(n).toLocaleString('es-MX');
}

export function formatFecha(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
