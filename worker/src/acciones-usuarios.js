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

import {
  _normalizarPedido,
  _exigirCatalogoEnApp,
  _ahoraISO,
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
};
