import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.chili.mobile",
  appName: "Chili",
  webDir: "dist",
  // Capacitor debug logging includes native call arguments (device secrets).
  loggingBehavior: "none",
  // Bundled UI only. No server.url, cleartext transport, or remote navigation.
  server: { hostname: "localhost", androidScheme: "https" },
  // The bundled page owns safe areas; native scroll insets would apply them twice.
  ios: { contentInset: "never", preferredContentMode: "mobile" },
  android: { allowMixedContent: false },
  plugins: { CapacitorHttp: { enabled: false } },
};

export default config;
