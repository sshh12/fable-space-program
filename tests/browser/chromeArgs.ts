/** Chrome flags for WebGPU test runs, measured in docs/research/webgpu-harness.md. Keep minimal. */
export function chromeArgs(opts: { uncapped?: boolean } = {}): string[] {
  const args = [
    // Background/occluded state must never throttle rAF or timers.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    // Dual-GPU machine: insurance that the discrete adapter is used (tests still assert the adapter).
    '--force_high_performance_gpu',
    // AudioContext created at page load starts running; speakers stay silent but the graph processes.
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    // Un-quantised timestamp-query and adapter.info.description.
    '--enable-webgpu-developer-features',
  ];
  // Uncapped rAF is NOT a GPU benchmark (frames are not back-pressured); only for throughput experiments.
  if (opts.uncapped) args.push('--disable-frame-rate-limit', '--disable-gpu-vsync');
  return args;
}
