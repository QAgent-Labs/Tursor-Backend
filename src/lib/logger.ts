export function createLogger(name: string) {
  return {
    log: (message: string) => console.log(`[${name}] ${message}`),
    debug: (message: string) => console.debug(`[${name}] ${message}`),
    warn: (message: string) => console.warn(`[${name}] ${message}`),
    error: (message: string) => console.error(`[${name}] ${message}`),
  };
}
