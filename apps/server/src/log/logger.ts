import type { Config } from "@canvas-drop/shared";
import { type Logger, pino } from "pino";

export type { Logger };

/**
 * Build the root structured logger (BUILD_BRIEF.md §8.5).
 *
 * JSON to stdout everywhere; `pretty` is human-readable local output. The app
 * never manages log files or shipping — the platform captures stdout.
 */
export function createLogger(config: Config): Logger {
  if (config.log.format === "pretty") {
    return pino({
      level: config.log.level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
      },
    });
  }
  return pino({ level: config.log.level });
}
