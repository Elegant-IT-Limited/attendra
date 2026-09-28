// SPDX-License-Identifier: AGPL-3.0-only
import pino, { type Logger, type LoggerOptions } from 'pino';
import { redact } from './redact';

export type { Logger };

/**
 * The only logger anything in this repo should use. Every object passed to it goes
 * through redact() in pino's formatter, so a stray `log.info({ transcript })` is
 * stored as `[redacted]`, and the message string itself is scrubbed too.
 */
export function createLogger(opts: { name: string; level?: string; destination?: pino.DestinationStream }): Logger {
  const options: LoggerOptions = {
    name: opts.name,
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    formatters: {
      log: (obj) => redact(obj),
    },
    hooks: {
      logMethod(args, method) {
        // pino puts the message last when an object is passed first
        const scrubbed = args.map((a) => (typeof a === 'string' ? redact(a) : a));
        method.apply(this, scrubbed as Parameters<typeof method>);
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}
