// Push best-effort D1 → Sheets. Si falla (red, Apps Script caído, etc.), no
// interrumpe la respuesta al usuario — la reconciliación periódica (paso 7b)
// cubre cualquier fila que quede con sincronizado_sheets = 0.

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

export async function _pushEstadoAnulacionYMarcar(env, idRegistro, texto) {
  try {
    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "_actualizarEstadoAnulacion",
        token: env.APPS_SCRIPT_TOKEN,
        datos: { idRegistro, texto },
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
