import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const chadashotVolume = volume("chadashot-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "europe-west4-drams3a",
    sizeMB: 5000,
  });

  const chadashot = service("chadashot", {
    source: github("pauljacobson/chadashot", {
      branch: "main",
      checkSuites: true,
    }),
    replicas: { "europe-west4-drams3a": 1 },
    domains: [{ domain: "chadashot.app", port: 8787 }],
    volumeMounts: { "/data": chadashotVolume },
    healthcheck: "/api/health",
    healthcheckTimeout: 100,
    env: {
      APP_ORIGIN: "https://chadashot.app",
      AUTH_MODE: "passkey",
      DATA_DIR: "/data",
      PORT: "8787",
      BOOTSTRAP_TOKEN: preserve(),
      ENCRYPTION_KEY: preserve(),
      LITESTREAM_ACCESS_KEY_ID: preserve(),
      LITESTREAM_REPLICA_URL: preserve(),
      LITESTREAM_SECRET_ACCESS_KEY: preserve(),
    },
  });

  return project("chadashot", {
    resources: [chadashot, chadashotVolume],
  });
});
