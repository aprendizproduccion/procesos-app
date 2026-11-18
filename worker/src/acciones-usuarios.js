// Módulo Usuarios del rol Planeación: reemplaza las hojas Operarios y
// supervisores-supernumerarios. Todas las acciones van en PERMISOS_POR_ACCION
// de index.js como ["planeacion"].
// U1 (solo lectura): personas con sus roles, nombres de rol sin persona (con
// sugerencias para vincular), turnos y avisos para limpiar antes del corte.
//
// Una fila de `operarios` por persona:
// - es_operario: aparece en el registro y entra como operario (se asigna y se
//   quita). Los grupos siempre van en 0.
// - es_grupo: Calidad, Picking, Maquinas... La cédula es el nombre, no tiene
//   turno ni cuenta.
// - turno_id: el turno asignado por nombre. `turno` (la hora) es la copia que
//   lee la cadena de horas; hasta el corte la escribe el pull, así que el
//   turno se deduce de la hora.
// Los nombres de rol (coordinador y supernumerario) viven en `supervisores`:
// `cedula` dice de quién es y el nombre es el texto exacto que guardan los
// registros. Las cuentas (Administrativo = rol "supervisor", Planeación)
// viven en `usuarios`.

import { _normalizarPedido, _exigirCatalogoEnApp } from "./d1-negocio.js";

const MAX_SUGERENCIAS = 5;

// Rol interno de la cuenta → nombre de la tarjeta.
const ROL_CUENTA = { supervisor: "administrativo", planeacion: "planeacion" };

// Palabras de un nombre sin tildes ni mayúsculas.
function _palabras(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Distancia de edición, con corte: solo interesa saber si es 0 o 1.
function _distancia(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let previa = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const fila = [i];
    for (let j = 1; j <= b.length; j++) {
      fila[j] = Math.min(
        previa[j] + 1,
        fila[j - 1] + 1,
        previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previa = fila;
  }
  return previa[b.length];
}

// Cómo coincide un nombre de rol con el nombre completo de una persona: cada
// palabra del rol debe estar en el nombre, igual o con una letra de
// diferencia si tiene 4 o más ("Mayerli" / "Mayerly"). Devuelve null si no
// coincide, o { exactas, parecidas }.
function _coincidencia(palabrasRol, palabrasPersona) {
  let exactas = 0;
  let parecidas = 0;
  for (const r of palabrasRol) {
    if (palabrasPersona.includes(r)) exactas++;
    else if (
      r.length >= 4 &&
      palabrasPersona.some((p) => p.length >= 4 && _distancia(r, p) <= 1)
    )
      parecidas++;
    else return null;
  }
  return { exactas, parecidas };
}

// Personas que pueden ser dueñas de un nombre de rol: activas, que no son
// grupo y que no tienen ya un nombre activo de ese mismo rol. Primero las que
// tienen cuenta de Administrativo (los coordinadores y supernumerarios entran
// con ella), luego las coincidencias exactas.
function _sugerencias(rol, personas) {
  const palabrasRol = _palabras(rol.nombre);
  if (palabrasRol.length === 0) return { lista: [], total: 0 };
  const candidatas = [];
  personas.forEach((p) => {
    if (!p.activo || p.esGrupo) return;
    if (p.nombresRol.some((n) => n.tipo === rol.tipo && n.activo)) return;
    const c = _coincidencia(palabrasRol, p.palabras);
    if (!c) return;
    const cuenta = p.cuentas.some(
      (x) => x.rol === "administrativo" && x.activa,
    );
    candidatas.push({
      cedula: p.cedula,
      nombre: p.nombre,
      cuenta,
      exacta: c.parecidas === 0,
      puntaje:
        (cuenta ? 100 : 0) +
        c.exactas * 10 +
        c.parecidas * 5 +
        (p.palabras[0] === palabrasRol[0] ? 1 : 0),
    });
  });
  candidatas.sort(
    (a, b) => b.puntaje - a.puntaje || a.nombre.localeCompare(b.nombre, "es"),
  );
  return {
    lista: candidatas.slice(0, MAX_SUGERENCIAS).map((c) => ({
      cedula: c.cedula,
      nombre: c.nombre,
      cuenta: c.cuenta,
      exacta: c.exacta,
    })),
    total: candidatas.length,
  };
}

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
    const { results: filasRoles } = await env.DB.prepare(
      "SELECT id, tipo, nombre, cedula, activo FROM supervisores ORDER BY tipo, nombre",
    ).all();
    // Los registros guardan el nombre del rol tal como estaba en el catálogo;
    // la validación del envío lo compara sin mayúsculas.
    const { results: usos } = await env.DB.prepare(
      "SELECT 'coordinador' AS tipo, LOWER(coordinador) AS nombre, COUNT(*) AS n " +
        "FROM registros GROUP BY LOWER(coordinador) UNION ALL " +
        "SELECT 'supernumerario', LOWER(supernumerario), COUNT(*) " +
        "FROM registros GROUP BY LOWER(supernumerario)",
    ).all();
    const { results: filasCuentas } = await env.DB.prepare(
      "SELECT cedula, rol, activo FROM usuarios",
    ).all();

    const usoPorRol = new Map(
      usos.map((u) => [u.tipo + "|" + u.nombre, Number(u.n) || 0]),
    );
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
        nombresRol: [],
        cuentas: [],
      };
    });
    const personaPorCedula = new Map(personas.map((p) => [p.cedula, p]));

    const nombresSinPersona = [];
    filasRoles.forEach((r) => {
      const rol = {
        id: r.id,
        tipo: String(r.tipo),
        nombre: String(r.nombre),
        activo: r.activo === 1,
        registros:
          usoPorRol.get(r.tipo + "|" + String(r.nombre).toLowerCase()) || 0,
      };
      const cedula = String(r.cedula || "").trim();
      const duena = cedula && personaPorCedula.get(cedula);
      if (duena) duena.nombresRol.push(rol);
      else nombresSinPersona.push({ ...rol, cedulaPerdida: cedula });
    });

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
      p.palabras = _palabras(p.nombre);
      if (p.activo && p.turno) {
        const t = turnoPorId.get(p.turno.id);
        if (t) t.personas++;
      }
    });

    nombresSinPersona.forEach((r) => {
      const s = r.activo ? _sugerencias(r, personas) : { lista: [], total: 0 };
      r.sugerencias = s.lista;
      r.coincidencias = s.total;
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
    const sinVincular = nombresSinPersona.filter((r) => r.activo).length;
    if (sinVincular)
      alertas.push(
        (sinVincular === 1
          ? "1 nombre de coordinador o supernumerario no está vinculado"
          : sinVincular +
            " nombres de coordinador o supernumerario no están vinculados") +
          " a una persona (ver abajo).",
      );

    const equipos = new Map();
    personas
      .filter((p) => p.activo && p.equipo)
      .forEach((p) => equipos.set(p.equipo, (equipos.get(p.equipo) || 0) + 1));

    personas.forEach((p) => delete p.palabras);
    personas.sort(
      (a, b) =>
        Number(b.activo) - Number(a.activo) ||
        a.nombre.localeCompare(b.nombre, "es"),
    );
    nombresSinPersona.sort(
      (a, b) =>
        a.tipo.localeCompare(b.tipo) || a.nombre.localeCompare(b.nombre, "es"),
    );

    return {
      success: true,
      personas,
      nombresSinPersona,
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
