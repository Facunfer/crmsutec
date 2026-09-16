import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // kysely-pglite reexporta su generador de tipos (kysely-codegen + jiti),
  // que usa requires dinámicos que rompen al pasar por el bundler de
  // Next. Corriendo como paquete externo, Next lo deja en manos de Node
  // directo (igual que tsx en los scripts), sin intentar empaquetarlo.
  serverExternalPackages: ["kysely-pglite", "@electric-sql/pglite", "kysely"],
  // Evita que un package-lock.json en un directorio padre (fuera de este
  // proyecto) le haga inferir mal la raíz del workspace (lección de la
  // Etapa 0 sobre el CRM de referencia).
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  // VPS compartidos de poca memoria ya causaron builds fallidos en el CRM de
  // referencia (Etapa 0, riesgo #6); limitar CPUs de build reduce el pico de RAM.
  experimental: {
    cpus: 2,
  },
  // lib/ y scripts/ usan extensiones .js explícitas en los imports relativos
  // (necesario para que tsx/Node ESM los resuelva al correr los scripts de
  // migración/seed fuera de Next); esto le enseña al bundler de Next a
  // resolver esos mismos imports contra los .ts reales.
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
