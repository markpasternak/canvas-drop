import type { Config } from "@canvas-drop/shared";
import { type Logger, pino } from "pino";
import pretty from "pino-pretty";

export type { Logger };

/**
 * Build the root structured logger (BUILD_BRIEF.md §8.5).
 *
 * JSON to stdout everywhere; `pretty` is human-readable local output. The app
 * never manages log files or shipping — the platform captures stdout.
 *
 * In `pretty` mode we run pino-pretty as an in-process stream rather than a
 * worker `transport`. A worker transport is torn down abruptly on
 * `process.exit()` (e.g. a startup EADDRINUSE) and can flush a stray `undefined`
 * line; the in-process stream stays ordered and flushes cleanly on exit.
 */
export function createLogger(config: Config): Logger {
  if (config.log.format === "pretty") {
    return pino(
      { level: config.log.level },
      pretty({ colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" }),
    );
  }
  return pino({ level: config.log.level });
}
