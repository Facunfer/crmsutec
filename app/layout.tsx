import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CRM SUTECBA",
  description: "Sistema de gestión de personas, asociaciones y reuniones de SUTECBA",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <body>{children}</body>
    </html>
  );
}
