/**
 * GPU time of one render pass from timestamp queries, read back without stalling (a small pool of
 * readback buffers; a frame whose buffers are all in flight is simply not measured).
 */
export class PassTimer {
  private readonly querySet: GPUQuerySet;
  private readonly resolve: GPUBuffer;
  private readonly free: GPUBuffer[] = [];
  private pending: GPUBuffer | null = null;
  readonly samples: number[] = [];

  constructor(private readonly device: GPUDevice) {
    this.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
    this.resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    for (let i = 0; i < 4; i++) this.free.push(device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
  }

  /** timestampWrites for the pass to measure, or undefined when no readback buffer is free this frame. */
  begin(): GPURenderPassTimestampWrites | undefined {
    if (this.free.length === 0) return undefined;
    this.pending = this.free.pop()!;
    return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }

  /** After the measured pass has ended: resolve into the claimed readback buffer. */
  end(encoder: GPUCommandEncoder): void {
    if (!this.pending) return;
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, this.pending, 0, 16);
  }

  /** After queue.submit: map the buffer and record the pass time in milliseconds. */
  collect(): void {
    const buf = this.pending;
    this.pending = null;
    if (!buf) return;
    buf.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigInt64Array(buf.getMappedRange());
        const ms = Number(t[1]! - t[0]!) / 1e6;
        buf.unmap();
        this.free.push(buf);
        if (ms >= 0 && ms < 1000) {
          this.samples.push(ms);
          if (this.samples.length > 2000) this.samples.splice(0, this.samples.length - 2000);
        }
      },
      () => this.free.push(buf),
    );
  }
}
