// Acciones de solo lectura — traducción mecánica de code.js a D1.

import { _localizarValidacionEan } from "./d1-negocio.js";

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

    let row;
    try {
      row = await _localizarValidacionEan(env, pedido, ean);
    } catch (err) {
      return { success: false, message: err.message };
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

  async obtenerRegistrosParaEditar(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    const operarioTexto = String(datos.operario || "").trim();
    if (!pedido && !operarioTexto)
      return {
        success: false,
        message: "Escribe un número de pedido o un nombre de operario.",
      };

    const ean = String(datos.ean || "").trim();

    let sql =
      "SELECT id, numero_pedido AS pedido, fecha, coordinador, cedula_operario AS cedulaOperario, operario, " +
      "supernumerario, proceso, ean, hora_inicio AS horaInicio, hora_final AS horaFinal, " +
      "suplemento, observacion, unidades_procesadas_operario AS unidadesProcesadas, " +
      "codigos_sobrantes AS codigosSobrantes, anulado, anulado_por AS anuladoPor, " +
      "anulado_en AS anuladoEn, motivo_anulacion AS motivoAnulacion, " +
      "editado_por AS editadoPor, editado_en AS editadoEn, motivo_edicion AS motivoEdicion " +
      "FROM registros WHERE 1 = 1";
    const binds = [];
    if (pedido) {
      sql += " AND numero_pedido = ?";
      binds.push(pedido);
    }
    if (ean) {
      sql += " AND ean = ?";
      binds.push(ean);
    }
    if (operarioTexto) {
      sql += " AND " + _sqlSinTildes("operario") + " LIKE ?";
      binds.push("%" + _normalizarTexto(operarioTexto) + "%");
    }
    sql += " ORDER BY fecha DESC, hora_inicio ASC, id DESC";
    if (!pedido) sql += " LIMIT 100";

    const { results } = await env.DB.prepare(sql)
      .bind(...binds)
      .all();

    return { success: true, registros: results };
  },

  async obtenerSeguimientoPaquetes(datos, env) {
    const { results } = await env.DB.prepare(
      "SELECT ve.numero_pedido AS pedido, ve.subLinea AS subLinea, " +
        "ve.unidadesTotales AS unidadesTotales, ve.unidadesProcesadas AS unidadesProcesadas, " +
        "ve.codigosSobrantes AS codigosSobrantes, " +
        "COALESCE(rg.horasTotales,0) AS horasTotales, " +
        "COALESCE(rg.sumaUnidadesPorTiempo,0) AS sumaUnidadesPorTiempo " +
        "FROM (" +
        "SELECT numero_pedido, GROUP_CONCAT(DISTINCT sublinea) AS subLinea, " +
        "SUM(unidades_totales) AS unidadesTotales, SUM(unidades_procesadas) AS unidadesProcesadas, " +
        "SUM(codigos_sobrantes) AS codigosSobrantes " +
        "FROM validacion_eanes GROUP BY numero_pedido" +
        ") ve " +
        "LEFT JOIN (" +
        "SELECT numero_pedido, SUM(tiempo_total) AS horasTotales, " +
        "SUM(tiempo_total * unidades_hora_estandar) AS sumaUnidadesPorTiempo " +
        "FROM registros WHERE anulado = 0 GROUP BY numero_pedido" +
        ") rg ON rg.numero_pedido = ve.numero_pedido " +
        "ORDER BY ve.numero_pedido",
    ).all();

    const paquetes = results.map((r) => {
      const unidadesConSobrantes = r.unidadesProcesadas + r.codigosSobrantes;
      let estado;
      if (unidadesConSobrantes >= r.unidadesTotales) estado = "Completado";
      else if (unidadesConSobrantes > 0) estado = "En proceso";
      else estado = "Pendiente";

      const noIniciado = estado === "Pendiente";
      return {
        pedido: r.pedido,
        subLinea: r.subLinea,
        unidadesTotales: r.unidadesTotales,
        unidadesProcesadas: r.unidadesProcesadas,
        unidadesPendientes: r.unidadesTotales - r.unidadesProcesadas,
        estado,
        horasTotales: noIniciado
          ? null
          : Math.round(r.horasTotales * 100) / 100,
        eficiencia:
          noIniciado || r.sumaUnidadesPorTiempo <= 0
            ? null
            : Math.round(
                (r.unidadesProcesadas / r.sumaUnidadesPorTiempo) * 100,
              ),
      };
    });

    return { success: true, paquetes };
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

// Normaliza texto para comparar nombres sin distinguir mayúsculas ni tildes.
function _normalizarTexto(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Genera una expresión SQL que quita tildes (mayús/minús) antes de aplicar LOWER,
// para que LOWER() no dependa de que SQLite maneje bien Unicode.
function _sqlSinTildes(columna) {
  const mapa = [
    ["Á", "a"],
    ["É", "e"],
    ["Í", "i"],
    ["Ó", "o"],
    ["Ú", "u"],
    ["Ñ", "n"],
    ["Ü", "u"],
    ["á", "a"],
    ["é", "e"],
    ["í", "i"],
    ["ó", "o"],
    ["ú", "u"],
    ["ñ", "n"],
    ["ü", "u"],
  ];
  let expr = columna;
  for (const [conTilde, sinTilde] of mapa) {
    expr = `REPLACE(${expr}, '${conTilde}', '${sinTilde}')`;
  }
  return `LOWER(${expr})`;
}
