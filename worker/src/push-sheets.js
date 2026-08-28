// Push best-effort D1 → Sheets. Si falla (red, Apps Script caído, etc.), no
// interrumpe la respuesta al usuario — la reconciliación periódica (paso 7b)
// cubre cualquier fila que quede con sincronizado_sheets = 0.

import { _fechaHoraBogota } from "./d1-negocio.js";

export async function _pushRegistrosYMarcar(env, ids, filas) {
  if (!ids || ids.length === 0) return;
  try {
    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "_pushRegistros",
        token: env.APPS_SCRIPT_TOKEN,
        datos: { filas },
      }),
    });
    const body = await res.json();
    if (!body.success) return;

    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(
      "UPDATE registros SET sincronizado_sheets = 1, sincronizado_en = ? WHERE id IN (" +
        placeholders +
        ")",
    )
      .bind(new Date().toISOString(), ...ids)
      .run();
  } catch (err) {
    // best-effort: se queda con sincronizado_sheets = 0, la reconciliación lo recoge después.
  }
}

export async function _pushJustificacionYMarcar(env, id, fila) {
  try {
    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "_pushJustificacion",
        token: env.APPS_SCRIPT_TOKEN,
        datos: { fila },
      }),
    });
    const body = await res.json();
    if (!body.success) return;

    await env.DB.prepare(
      "UPDATE justificaciones SET sincronizado_sheets = 1, sincronizado_en = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), id)
      .run();
  } catch (err) {
    // best-effort
  }
}

// Relee la fila completa y fresca de D1 (ya con los cambios de editar/anular/
// reactivar aplicados), calcula "Última acción" según el estado actual, y
// sobreescribe la fila entera en Sheets.
export async function _pushFilaRegistroYMarcar(env, idRegistro) {
  try {
    const fila = await env.DB.prepare(
      "SELECT id, lote_id, fecha, coordinador, cedula_operario, operario, supernumerario, " +
        "cliente, proceso, unidades_hora_estandar, sublinea, evento, numero_pedido, ean, " +
        "unidades_totales_procesadas, hora_inicio, hora_final, suplemento, observacion, " +
        "duracion_bruta_min, clasificacion_proceso, tiempo_total, unidades_procesadas_operario, " +
        "unidades_hora_real, eficiencia, anulado, anulado_por, anulado_en, motivo_anulacion, " +
        "editado_por, editado_en, motivo_edicion FROM registros WHERE id = ?",
    )
      .bind(idRegistro)
      .first();
    if (!fila) return; // se borró justo antes de que este push corriera

    const ultimaAccion =
      fila.anulado === 1
        ? "ANULADO — " +
          fila.anulado_por +
          " — " +
          fila.motivo_anulacion +
          " — " +
          _fechaHoraBogota(fila.anulado_en)
        : fila.editado_por
          ? "EDITADO — " +
            fila.editado_por +
            " — " +
            fila.motivo_edicion +
            " — " +
            _fechaHoraBogota(fila.editado_en)
          : "";

    const valores = [
      fila.lote_id,
      fila.fecha,
      fila.coordinador,
      fila.cedula_operario,
      fila.operario,
      fila.supernumerario,
      fila.cliente,
      fila.proceso,
      fila.unidades_hora_estandar,
      fila.sublinea,
      fila.evento,
      fila.numero_pedido,
      fila.ean,
      fila.unidades_totales_procesadas,
      fila.hora_inicio,
      fila.hora_final,
      fila.suplemento,
      fila.observacion,
      fila.duracion_bruta_min,
      fila.clasificacion_proceso,
      fila.tiempo_total,
      fila.unidades_procesadas_operario,
      fila.unidades_hora_real,
      fila.eficiencia,
      fila.id,
      ultimaAccion,
    ];

    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "_actualizarFilaRegistro",
        token: env.APPS_SCRIPT_TOKEN,
        datos: { idRegistro, valores },
      }),
    });
    const body = await res.json();
    if (!body.success) return;

    await env.DB.prepare(
      "UPDATE registros SET anulado_sincronizado_sheets = 1 WHERE id = ?",
    )
      .bind(idRegistro)
      .run();
  } catch (err) {
    // best-effort: se queda con anulado_sincronizado_sheets = 0, la reconciliación lo recoge después.
  }
}

// Best-effort a propósito, sin red de seguridad: si falla, la fila queda
// huérfana en Sheets hasta la próxima purga periódica de la hoja (1-3 meses)
// — aceptado, no hay tabla de pendientes para esto.
export async function _eliminarFilaRegistroSheets(env, idRegistro) {
  try {
    await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "_eliminarFilaRegistro",
        token: env.APPS_SCRIPT_TOKEN,
        datos: { idRegistro },
      }),
    });
  } catch (err) {
    // best-effort a propósito: sin reintento, ver comentario arriba.
  }
}
