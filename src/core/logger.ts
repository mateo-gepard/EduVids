import pino from 'pino';

export const logger = pino({
  transport: {
    target: 'pino/file',
    options: { destination: 1 }, // stdout
  },
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Create a child logger with context (e.g. agent name, project ID) */
export function createLogger(context: Record<string, string>) {
  return logger.child(context);
}
