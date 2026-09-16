/**
 * Cualquier módulo que hable con la base o maneje secretos debe llamar a esto
 * como primera línea. Si algún día un bundle de cliente llega a importarlo,
 * esto revienta en build/runtime en vez de filtrar credenciales en silencio.
 */
export function assertServerOnly(moduleName: string): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `${moduleName} es server-only y se intentó ejecutar en el navegador.`
    );
  }
}
