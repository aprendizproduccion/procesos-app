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
} from "./d1-negocio.js";

export const accionesEscritura = {
  async submitRegistro(payload, env) {
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

    try {
      const pedido = String(payload.pedido || "").trim();
      if (!pedido) throw new Error("Falta el número de pedido.");

      const codigoEan = String(payload.codigoEan || "").trim();
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
            "unidades_procesadas_operario, unidades_hora_real, eficiencia, creado_en) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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

      await env.DB.batch(statements);

      const respuestaFinal = { success: true, loteId };
      await _confirmarIdempotencia(env, huella, respuestaFinal);
      return respuestaFinal;
    } catch (err) {
      await _liberarIdempotencia(env, huella);
      throw err;
    }
  },

    async submitRegistroOperario(payload, env) {
    const huella = await _huellaPayload("submitRegistroOperario", payload);
    const chequeo = await _chequearIdempotencia(env, huella);
    if (chequeo.duplicado) return chequeo.respuesta;
    if (chequeo.enProceso) {
      return {
        success: false,
        message: "Este registro ya se está procesando (posible doble envío). Espera unos segundos y verifica en Registros antes de reintentar.",
      };
    }

    try {
      const cedula = String(payload.cedula || "").trim();
      if (!cedula) throw new Error("Falta la cédula del operario.");

      const operarioMatch = await env.DB.prepare(
        "SELECT nombre_operario AS nombre, cedula FROM operarios WHERE cedula = ? AND activo = 1"
      ).bind(cedula).first();
      if (!operarioMatch) throw new Error('La cédula "' + cedula + '" no existe en el catálogo de Operarios.');

      const { coordinador, supernumerario } = await _validarSupervisorYSupernumerario(
        env, String(payload.coordinador || "").trim(), String(payload.supernumerario || "").trim()
      );

      const pedido = String(payload.pedido || "").trim();
      if (!pedido) throw new Error("Falta el número de pedido.");
      const codigoEan = String(payload.codigoEan || "").trim();
      if (!codigoEan) throw new Error("Falta escanear el código EAN del producto.");

      const total = Number(payload.unidadesProcesadas);
      if (!Number.isFinite(total) || total <= 0) throw new Error("Unidades procesadas inválidas.");

      const validacion = await _localizarValidacionEan(env, pedido, codigoEan);
      const unidadesEsperadas = validacion.unidades_totales;
      const sublinea = validacion.sublinea;
      const datosPedido = await _obtenerDatosPedido(env, pedido, sublinea);

      const codigosSobrantes = _validarCodigosSobrantes(payload.codigosSobrantes);
      const restantes = unidadesEsperadas - validacion.unidades_procesadas - validacion.justificado - validacion.codigos_sobrantes;
      if (total + codigosSobrantes > restantes) {
        throw new Error(
          "La cantidad ingresada (" + total +
            (codigosSobrantes > 0 ? " unidades + " + codigosSobrantes + " sobrantes" : " unidades") +
            ") no corresponde con lo disponible de este pedido"
        );
      }

      const procesoValidado = await _obtenerProcesoValidado(env, payload.proceso, pedido);
      const tasaEstandar = procesoValidado.unidadesHora;
      const suplementoMin = Number(payload.suplementoMin) || 0;
      const fecha = _fechaHoyBogota();
      const horaInicio = String(payload.horaInicio || "").trim();
      const horaFin = String(payload.horaFin || "").trim();
      const { duracionBrutaMin, duracionRealMin } = _calcularDuracionValidada(horaInicio, horaFin, suplementoMin);

      const observaciones = String(payload.observaciones || "").trim();
      const loteId = crypto.randomUUID();
      const ahora = _ahoraISO();
      const durHoras = Math.round((duracionRealMin / 60) * 100) / 100;
      const { unidadesHoraReal, eficiencia } = _calcularMetricasProduccion(total, tasaEstandar, durHoras);

      await _marcarPedidoIniciado(env, pedido, ahora);

      const reserva = await env.DB.prepare(
        "UPDATE validacion_eanes SET " +
          "unidades_procesadas = unidades_procesadas + ?, " +
          "codigos_sobrantes = codigos_sobrantes + ?, " +
          "estado = CASE WHEN (unidades_procesadas + ? + codigos_sobrantes + ?) >= unidades_totales THEN 'Completado' ELSE 'En proceso' END, " +
          "actualizado_en = ? " +
          "WHERE numero_pedido = ? AND ean_producto = ? " +
          "AND (unidades_procesadas + ? + codigos_sobrantes + ? + " +
          "(SELECT COALESCE(SUM(faltante),0) FROM justificaciones WHERE pedido = ? AND ean = ?)) <= unidades_totales"
      ).bind(
        total, codigosSobrantes, total, codigosSobrantes, ahora,
        pedido, codigoEan, total, codigosSobrantes, pedido, codigoEan
      ).run();

      if (reserva.meta.changes === 0) {
        throw new Error("Otro envío concurrente ya ocupó estas unidades. Verifica el estado actual del pedido antes de reintentar.");
      }

      const filaOperarios = await env.DB.prepare(
        "SELECT operarios FROM validacion_eanes WHERE numero_pedido = ? AND ean_producto = ?"
      ).bind(pedido, codigoEan).first();
      const listaActual = (filaOperarios.operarios || "").split(" - ").map((s) => s.trim()).filter(Boolean);
      if (!listaActual.includes(operarioMatch.nombre)) listaActual.push(operarioMatch.nombre);
      await env.DB.prepare(
        "UPDATE validacion_eanes SET operarios = ? WHERE numero_pedido = ? AND ean_producto = ?"
      ).bind(listaActual.join(" - "), pedido, codigoEan).run();

      const statements = [
        env.DB.prepare(
          "INSERT INTO registros (lote_id, fecha, coordinador, cedula_operario, operario, supernumerario, cliente, " +
            "proceso, unidades_hora_estandar, sublinea, evento, numero_pedido, ean, unidades_totales_procesadas, " +
            "hora_inicio, hora_final, suplemento, observacion, clasificacion_proceso, duracion_bruta_min, tiempo_total, " +
            "unidades_procesadas_operario, unidades_hora_real, eficiencia, creado_en) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(
          loteId, fecha, coordinador, operarioMatch.cedula, operarioMatch.nombre, supernumerario, datosPedido.cliente,
          procesoValidado.nombre, tasaEstandar, sublinea, datosPedido.evento, pedido, codigoEan, total,
          horaInicio, horaFin, suplementoMin, observaciones, datosPedido.clasificacionProceso,
          duracionBrutaMin, durHoras, total, unidadesHoraReal, eficiencia, ahora
        ),
      ];

      if (await _pedidoEstaCompleto(env, pedido)) {
        statements.push(
          env.DB.prepare(
            "INSERT INTO control_produccion (numero_pedido, estado, actualizado_en) VALUES (?, 'Completado', ?) " +
              "ON CONFLICT(numero_pedido) DO UPDATE SET estado = 'Completado', actualizado_en = excluded.actualizado_en"
          ).bind(pedido, ahora)
        );
      }

      await env.DB.batch(statements);

      const respuestaFinal = { success: true, loteId, horaInicio, horaFin };
      await _confirmarIdempotencia(env, huella, respuestaFinal);
      return respuestaFinal;
    } catch (err) {
      await _liberarIdempotencia(env, huella);
      throw err;
    }
  },
};
