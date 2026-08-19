// Acciones de solo lectura — traducción mecánica de code.js a D1.

export const accionesLectura = {
  async getSupervisoresData(datos, env) {
    const { results } = await env.DB.prepare(
      "SELECT tipo, nombre FROM supervisores ORDER BY tipo, nombre",
    ).all();
    const coordinadores = results
      .filter((r) => r.tipo === "coordinador")
      .map((r) => r.nombre);
    const supernumerarios = results
      .filter((r) => r.tipo === "supernumerario")
      .map((r) => ({ nombre: r.nombre }));
    return { success: true, data: { coordinadores, supernumerarios } };
  },

  async getProcesos(datos, env) {
    const { results } = await env.DB.prepare(
      "SELECT nombre_proceso AS nombre, unidades_hora_estandar AS unidadesHora, " +
        "numero_pedido AS pedido, link_procesos AS link FROM procesos",
    ).all();
    return { success: true, data: results };
  },

  async getOperariosData(datos, env) {
    const { results } = await env.DB.prepare(
      "SELECT nombre_operario AS nombre, equipo, cedula FROM operarios WHERE activo = 1",
    ).all();
    return { success: true, data: results };
  },

  async buscarOperarioPorCedula(datos, env) {
    const cedula = String(datos.cedula || "").trim();
    if (!cedula) return { success: false, message: "Falta la cédula." };

    const row = await env.DB.prepare(
      "SELECT nombre_operario AS nombre, equipo FROM operarios WHERE cedula = ? AND activo = 1",
    )
      .bind(cedula)
      .first();

    if (!row) {
      return {
        success: false,
        message: "Cédula no encontrada en el catálogo de Operarios.",
      };
    }
    return { success: true, nombre: row.nombre, equipo: row.equipo };
  },

  async obtenerDatosValidacion(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    const ean = String(datos.ean || "").trim();

    const row = await env.DB.prepare(
      "SELECT sublinea, unidades_totales, unidades_procesadas, codigos_sobrantes, " +
        "(SELECT COALESCE(SUM(faltante),0) FROM justificaciones WHERE pedido = ? AND ean = ?) AS justificado " +
        "FROM validacion_eanes WHERE numero_pedido = ? AND ean_producto = ?",
    )
      .bind(pedido, ean, pedido, ean)
      .first();

    if (!row) {
      return {
        success: false,
        message:
          "El pedido " +
          pedido +
          " con el EAN " +
          ean +
          " no existe en la hoja de Validación.",
      };
    }

    return {
      success: true,
      subLinea: row.sublinea,
      unidadesEsperadas: row.unidades_totales,
      restantes:
        row.unidades_totales -
        row.unidades_procesadas -
        row.justificado -
        row.codigos_sobrantes,
    };
  },

  async obtenerResumenPedido(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    const detalle = await _detalleEanesPedido(env, pedido);

    const eanes = detalle.map((e) => ({
      ean: e.ean,
      esperadas: e.esperadas,
      procesadas: e.procesadas,
      sobrantes: e.sobrantes,
      restantes: e.restanteNeto,
      justificado: e.justificado,
    }));
    const totalPedido = eanes.reduce((s, e) => s + e.esperadas, 0);
    const procesadoPedido = eanes.reduce(
      (s, e) => s + e.procesadas + e.sobrantes,
      0,
    );
    const restantePedido = eanes.reduce((s, e) => s + e.restantes, 0);

    return {
      success: true,
      totalPedido,
      procesadoPedido,
      restantePedido,
      detalleEanes: eanes,
    };
  },

  async obtenerEanesParaJustificar(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    const detalle = await _detalleEanesPedido(env, pedido);
    const eanes = detalle.map((e) => ({
      ean: e.ean,
      esperadas: e.esperadas,
      restanteNeto: e.restanteNeto,
      estado: e.estado,
    }));
    return { success: true, eanes };
  },

  async obtenerEstadoEanJustificar(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    const ean = String(datos.ean || "").trim();
    const detalle = await _detalleEanesPedido(env, pedido);
    const match = detalle.find((e) => e.ean === ean);
    if (!match) {
      return {
        success: false,
        message:
          "El EAN " +
          ean +
          " no existe en el pedido " +
          pedido +
          " según Validación eanes.",
      };
    }
    return {
      success: true,
      ean: match.ean,
      esperadas: match.esperadas,
      restanteNeto: match.restanteNeto,
      estado: match.estado,
    };
  },
};

// Equivalente a _obtenerDetalleEanesPedido de code.js — una consulta SQL en vez de recorrer la hoja.
async function _detalleEanesPedido(env, pedido) {
  const { results } = await env.DB.prepare(
    "SELECT ean_producto AS ean, unidades_totales AS esperadas, unidades_procesadas AS procesadas, " +
      "codigos_sobrantes AS sobrantes, estado, " +
      "(SELECT COALESCE(SUM(faltante),0) FROM justificaciones j " +
      " WHERE j.pedido = v.numero_pedido AND j.ean = v.ean_producto) AS justificado " +
      "FROM validacion_eanes v WHERE numero_pedido = ?",
  )
    .bind(pedido)
    .all();

  return results.map((r) => ({
    ean: r.ean,
    esperadas: r.esperadas,
    procesadas: r.procesadas,
    sobrantes: r.sobrantes,
    justificado: r.justificado,
    restanteNeto: r.esperadas - r.procesadas - r.justificado - r.sobrantes,
    estado: r.estado || "Pendiente",
  }));
}
