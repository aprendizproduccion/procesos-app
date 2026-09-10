import {
  _huellaPayload,
  _chequearIdempotencia,
  _confirmarIdempotencia,
  _liberarIdempotencia,
  _validarSupervisorYSupernumerario,
  _localizarValidacionEan,
  _obtenerDatosPedido,
  _obtenerProcesoValidado,
  _buscarCedulaPorNombre,
  _calcularDuracionValidada,
  _calcularMetricasProduccion,
  _validarCodigosSobrantes,
  _marcarPedidoIniciado,
  _pedidoEstaCompleto,
  _fechaHoyBogota,
  _ahoraISO,
  _revertirReserva,
  _revertirCierre,
  _recalcularContadorValidacion,
  _sincronizarEstadoPedido,
} from "./d1-negocio.js";

import {
  _pushRegistrosYMarcar,
  _pushJustificacionYMarcar,
  _pushFilaRegistroYMarcar,
  _eliminarFilaRegistroSheets,
} from "./push-sheets.js";

export const accionesEscritura = {
  async submitRegistro(payload, env, ctx) {
    const huella = await _huellaPayload("submitRegistro", payload);
    const chequeo = await _chequearIdempotencia(env, huella);
    if (chequeo.duplicado) return chequeo.respuesta;
    if (chequeo.enProceso) {
      return {
        success: false,
        message:
          "Este registro ya se está procesando (posible doble envío). Espera unos segundos y verifica en Registros antes de reintentar.",
      };
    }

    let reservaAplicada = null;

    try {
      const pedido = String(payload.pedido || "").trim();
      if (!pedido) throw new Error("Falta el número de pedido.");

      let codigoEan = String(payload.codigoEan || "").trim();
      if (!codigoEan)
        throw new Error("Falta escanear el código EAN del producto.");

      const { coordinador, supernumerario } =
        await _validarSupervisorYSupernumerario(
          env,
          String(payload.coordinador || "").trim(),
          String(payload.supernumerario || "").trim(),
        );

      const observaciones = String(payload.observaciones || "").trim();
      const operarios = (payload.operarios || [])
        .map((n) => String(n).trim())
        .filter(Boolean);
      const n = operarios.length;
      if (n === 0) throw new Error("Debes agregar al menos un operario.");

      const total = Number(payload.totalUnidades);
      if (!Number.isFinite(total) || total < 0)
        throw new Error("Total de unidades inválido.");

      const validacion = await _localizarValidacionEan(env, pedido, codigoEan);
      // De aquí en adelante se usa el EAN tal como quedó en D1 (ean_producto),
      // no el crudo del escáner — evita que el "0" del preamble UPC-A rompa
      // la reserva/INSERT si el catálogo tiene la otra forma.
      codigoEan = validacion.ean_producto;
      const unidadesEsperadas = validacion.unidades_totales;
      const sublinea = validacion.sublinea;
      const datosPedido = await _obtenerDatosPedido(env, pedido, sublinea);

      const codigosSobrantes = _validarCodigosSobrantes(
        payload.codigosSobrantes,
      );
      const restantes =
        unidadesEsperadas -
        validacion.unidades_procesadas -
        validacion.justificado -
        validacion.codigos_sobrantes;

      if (total + codigosSobrantes > restantes) {
        throw new Error(
          "La cantidad ingresada (" +
            total +
            (codigosSobrantes > 0
              ? " unidades + " + codigosSobrantes + " códigos sobrantes"
              : " unidades") +
            ") supera lo que falta del pedido (" +
            restantes +
            " de " +
            unidadesEsperadas +
            " totales). Verifica antes de continuar.",
        );
      }

      const suplementoMin = Number(payload.suplementoMin) || 0;

      const { duracionBrutaMin, duracionRealMin } = _calcularDuracionValidada(
        payload.horaInicio,
        payload.horaFin,
        suplementoMin,
      );
      const procesoValidado = await _obtenerProcesoValidado(
        env,
        payload.proceso,
        pedido,
      );
      const tasaEstandar = procesoValidado.unidadesHora;
      const loteId = crypto.randomUUID();
      const fecha = _fechaHoyBogota();
      const ahora = _ahoraISO();

      const unidadesPorOperario = Math.round((total / n) * 100) / 100;
      const codigosSobrantesPorOperario =
        Math.round((codigosSobrantes / n) * 100) / 100;
      const durHoras = Math.round((duracionRealMin / 60) * 100) / 100;
      const { unidadesHoraReal, eficiencia } = _calcularMetricasProduccion(
        unidadesPorOperario,
        n > 0 ? tasaEstandar / n : 0,
        durHoras,
      );

      await _marcarPedidoIniciado(env, pedido, ahora);

      // UPDATE atómico: reemplaza el LockService consolidado del Apps Script original.
      const reserva = await env.DB.prepare(
        "UPDATE validacion_eanes SET " +
          "unidades_procesadas = unidades_procesadas + ?, " +
          "codigos_sobrantes = codigos_sobrantes + ?, " +
          "estado = CASE WHEN (unidades_procesadas + ? + codigos_sobrantes + ?) >= unidades_totales THEN 'Completado' ELSE 'En proceso' END, " +
          "actualizado_en = ? " +
          "WHERE numero_pedido = ? AND ean_producto = ? " +
          "AND (unidades_procesadas + ? + codigos_sobrantes + ? + " +
          "(SELECT COALESCE(SUM(faltante),0) FROM justificaciones WHERE pedido = ? AND ean = ?)) <= unidades_totales",
      )
        .bind(
          total,
          codigosSobrantes,
          total,
          codigosSobrantes,
          ahora,
          pedido,
          codigoEan,
          total,
          codigosSobrantes,
          pedido,
          codigoEan,
        )
        .run();

      if (reserva.meta.changes === 0) {
        throw new Error(
          "Otro envío concurrente ya ocupó estas unidades. Verifica el estado actual del pedido antes de reintentar.",
        );
      }
      // A partir de aquí, si algo falla, hay que revertir esta reserva antes de fallar.
      reservaAplicada = { pedido, ean: codigoEan, total, codigosSobrantes };

      // Lista de operarios — informativa, best-effort (ver nota de diseño de la sesión anterior).
      const filaOperarios = await env.DB.prepare(
        "SELECT operarios FROM validacion_eanes WHERE numero_pedido = ? AND ean_producto = ?",
      )
        .bind(pedido, codigoEan)
        .first();
      const listaActual = (filaOperarios.operarios || "")
        .split(" - ")
        .map((s) => s.trim())
        .filter(Boolean);
      operarios.forEach((nom) => {
        if (!listaActual.includes(nom)) listaActual.push(nom);
      });
      await env.DB.prepare(
        "UPDATE validacion_eanes SET operarios = ? WHERE numero_pedido = ? AND ean_producto = ?",
      )
        .bind(listaActual.join(" - "), pedido, codigoEan)
        .run();

      const cedulas = await Promise.all(
        operarios.map((nom) => _buscarCedulaPorNombre(env, nom)),
      );

      const statements = operarios.map((nombre, i) =>
        env.DB.prepare(
          "INSERT INTO registros (lote_id, fecha, coordinador, cedula_operario, operario, supernumerario, cliente, " +
            "proceso, unidades_hora_estandar, sublinea, evento, numero_pedido, ean, unidades_totales_procesadas, " +
            "hora_inicio, hora_final, suplemento, observacion, clasificacion_proceso, duracion_bruta_min, tiempo_total, " +
            "unidades_procesadas_operario, codigos_sobrantes, unidades_hora_real, eficiencia, creado_en) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          loteId,
          fecha,
          coordinador,
          cedulas[i],
          nombre,
          supernumerario,
          datosPedido.cliente,
          procesoValidado.nombre,
          tasaEstandar,
          sublinea,
          datosPedido.evento,
          pedido,
          codigoEan,
          total,
          payload.horaInicio,
          payload.horaFin,
          suplementoMin,
          observaciones,
          datosPedido.clasificacionProceso,
          duracionBrutaMin,
          durHoras,
          unidadesPorOperario,
          codigosSobrantesPorOperario,
          unidadesHoraReal,
          eficiencia,
          ahora,
        ),
      );

      if (await _pedidoEstaCompleto(env, pedido)) {
        statements.push(
          env.DB.prepare(
            "INSERT INTO control_produccion (numero_pedido, estado, actualizado_en) VALUES (?, 'Completado', ?) " +
              "ON CONFLICT(numero_pedido) DO UPDATE SET estado = 'Completado', actualizado_en = excluded.actualizado_en",
          ).bind(pedido, ahora),
        );
      }

      const filasParaSheets = operarios.map((nombre, i) => [
        loteId,
        fecha,
        coordinador,
        cedulas[i],
        nombre,
        supernumerario,
        datosPedido.cliente,
        procesoValidado.nombre,
        tasaEstandar,
        sublinea,
        datosPedido.evento,
        pedido,
        codigoEan,
        total,
        payload.horaInicio,
        payload.horaFin,
        suplementoMin,
        observaciones,
        duracionBrutaMin,
        datosPedido.clasificacionProceso,
        durHoras,
        unidadesPorOperario,
        unidadesHoraReal,
        eficiencia,
      ]);

      const resultadosBatch = await env.DB.batch(statements);
      const respuestaFinal = { success: true, loteId };

      // A partir de aquí D1 ya tiene el estado correcto — cualquier fallo de acá
      // en adelante NO debe liberar la idempotencia ni fallarle al usuario.
      try {
        await _confirmarIdempotencia(env, huella, respuestaFinal);
        const idsRegistros = resultadosBatch
          .slice(0, operarios.length)
          .map((r) => r.meta.last_row_id);
        const filasParaSheetsConId = filasParaSheets.map((fila, i) => [
          ...fila,
          idsRegistros[i],
        ]);
        ctx.waitUntil(
          _pushRegistrosYMarcar(env, idsRegistros, filasParaSheetsConId),
        );
      } catch (errPostCommit) {
        // No relanzamos: el registro ya es válido en D1. Queda sin push
        // inmediato, pero la reconciliación periódica lo recoge.
      }

      return respuestaFinal;
    } catch (err) {
      if (reservaAplicada) {
        await _revertirReserva(env, reservaAplicada);
      }
      await _liberarIdempotencia(env, huella);
      throw err;
    }
  },

  async submitRegistroOperario(payload, env, ctx) {
    const huella = await _huellaPayload("submitRegistroOperario", payload);
    const chequeo = await _chequearIdempotencia(env, huella);
    if (chequeo.duplicado) return chequeo.respuesta;
    if (chequeo.enProceso) {
      return {
        success: false,
        message:
          "Este registro ya se está procesando (posible doble envío). Espera unos segundos y verifica en Registros antes de reintentar.",
      };
    }

    let reservaAplicada = null;

    try {
      const cedula = String(payload.cedula || "").trim();
      if (!cedula) throw new Error("Falta la cédula del operario.");

      const operarioMatch = await env.DB.prepare(
        "SELECT nombre_operario AS nombre, cedula FROM operarios WHERE cedula = ? AND activo = 1",
      )
        .bind(cedula)
        .first();
      if (!operarioMatch)
        throw new Error(
          'La cédula "' + cedula + '" no existe en el catálogo de Operarios.',
        );

      const { coordinador, supernumerario } =
        await _validarSupervisorYSupernumerario(
          env,
          String(payload.coordinador || "").trim(),
          String(payload.supernumerario || "").trim(),
        );

      const pedido = String(payload.pedido || "").trim();
      if (!pedido) throw new Error("Falta el número de pedido.");
      let codigoEan = String(payload.codigoEan || "").trim();
      if (!codigoEan)
        throw new Error("Falta escanear el código EAN del producto.");

      const total = Number(payload.unidadesProcesadas);
      if (!Number.isFinite(total) || total < 0)
        throw new Error("Unidades procesadas inválidas.");

      const validacion = await _localizarValidacionEan(env, pedido, codigoEan);
      codigoEan = validacion.ean_producto;
      const unidadesEsperadas = validacion.unidades_totales;
      const sublinea = validacion.sublinea;
      const datosPedido = await _obtenerDatosPedido(env, pedido, sublinea);

      const codigosSobrantes = _validarCodigosSobrantes(
        payload.codigosSobrantes,
      );
      const restantes =
        unidadesEsperadas -
        validacion.unidades_procesadas -
        validacion.justificado -
        validacion.codigos_sobrantes;
      if (total + codigosSobrantes > restantes) {
        throw new Error(
          "La cantidad ingresada (" +
            total +
            (codigosSobrantes > 0
              ? " unidades + " + codigosSobrantes + " sobrantes"
              : " unidades") +
            ") no corresponde con lo disponible de este pedido",
        );
      }

      const procesoValidado = await _obtenerProcesoValidado(
        env,
        payload.proceso,
        pedido,
      );
      const tasaEstandar = procesoValidado.unidadesHora;
      const suplementoMin = Number(payload.suplementoMin) || 0;
      const fecha = _fechaHoyBogota();
      const horaInicio = String(payload.horaInicio || "").trim();
      const horaFin = String(payload.horaFin || "").trim();
      const { duracionBrutaMin, duracionRealMin } = _calcularDuracionValidada(
        horaInicio,
        horaFin,
        suplementoMin,
      );

      const observaciones = String(payload.observaciones || "").trim();
      const loteId = crypto.randomUUID();
      const ahora = _ahoraISO();
      const durHoras = Math.round((duracionRealMin / 60) * 100) / 100;
      const { unidadesHoraReal, eficiencia } = _calcularMetricasProduccion(
        total,
        tasaEstandar,
        durHoras,
      );

      await _marcarPedidoIniciado(env, pedido, ahora);

      const reserva = await env.DB.prepare(
        "UPDATE validacion_eanes SET " +
          "unidades_procesadas = unidades_procesadas + ?, " +
          "codigos_sobrantes = codigos_sobrantes + ?, " +
          "estado = CASE WHEN (unidades_procesadas + ? + codigos_sobrantes + ?) >= unidades_totales THEN 'Completado' ELSE 'En proceso' END, " +
          "actualizado_en = ? " +
          "WHERE numero_pedido = ? AND ean_producto = ? " +
          "AND (unidades_procesadas + ? + codigos_sobrantes + ? + " +
          "(SELECT COALESCE(SUM(faltante),0) FROM justificaciones WHERE pedido = ? AND ean = ?)) <= unidades_totales",
      )
        .bind(
          total,
          codigosSobrantes,
          total,
          codigosSobrantes,
          ahora,
          pedido,
          codigoEan,
          total,
          codigosSobrantes,
          pedido,
          codigoEan,
        )
        .run();

      if (reserva.meta.changes === 0) {
        throw new Error(
          "Otro envío concurrente ya ocupó estas unidades. Verifica el estado actual del pedido antes de reintentar.",
        );
      }
      // A partir de aquí, si algo falla, hay que revertir esta reserva antes de fallar.
      reservaAplicada = { pedido, ean: codigoEan, total, codigosSobrantes };

      const filaOperarios = await env.DB.prepare(
        "SELECT operarios FROM validacion_eanes WHERE numero_pedido = ? AND ean_producto = ?",
      )
        .bind(pedido, codigoEan)
        .first();
      const listaActual = (filaOperarios.operarios || "")
        .split(" - ")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!listaActual.includes(operarioMatch.nombre))
        listaActual.push(operarioMatch.nombre);
      await env.DB.prepare(
        "UPDATE validacion_eanes SET operarios = ? WHERE numero_pedido = ? AND ean_producto = ?",
      )
        .bind(listaActual.join(" - "), pedido, codigoEan)
        .run();

      const statements = [
        env.DB.prepare(
          "INSERT INTO registros (lote_id, fecha, coordinador, cedula_operario, operario, supernumerario, cliente, " +
            "proceso, unidades_hora_estandar, sublinea, evento, numero_pedido, ean, unidades_totales_procesadas, " +
            "hora_inicio, hora_final, suplemento, observacion, clasificacion_proceso, duracion_bruta_min, tiempo_total, " +
            "unidades_procesadas_operario, codigos_sobrantes, unidades_hora_real, eficiencia, creado_en) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          loteId,
          fecha,
          coordinador,
          operarioMatch.cedula,
          operarioMatch.nombre,
          supernumerario,
          datosPedido.cliente,
          procesoValidado.nombre,
          tasaEstandar,
          sublinea,
          datosPedido.evento,
          pedido,
          codigoEan,
          total,
          horaInicio,
          horaFin,
          suplementoMin,
          observaciones,
          datosPedido.clasificacionProceso,
          duracionBrutaMin,
          durHoras,
          total,
          codigosSobrantes,
          unidadesHoraReal,
          eficiencia,
          ahora,
        ),
      ];

      if (await _pedidoEstaCompleto(env, pedido)) {
        statements.push(
          env.DB.prepare(
            "INSERT INTO control_produccion (numero_pedido, estado, actualizado_en) VALUES (?, 'Completado', ?) " +
              "ON CONFLICT(numero_pedido) DO UPDATE SET estado = 'Completado', actualizado_en = excluded.actualizado_en",
          ).bind(pedido, ahora),
        );
      }

      const filaParaSheets = [
        loteId,
        fecha,
        coordinador,
        operarioMatch.cedula,
        operarioMatch.nombre,
        supernumerario,
        datosPedido.cliente,
        procesoValidado.nombre,
        tasaEstandar,
        sublinea,
        datosPedido.evento,
        pedido,
        codigoEan,
        total,
        horaInicio,
        horaFin,
        suplementoMin,
        observaciones,
        duracionBrutaMin,
        datosPedido.clasificacionProceso,
        durHoras,
        total,
        unidadesHoraReal,
        eficiencia,
      ];

      const resultadosBatch = await env.DB.batch(statements);
      const respuestaFinal = { success: true, loteId, horaInicio, horaFin };

      try {
        await _confirmarIdempotencia(env, huella, respuestaFinal);
        const idRegistro = resultadosBatch[0].meta.last_row_id;
        ctx.waitUntil(
          _pushRegistrosYMarcar(
            env,
            [idRegistro],
            [[...filaParaSheets, idRegistro]],
          ),
        );
      } catch (errPostCommit) {
        // No relanzamos: el registro ya es válido en D1.
      }

      return respuestaFinal;
    } catch (err) {
      if (reservaAplicada) {
        await _revertirReserva(env, reservaAplicada);
      }
      await _liberarIdempotencia(env, huella);
      throw err;
    }
  },

  async guardarJustificacion(payload, env, ctx) {
    const huella = await _huellaPayload("guardarJustificacion", payload);
    const chequeo = await _chequearIdempotencia(env, huella);
    if (chequeo.duplicado) return chequeo.respuesta;
    if (chequeo.enProceso) {
      return {
        success: false,
        message:
          "Esta justificación ya se está procesando (posible doble envío). Espera unos segundos y verifica antes de reintentar.",
      };
    }

    let cierreAplicado = null;

    try {
      const pedido = String(payload.pedido || "").trim();
      let ean = String(payload.ean || "").trim();
      const motivo = String(payload.motivo || "").trim();
      const unidadesAJustificar = Number(payload.unidadesAJustificar);
      const supernumerario = String(payload.supernumerario || "").trim();

      if (!pedido) throw new Error("Falta el número de pedido.");
      if (!ean) throw new Error("Falta el código EAN.");
      if (!motivo) throw new Error("Debes escribir el motivo de la novedad.");
      if (!Number.isFinite(unidadesAJustificar) || unidadesAJustificar <= 0) {
        throw new Error("Las unidades a justificar deben ser mayores a cero.");
      }
      if (!supernumerario)
        throw new Error("Falta el nombre del supernumerario.");

      // Chequeo informativo previo, para un mensaje de error claro.
      // La autoridad real es el UPDATE atómico de abajo, que vuelve a leer en frío.
      const validacion = await _localizarValidacionEan(env, pedido, ean);
      ean = validacion.ean_producto;
      const restanteNeto =
        validacion.unidades_totales -
        validacion.unidades_procesadas -
        validacion.justificado -
        validacion.codigos_sobrantes;

      if (restanteNeto <= 0) {
        throw new Error(
          "Este EAN ya no tiene faltante pendiente por justificar.",
        );
      }
      if (unidadesAJustificar !== restanteNeto) {
        throw new Error(
          "Debes justificar exactamente " +
            restanteNeto +
            " unidades (el faltante total de este EAN) para poder cerrarlo. Ni más ni menos.",
        );
      }

      const ahora = _ahoraISO();
      const hoy = _fechaHoyBogota();

      // UPDATE atómico: cierra el EAN solo si el faltante fresco sigue coincidiendo
      // exactamente en este instante. Esto es lo que cierra el hueco de concurrencia
      // que había quedado pendiente en el Apps Script original.
      const cierre = await env.DB.prepare(
        "UPDATE validacion_eanes SET estado = 'Completado', actualizado_en = ? " +
          "WHERE numero_pedido = ? AND ean_producto = ? " +
          "AND (unidades_totales - unidades_procesadas - codigos_sobrantes - " +
          "(SELECT COALESCE(SUM(faltante),0) FROM justificaciones WHERE pedido = ? AND ean = ?)) = ?",
      )
        .bind(ahora, pedido, ean, pedido, ean, unidadesAJustificar)
        .run();

      if (cierre.meta.changes === 0) {
        throw new Error(
          "El estado de este EAN cambió justo antes de confirmar. Verifica el faltante actual antes de reintentar.",
        );
      }
      cierreAplicado = { pedido, ean };

      const statements = [
        env.DB.prepare(
          "INSERT INTO justificaciones (fecha, supernumerario, pedido, ean, faltante, motivo, creado_en) VALUES (?,?,?,?,?,?,?)",
        ).bind(
          hoy,
          supernumerario,
          pedido,
          ean,
          unidadesAJustificar,
          motivo,
          ahora,
        ),
      ];

      const pedidoCompleto = await _pedidoEstaCompleto(env, pedido);
      if (pedidoCompleto) {
        statements.push(
          env.DB.prepare(
            "INSERT INTO control_produccion (numero_pedido, estado, actualizado_en) VALUES (?, 'Completado', ?) " +
              "ON CONFLICT(numero_pedido) DO UPDATE SET estado = 'Completado', actualizado_en = excluded.actualizado_en",
          ).bind(pedido, ahora),
        );
      }

      const resultadosBatch = await env.DB.batch(statements);
      const respuestaFinal = { success: true, pedidoCompleto };

      try {
        await _confirmarIdempotencia(env, huella, respuestaFinal);
        ctx.waitUntil(
          _pushJustificacionYMarcar(env, resultadosBatch[0].meta.last_row_id, [
            hoy,
            supernumerario,
            pedido,
            ean,
            unidadesAJustificar,
            motivo,
          ]),
        );
      } catch (errPostCommit) {
        // No relanzamos: la justificación ya quedó registrada en D1.
      }

      return respuestaFinal;
    } catch (err) {
      if (cierreAplicado) {
        await _revertirCierre(env, cierreAplicado.pedido, cierreAplicado.ean);
      }
      await _liberarIdempotencia(env, huella);
      throw err;
    }
  },

  async editarRegistro(payload, env, ctx) {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error("Falta el ID del registro a editar.");

    const motivo = String(payload.motivo || "").trim();
    if (!motivo) throw new Error("Debes indicar el motivo de la edición.");

    const editadoPor = String(payload.editadoPor || "").trim();
    if (!editadoPor) throw new Error("Falta el nombre de quien edita.");

    const actual = await env.DB.prepare(
      "SELECT numero_pedido, ean FROM registros WHERE id = ? AND anulado = 0",
    )
      .bind(id)
      .first();
    if (!actual)
      throw new Error(
        "El registro no existe o ya fue anulado. Actualiza la lista e intenta de nuevo.",
      );

    const pedido = actual.numero_pedido;
    const ean = actual.ean;

    const { coordinador, supernumerario } =
      await _validarSupervisorYSupernumerario(
        env,
        String(payload.coordinador || "").trim(),
        String(payload.supernumerario || "").trim(),
      );

    const procesoValidado = await _obtenerProcesoValidado(
      env,
      payload.proceso,
      pedido,
    );
    const tasaEstandar = procesoValidado.unidadesHora;

    const horaInicio = String(payload.horaInicio || "").trim();
    const horaFin = String(payload.horaFin || "").trim();
    const suplementoMin = Number(payload.suplementoMin) || 0;
    const { duracionBrutaMin, duracionRealMin } = _calcularDuracionValidada(
      horaInicio,
      horaFin,
      suplementoMin,
    );
    const durHoras = Math.round((duracionRealMin / 60) * 100) / 100;

    const unidadesNuevas = Number(payload.unidadesProcesadas);
    if (!Number.isFinite(unidadesNuevas) || unidadesNuevas < 0)
      throw new Error("Unidades procesadas inválidas.");
    const codigosSobrantesNuevos = _validarCodigosSobrantes(
      payload.codigosSobrantes,
    );

    const observaciones = String(payload.observaciones || "").trim();

    const disponible = await env.DB.prepare(
      "SELECT v.unidades_totales AS totales, " +
        "(SELECT COALESCE(SUM(r.unidades_procesadas_operario + r.codigos_sobrantes), 0) " +
        "FROM registros r WHERE r.numero_pedido = v.numero_pedido AND r.ean = v.ean_producto " +
        "AND r.anulado = 0 AND r.id != ?) AS ocupadoOtras, " +
        "(SELECT COALESCE(SUM(faltante), 0) FROM justificaciones " +
        "WHERE pedido = v.numero_pedido AND ean = v.ean_producto) AS justificado " +
        "FROM validacion_eanes v WHERE v.numero_pedido = ? AND v.ean_producto = ?",
    )
      .bind(id, pedido, ean)
      .first();

    const restante =
      disponible.totales - disponible.ocupadoOtras - disponible.justificado;
    if (unidadesNuevas + codigosSobrantesNuevos > restante) {
      throw new Error(
        "La cantidad ingresada (" +
          unidadesNuevas +
          (codigosSobrantesNuevos > 0
            ? " unidades + " + codigosSobrantesNuevos + " códigos sobrantes"
            : " unidades") +
          ") supera lo que el pedido tiene disponible (" +
          restante +
          " de " +
          disponible.totales +
          " totales, contando las demás filas y lo justificado). Verifica antes de continuar.",
      );
    }

    const { unidadesHoraReal, eficiencia } = _calcularMetricasProduccion(
      unidadesNuevas,
      tasaEstandar,
      durHoras,
    );

    const ahora = _ahoraISO();
    const resultado = await env.DB.prepare(
      "UPDATE registros SET coordinador = ?, supernumerario = ?, proceso = ?, " +
        "unidades_hora_estandar = ?, hora_inicio = ?, hora_final = ?, suplemento = ?, " +
        "observacion = ?, duracion_bruta_min = ?, tiempo_total = ?, " +
        "unidades_procesadas_operario = ?, codigos_sobrantes = ?, unidades_hora_real = ?, " +
        "eficiencia = ?, editado_por = ?, editado_en = ?, motivo_edicion = ?, " +
        "anulado_sincronizado_sheets = 0 " +
        "WHERE id = ? AND anulado = 0",
    )
      .bind(
        coordinador,
        supernumerario,
        procesoValidado.nombre,
        tasaEstandar,
        horaInicio,
        horaFin,
        suplementoMin,
        observaciones,
        duracionBrutaMin,
        durHoras,
        unidadesNuevas,
        codigosSobrantesNuevos,
        unidadesHoraReal,
        eficiencia,
        editadoPor,
        ahora,
        motivo,
        id,
      )
      .run();

    if (resultado.meta.changes === 0) {
      throw new Error(
        "El registro fue anulado justo antes de guardar los cambios. Actualiza la lista e intenta de nuevo.",
      );
    }

    await _recalcularContadorValidacion(env, pedido, ean);
    const pedidoCompleto = await _sincronizarEstadoPedido(env, pedido);

    ctx.waitUntil(_pushFilaRegistroYMarcar(env, id));

    return { success: true, id, pedidoCompleto };
  },

  async anularRegistro(payload, env, ctx) {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error("Falta el ID del registro a anular.");

    const motivo = String(payload.motivo || "").trim();
    if (!motivo) throw new Error("Debes indicar el motivo de la anulación.");

    const anuladoPor = String(payload.anuladoPor || "").trim();
    if (!anuladoPor) throw new Error("Falta el nombre de quien anula.");

    const actual = await env.DB.prepare(
      "SELECT numero_pedido, ean FROM registros WHERE id = ? AND anulado = 0",
    )
      .bind(id)
      .first();
    if (!actual)
      throw new Error(
        "El registro no existe o ya estaba anulado. Actualiza la lista e intenta de nuevo.",
      );

    const pedido = actual.numero_pedido;
    const ean = actual.ean;
    const ahora = _ahoraISO();

    const resultado = await env.DB.prepare(
      "UPDATE registros SET anulado = 1, anulado_por = ?, anulado_en = ?, " +
        "motivo_anulacion = ?, anulado_sincronizado_sheets = 0 WHERE id = ? AND anulado = 0",
    )
      .bind(anuladoPor, ahora, motivo, id)
      .run();

    if (resultado.meta.changes === 0) {
      throw new Error(
        "El registro fue anulado por otro proceso justo antes. Actualiza la lista e intenta de nuevo.",
      );
    }

    await _recalcularContadorValidacion(env, pedido, ean);
    const pedidoCompleto = await _sincronizarEstadoPedido(env, pedido);

    ctx.waitUntil(_pushFilaRegistroYMarcar(env, id));

    return { success: true, id, pedidoCompleto };
  },

  async reactivarRegistro(payload, env, ctx) {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error("Falta el ID del registro a reactivar.");

    const motivo = String(payload.motivo || "").trim();
    if (!motivo) throw new Error("Debes indicar el motivo de la reactivación.");

    const reactivadoPor = String(payload.reactivadoPor || "").trim();
    if (!reactivadoPor) throw new Error("Falta el nombre de quien reactiva.");

    const actual = await env.DB.prepare(
      "SELECT numero_pedido, ean, unidades_procesadas_operario, codigos_sobrantes " +
        "FROM registros WHERE id = ? AND anulado = 1",
    )
      .bind(id)
      .first();
    if (!actual)
      throw new Error(
        "El registro no existe o no está anulado. Actualiza la lista e intenta de nuevo.",
      );

    const pedido = actual.numero_pedido;
    const ean = actual.ean;

    const disponible = await env.DB.prepare(
      "SELECT v.unidades_totales AS totales, " +
        "(SELECT COALESCE(SUM(r.unidades_procesadas_operario + r.codigos_sobrantes), 0) " +
        "FROM registros r WHERE r.numero_pedido = v.numero_pedido AND r.ean = v.ean_producto " +
        "AND r.anulado = 0) AS ocupadoActivos, " +
        "(SELECT COALESCE(SUM(faltante), 0) FROM justificaciones " +
        "WHERE pedido = v.numero_pedido AND ean = v.ean_producto) AS justificado " +
        "FROM validacion_eanes v WHERE v.numero_pedido = ? AND v.ean_producto = ?",
    )
      .bind(pedido, ean)
      .first();

    const restante =
      disponible.totales - disponible.ocupadoActivos - disponible.justificado;
    const ocupaEstaFila =
      actual.unidades_procesadas_operario + actual.codigos_sobrantes;
    if (ocupaEstaFila > restante) {
      throw new Error(
        "No se puede reactivar: este registro ocupa " +
          ocupaEstaFila +
          " unidades y el pedido solo tiene " +
          restante +
          " disponibles ahora mismo (contando lo ya activo y lo justificado). " +
          "Edita las unidades antes de reactivarlo, o revisa el pedido.",
      );
    }

    const ahora = _ahoraISO();
    const resultado = await env.DB.prepare(
      "UPDATE registros SET anulado = 0, editado_por = ?, editado_en = ?, " +
        "motivo_edicion = ?, anulado_sincronizado_sheets = 0 WHERE id = ? AND anulado = 1",
    )
      .bind(reactivadoPor, ahora, motivo, id)
      .run();

    if (resultado.meta.changes === 0) {
      throw new Error(
        "El registro fue modificado por otro proceso justo antes. Actualiza la lista e intenta de nuevo.",
      );
    }

    await _recalcularContadorValidacion(env, pedido, ean);
    const pedidoCompleto = await _sincronizarEstadoPedido(env, pedido);

    ctx.waitUntil(_pushFilaRegistroYMarcar(env, id));

    return { success: true, id, pedidoCompleto };
  },

  async eliminarRegistro(payload, env, ctx) {
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0)
      throw new Error("Falta el ID del registro a eliminar.");

    const actual = await env.DB.prepare(
      "SELECT numero_pedido, ean, lote_id FROM registros WHERE id = ? AND anulado = 1",
    )
      .bind(id)
      .first();
    if (!actual)
      throw new Error(
        "El registro no existe o no está anulado. Solo se pueden eliminar registros ya anulados.",
      );

    const resultado = await env.DB.prepare(
      "DELETE FROM registros WHERE id = ? AND anulado = 1",
    )
      .bind(id)
      .run();

    if (resultado.meta.changes === 0) {
      throw new Error(
        "El registro fue modificado por otro proceso justo antes. Actualiza la lista e intenta de nuevo.",
      );
    }

    // Borrar una fila anulada no cambia unidades_procesadas/codigos_sobrantes
    // (ya estaba excluida de esa suma), pero sí hace falta recalcular para
    // refrescar "operarios" y el estado — sobre todo en filas anuladas antes
    // de que este recálculo existiera, que quedaron con datos obsoletos.
    await _recalcularContadorValidacion(env, actual.numero_pedido, actual.ean);

    // Best-effort, sin tabla de pendientes: si falla, la fila huérfana se
    // resuelve sola con la próxima purga periódica de la hoja.
    ctx.waitUntil(_eliminarFilaRegistroSheets(env, id, actual.lote_id));

    return { success: true, id };
  },
};
