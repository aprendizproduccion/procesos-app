// Acciones de solo lectura — traducción mecánica de code.js a D1.

import {
  _localizarValidacionEan,
  _fechaHoyBogota,
  _ahoraBogota,
  TURNO_POR_DEFECTO,
  _turnoOperario,
  _fechaJornada,
  _sqlClaveHora,
  _pivoteSql,
  _resolverPedido,
  _formasEan,
  _sqlEanReferente,
  _sqlRegistroReferente,
  _catalogoEnApp,
} from "./d1-negocio.js";

export const accionesLectura = {
  // Selectores del registro. Hasta el corte salen de `supervisores` (la
  // hoja); desde el corte, de roles_persona: el rol activo de una persona
  // activa (módulo Usuarios).
  // datos.historicos (filtros de Editar registros y Control tiempos, una vez
  // por sesión): desde el corte devuelve además los nombres que tienen los
  // registros, para seguir encontrando el historial de quien ya no está.
  async getSupervisoresData(datos, env) {
    const enApp = await _catalogoEnApp(env, "supervisores");
    const { results } = await env.DB.prepare(
      enApp
        ? "SELECT r.tipo, r.nombre FROM roles_persona r JOIN operarios o ON o.cedula = r.cedula " +
            "WHERE r.activo = 1 AND o.activo = 1 ORDER BY r.tipo, r.nombre"
        : "SELECT tipo, nombre FROM supervisores ORDER BY tipo, nombre",
    ).all();
    const coordinadores = results
      .filter((r) => r.tipo === "coordinador")
      .map((r) => r.nombre);
    const supernumerarios = results
      .filter((r) => r.tipo === "supernumerario")
      .map((r) => ({ nombre: r.nombre }));
    const data = { coordinadores, supernumerarios };
    if (enApp && datos && datos.historicos === true) {
      const { results: viejos } = await env.DB.prepare(
        "SELECT 'coordinador' AS tipo, TRIM(coordinador) AS nombre, COUNT(*) AS n FROM registros " +
          "WHERE TRIM(coordinador) <> '' GROUP BY TRIM(coordinador) UNION ALL " +
          "SELECT 'supernumerario', TRIM(supernumerario), COUNT(*) FROM registros " +
          "WHERE TRIM(supernumerario) <> '' GROUP BY TRIM(supernumerario)",
      ).all();
      // Un nombre escrito con otras mayúsculas cuenta una sola vez, con la
      // escritura más usada.
      const lista = (tipo) => {
        const porClave = new Map();
        viejos
          .filter((r) => r.tipo === tipo)
          .sort(
            (a, b) =>
              b.n - a.n ||
              a.nombre.localeCompare(b.nombre, "es", { caseFirst: "upper" }),
          )
          .forEach((r) => {
            const clave = r.nombre.toLowerCase();
            if (!porClave.has(clave)) porClave.set(clave, r.nombre);
          });
        return [...porClave.values()].sort((a, b) => a.localeCompare(b, "es"));
      };
      data.historicos = {
        coordinadores: lista("coordinador"),
        supernumerarios: lista("supernumerario"),
      };
    }
    return { success: true, data };
  },

  async getProcesos(datos, env) {
    const { results } = await env.DB.prepare(
      "SELECT nombre_proceso AS nombre, unidades_hora_estandar AS unidadesHora, " +
        "numero_pedido AS pedido, link_procesos AS link FROM procesos",
    ).all();
    return { success: true, data: results };
  },

  async getOperariosData(datos, env) {
    // Sin cédula: el catálogo se descarga en cada carga y en cada
    // visibilitychange, y el frontend solo usa nombre y equipo. Solo quienes
    // tienen el rol de operario (módulo Usuarios): fuera los grupos.
    const { results } = await env.DB.prepare(
      "SELECT nombre_operario AS nombre, equipo FROM operarios WHERE activo = 1 AND es_operario = 1",
    ).all();
    return { success: true, data: results };
  },

  async getClientes(datos, env) {
    // Solo alimenta las sugerencias del filtro Cliente de Control tiempos
    // (admin). El filtro sigue siendo "contiene" sobre registros.cliente,
    // así que un cliente que ya no esté en pedidos se puede escribir a mano.
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT cliente FROM pedidos WHERE cliente <> '' ORDER BY cliente",
    ).all();
    return { success: true, data: results.map((r) => r.cliente) };
  },

  async buscarOperarioPorCedula(datos, env) {
    const cedula = String(datos.cedula || "").trim();
    if (!cedula) return { success: false, message: "Falta la cédula." };

    const { fecha: fechaHoy, hora } = _ahoraBogota();
    // Pendiente 16: la jornada de un turno que cruza la medianoche, y su
    // último fin medido con la clave de la jornada.
    const turnoOp = await _turnoOperario(env, cedula);
    const fecha = _fechaJornada(fechaHoy, hora, turnoOp);
    const row = await env.DB.prepare(
      "SELECT o.nombre_operario AS nombre, o.equipo, o.turno, " +
        "(SELECT hora_final FROM registros " +
        "WHERE cedula_operario = ? AND fecha = ? AND anulado = 0 " +
        "ORDER BY " +
        _sqlClaveHora("hora_final") +
        " DESC LIMIT 1) AS ultimoFin " +
        "FROM operarios o WHERE o.cedula = ? AND o.activo = 1 AND o.es_operario = 1",
    )
      .bind(cedula, fecha, _pivoteSql(turnoOp), cedula)
      .first();

    if (!row) {
      return {
        success: false,
        message: "Cédula no encontrada en el catálogo de Operarios.",
      };
    }

    // horaInicioPrevista es vista previa (el servidor la recalcula al enviar);
    // horaCaptura es la hora fin que se congela al confirmar la cédula.
    const ultimoFin = String(row.ultimoFin || "").trim();
    const turno = String(row.turno || "").trim();
    return {
      success: true,
      nombre: row.nombre,
      equipo: row.equipo,
      horaInicioPrevista: ultimoFin || turno || TURNO_POR_DEFECTO,
      turnoConfigurado: Boolean(ultimoFin || turno),
      horaCaptura: hora,
      fechaJornada: fecha,
      // Pivote de la jornada ("" en un turno de día): el navegador lo usa para
      // la vista previa de la duración, con la misma regla del Worker.
      pivoteJornada: _pivoteSql(turnoOp),
    };
  },

  async obtenerDatosValidacion(datos, env) {
    const pedido = await _resolverPedido(env, datos.pedido);
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
      unidadesEsperadas: row.sin_limite ? null : row.unidades_totales,
      sinLimite: row.sin_limite === 1,
      restantes: row.sin_limite
        ? null
        : row.unidades_totales -
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
      sinLimite: e.sinLimite,
      justificado: e.justificado,
      referente: e.referente,
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

  async obtenerRegistrosParaEditar(datos, env) {
    const pedido = String(datos.pedido || "").trim();
    const operarioTexto = String(datos.operario || "").trim();
    const fecha = String(datos.fecha || "").trim();
    const ean = String(datos.ean || "").trim();
    const coordinador = String(datos.coordinador || "").trim();
    const supernumerario = String(datos.supernumerario || "").trim();
    const proceso = String(datos.proceso || "").trim();

    // Cualquier filtro basta por sí solo y ninguno depende de otro; lo único
    // que se rechaza es pedir la tabla entera sin ningún criterio.
    if (
      !pedido &&
      !operarioTexto &&
      !fecha &&
      !ean &&
      !coordinador &&
      !supernumerario &&
      !proceso
    )
      return {
        success: false,
        message:
          "Usa al menos un filtro para buscar: pedido, operario, fecha, coordinador, supernumerario, proceso o EAN.",
      };

    // Sin cedula_operario: el frontend nunca la lee y el filtro por operario
    // es por nombre, así que no hace falta exponerla en el response.
    let sql =
      "SELECT id, numero_pedido AS pedido, fecha, coordinador, operario, " +
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
      // Las dos formas del EAN: el preamble UPC-A del escáner Zebra antepone
      // un "0", y en D1 puede estar guardada cualquiera de las dos.
      const [eanA, eanB] = _formasEan(ean);
      sql += " AND ean IN (?, ?)";
      binds.push(eanA, eanB);
    }
    if (operarioTexto) {
      sql += " AND " + _sqlContiene("operario");
      binds.push(_normalizarTexto(operarioTexto));
    }
    if (fecha) {
      sql += " AND fecha = ?";
      binds.push(fecha);
    }
    if (coordinador) {
      sql += " AND lower(coordinador) = lower(?)";
      binds.push(coordinador);
    }
    if (supernumerario) {
      sql += " AND lower(supernumerario) = lower(?)";
      binds.push(supernumerario);
    }
    if (proceso) {
      sql += " AND " + _sqlContiene("proceso");
      binds.push(_normalizarTexto(proceso));
    }
    sql += " ORDER BY fecha DESC, hora_inicio ASC, id DESC";
    if (!pedido) sql += " LIMIT 100";

    const { results } = await env.DB.prepare(sql)
      .bind(...binds)
      .all();

    return { success: true, registros: results };
  },

  async obtenerSeguimientoPaquetes(datos, env) {
    const REF = _sqlEanReferente("");
    const { results } = await env.DB.prepare(
      "SELECT ve.numero_pedido AS pedido, ve.subLinea AS subLinea, " +
        "ve.unidadesTotales AS unidadesTotales, ve.unidadesProcesadas AS unidadesProcesadas, " +
        "ve.codigosSobrantes AS codigosSobrantes, ve.nReferentes AS nReferentes, " +
        "ve.eanesAbiertos AS eanesAbiertos, " +
        "COALESCE(js.justificado, 0) AS justificado, " +
        "COALESCE(rg.horasTotales,0) AS horasTotales, " +
        "COALESCE(rg.sumaUnidadesPorTiempo,0) AS sumaUnidadesPorTiempo, " +
        "COALESCE(rg.unidadesConEstandar,0) AS unidadesConEstandar, " +
        "COALESCE(pf.fecha, '') AS fecha " +
        "FROM (" +
        "SELECT numero_pedido, GROUP_CONCAT(DISTINCT sublinea) AS subLinea, " +
        // Cifras y estado solo de los EAN referentes (ver _sqlEanReferente).
        // nReferentes = 0: pedido de trabajo indirecto, nunca cierra.
        "SUM(CASE WHEN " + REF + " THEN unidades_totales ELSE 0 END) AS unidadesTotales, " +
        "SUM(CASE WHEN " + REF + " THEN unidades_procesadas ELSE 0 END) AS unidadesProcesadas, " +
        "SUM(CASE WHEN " + REF + " THEN codigos_sobrantes ELSE 0 END) AS codigosSobrantes, " +
        "SUM(CASE WHEN " + REF + " THEN 1 ELSE 0 END) AS nReferentes, " +
        "SUM(CASE WHEN " + REF + " AND COALESCE(estado, '') <> 'Completado' THEN 1 ELSE 0 END) AS eanesAbiertos " +
        "FROM validacion_eanes GROUP BY numero_pedido" +
        ") ve " +
        "LEFT JOIN (" +
        "SELECT pedido, SUM(faltante) AS justificado FROM justificaciones GROUP BY pedido" +
        ") js ON js.pedido = ve.numero_pedido " +
        "LEFT JOIN (" +
        "SELECT r.numero_pedido, SUM(r.tiempo_total) AS horasTotales, " +
        "SUM(r.tiempo_total * r.unidades_hora_estandar) AS sumaUnidadesPorTiempo, " +
        // Numerador de la eficiencia: solo unidades con estándar, las mismas
        // filas que suman tiempo esperado (ver _datosSeguimientoPedido).
        "SUM(CASE WHEN r.unidades_hora_estandar > 0 THEN r.unidades_procesadas_operario ELSE 0 END) AS unidadesConEstandar " +
        "FROM registros r WHERE r.anulado = 0 AND " +
        _sqlRegistroReferente("r") +
        " GROUP BY r.numero_pedido" +
        ") rg ON rg.numero_pedido = ve.numero_pedido " +
        // Mismo criterio que la hoja "Seguimiento paquetes": la fecha más
        // antigua del pedido entre sus sublíneas, ignorando celdas vacías.
        "LEFT JOIN (" +
        "SELECT numero_pedido, MIN(fecha) AS fecha FROM pedidos " +
        "WHERE fecha <> '' GROUP BY numero_pedido" +
        ") pf ON pf.numero_pedido = ve.numero_pedido " +
        "ORDER BY ve.numero_pedido",
    ).all();

    const paquetes = results.map((r) => {
      const unidadesConSobrantes = r.unidadesProcesadas + r.codigosSobrantes;
      // Cerrado = mismo criterio que _pedidoEstaCompleto: tiene EAN referentes
      // y todos están en Completado. Etiquetas iguales a las de la hoja.
      // sinLimite y soloSinLimite significan ahora "sin EAN referentes": el
      // frontend oculta esos pedidos y no les ofrece Justificar.
      const sinReferentes = r.nReferentes === 0;
      const cerrado = !sinReferentes && r.eanesAbiertos === 0;
      let estado;
      if (cerrado) estado = r.justificado > 0 ? "No cumple" : "Cumple";
      else if (unidadesConSobrantes > 0) estado = "En proceso";
      else estado = "Pendiente";

      const noIniciado = estado === "Pendiente";
      return {
        fecha: r.fecha,
        pedido: r.pedido,
        subLinea: r.subLinea,
        unidadesTotales: r.unidadesTotales,
        unidadesProcesadas: r.unidadesProcesadas,
        // Cerrado por justificación: lo que faltó, igual que en la hoja.
        unidadesPendientes: sinReferentes
          ? null
          : estado === "No cumple"
            ? r.justificado
            : r.unidadesTotales - r.unidadesProcesadas,
        cerrado,
        sinLimite: sinReferentes,
        soloSinLimite: sinReferentes,
        estado,
        horasTotales: noIniciado
          ? null
          : Math.round(r.horasTotales * 100) / 100,
        eficiencia:
          noIniciado || r.sumaUnidadesPorTiempo <= 0
            ? null
            : Math.round(
                (r.unidadesConEstandar / r.sumaUnidadesPorTiempo) * 100,
              ),
      };
    });

    return { success: true, paquetes };
  },

  // Detalle de un pedido en Seguimiento: una fila por EAN. registros.ean es
  // el ean_producto canónico (submitRegistro lo toma de _localizarValidacionEan),
  // así que el cruce por igualdad exacta no sufre con el "0" del Zebra.
  async obtenerDetalleSeguimientoPedido(datos, env) {
    const pedido = await _resolverPedido(env, datos.pedido);
    if (!pedido)
      return { success: false, message: "Falta el número de pedido." };

    const { results } = await env.DB.prepare(
      "SELECT v.ean_producto AS ean, v.sublinea AS subLinea, v.estado AS estado, " +
        "v.unidades_totales AS unidadesTotales, v.unidades_procesadas AS unidadesProcesadas, " +
        "v.codigos_sobrantes AS codigosSobrantes, v.sin_limite AS sinLimite, " +
        "CASE WHEN " + _sqlEanReferente("v.") + " THEN 1 ELSE 0 END AS referente, " +
        "COALESCE(js.justificado, 0) AS justificado, " +
        "COALESCE(rg.nRegistros, 0) AS nRegistros, rg.supernumerarios AS supernumerarios, " +
        "COALESCE(rg.horasTotales, 0) AS horasTotales, " +
        "COALESCE(rg.sumaUnidadesPorTiempo, 0) AS sumaUnidadesPorTiempo, " +
        "COALESCE(rg.unidadesConEstandar, 0) AS unidadesConEstandar " +
        "FROM validacion_eanes v " +
        "LEFT JOIN (" +
        "SELECT ean, SUM(faltante) AS justificado FROM justificaciones " +
        "WHERE pedido = ? GROUP BY ean" +
        ") js ON js.ean = v.ean_producto " +
        "LEFT JOIN (" +
        "SELECT ean, COUNT(*) AS nRegistros, " +
        "GROUP_CONCAT(DISTINCT supernumerario) AS supernumerarios, " +
        "SUM(tiempo_total) AS horasTotales, " +
        "SUM(tiempo_total * unidades_hora_estandar) AS sumaUnidadesPorTiempo, " +
        "SUM(CASE WHEN unidades_hora_estandar > 0 THEN unidades_procesadas_operario ELSE 0 END) AS unidadesConEstandar " +
        "FROM registros WHERE numero_pedido = ? AND anulado = 0 GROUP BY ean" +
        ") rg ON rg.ean = v.ean_producto " +
        "WHERE v.numero_pedido = ? ORDER BY v.sublinea, v.ean_producto",
    )
      .bind(pedido, pedido, pedido)
      .all();

    // GROUP_CONCAT(DISTINCT ...) no acepta separador propio: sale con ",".
    const _listaSupers = (texto) =>
      String(texto || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const supersPedido = new Set();

    const eanes = results.map((r) => {
      const sinLimite = r.sinLimite === 1;
      const conSobrantes = r.unidadesProcesadas + r.codigosSobrantes;
      // EAN nuevo desde el pull llega con estado NULL (ver _pedidoEstaCompleto).
      const estado =
        r.estado || (conSobrantes > 0 ? "En proceso" : "Pendiente");
      const supers = _listaSupers(r.supernumerarios);
      supers.forEach((s) => supersPedido.add(s));
      const sinRegistros = r.nRegistros === 0;
      return {
        ean: r.ean,
        subLinea: r.subLinea,
        estado,
        supernumerarios: supers,
        unidadesTotales: r.unidadesTotales,
        unidadesProcesadas: r.unidadesProcesadas,
        sinLimite,
        referente: r.referente === 1,
        // Mismo criterio que el pedido: cerrado por justificación = lo que faltó.
        unidadesPendientes: sinLimite
          ? null
          : estado === "Completado" && r.justificado > 0
            ? r.justificado
            : r.unidadesTotales - r.unidadesProcesadas,
        horasTotales: sinRegistros
          ? null
          : Math.round(r.horasTotales * 100) / 100,
        eficiencia:
          sinRegistros || r.sumaUnidadesPorTiempo <= 0
            ? null
            : Math.round(
                (r.unidadesConEstandar / r.sumaUnidadesPorTiempo) * 100,
              ),
      };
    });

    return {
      success: true,
      pedido,
      eanes,
      supernumerariosPedido: [...supersPedido].sort((a, b) =>
        a.localeCompare(b, "es"),
      ),
    };
  },

  async obtenerControlTiempos(datos, env) {
    const esAdmin = datos.admin === true;
    const cedula = String(datos.cedula || "").trim();
    if (!cedula && !esAdmin)
      return { success: false, message: "Falta la cédula." };

    // El histórico (últimos 100) es solo del operario: el administrador ve
    // registros sin tope, así que siempre filtra por fecha.
    const filtro =
      !esAdmin && datos.filtro === "historico" ? "historico" : "fecha";
    const hoy = _fechaHoyBogota();
    let fechaFiltro = hoy;
    if (filtro === "fecha") {
      const valor = String(datos.fecha || "").trim();
      if (valor) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
          return {
            success: false,
            message: "La fecha no tiene un formato válido.",
          };
        }
        if (valor > hoy) {
          return { success: false, message: "No se permiten fechas futuras." };
        }
        fechaFiltro = valor;
      }
    }

    const pedidoTexto = String(datos.pedido || "").trim();
    const pedido = pedidoTexto ? await _resolverPedido(env, pedidoTexto) : "";

    let sql =
      "SELECT fecha, coordinador, operario, supernumerario, numero_pedido AS pedido, " +
      "cliente, proceso, ean, unidades_procesadas_operario AS unidadesProcesadas, eficiencia, " +
      "suplemento, " +
      "unidades_hora_estandar AS unidadesHoraEstandar, hora_inicio AS horaInicio, " +
      "hora_final AS horaFinal, anulado " +
      "FROM registros WHERE 1 = 1";
    const binds = [];

    if (cedula) {
      sql += " AND cedula_operario = ?";
      binds.push(cedula);
    }
    if (filtro === "fecha") {
      sql += " AND fecha = ?";
      binds.push(fechaFiltro);
    }
    if (pedido) {
      sql += " AND numero_pedido = ?";
      binds.push(pedido);
    }
    // Pedido y proceso los usan las dos vistas; el resto es solo administrador.
    const proceso = String(datos.proceso || "").trim();
    if (proceso) {
      sql += " AND " + _sqlContiene("proceso");
      binds.push(_normalizarTexto(proceso));
    }

    // Filtros exclusivos de la vista administrador.
    if (esAdmin) {
      const coordinador = String(datos.coordinador || "").trim();
      if (coordinador) {
        sql += " AND lower(coordinador) = lower(?)";
        binds.push(coordinador);
      }
      const supernumerario = String(datos.supernumerario || "").trim();
      if (supernumerario) {
        sql += " AND lower(supernumerario) = lower(?)";
        binds.push(supernumerario);
      }
      const operario = String(datos.operario || "").trim();
      if (operario) {
        sql += " AND " + _sqlContiene("operario");
        binds.push(_normalizarTexto(operario));
      }
      const cliente = String(datos.cliente || "").trim();
      if (cliente) {
        sql += " AND " + _sqlContiene("cliente");
        binds.push(_normalizarTexto(cliente));
      }
      // Las dos formas del EAN: el preamble UPC-A del escáner Zebra antepone
      // un "0", y en D1 puede estar guardada cualquiera de las dos.
      const eanTexto = String(datos.ean || "").trim();
      if (eanTexto) {
        const [eanA, eanB] = _formasEan(eanTexto);
        sql += " AND ean IN (?, ?)";
        binds.push(eanA, eanB);
      }
    }

    sql += " ORDER BY fecha DESC, hora_inicio DESC, id DESC";
    // Sin tope en administrador: la vista del operario conserva el LIMIT 100.
    if (!esAdmin) sql += " LIMIT 100";

    const { results } = await env.DB.prepare(sql)
      .bind(...binds)
      .all();

    const registros = results.map((r) => ({
      fecha: r.fecha,
      coordinador: r.coordinador,
      operario: r.operario,
      supernumerario: r.supernumerario,
      pedido: r.pedido,
      cliente: r.cliente,
      proceso: r.proceso,
      ean: r.ean,
      unidadesProcesadas: r.unidadesProcesadas,
      suplemento: r.suplemento || 0,
      eficiencia: r.unidadesHoraEstandar > 0 ? r.eficiencia : null,
      horaInicio: r.horaInicio,
      horaFinal: r.horaFinal,
      anulado: !!r.anulado,
    }));

    return { success: true, registros };
  },
};

// Equivalente a _obtenerDetalleEanesPedido de code.js — una consulta SQL en vez de recorrer la hoja.
async function _detalleEanesPedido(env, pedido) {
  const { results } = await env.DB.prepare(
    "SELECT ean_producto AS ean, unidades_totales AS esperadas, unidades_procesadas AS procesadas, " +
      "codigos_sobrantes AS sobrantes, estado, sin_limite AS sinLimite, " +
      "CASE WHEN " + _sqlEanReferente("v.") + " THEN 1 ELSE 0 END AS referente, " +
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
    restanteNeto: r.sinLimite
      ? null
      : r.esperadas - r.procesadas - r.justificado - r.sobrantes,
    sinLimite: r.sinLimite === 1,
    referente: r.referente === 1,
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

// D1 limita los patrones LIKE a 50 bytes: un nombre de proceso largo con
// los dos "%" lo supera y la consulta falla. instr() no tiene ese tope y
// tampoco interpreta "%" ni "_" dentro del texto buscado.
function _sqlContiene(columna) {
  return "instr(" + _sqlSinTildes(columna) + ", ?) > 0";
}
