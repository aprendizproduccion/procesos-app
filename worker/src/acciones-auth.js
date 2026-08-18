// Acciones de autenticación — no tocan D1.

export const accionesAuth = {
  async validarLogin(datos, env) {
    const rol = String(datos.rol || "").trim().toLowerCase();
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
        message: "No hay contraseña configurada para este rol. Contacta al administrador.",
      };
    }

    return clave === claveGuardada
      ? { success: true, rol }
      : { success: false, message: "Contraseña incorrecta." };
  },
};
