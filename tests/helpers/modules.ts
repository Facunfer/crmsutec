import { MODULES, type ModuleKey } from "../../lib/permissions/catalog.js";

/** Todos los módulos del catálogo: para sesiones de prueba que no ejercitan el filtrado por módulo. */
export const ALL_MODULE_KEYS: ReadonlySet<ModuleKey> = new Set(MODULES.map((m) => m.key));
