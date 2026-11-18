// Módulo Usuarios del rol Planeación: reemplaza las hojas Operarios y
// supervisores-supernumerarios. Todas las acciones van en PERMISOS_POR_ACCION
// de index.js como ["planeacion"].
// U1 (solo lectura): personas con sus roles, turnos, equipos y avisos para
// limpiar antes del corte.
//
// Una fila de `operarios` por persona:
// - es_operario: aparece en el registro y entra como operario (se asigna y se
//   quita). Los grupos siempre van en 0.
// - es_grupo: Calidad, Picking, Maquinas... La cédula es el nombre, no tiene
//   turno ni cuenta.
// - turno_id: el turno asignado por nombre. `turno` (la hora) es la copia que
//   lee la cadena de horas; hasta el corte la escribe el pull, así que el
//   turno se deduce de la hora.
// Los roles de coordinador y supernumerario no se cargan de la hoja
// supervisores-supernumerarios (son solo nombres, varios con un apellido o que
// no son personas): se asignan a cada persona desde el módulo (U2), así que en
// U1 nadie los tiene todavía. Las cuentas (Administrativo = rol "supervisor",
// Planeación) viven en `usuarios`.

import { _normalizarPedido, _exigirCatalogoEnApp } from "./d1-negocio.js";

// Rol interno de la cuenta → nombre de la tarjeta.
const ROL_CUENTA = { supervisor: "administrativo", planeacion: "planeacion" };

// true si todos los catálogos están en la app (solo informa al frontend).
async function _edicionHabilitada(env, claves) {
  try {
    for (const clave of claves) await _exigirCatalogoEnApp(env, clave);
    return true;
  } catch (err) {
    return false;
  }
}

