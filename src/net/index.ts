/**
 * The wire layer (docs/ARCHITECTURE.md section 13; brief `wire-protocol`): message codec and framing,
 * transports, the session layer for both ends, time sync and the input-margin loop, the latency injector, the
 * downstream budget, the recorder. Imports src/core only; runs unchanged in Chrome, in Node and in a worker.
 * The message TYPES are in src/core/contracts/net.ts (the wire-message section).
 */

// Codec and framing.
export { ByteReader, ByteWriter, WireEncodeError, type DecodeError, type DecodeErrorCode, type StringTableIn, type StringTableOut } from './codec/bytes';
export { assembleFrame, decodeDocument, decodeFrame, encodeDocument, encodeFrame, encodeMessage, FrameReader, FrameWriter, MAX_CLIENT_FRAME_MESSAGES, writeMessage, type DecodeOptions, type FrameResult, type FrameSource } from './codec/framing';
export { DocumentStrings, HandleTableIn, HandleTableOut, MAX_HANDLES } from './codec/handles';
export { MESSAGE_SPECS, randomMessage, specByCode, specOf, supersedeKey, type Delivery, type MessageSpec, type Sender as MessageSender } from './codec/messages';
export { canonicalConic, canonicalRadius, expandConic } from './codec/census';
export {
  ATT_SCALE,
  dequantizePose,
  makePose,
  NEAR_ATT_SCALE,
  NEAR_COARSE,
  NEAR_FINE,
  nearAttitude,
  nearQuat,
  POS_COARSE,
  POS_FINE,
  quantizePose,
  quatAngle,
  RATE_SCALE,
  VEL_COARSE,
  VEL_FINE,
  type IslandPose,
} from './codec/quant';
export { FRACTION_SCALE, GIMBAL_SCALE, InputAckFrame, InputFrame, IslandDeltaFrame, IslandKeyFrame, KELVIN_SCALE, NearFrame, type HotCodec } from './codec/island';
export { Gen } from './codec/schema';

// Transports.
export { CLOSE, type CloseInfo, type Transport, type TransportHandler, type TransportState } from './transport/types';
export { createLoopbackPair, type LoopbackTransport } from './transport/loopback';
export { connectWebSocket, nodeWsTransport, webSocketTransport, type WebSocketLike, type WsSocketLike } from './transport/websocket';
export { FrameAssembler, lengthPrefixed, streamTransport, type ByteStreamLike } from './transport/stream';
export { recordsOf, Sender, type SenderOptions, type SenderStats } from './transport/sender';

// Time.
export { ManualScheduler, RealScheduler, type Scheduler, type TimerHandle } from './time/scheduler';
export { addSample, clockTickAt, estimateClock, initialLead, leadParams, nextLead, offsetOf, rttOf, stampTick, type LeadParams, type SyncEstimate, type SyncSample } from './time/sync';

// Session layer.
export { ClientSession, type ClientAction, type ClientConfig, type ClientPhase, type ClientRefusal } from './session/client';
export { ServerSession, type AuthResult, type ResumeResult, type ServerAction, type ServerConfig, type ServerPhase, type ServerRefusalRecord } from './session/server';
export { ClientDriver, ServerDriver, type ClientDriverOptions, type ServerDriverOptions, type ServerHost } from './session/driver';
export { InputBuffer, InputWindow, type InputBufferStats, type InputDrop } from './session/inputs';
export { budgetClassOf, DownstreamBudget, type BudgetClass, type BudgetOptions, type BudgetStats } from './session/budget';
export { backoffMs, RateWindow } from './session/limits';

// Injector.
export { DelayLine, NO_DELAY, roundTripProfile, type DirectionProfile, type InjectorProfile, type ScheduledUnit } from './injector/model';
export { InjectedTransport, injectTransport, type Direction, type InjectorStep, type LoggedUnit } from './injector/injected';
export { parseProfile, pipeWithInjection, type InjectedPipe, type PipeStats } from './injector/proxy';

// Recorder.
export { decodeRecording, encodeRecording, fromHex, recordingTransport, RECORDING_VERSION, replayFrames, StreamRecorder, toHex, type FrameDirection, type RecordedFrame } from './record/recorder';
