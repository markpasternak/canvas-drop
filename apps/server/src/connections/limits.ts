import { inProcessRateLimitStore } from "../http/rate-limit.js";

export type ConnectionLimitCode = "CONNECTION_RATE_LIMIT" | "CONNECTION_LIMIT";

export class ConnectionLimitError extends Error {
  constructor(
    readonly code: ConnectionLimitCode,
    readonly retryAfterSeconds: number,
  ) {
    super(
      code === "CONNECTION_RATE_LIMIT"
        ? "connection rate limit exceeded"
        : "connection concurrency limit exceeded",
    );
    this.name = "ConnectionLimitError";
  }
}

export interface ConnectionLimitConfig {
  actorPerMin: number;
  profilePerMin: number;
  canvasConcurrency: number;
  instanceConcurrency: number;
}

export interface ConnectionAdmission {
  release(): void;
}

/** Single-process admission control for the small-data connection runtime. */
export function connectionLimits(config: ConnectionLimitConfig, now = () => Date.now()) {
  const rates = inProcessRateLimitStore(now);
  const canvasActive = new Map<string, number>();
  let instanceActive = 0;

  function takeWindow(key: string, maximum: number) {
    const result = rates.hit(key, maximum, 60_000);
    if (!result.allowed) {
      throw new ConnectionLimitError("CONNECTION_RATE_LIMIT", result.retryAfterSec);
    }
  }

  return {
    acquire(input: { actorId: string; canvasId: string; profileId: string }): ConnectionAdmission {
      takeWindow(
        `connection:actor:${input.actorId}:${input.canvasId}:${input.profileId}`,
        config.actorPerMin,
      );
      takeWindow(`connection:profile:${input.profileId}`, config.profilePerMin);
      const activeForCanvas = canvasActive.get(input.canvasId) ?? 0;
      if (
        instanceActive >= config.instanceConcurrency ||
        activeForCanvas >= config.canvasConcurrency
      ) {
        throw new ConnectionLimitError("CONNECTION_LIMIT", 1);
      }
      instanceActive += 1;
      canvasActive.set(input.canvasId, activeForCanvas + 1);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          instanceActive -= 1;
          const remaining = (canvasActive.get(input.canvasId) ?? 1) - 1;
          if (remaining === 0) canvasActive.delete(input.canvasId);
          else canvasActive.set(input.canvasId, remaining);
        },
      };
    },
  };
}

export type ConnectionLimits = ReturnType<typeof connectionLimits>;
