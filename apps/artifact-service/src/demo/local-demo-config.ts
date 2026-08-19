export interface LocalDemoConfigurationOptions {
  readonly name: string;
  readonly workerEntry: string;
  readonly migrationsRoot: string;
  readonly controlToken: string;
  readonly pdfPublicKey: string;
}

export const createLocalDemoConfiguration = (options: LocalDemoConfigurationOptions) => ({
  name: options.name,
  main: options.workerEntry,
  compatibility_date: "2026-08-16",
  dev: { inspector_port: 0 },
  vars: {
    ALLOWED_EXPIRY_SECONDS: "900,1800,3600,43200,86400",
    MAX_ARTIFACT_BYTES: "26214400",
    MAX_EXPIRY_SECONDS: "86400",
    LOCAL_TEST_CONTROL_TOKEN: options.controlToken,
    PDF_PROVENANCE_PUBLIC_KEYS: JSON.stringify({ "local-test": options.pdfPublicKey }),
    PDF_PROVENANCE_RENDERERS: "artifact-share-qualified-pdf@1",
  },
  d1_databases: [{
    binding: "ARTIFACT_DB",
    database_name: options.name,
    database_id: "00000000-0000-0000-0000-000000000000",
    migrations_dir: options.migrationsRoot,
  }],
  r2_buckets: [{
    binding: "ARTIFACTS",
    bucket_name: options.name,
  }],
  assets: {
    binding: "ASSETS",
    run_worker_first: ["/health", "/upload", "/connect/*", "/api/*", "/a/*", "/__local-test/*"],
  },
});
