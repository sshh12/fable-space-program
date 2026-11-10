/**
 * GPU load governor (ARCHITECTURE 10.5) + dynamic resolution. Pure state machine: unit-tested in vitest.
 *
 * Order of action when the measured GPU time nears the budget: first lower FrameContext.qualityScale
 * (features scale their march steps and particle counts with it), and only when that is at its minimum
 * lower the internal render resolution. Recovery runs in the opposite order, with hysteresis: nothing
 * changes while the load sits between the recovery and the pressure thresholds, and a raise is only made
 * when the predicted cost after it stays below the pressure threshold.
 */
export interface GovernorConfig {
  /** GPU frame budget, ms (ARCHITECTURE 17: 11 ms). */
  budgetMs: number;
  /** Act when the smoothed GPU time exceeds this fraction of the budget. */
  pressure: number;
  /** Recover when it is below this fraction of the budget. */
  recovery: number;
  qualityMin: number;
  renderScaleMin: number;
  renderScaleMax: number;
  /** Render scale quantum (targets are reallocated on change). */
  renderScaleStep: number;
  /** Frames to wait after a quality / resolution change before judging again. */
  qualityCooldown: number;
  resolutionCooldown: number;
}

export const DEFAULT_GOVERNOR: GovernorConfig = {
  budgetMs: 11,
  pressure: 0.92,
  recovery: 0.72,
  qualityMin: 0.5,
  renderScaleMin: 0.5,
  renderScaleMax: 1,
  renderScaleStep: 1 / 16,
  qualityCooldown: 6,
  resolutionCooldown: 20,
};

export interface GovernorState {
  qualityScale: number;
  renderScale: number;
  /** Frames left before the next decision. */
  cooldown: number;
  /** Exponentially smoothed GPU time, ms (0 = no measurement yet). */
  smoothedMs: number;
}

export const initialGovernorState = (cfg: GovernorConfig): GovernorState => ({ qualityScale: 1, renderScale: cfg.renderScaleMax, cooldown: 0, smoothedMs: 0 });

const quantise = (x: number, step: number): number => Math.round(x / step) * step;

/**
 * Advance the governor by one frame. `gpuMs` is the latest measured sum of GPU pass times (null when no
 * new measurement arrived this frame).
 */
export function governorStep(s: GovernorState, gpuMs: number | null, cfg: GovernorConfig): GovernorState {
  const next: GovernorState = { ...s };
  next.renderScale = Math.max(cfg.renderScaleMin, Math.min(cfg.renderScaleMax, next.renderScale));
  if (gpuMs !== null && Number.isFinite(gpuMs)) {
    // While waiting for a change to take effect the raw value is tracked (old measurements must not
    // linger); otherwise rising load is believed quickly and falling load slowly.
    const k = next.smoothedMs === 0 || next.cooldown > 0 ? 1 : gpuMs > next.smoothedMs ? 0.5 : 0.15;
    next.smoothedMs += (gpuMs - next.smoothedMs) * k;
  }
  if (next.cooldown > 0) {
    next.cooldown--;
    return next;
  }
  if (next.smoothedMs === 0) return next;
  const high = cfg.budgetMs * cfg.pressure;
  const low = cfg.budgetMs * cfg.recovery;
  const ms = next.smoothedMs;
  if (ms > high) {
    const over = ms / high;
    if (next.qualityScale > cfg.qualityMin + 1e-9) {
      // Proportional step, at least 0.05: a 30 % overshoot drops quality by 0.15 in one decision.
      next.qualityScale = Math.max(cfg.qualityMin, next.qualityScale - Math.max(0.05, 0.5 * (over - 1)));
      next.cooldown = cfg.qualityCooldown;
    } else if (next.renderScale > cfg.renderScaleMin + 1e-9) {
      const wanted = next.renderScale / Math.sqrt(over);
      next.renderScale = Math.max(cfg.renderScaleMin, Math.min(next.renderScale - cfg.renderScaleStep, quantise(wanted, cfg.renderScaleStep)));
      next.cooldown = cfg.resolutionCooldown;
    }
  } else if (ms < low) {
    if (next.renderScale < cfg.renderScaleMax - 1e-9) {
      const up = Math.min(cfg.renderScaleMax, next.renderScale + cfg.renderScaleStep);
      if (ms * (up / next.renderScale) ** 2 < high * 0.95) {
        next.renderScale = up;
        next.cooldown = cfg.resolutionCooldown;
      }
    } else if (next.qualityScale < 1 - 1e-9) {
      const up = Math.min(1, next.qualityScale + 0.05);
      if (ms * (up / next.qualityScale) < high * 0.95) {
        next.qualityScale = up;
        next.cooldown = cfg.qualityCooldown;
      }
    }
  }
  return next;
}
