// Módulo Usuarios del rol Planeación: reemplaza las hojas Operarios y
// supervisores-supernumerarios. Todas las acciones van en PERMISOS_POR_ACCION
// de index.js como ["planeacion"].
// U1 (lectura): personas con sus roles, turnos, equipos y avisos para limpiar
// antes del corte.
// U2a (funciona antes del corte, sin interruptor: son datos que el pull no
// toca): el rol de operario, los roles de coordinador y supernumerario
// (roles_persona) y las cuentas de usuarios, estas con la clave maestra.
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
// no son personas): se asignan a cada persona en `roles_persona`, con el
// nombre que sale en el registro. En el corte, los selectores del registro
// pasan a leer esa tabla. Las cuentas (Administrativo = rol "supervisor",
// Planeación) viven en `usuarios`.
// U2b (con el interruptor `operarios` y `supervisores`, es decir, desde el
// corte único): altas de personas y grupos, nombre, equipo y turno, cambio de
// turno en bloque, catálogo de turnos, y desactivar, reactivar y eliminar
// personas.
// Turnos: el nombre es solo para verlo; lo que usa el sistema es la hora de
// inicio, copiada en `operarios.turno`. Por ahora un turno empieza y termina
// el mismo día (la hora fin es informativa): la jornada no cruza la
// medianoche.

import {
  _normalizarPedido,
  _exigirCatalogoEnApp,
  _ahoraISO,
  HORA_LIMITE_ENVIO,
  MAX_TURNO_CRUZA_MIN,
} from "./d1-negocio.js";
import {
  hashClave,
  textosIguales,
  registrarFalloYEsperar,
  borrarIntentos,
} from "./sesiones.js";

// Rol interno de la cuenta → nombre de la tarjeta, y al revés.
const ROL_CUENTA = { supervisor: "administrativo", planeacion: "planeacion" };
const ROL_INTERNO = { administrativo: "supervisor", planeacion: "planeacion" };
const TIPOS_ROL = ["coordinador", "supernumerario"];
const LARGO_MIN_CLAVE = 8; // igual que establecerClaveUsuario
const LARGO_MAX_CLAVE = 200;
const MAX_TURNO_BLOQUE = 500;
const PATRON_HORA_TURNO = /^([01]\d|2[0-3]):[0-5]\d$/;

function _limpiar(texto) {
  return String(texto || "")
    .trim()
    .replace(/\s+/g, " ");
}

async function _persona(env, cedula) {
  return env.DB.prepare(
    "SELECT cedula, nombre_operario AS nombre, activo, es_operario AS esOperario, " +
      "es_grupo AS esGrupo FROM operarios WHERE cedula = ?",
  )
    .bind(cedula)
    .first();
}

async function _personaExigida(env, datos) {
  const cedula = String(datos.cedula || "").trim();
  if (!cedula) throw new Error("Falta la cédula.");
  const p = await _persona(env, cedula);
  if (!p)
    throw new Error("La persona ya no está en Operarios. Recarga la lista.");
  return p;
}

// Fila de auditoria_catalogos. Nunca lleva contraseñas.
function _auditoria(env, sesion, fila) {
  return env.DB.prepare(
    "INSERT INTO auditoria_catalogos (tabla, llave, accion, antes, despues, cedula, nombre, hecho_en) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    fila.tabla,
    fila.llave,
    fila.accion,
    fila.antes === undefined ? null : JSON.stringify(fila.antes),
    fila.despues === undefined ? null : JSON.stringify(fila.despues),
    sesion.cedula,
    sesion.nombre || "",
    _ahoraISO(),
  );
}

// Misma protección que establecerClaveUsuario: demora por IP con cada fallo.
async function _exigirClaveMaestra(env, ip, clave) {
  if (!env.CLAVE_MAESTRA) throw new Error("CLAVE_MAESTRA no está configurada.");
  const llave = "maestra:" + (ip || "desconocida");
  if (!(await textosIguales(String(clave || ""), env.CLAVE_MAESTRA))) {
    await registrarFalloYEsperar(env, [llave]);
    throw new Error("Clave maestra incorrecta.");
  }
  await borrarIntentos(env, [llave]);
}

// Nombre con el que el rol sale en el registro (y queda en los registros).
function _nombreRolValidado(texto) {
  const nombre = _limpiar(texto);
  if (nombre.length < 2 || nombre.length > 60)
    throw new Error("El nombre debe tener entre 2 y 60 caracteres.");
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(nombre))
    throw new Error(
      "El nombre solo puede tener letras, números, espacios, punto, apóstrofo y guion.",
    );
  return nombre;
}

// Dos personas no pueden tener el mismo nombre activo en el mismo rol: el
// registro solo guarda el nombre. Se compara sin tildes, mayúsculas ni
// espacios; el índice único (sin mayúsculas) lo vuelve a revisar al escribir.
async function _exigirNombreLibre(env, tipo, nombre, cedula) {
  const { results } = await env.DB.prepare(
    "SELECT r.cedula, r.nombre, o.nombre_operario AS persona FROM roles_persona r " +
      "LEFT JOIN operarios o ON o.cedula = r.cedula WHERE r.tipo = ? AND r.activo = 1",
  )
    .bind(tipo)
    .all();
  const otro = results.find(
    (r) =>
      r.cedula !== cedula &&
      _normalizarPedido(r.nombre) === _normalizarPedido(nombre),
  );
  if (otro)
    throw new Error(
      'El nombre "' +
        otro.nombre +
        '" ya lo usa ' +
        (otro.persona || "otra persona") +
        " como " +
        tipo +
        ".",
    );
}

