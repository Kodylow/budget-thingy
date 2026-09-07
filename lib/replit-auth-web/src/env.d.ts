// Minimal ambient declaration for the Vite-injected `import.meta.env.BASE_URL`.
// Consuming apps provide the full `vite/client` types; this keeps the lib
// self-contained without a hard dependency on Vite.
interface ImportMeta {
  readonly env: {
    readonly BASE_URL: string;
    readonly [key: string]: string | boolean | undefined;
  };
}
