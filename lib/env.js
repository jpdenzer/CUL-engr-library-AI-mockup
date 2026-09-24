// Load ./.env (if present) before other modules read process.env.
try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}
