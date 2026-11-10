import {
  ITERACIONES_PBKDF2,
  ROLES_CON_CLAVE,
  UMBRAL_DEMORA_IP,
  hashClave,
  verificarClave,
  firmarToken,
  leerModoAuth,
  textosIguales,
  registrarFalloYEsperar,
  borrarIntentos,
} from "./sesiones.js";

const LARGO_MIN_CLAVE = 8; // mínimo para las contraseñas de  usuarios

const MSG_CEDULA_INACTIVA = "No encontramos esa cédula entre el personal activo.";

// Sin cuenta se calcula igual un hash contra esta fila, para que el tiempo de
// respuesta no delate si la cédula tiene cuenta.
const CUENTA_FICTICIA = {
  hash: "A".repeat(43),
  sal: "A".repeat(22),
  iteraciones: ITERACIONES_PBKDF2,
};

async function _personaActiva(env, cedula) {
  return env.DB.prepare(
    "SELECT nombre_operario AS nombre FROM operarios WHERE cedula = ? AND activo = 1",
  )
    .bind(cedula)
    .first();
}

// El proxy quita token y exp del JSON y los guarda en la cookie rp_ses.
async function _respuestaLogin(env, contenido) {
  const t = await firmarToken(env, contenido);
  return {
    success: true,
    rol: contenido.rol,
    nombre: contenido.nombre,
    cedula: contenido.cedula,
    token: t.token,
    exp: t.exp,
    duracion: t.duracion,
  };
}

// Formato viejo, sin cédula: { rol: "operario" } o { rol: "supervisor",
// password } contra PASS_SUPERVISOR. Solo en modo mixto, para un index.html en
// caché. No devuelve token. Sale en S4 junto con PASS_SUPERVISOR.
async function _loginSinCedula(env, ip, rol, clave) {
  if (rol === "planeacion" || (await leerModoAuth(env)) !== "mixto") {
    return { success: false, message: "Escribe o escanea tu cédula." };
  }
  if (rol === "operario") return { success: true, rol };

  const claveGuardada = env.PASS_SUPERVISOR || "";
  if (!claveGuardada) {
    return {
      success: false,
      message:
        "No hay contraseña configurada para este rol. Contacta al administrador.",
    };
  }
  const llave = "ip:" + (ip || "desconocida");
  if (await textosIguales(clave, claveGuardada)) {
    await borrarIntentos(env, [llave]);
    return { success: true, rol };
  }
  await registrarFalloYEsperar(env, [llave]);
  return { success: false, message: "Contraseña incorrecta." };
}