async function _registrosDelNombre(env, tipo, nombre) {
  const columna = tipo === "coordinador" ? "coordinador" : "supernumerario";
  const fila = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM registros WHERE LOWER(" +
      columna +
      ") = LOWER(?)",
  )
    .bind(nombre)
    .first();
  return Number(fila && fila.n) || 0;
}

function _errorUnico(err, tipo) {
  return /UNIQUE/i.test(String(err && err.message))
    ? new Error(
        "Ese nombre ya lo usa otra persona como " +
          tipo +
          ". Recarga la lista.",
      )
    : err;
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

// ---- U2b: personas, grupos y turnos ----

// Las escrituras de personas y turnos esperan el corte: el pull de la hoja
// Operarios revertiría lo escrito desde la app.
async function _exigirEdicionPersonas(env) {
  await _exigirCatalogoEnApp(env, "operarios");
  await _exigirCatalogoEnApp(env, "supervisores");
}

// Fila de auditoría que es además la guarda del batch: si la condición ya no
// se cumple al escribir, hecho_en queda NULL, choca con su NOT NULL y el batch
// entero se deshace.
function _auditoriaConGuarda(env, sesion, fila, condicion, binds) {
  return env.DB.prepare(
    "INSERT INTO auditoria_catalogos (tabla, llave, accion, antes, despues, cedula, nombre, hecho_en) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN " +
      condicion +
      " THEN ? END)",
  ).bind(
    fila.tabla,
    fila.llave,
    fila.accion,
    fila.antes === undefined ? null : JSON.stringify(fila.antes),
    fila.despues === undefined ? null : JSON.stringify(fila.despues),
    sesion.cedula,
    sesion.nombre || "",
    ...binds,
    _ahoraISO(),
  );
}

function _esFalloDeGuarda(err) {
  return /NOT NULL/i.test(String(err && err.message));
}

function _nombrePersonaValidado(texto) {
  const nombre = _limpiar(texto);
  if (nombre.length < 2 || nombre.length > 80)
    throw new Error("El nombre debe tener entre 2 y 80 caracteres.");
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(nombre))
    throw new Error(
      "El nombre solo puede tener letras, números, espacios, punto, apóstrofo y guion.",
    );
  return nombre;
}

// El registro del administrador agrega operarios por nombre: no puede haber
// dos personas activas (ni grupos) con el mismo nombre. Se compara sin
// tildes, mayúsculas ni espacios.
async function _exigirNombrePersonaLibre(env, nombre, cedula) {
  const { results } = await env.DB.prepare(
    "SELECT cedula, nombre_operario AS nombre FROM operarios WHERE activo = 1",
  ).all();
  const clave = _normalizarPedido(nombre);
  const otro = results.find(
    (r) =>
      String(r.cedula || "").trim() !== cedula &&
      _normalizarPedido(r.nombre) === clave,
  );
  if (otro)
    throw new Error(
      'Ya hay una persona activa llamada "' +
        String(otro.nombre).trim() +
        '" (cédula ' +
        String(otro.cedula).trim() +
        "). Usa un nombre que las distinga.",
    );
}

// Equipo libre; si coincide con uno que ya existe (sin tildes, mayúsculas ni
// espacios), se guarda con su escritura para no partir "Agregar equipo".
async function _equipoCanonico(env, texto) {
  const equipo = _limpiar(texto);
  if (!equipo) return "";
  if (equipo.length > 40)
    throw new Error("El equipo debe tener máximo 40 caracteres.");
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT equipo FROM operarios WHERE TRIM(equipo) <> ''",
  ).all();
  const clave = _normalizarPedido(equipo);
  const igual = results.find((r) => _normalizarPedido(r.equipo) === clave);
  return igual ? String(igual.equipo).trim() : equipo;
}