export const accionesUsuarios = {
  // U1: todo lo que muestra el módulo, en solo lectura. Lleva las cédulas:
  // solo la ve una sesión de Planeación.
  async obtenerUsuariosPlaneacion(datos, env, ctx, ip, sesion) {
    const { results: filasPersonas } = await env.DB.prepare(
      "SELECT cedula, nombre_operario AS nombre, equipo, activo, turno, " +
        "turno_id AS turnoId, es_operario AS esOperario, es_grupo AS esGrupo " +
        "FROM operarios WHERE cedula IS NOT NULL AND TRIM(cedula) <> ''",
    ).all();
    const sinCedula = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM operarios WHERE cedula IS NULL OR TRIM(cedula) = ''",
    ).first();
    const { results: filasTurnos } = await env.DB.prepare(
      "SELECT id, nombre, hora_inicio AS hora, activo FROM turnos ORDER BY hora_inicio, nombre",
    ).all();
    const { results: filasCuentas } = await env.DB.prepare(
      "SELECT cedula, rol, activo FROM usuarios",
    ).all();

    const turnos = filasTurnos.map((t) => ({
      id: t.id,
      nombre: String(t.nombre),
      hora: String(t.hora),
      activo: t.activo === 1,
      personas: 0,
    }));
    const turnoPorId = new Map(turnos.map((t) => [t.id, t]));

    const personas = filasPersonas.map((f) => {
      const esGrupo = f.esGrupo === 1;
      const hora = String(f.turno || "").trim();
      // Turno asignado (después del corte) o deducido de la hora (antes).
      let turno = null;
      if (!esGrupo) {
        const asignado = f.turnoId != null && turnoPorId.get(f.turnoId);
        if (asignado) {
          turno = {
            id: asignado.id,
            nombre: asignado.nombre,
            hora: asignado.hora,
            deducido: false,
          };
        } else if (hora) {
          const porHora = turnos.filter((t) => t.activo && t.hora === hora);
          if (porHora.length === 1)
            turno = {
              id: porHora[0].id,
              nombre: porHora[0].nombre,
              hora,
              deducido: true,
            };
        }
      }
      return {
        cedula: String(f.cedula).trim(),
        nombre: String(f.nombre || "").trim(),
        equipo: String(f.equipo || "").trim(),
        activo: f.activo === 1,
        esOperario: f.esOperario === 1 && !esGrupo,
        esGrupo,
        hora,
        turno,
        // Roles de coordinador y supernumerario: llegan en U2.
        nombresRol: [],
        cuentas: [],
      };
    });
    const personaPorCedula = new Map(personas.map((p) => [p.cedula, p]));

    const cuentasSinPersona = [];
    filasCuentas.forEach((c) => {
      const cuenta = {
        rol: ROL_CUENTA[c.rol] || String(c.rol),
        activa: c.activo === 1,
      };
      const p = personaPorCedula.get(String(c.cedula).trim());
      if (p) p.cuentas.push(cuenta);
      else cuentasSinPersona.push({ cedula: String(c.cedula), ...cuenta });
    });

    // Roles activos de cada persona (las tarjetas y el filtro por rol).
    personas.forEach((p) => {
      const roles = [];
      if (p.esOperario) roles.push("operario");
      ["supernumerario", "coordinador"].forEach((tipo) => {
        if (p.nombresRol.some((n) => n.tipo === tipo && n.activo))
          roles.push(tipo);
      });
      ["administrativo", "planeacion"].forEach((rol) => {
        if (p.cuentas.some((c) => c.rol === rol && c.activa)) roles.push(rol);
      });
      p.roles = roles;
      p.cuentas.sort((a, b) => (a.rol < b.rol ? -1 : 1));
      p.yo = p.cedula === String((sesion && sesion.cedula) || "");
      if (p.activo && p.turno) {
        const t = turnoPorId.get(p.turno.id);
        if (t) t.personas++;
      }
    });

    // --- Avisos para limpiar antes del corte ---
    const alertas = [];
    const porNombre = new Map();
    personas
      .filter((p) => p.activo)
      .forEach((p) => {
        const clave = _normalizarPedido(p.nombre);
        if (!porNombre.has(clave)) porNombre.set(clave, []);
        porNombre.get(clave).push(p);
      });
    porNombre.forEach((lista) => {
      if (lista.length > 1)
        alertas.push(
          'El nombre "' +
            lista[0].nombre +
            '" está en ' +
            lista.length +
            " personas activas (cédulas " +
            lista.map((p) => p.cedula).join(", ") +
            "): el registro agrega operarios por nombre.",
        );
    });
    if (sinCedula && sinCedula.n > 0)
      alertas.push(
        (sinCedula.n === 1
          ? "1 fila de Operarios no tiene cédula"
          : sinCedula.n + " filas de Operarios no tienen cédula") +
          ": no se muestran y se borran en el corte.",
      );
    const horasRaras = new Map();
    personas
      .filter((p) => p.activo && !p.esGrupo && p.hora && !p.turno)
      .forEach((p) =>
        horasRaras.set(p.hora, (horasRaras.get(p.hora) || 0) + 1),
      );
    horasRaras.forEach((n, hora) =>
      alertas.push(
        (n === 1 ? "1 persona tiene" : n + " personas tienen") +
          " turno a las " +
          hora +
          ", que no está en el catálogo de turnos.",
      ),
    );
    const sinTurno = personas.filter(
      (p) => p.activo && p.esOperario && !p.hora,
    ).length;
    if (sinTurno)
      alertas.push(
        (sinTurno === 1
          ? "1 operario no tiene"
          : sinTurno + " operarios no tienen") +
          " turno: su primer registro del día empieza a las 06:00.",
      );
    personas
      .filter((p) => !p.activo && p.cuentas.some((c) => c.activa))
      .forEach((p) =>
        alertas.push(
          p.nombre +
            " está inactivo pero conserva una cuenta activa (no puede entrar mientras siga inactivo).",
        ),
      );
    cuentasSinPersona.forEach((c) =>
      alertas.push(
        "Hay una cuenta de " +
          (c.rol === "planeacion" ? "Planeación" : "Administrativo") +
          " con la cédula " +
          c.cedula +
          ", que no está en Operarios.",
      ),
    );
    const equipos = new Map();
    personas
      .filter((p) => p.activo && p.equipo)
      .forEach((p) => equipos.set(p.equipo, (equipos.get(p.equipo) || 0) + 1));

    personas.sort(
      (a, b) =>
        Number(b.activo) - Number(a.activo) ||
        a.nombre.localeCompare(b.nombre, "es"),
    );
    return {
      success: true,
      personas,
      turnos,
      equipos: [...equipos.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], "es", { numeric: true }))
        .map(([nombre, personas]) => ({ nombre, personas })),
      alertas,
      // U2b: personas, roles y turnos esperan el corte único (F4).
      edicionHabilitada: await _edicionHabilitada(env, [
        "operarios",
        "supervisores",
      ]),
    };
  },
};
