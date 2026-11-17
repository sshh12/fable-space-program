/**
 * The same frame stated about another origin (labs and tests): every ROOT position and velocity of a snapshot
 * and the camera's position, minus those of one body, with the snapshot's frame naming that body as the
 * origin. The renderer draws from differences of ROOT positions only, so the picture is the same; where the
 * positions of the frame and of the new origin lie on one float64 grid (everything near the new origin: a
 * vessel in lunar orbit, the Moon, the camera) the differences the renderer forms are the same numbers to the
 * last bit, which is what the origin test of the integration lab compares (`?frameorigin=<body id>`).
 */
import { rebaseSnapshot } from '@/core/access/frameAccess';
import type { CameraState } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { v3 } from '@/core/math';

export function translateFrame(snapshot: SimSnapshot, camera: CameraState, bodyId: string): { snapshot: SimSnapshot; camera: CameraState } {
  const body = snapshot.bodies.find((b) => b.id === bodyId);
  if (!body) throw new Error(`translateFrame: the snapshot has no body "${bodyId}"`);
  const moved = rebaseSnapshot(snapshot, { offset: v3.neg(body.rRoot), velocity: v3.neg(body.vRoot) });
  return {
    // (The translated frames all have the one origin, whatever the session's own origin does: one epoch.)
    snapshot: { ...moved, frame: { epoch: 0, origin: { kind: 'body', bodyId }, rebase: null, previous: [] } },
    camera: { ...camera, positionRoot: v3.sub(camera.positionRoot, body.rRoot) },
  };
}