async function _turnoExigido(env, turnoId) {
  const id = Number(turnoId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Elige un turno.");
  const t = await env.DB.prepare(
    "SELECT id, nombre, hora_inicio AS hora FROM turnos WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!t) throw new Error("Ese turno ya no existe. Recarga la lista.");
  return t;
}

function _nombreTurnoValidado(texto) {
  const nombre = _limpiar(texto);
  if (nombre.length < 2 || nombre.length > 40)
    throw new Error("El nombre del turno debe tener entre 2 y 40 caracteres.");
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .:'()/-]*$/u.test(nombre))
    throw new Error(
      "El nombre del turno solo puede tener letras, números, espacios y . : ' ( ) / -",
    );
  return nombre;
}

// Hora de inicio y fin "HH:MM". Un turno de día termina a más tardar a las
// HORA_LIMITE_ENVIO. Desde el pendiente 16, un turno puede cruzar la
// medianoche (fin menor que el inicio, 22:00–06:00), con un máximo de 12 h:
// sus registros guardan la fecha del inicio de la jornada.
function _horasTurnoValidadas(datos) {
  const hora = String(datos.hora || "").trim();
  const horaFin = String(datos.horaFin || "").trim();
  if (!PATRON_HORA_TURNO.test(hora))
    throw new Error("La hora de inicio debe tener el formato HH:MM.");
  if (!PATRON_HORA_TURNO.test(horaFin))
    throw new Error("La hora de fin debe tener el formato HH:MM.");
  if (horaFin === hora)
    throw new Error(
      "La hora de fin del turno debe ser distinta de la de inicio.",
    );
  if (horaFin > hora) {
    if (horaFin > HORA_LIMITE_ENVIO)
      throw new Error(
        "Un turno que termina el mismo día debe terminar a más tardar a las " +
          HORA_LIMITE_ENVIO +
          ".",
      );
    return { hora, horaFin };
  }
  const minutos = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  if (minutos(horaFin) + 24 * 60 - minutos(hora) > MAX_TURNO_CRUZA_MIN)
    throw new Error(
      "Un turno que cruza la medianoche dura como máximo " +
        MAX_TURNO_CRUZA_MIN / 60 +
        " horas (" +
        hora +
        " a " +
        horaFin +
        " es más largo).",
    );
  return { hora, horaFin };
}

async function _exigirNombreTurnoLibre(env, nombre, id) {
  const { results } = await env.DB.prepare(
    "SELECT id, nombre FROM turnos",
  ).all();
  const clave = _normalizarPedido(nombre);
  const otro = results.find(
    (t) => t.id !== id && _normalizarPedido(t.nombre) === clave,
  );
  if (otro) throw new Error('Ya hay un turno llamado "' + otro.nombre + '".');
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
      "SELECT id, nombre, hora_inicio AS hora, hora_fin AS horaFin, activo FROM turnos " +
        "ORDER BY hora_inicio, nombre",
    ).all();
    const { results: filasCuentas } = await env.DB.prepare(
      "SELECT cedula, rol, activo FROM usuarios",
    ).all();
    const { results: filasRoles } = await env.DB.prepare(
      "SELECT cedula, tipo, nombre, activo FROM roles_persona",
    ).all();
    // Registros por nombre de rol (deciden si el nombre se puede cambiar). Los
    // registros guardan el nombre; el envío lo compara sin mayúsculas.
    const usos = filasRoles.length
      ? (
          await env.DB.prepare(
            "SELECT 'coordinador' AS tipo, LOWER(coordinador) AS nombre, COUNT(*) AS n " +
              "FROM registros GROUP BY LOWER(coordinador) UNION ALL " +
              "SELECT 'supernumerario', LOWER(supernumerario), COUNT(*) " +
              "FROM registros GROUP BY LOWER(supernumerario)",
          ).all()
        ).results
      : [];
    const usoPorRol = new Map(
      usos.map((u) => [u.tipo + "|" + u.nombre, Number(u.n) || 0]),
    );

    const turnos = filasTurnos.map((t) => ({
      id: t.id,
      nombre: String(t.nombre),
      hora: String(t.hora),
      horaFin: String(t.horaFin || ""),
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

    const rolesSinPersona = [];
    filasRoles.forEach((r) => {
      const rol = {
        tipo: String(r.tipo),
        nombre: String(r.nombre),
        activo: r.activo === 1,
        registros:
          usoPorRol.get(r.tipo + "|" + String(r.nombre).toLowerCase()) || 0,
      };
      const p = personaPorCedula.get(String(r.cedula).trim());
      if (p) p.nombresRol.push(rol);
      else rolesSinPersona.push({ cedula: String(r.cedula), ...rol });
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
    rolesSinPersona
      .filter((r) => r.activo)
      .forEach((r) =>
        alertas.push(
          "El nombre de " +
            r.tipo +
            ' "' +
            r.nombre +
            '" está asignado a la cédula ' +
            r.cedula +
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

  // U2a: pone o quita el rol de operario (sale en el registro y entra como
  // operario). datos: { cedula, esOperario }
  async cambiarRolOperario(datos, env, ctx, ip, sesion) {
    if (typeof datos.esOperario !== "boolean")
      throw new Error("Falta indicar si tiene el rol de operario.");
    const p = await _personaExigida(env, datos);
    if (p.esGrupo === 1)
      throw new Error("Un grupo no puede tener el rol de operario.");
    const valor = datos.esOperario ? 1 : 0;
    if (p.esOperario === valor)
      return { success: true, cedula: p.cedula, sinCambios: true };
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE operarios SET es_operario = ? WHERE cedula = ? AND es_grupo = 0",
      ).bind(valor, p.cedula),
      _auditoria(env, sesion, {
        tabla: "operarios",
        llave: p.cedula,
        accion: "editar",
        antes: { esOperario: p.esOperario === 1 },
        despues: { esOperario: valor === 1 },
      }),
    ]);
    return { success: true, cedula: p.cedula };
  },

  // U2a: roles de coordinador y supernumerario (roles_persona). Una fila por
  // persona y rol, con el nombre que sale en el registro.
  // datos: { cedula, tipo, accion, nombre }
  // - asignar: persona activa, nombre libre entre los activos de ese rol.
  // - renombrar: solo si el nombre actual no tiene registros (los registros
  //   guardan ese texto).
  // - quitar: con registros queda inactivo (se puede reactivar); sin
  //   registros se borra.
  // - reactivar: persona activa y nombre libre.
  async guardarRolPersona(datos, env, ctx, ip, sesion) {
    const tipo = String(datos.tipo || "");
    if (!TIPOS_ROL.includes(tipo)) throw new Error("Rol no válido.");
    const accion = String(datos.accion || "");
    const p = await _personaExigida(env, datos);
    const actual = await env.DB.prepare(
      "SELECT nombre, activo FROM roles_persona WHERE cedula = ? AND tipo = ?",
    )
      .bind(p.cedula, tipo)
      .first();
    const ahora = _ahoraISO();
    const base = { tabla: "roles_persona", llave: p.cedula };

    if (accion === "asignar") {
      if (p.activo !== 1) throw new Error("La persona está inactiva.");
      if (actual)
        throw new Error(
          actual.activo === 1
            ? "Ya es " + tipo + ' como "' + actual.nombre + '".'
            : 'Ya tuvo el rol como "' + actual.nombre + '": reactívalo.',
        );
      const nombre = _nombreRolValidado(datos.nombre);
      await _exigirNombreLibre(env, tipo, nombre, p.cedula);
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO roles_persona (cedula, tipo, nombre, activo, creado_en, actualizado_en) " +
              "VALUES (?, ?, ?, 1, ?, ?)",
          ).bind(p.cedula, tipo, nombre, ahora, ahora),
          _auditoria(env, sesion, {
            ...base,
            accion: "crear",
            despues: { tipo, nombre },
          }),
        ]);
      } catch (err) {
        throw _errorUnico(err, tipo);
      }
      return { success: true, cedula: p.cedula, tipo, nombre };
    }

    if (!actual)
      throw new Error(
        "La persona no tiene el rol de " + tipo + ". Recarga la lista.",
      );

    if (accion === "renombrar") {
      const nombre = _nombreRolValidado(datos.nombre);
      if (nombre === actual.nombre)
        return { success: true, cedula: p.cedula, tipo, sinCambios: true };
      const registros = await _registrosDelNombre(env, tipo, actual.nombre);
      if (registros > 0)
        throw new Error(
          'El nombre "' +
            actual.nombre +
            '" ya tiene ' +
            registros +
            (registros === 1 ? " registro" : " registros") +
            ": no se cambia, porque los registros guardan ese nombre.",
        );
      if (actual.activo === 1)
        await _exigirNombreLibre(env, tipo, nombre, p.cedula);
      try {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE roles_persona SET nombre = ?, actualizado_en = ? WHERE cedula = ? AND tipo = ?",
          ).bind(nombre, ahora, p.cedula, tipo),
          _auditoria(env, sesion, {
            ...base,
            accion: "editar",
            antes: { tipo, nombre: actual.nombre },
            despues: { tipo, nombre },
          }),
        ]);
      } catch (err) {
        throw _errorUnico(err, tipo);
      }
      return { success: true, cedula: p.cedula, tipo, nombre };
    }

    if (accion === "quitar") {
      const registros = await _registrosDelNombre(env, tipo, actual.nombre);
      if (registros > 0 && actual.activo !== 1)
        return { success: true, cedula: p.cedula, tipo, sinCambios: true };
      await env.DB.batch([
        registros > 0
          ? env.DB.prepare(
              "UPDATE roles_persona SET activo = 0, actualizado_en = ? WHERE cedula = ? AND tipo = ?",
            ).bind(ahora, p.cedula, tipo)
          : env.DB.prepare(
              "DELETE FROM roles_persona WHERE cedula = ? AND tipo = ?",
            ).bind(p.cedula, tipo),
        _auditoria(env, sesion, {
          ...base,
          accion: registros > 0 ? "desactivar" : "eliminar",
          antes: { tipo, nombre: actual.nombre, activo: actual.activo === 1 },
        }),
      ]);
      return {
        success: true,
        cedula: p.cedula,
        tipo,
        quedaInactivo: registros > 0,
      };
    }

    if (accion === "reactivar") {
      if (actual.activo === 1)
        return { success: true, cedula: p.cedula, tipo, sinCambios: true };
      if (p.activo !== 1) throw new Error("La persona está inactiva.");
      await _exigirNombreLibre(env, tipo, actual.nombre, p.cedula);
      try {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE roles_persona SET activo = 1, actualizado_en = ? WHERE cedula = ? AND tipo = ?",
          ).bind(ahora, p.cedula, tipo),
          _auditoria(env, sesion, {
            ...base,
            accion: "activar",
            despues: { tipo, nombre: actual.nombre },
          }),
        ]);
      } catch (err) {
        throw _errorUnico(err, tipo);
      }
      return { success: true, cedula: p.cedula, tipo };
    }

    throw new Error("Acción de rol no válida.");
  },

  // U2a: cuentas de Administrativo y Planeación, todas con la clave maestra.
  // datos: { cedula, rol: "administrativo"|"planeacion", accion, password,
  //   claveMaestra }
  // - crear y clave (cambiar contraseña) piden la contraseña nueva.
  // - Cada cambio sube `version`: las sesiones abiertas de esa cuenta se
  //   cierran al instante.
  // - Nadie desactiva ni elimina la cuenta con la que entró. Si cambia su
  //   propia contraseña, responde cerrarSesion: tiene que entrar de nuevo.
  // - eliminar: solo una cuenta inactiva.
  async guardarCuentaUsuario(datos, env, ctx, ip, sesion) {
    const rolCuenta = String(datos.rol || "");
    const rol = ROL_INTERNO[rolCuenta];
    if (!rol) throw new Error("Rol de cuenta no válido.");
    const accion = String(datos.accion || "");
    if (
      !["crear", "clave", "desactivar", "reactivar", "eliminar"].includes(
        accion,
      )
    )
      throw new Error("Acción de cuenta no válida.");
    await _exigirClaveMaestra(env, ip, datos.claveMaestra);

    const p = await _personaExigida(env, datos);
    if (p.esGrupo === 1) throw new Error("Un grupo no puede tener cuenta.");
    const cuenta = await env.DB.prepare(
      "SELECT activo FROM usuarios WHERE cedula = ? AND rol = ?",
    )
      .bind(p.cedula, rol)
      .first();
    const propia = sesion.cedula === p.cedula && sesion.rol === rol;
    const ahora = _ahoraISO();
    const base = { tabla: "usuarios", llave: p.cedula };
    const respuesta = {
      success: true,
      cedula: p.cedula,
      rol: rolCuenta,
      accion,
    };

    const _clave = () => {
      const password = String(datos.password || "");
      if (
        password.length < LARGO_MIN_CLAVE ||
        password.length > LARGO_MAX_CLAVE
      )
        throw new Error(
          "La contraseña debe tener al menos " +
            LARGO_MIN_CLAVE +
            " caracteres.",
        );
      return hashClave(password);
    };

    if (accion === "crear") {
      if (p.activo !== 1) throw new Error("La persona está inactiva.");
      if (cuenta)
        throw new Error(
          cuenta.activo === 1
            ? "Ya tiene esta cuenta."
            : "Ya tiene esta cuenta, inactiva: reactívala.",
        );
      const h = await _clave();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO usuarios (cedula, rol, hash, sal, iteraciones, version, activo, " +
            "creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)",
        ).bind(p.cedula, rol, h.hash, h.sal, h.iteraciones, ahora, ahora),
        _auditoria(env, sesion, {
          ...base,
          accion: "crear",
          despues: { rol: rolCuenta, activo: true },
        }),
      ]);
      return respuesta;
    }

    if (!cuenta) {
      if (accion === "eliminar") return { ...respuesta, sinCambios: true };
      throw new Error("La persona no tiene esta cuenta. Recarga la lista.");
    }

    if (accion === "clave") {
      const h = await _clave();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE usuarios SET hash = ?, sal = ?, iteraciones = ?, version = version + 1, " +
            "actualizado_en = ? WHERE cedula = ? AND rol = ?",
        ).bind(h.hash, h.sal, h.iteraciones, ahora, p.cedula, rol),
        _auditoria(env, sesion, {
          ...base,
          accion: "editar",
          despues: { rol: rolCuenta, contrasena: "cambiada" },
        }),
      ]);
      return propia ? { ...respuesta, cerrarSesion: true } : respuesta;
    }

    if (propia && (accion === "desactivar" || accion === "eliminar"))
      throw new Error(
        "No puedes desactivar ni eliminar la cuenta con la que entraste.",
      );

    if (accion === "desactivar" || accion === "reactivar") {
      const activo = accion === "reactivar" ? 1 : 0;
      if (cuenta.activo === activo) return { ...respuesta, sinCambios: true };
      if (activo && p.activo !== 1)
        throw new Error(
          "La persona está inactiva: su cuenta no se puede reactivar.",
        );
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE usuarios SET activo = ?, version = version + 1, actualizado_en = ? " +
            "WHERE cedula = ? AND rol = ?",
        ).bind(activo, ahora, p.cedula, rol),
        _auditoria(env, sesion, {
          ...base,
          accion: activo ? "activar" : "desactivar",
          antes: { rol: rolCuenta, activo: !activo },
          despues: { rol: rolCuenta, activo: !!activo },
        }),
      ]);
      return respuesta;
    }

    // eliminar
    if (cuenta.activo === 1)
      throw new Error(
        "Primero desactiva la cuenta; después se puede eliminar.",
      );
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM usuarios WHERE cedula = ? AND rol = ? AND activo = 0",
      ).bind(p.cedula, rol),
      _auditoria(env, sesion, {
        ...base,
        accion: "eliminar",
        antes: { rol: rolCuenta, activo: false },
      }),
    ]);
    return respuesta;
  },

  // ---- U2b: personas, grupos y turnos (desde el corte único) ----

  // Alta y edición de una persona o grupo.
  // datos: { accion: "crear"|"editar", cedula, nombre, equipo, turnoId,
  //   esOperario, esGrupo }
  // - crear persona: cédula de 5 a 15 letras o números; nombre libre entre
  //   los activos; el turno es obligatorio si tiene el rol de operario.
  // - crear grupo: la cédula es el nombre; sin turno, equipo ni cuenta, y
  //   nunca operario.
  // - editar: nombre, equipo y turno. La cédula no se edita. Los registros
  //   viejos conservan el nombre que tenían (la cadena y Control tiempos van
  //   por cédula).
  // El turno se escribe por id y su hora se copia en `turno` (la que lee la
  // cadena) con una subconsulta: si el turno se eliminó entre medias, la hora
  // queda NULL, choca con el NOT NULL y no se guarda nada.
  async guardarPersona(datos, env, ctx, ip, sesion) {
    await _exigirEdicionPersonas(env);
    const accion = String(datos.accion || "");
    if (accion !== "crear" && accion !== "editar")
      throw new Error("Acción de persona no válida.");
    const nombre = _nombrePersonaValidado(datos.nombre);

    if (accion === "crear") {
      const esGrupo = datos.esGrupo === true;
      const cedula = esGrupo ? nombre : String(datos.cedula || "").trim();
      if (!esGrupo && !/^[A-Za-z0-9]{5,15}$/.test(cedula))
        throw new Error(
          "La cédula debe tener de 5 a 15 letras o números, sin espacios ni puntos.",
        );
      const existe = await env.DB.prepare(
        "SELECT nombre_operario AS nombre, activo FROM operarios WHERE LOWER(TRIM(cedula)) = LOWER(?)",
      )
        .bind(cedula)
        .first();
      if (existe)
        throw new Error(
          (esGrupo
            ? 'Ya existe un grupo o persona con la cédula "' + cedula + '"'
            : "La cédula " + cedula + " ya es de " + existe.nombre) +
            (existe.activo === 1 ? "." : " (inactiva): reactívala."),
        );
      await _exigirNombrePersonaLibre(env, nombre, cedula);
      const esOperario = !esGrupo && datos.esOperario === true;
      const equipo = esGrupo ? "" : await _equipoCanonico(env, datos.equipo);
      let turno = null;
      if (!esGrupo && (esOperario || datos.turnoId))
        turno = await _turnoExigido(env, datos.turnoId);
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO operarios (cedula, nombre_operario, equipo, activo, turno, turno_id, " +
              "es_operario, es_grupo) VALUES (?, ?, ?, 1, " +
              (turno ? "(SELECT hora_inicio FROM turnos WHERE id = ?)" : "?") +
              ", ?, ?, ?)",
          ).bind(
            cedula,
            nombre,
            equipo,
            turno ? turno.id : "",
            turno ? turno.id : null,
            esOperario ? 1 : 0,
            esGrupo ? 1 : 0,
          ),
          _auditoria(env, sesion, {
            tabla: "operarios",
            llave: cedula,
            accion: "crear",
            despues: {
              nombre,
              equipo,
              turno: turno ? turno.nombre : "",
              esOperario,
              esGrupo,
            },
          }),
        ]);
      } catch (err) {
        if (/UNIQUE/i.test(String(err && err.message)))
          throw new Error("Esa cédula ya existe. Recarga la lista.");
        if (_esFalloDeGuarda(err))
          throw new Error("El turno elegido ya no existe. Recarga la lista.");
        throw err;
      }
      return { success: true, cedula, nombre };
    }

    // editar
    const p = await _personaExigida(env, datos);
    const actual = await env.DB.prepare(
      "SELECT o.nombre_operario AS nombre, o.equipo, o.turno_id AS turnoId, t.nombre AS turnoNombre " +
        "FROM operarios o LEFT JOIN turnos t ON t.id = o.turno_id WHERE o.cedula = ?",
    )
      .bind(p.cedula)
      .first();
    const esGrupo = p.esGrupo === 1;
    if (p.activo === 1) await _exigirNombrePersonaLibre(env, nombre, p.cedula);
    const equipo = esGrupo ? "" : await _equipoCanonico(env, datos.equipo);
    let turno = null;
    if (!esGrupo && datos.turnoId)
      turno = await _turnoExigido(env, datos.turnoId);
    if (!esGrupo && !turno && p.esOperario === 1)
      throw new Error("Un operario necesita turno.");
    const turnoIdNuevo = turno ? turno.id : null;
    const cambiaTurno = !esGrupo && turnoIdNuevo !== (actual.turnoId ?? null);
    if (
      nombre === String(actual.nombre || "").trim() &&
      equipo === String(actual.equipo || "").trim() &&
      !cambiaTurno
    )
      return { success: true, cedula: p.cedula, sinCambios: true };
    const sets = ["nombre_operario = ?", "equipo = ?"];
    const binds = [nombre, equipo];
    if (cambiaTurno) {
      sets.push(
        "turno_id = ?",
        turno
          ? "turno = (SELECT hora_inicio FROM turnos WHERE id = ?)"
          : "turno = ?",
      );
      binds.push(turnoIdNuevo, turno ? turno.id : "");
    }
    try {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE operarios SET " + sets.join(", ") + " WHERE cedula = ?",
        ).bind(...binds, p.cedula),
        _auditoria(env, sesion, {
          tabla: "operarios",
          llave: p.cedula,
          accion: "editar",
          antes: {
            nombre: actual.nombre,
            equipo: actual.equipo,
            turno: actual.turnoNombre || "",
          },
          despues: {
            nombre,
            equipo,
            turno: cambiaTurno
              ? turno
                ? turno.nombre
                : ""
              : actual.turnoNombre || "",
          },
        }),
      ]);
    } catch (err) {
      if (_esFalloDeGuarda(err))
        throw new Error("El turno elegido ya no existe. Recarga la lista.");
      throw err;
    }
    return { success: true, cedula: p.cedula, nombre };
  },

  // Desactivar, reactivar o eliminar a una persona.
  // datos: { cedula, accion: "desactivar"|"reactivar"|"eliminar", claveMaestra }
  // - desactivar (clave maestra): también sus cuentas, con `version` + 1 para
  //   cerrar sus sesiones; nadie se desactiva a sí mismo. Sus roles de
  //   coordinador y supernumerario salen de los selectores solos (leen solo
  //   personas activas).
  // - reactivar: sin clave; el nombre no puede chocar con otro activo. Sus
  //   cuentas no vuelven solas.
  // - eliminar (clave maestra, solo inactiva): borra la persona y sus
  //   cuentas; sus nombres de rol con registros quedan inactivos y los demás
  //   se borran. Sus registros no se tocan.
  async cambiarEstadoPersona(datos, env, ctx, ip, sesion) {
    await _exigirEdicionPersonas(env);
    const accion = String(datos.accion || "");
    if (!["desactivar", "reactivar", "eliminar"].includes(accion))
      throw new Error("Acción no válida.");
    if (accion !== "reactivar")
      await _exigirClaveMaestra(env, ip, datos.claveMaestra);
    const p = await _personaExigida(env, datos);
    const ahora = _ahoraISO();
    const base = { tabla: "operarios", llave: p.cedula };

    if (accion === "desactivar") {
      if (p.activo !== 1)
        return { success: true, cedula: p.cedula, sinCambios: true };
      if (p.cedula === String(sesion.cedula || ""))
        throw new Error("No puedes desactivarte a ti mismo.");
      const { results: cuentas } = await env.DB.prepare(
        "SELECT rol FROM usuarios WHERE cedula = ? AND activo = 1",
      )
        .bind(p.cedula)
        .all();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE operarios SET activo = 0 WHERE cedula = ? AND activo = 1",
        ).bind(p.cedula),
        env.DB.prepare(
          "UPDATE usuarios SET activo = 0, version = version + 1, actualizado_en = ? " +
            "WHERE cedula = ? AND activo = 1",
        ).bind(ahora, p.cedula),
        _auditoria(env, sesion, {
          ...base,
          accion: "desactivar",
          antes: { activo: true },
          despues: {
            activo: false,
            cuentasDesactivadas: cuentas.map((c) => ROL_CUENTA[c.rol] || c.rol),
          },
        }),
      ]);
      return {
        success: true,
        cedula: p.cedula,
        cuentasDesactivadas: cuentas.length,
      };
    }

    if (accion === "reactivar") {
      if (p.activo === 1)
        return { success: true, cedula: p.cedula, sinCambios: true };
      await _exigirNombrePersonaLibre(env, p.nombre, p.cedula);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE operarios SET activo = 1 WHERE cedula = ? AND activo = 0",
        ).bind(p.cedula),
        _auditoria(env, sesion, {
          ...base,
          accion: "activar",
          antes: { activo: false },
          despues: { activo: true },
        }),
      ]);
      return { success: true, cedula: p.cedula };
    }

    // eliminar
    if (p.activo === 1)
      throw new Error(
        "Primero desactiva a la persona; después se puede eliminar.",
      );
    const { results: roles } = await env.DB.prepare(
      "SELECT tipo, nombre FROM roles_persona WHERE cedula = ?",
    )
      .bind(p.cedula)
      .all();
    const sentencias = [
      // Guarda: si alguien la reactivó entre medias, no se borra nada.
      _auditoriaConGuarda(
        env,
        sesion,
        {
          ...base,
          accion: "eliminar",
          antes: { nombre: p.nombre, esGrupo: p.esGrupo === 1 },
        },
        "EXISTS (SELECT 1 FROM operarios WHERE cedula = ? AND activo = 0)",
        [p.cedula],
      ),
    ];
    for (const r of roles) {
      const usados = await _registrosDelNombre(env, r.tipo, r.nombre);
      sentencias.push(
        usados > 0
          ? env.DB.prepare(
              "UPDATE roles_persona SET activo = 0, actualizado_en = ? WHERE cedula = ? AND tipo = ?",
            ).bind(ahora, p.cedula, r.tipo)
          : env.DB.prepare(
              "DELETE FROM roles_persona WHERE cedula = ? AND tipo = ?",
            ).bind(p.cedula, r.tipo),
      );
    }
    sentencias.push(
      env.DB.prepare("DELETE FROM usuarios WHERE cedula = ?").bind(p.cedula),
      env.DB.prepare(
        "DELETE FROM operarios WHERE cedula = ? AND activo = 0",
      ).bind(p.cedula),
    );
    try {
      await env.DB.batch(sentencias);
    } catch (err) {
      if (_esFalloDeGuarda(err))
        throw new Error(
          "La persona se reactivó entre medias. Recarga la lista.",
        );
      throw err;
    }
    return { success: true, cedula: p.cedula, eliminada: true };
  },

  // Cambio de turno en bloque. datos: { cedulas: [...], turnoId }
  // Hasta MAX_TURNO_BLOQUE personas, nunca grupos.
  async cambiarTurnoPersonas(datos, env, ctx, ip, sesion) {
    await _exigirEdicionPersonas(env);
    if (!Array.isArray(datos.cedulas) || !datos.cedulas.length)
      throw new Error("Selecciona al menos una persona.");
    const cedulas = [
      ...new Set(datos.cedulas.map((c) => String(c || "").trim())),
    ].filter(Boolean);
    if (cedulas.length > MAX_TURNO_BLOQUE)
      throw new Error(
        "Se pueden cambiar máximo " + MAX_TURNO_BLOQUE + " personas a la vez.",
      );
    const turno = await _turnoExigido(env, datos.turnoId);
    const lista = JSON.stringify(cedulas);
    const { results } = await env.DB.prepare(
      "SELECT cedula, es_grupo AS esGrupo, turno_id AS turnoId FROM operarios " +
        "WHERE cedula IN (SELECT value FROM json_each(?))",
    )
      .bind(lista)
      .all();
    if (results.length !== cedulas.length)
      throw new Error(
        "Alguna de las personas ya no está en la lista. Recarga la lista.",
      );
    if (results.some((r) => r.esGrupo === 1))
      throw new Error("Un grupo no tiene turno.");
    const cambian = results.filter((r) => r.turnoId !== turno.id).length;
    if (!cambian) return { success: true, sinCambios: true, actualizadas: 0 };
    try {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE operarios SET turno_id = ?, turno = (SELECT hora_inicio FROM turnos WHERE id = ?) " +
            "WHERE cedula IN (SELECT value FROM json_each(?)) AND es_grupo = 0",
        ).bind(turno.id, turno.id, lista),
        _auditoria(env, sesion, {
          tabla: "operarios",
          llave: "bloque",
          accion: "editar",
          despues: { turno: turno.nombre, cedulas },
        }),
      ]);
    } catch (err) {
      if (_esFalloDeGuarda(err))
        throw new Error("El turno elegido ya no existe. Recarga la lista.");
      throw err;
    }
    return { success: true, actualizadas: cambian, turno: turno.nombre };
  },

  // Catálogo de turnos. datos: { accion: "crear"|"editar"|"eliminar", id,
  //   nombre, hora, horaFin, confirmado }
  // - El nombre es solo para verlo (único); la hora de inicio es la que usa
  //   el sistema. La hora fin es informativa por ahora.
  // - editar: cambiar la hora de un turno con gente responde `confirmar` sin
  //   escribir; con confirmado: true copia la hora nueva a sus personas en el
  //   mismo batch. Los registros ya guardados no cambian.
  // - eliminar: solo si ninguna persona activa lo tiene. Las inactivas que lo
  //   tenían quedan sin turno asignado (conservan su hora).
  async guardarTurno(datos, env, ctx, ip, sesion) {
    await _exigirEdicionPersonas(env);
    const accion = String(datos.accion || "");
    if (!["crear", "editar", "eliminar"].includes(accion))
      throw new Error("Acción de turno no válida.");
    const ahora = _ahoraISO();

    if (accion === "crear") {
      const nombre = _nombreTurnoValidado(datos.nombre);
      const { hora, horaFin } = _horasTurnoValidadas(datos);
      await _exigirNombreTurnoLibre(env, nombre, null);
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO turnos (nombre, hora_inicio, hora_fin, activo, creado_en) VALUES (?, ?, ?, 1, ?)",
          ).bind(nombre, hora, horaFin, ahora),
          _auditoria(env, sesion, {
            tabla: "turnos",
            llave: nombre,
            accion: "crear",
            despues: { nombre, hora, horaFin },
          }),
        ]);
      } catch (err) {
        if (/UNIQUE/i.test(String(err && err.message)))
          throw new Error('Ya hay un turno llamado "' + nombre + '".');
        throw err;
      }
      return { success: true, nombre };
    }

    const id = Number(datos.id);
    const t = Number.isInteger(id)
      ? await env.DB.prepare(
          "SELECT id, nombre, hora_inicio AS hora, hora_fin AS horaFin FROM turnos WHERE id = ?",
        )
          .bind(id)
          .first()
      : null;
    if (!t) throw new Error("Ese turno ya no existe. Recarga la lista.");
    const activas = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM operarios WHERE turno_id = ? AND activo = 1",
    )
      .bind(t.id)
      .first();
    const personas = Number(activas && activas.n) || 0;
    const base = { tabla: "turnos", llave: String(t.id) };
    const antes = { nombre: t.nombre, hora: t.hora, horaFin: t.horaFin };

    if (accion === "editar") {
      const nombre = _nombreTurnoValidado(datos.nombre);
      const { hora, horaFin } = _horasTurnoValidadas(datos);
      if (nombre === t.nombre && hora === t.hora && horaFin === t.horaFin)
        return { success: true, id: t.id, sinCambios: true };
      if (nombre !== t.nombre) await _exigirNombreTurnoLibre(env, nombre, t.id);
      const cambiaHora = hora !== t.hora;
      if (cambiaHora && personas > 0 && datos.confirmado !== true)
        return {
          success: true,
          id: t.id,
          confirmar: { personas, horaAntes: t.hora, horaNueva: hora },
        };
      const sentencias = [
        env.DB.prepare(
          "UPDATE turnos SET nombre = ?, hora_inicio = ?, hora_fin = ? WHERE id = ?",
        ).bind(nombre, hora, horaFin, t.id),
      ];
      if (cambiaHora)
        sentencias.push(
          env.DB.prepare(
            "UPDATE operarios SET turno = ? WHERE turno_id = ?",
          ).bind(hora, t.id),
        );
      sentencias.push(
        _auditoria(env, sesion, {
          ...base,
          accion: "editar",
          antes,
          despues: { nombre, hora, horaFin },
        }),
      );
      try {
        await env.DB.batch(sentencias);
      } catch (err) {
        if (/UNIQUE/i.test(String(err && err.message)))
          throw new Error('Ya hay un turno llamado "' + nombre + '".');
        throw err;
      }
      return {
        success: true,
        id: t.id,
        personasActualizadas: cambiaHora ? personas : 0,
      };
    }

    // eliminar
    if (personas > 0)
      throw new Error(
        (personas === 1
          ? "Lo tiene 1 persona activa"
          : "Lo tienen " + personas + " personas activas") +
          ': pásalas a otro turno con "Cambiar turno" y vuelve a intentarlo.',
      );
    try {
      await env.DB.batch([
        // Guarda: si alguien recibió el turno entre medias, no se borra.
        _auditoriaConGuarda(
          env,
          sesion,
          { ...base, accion: "eliminar", antes },
          "NOT EXISTS (SELECT 1 FROM operarios WHERE turno_id = ? AND activo = 1)",
          [t.id],
        ),
        env.DB.prepare(
          "UPDATE operarios SET turno_id = NULL WHERE turno_id = ?",
        ).bind(t.id),
        env.DB.prepare("DELETE FROM turnos WHERE id = ?").bind(t.id),
      ]);
    } catch (err) {
      if (_esFalloDeGuarda(err))
        throw new Error(
          "Alguien recibió este turno entre medias. Recarga la lista.",
        );
      throw err;
    }
    return { success: true, id: t.id, eliminado: true };
  },
};
