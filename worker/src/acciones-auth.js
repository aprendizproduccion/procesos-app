import {
  ROLES_CON_CLAVE,
  hashClave,
  textosIguales,
  registrarFalloYEsperar,
  borrarIntentos,
} from "./sesiones.js";

const LARGO_MIN_CLAVE = 8; // mínimo para las contraseñas de usuarios

const DEMORA_MAX_SEG = 10; // techo de demora tras intentos fallidos repetidos
const DECAY_MS = 60 * 60 * 1000; // 1 hora sin fallos nuevos = contador se considera reiniciado

export const accionesAuth = {
  async validarLogin(datos, env, ctx, ip) {
    const rol = String(datos.rol || "")
      .trim()
      .toLowerCase();
    const clave = String(datos.password || "");

    if (rol === "operario") {
      // El perfil operario no requiere contraseña.
      return { success: true, rol };
    }

    if (rol !== "supervisor") {
      return { success: false, message: "Rol inválido." };
    }

    const claveGuardada = env.PASS_SUPERVISOR || "";
    if (!claveGuardada) {
      return {
        success: false,
        message:
          "No hay contraseña configurada para este rol. Contacta al administrador.",
      };
    }

    const identificador = ip || "desconocida";
    const fila = await env.DB.prepare(
      "SELECT intentos, actualizado_en FROM intentos_login WHERE identificador = ?",
    )
      .bind(identificador)
      .first();
    const yaExpiro =
      fila && Date.now() - new Date(fila.actualizado_en).getTime() > DECAY_MS;
    const intentosPrevios = fila && !yaExpiro ? fila.intentos : 0;

    if (clave === claveGuardada) {
      if (fila) {
        await env.DB.prepare(
          "DELETE FROM intentos_login WHERE identificador = ?",
        )
          .bind(identificador)
          .run();
      }
      return { success: true, rol };
    }

    // Contraseña incorrecta: registrar el intento y aplicar demora creciente
    // (no bloqueo duro, para no afectar a otros dispositivos que compartan IP).
    const intentosNuevos = intentosPrevios + 1;
    await env.DB.prepare(
      "INSERT INTO intentos_login (identificador, intentos, actualizado_en) VALUES (?, ?, ?) " +
        "ON CONFLICT(identificador) DO UPDATE SET intentos = excluded.intentos, actualizado_en = excluded.actualizado_en",
    )
      .bind(identificador, intentosNuevos, new Date().toISOString())
      .run();

    const demoraSeg = Math.min(intentosNuevos, DEMORA_MAX_SEG);
    await new Promise((resolve) => setTimeout(resolve, demoraSeg * 1000));

    return { success: false, message: "Contraseña incorrecta." };
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