export const accionesAuth = {
  // Pública. Muestra el nombre en el login antes de pedir la contraseña. Solo
  // dice si la cédula está activa en Operarios, no si tiene cuenta.
  async nombrePorCedula(datos, env) {
    const cedula = String(datos.cedula || "").trim();
    if (!cedula) {
      return { success: false, message: "Escribe o escanea tu cédula." };
    }
    const persona = await _personaActiva(env, cedula);
    if (!persona) return { success: false, message: MSG_CEDULA_INACTIVA };
    return { success: true, nombre: persona.nombre };
  },

  // Pública. Login de los tres roles por cédula: el operario sin contraseña,
  // supervisor y Planeación contra su cuenta en `usuarios`. Devuelve un token
  // firmado (ver _respuestaLogin). La respuesta no distingue "no tienes
  // cuenta" de "contraseña incorrecta".
  async validarLogin(datos, env, ctx, ip) {
    const rol = String(datos.rol || "")
      .trim()
      .toLowerCase();
    const cedula = String(datos.cedula || "").trim();
    const clave = String(datos.password || "");

    if (rol !== "operario" && !ROLES_CON_CLAVE.includes(rol)) {
      return { success: false, message: "Rol inválido." };
    }
    if (!cedula) return _loginSinCedula(env, ip, rol, clave);

    if (rol === "operario") {
      const persona = await _personaActiva(env, cedula);
      if (!persona) return { success: false, message: MSG_CEDULA_INACTIVA };
      return _respuestaLogin(env, { rol, cedula, nombre: persona.nombre, v: 0 });
    }

    const llaveIp = "ip:" + (ip || "desconocida");
    const llaves = [llaveIp, "ced:" + cedula];
    const fila = await env.DB.prepare(
      "SELECT u.hash, u.sal, u.iteraciones, u.version, u.activo AS cuenta_activa, " +
        "o.nombre_operario AS nombre, o.activo AS persona_activa " +
        "FROM usuarios u JOIN operarios o ON o.cedula = u.cedula " +
        "WHERE u.cedula = ? AND u.rol = ?",
    )
      .bind(cedula, rol)
      .first();
    const claveOk = await verificarClave(clave, fila || CUENTA_FICTICIA);
    if (
      !fila ||
      !claveOk ||
      fila.cuenta_activa !== 1 ||
      fila.persona_activa !== 1
    ) {
      await registrarFalloYEsperar(env, llaves, {
        [llaveIp]: UMBRAL_DEMORA_IP,
      });
      return { success: false, message: "Cédula o contraseña incorrecta." };
    }
    // Se borran las dos llaves: quien ataca desde internet nunca acierta desde
    // su IP, y en bodega la protección por persona la sigue dando "ced:".
    await borrarIntentos(env, llaves);
    return _respuestaLogin(env, {
      rol,
      cedula,
      nombre: fila.nombre,
      v: fila.version,
    });
  },

  // Pública. El token no tiene estado en el servidor: cerrar sesión es borrar
  // la cookie, y eso lo hace el proxy al ver esta acción.
  async cerrarSesion() {
    return { success: true };
  },

  // No es pública: index.js ya verificó el token. Con token inválido responde
  // 401 sesionVencida antes de llegar aquí. La usa el navegador al recargar
  // para confirmar que la sesión guardada en rp_sesion sigue viva.
  async sesionActual(datos, env, ctx, ip, sesion) {
    if (!sesion) {
      return { success: false, sinSesion: true, message: "No hay sesión activa." };
    }
    return {
      success: true,
      rol: sesion.rol,
      nombre: sesion.nombre,
      cedula: sesion.cedula,
    };
  },

  // Crea, restablece, desactiva o reactiva la cuenta de un administrativo o de
  // Planeación. Protegida por el secret CLAVE_MAESTRA; se llama desde la
  // consola del navegador. Una contraseña nueva o un cambio de estado sube
  // `version`, lo que invalida al instante los tokens viejos (desde S1).
  async establecerClaveUsuario(datos, env, ctx, ip) {
    if (!env.CLAVE_MAESTRA) {
      return { success: false, message: "CLAVE_MAESTRA no está configurada." };
    }

    const llaveMaestra = "maestra:" + (ip || "desconocida");
    const maestraOk = await textosIguales(
      String(datos.claveMaestra || ""),
      env.CLAVE_MAESTRA,
    );
    if (!maestraOk) {
      await registrarFalloYEsperar(env, [llaveMaestra]);
      return { success: false, message: "Clave maestra incorrecta." };
    }
    await borrarIntentos(env, [llaveMaestra]);

    const cedula = String(datos.cedula || "").trim();
    const rol = String(datos.rol || "")
      .trim()
      .toLowerCase();
    const password = String(datos.password || "");
    const activo = datos.activo === false || datos.activo === 0 ? 0 : 1;

    if (!cedula) return { success: false, message: "Falta la cédula." };
    if (!ROLES_CON_CLAVE.includes(rol)) {
      return {
        success: false,
        message: "Rol inválido. Usa: " + ROLES_CON_CLAVE.join(", ") + ".",
      };
    }
    if (password && password.length < LARGO_MIN_CLAVE) {
      return {
        success: false,
        message:
          "La contraseña debe tener al menos " +
          LARGO_MIN_CLAVE +
          " caracteres.",
      };
    }

    // El nombre y el estado salen de Operarios (ahí están también coordinadores
    // y supernumerarios). Para desactivar no se exige que siga activo.
    const operario = await env.DB.prepare(
      "SELECT nombre_operario AS nombre, activo FROM operarios WHERE cedula = ?",
    )
      .bind(cedula)
      .first();
    if (activo === 1 && (!operario || operario.activo !== 1)) {
      return {
        success: false,
        message: "La cédula no está activa en el catálogo de Operarios.",
      };
    }

    const existente = await env.DB.prepare(
      "SELECT version, activo FROM usuarios WHERE cedula = ? AND rol = ?",
    )
      .bind(cedula, rol)
      .first();
    const ahora = new Date().toISOString();

    let accion;
    if (password) {
      const h = await hashClave(password);
      if (existente) {
        await env.DB.prepare(
          "UPDATE usuarios SET hash = ?, sal = ?, iteraciones = ?, activo = ?, " +
            "version = version + 1, actualizado_en = ? WHERE cedula = ? AND rol = ?",
        )
          .bind(h.hash, h.sal, h.iteraciones, activo, ahora, cedula, rol)
          .run();
        accion = "contraseña cambiada";
      } else {
        await env.DB.prepare(
          "INSERT INTO usuarios (cedula, rol, hash, sal, iteraciones, version, activo, " +
            "creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
        )
          .bind(cedula, rol, h.hash, h.sal, h.iteraciones, activo, ahora, ahora)
          .run();
        accion = "cuenta creada";
      }
    } else {
      if (!existente) {
        return {
          success: false,
          message:
            "La cuenta no existe: para crearla hace falta la contraseña.",
        };
      }
      await env.DB.prepare(
        "UPDATE usuarios SET activo = ?, version = version + 1, actualizado_en = ? " +
          "WHERE cedula = ? AND rol = ?",
      )
        .bind(activo, ahora, cedula, rol)
        .run();
      accion = activo ? "cuenta activada" : "cuenta desactivada";
    }

    const fila = await env.DB.prepare(
      "SELECT version, activo FROM usuarios WHERE cedula = ? AND rol = ?",
    )
      .bind(cedula, rol)
      .first();
    return {
      success: true,
      accion,
      cedula,
      rol,
      nombre: operario ? operario.nombre : "",
      activo: fila.activo === 1,
      version: fila.version,
    };
  },
};
