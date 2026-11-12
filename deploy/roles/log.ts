/**
 * Structured logs (ARCHITECTURE 27): one JSON line per event on stdout, with the role and the build. Railway
 * keeps 7 days of them on the Hobby plan and drops lines past 500 a second per replica, so roles log events,
 * never per-request noise. Nothing secret is ever passed to a logger (credentials and signed URLs stay out).
 */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(base: Record<string, unknown>, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger {
  const emit = (level: string, event: string, fields?: Record<string, unknown>): void => {
    write(JSON.stringify({ t: new Date().toISOString(), level, event, ...base, ...fields }));
  };
  return {
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    child: (f) => createLogger({ ...base, ...f }, write),
  };
}
