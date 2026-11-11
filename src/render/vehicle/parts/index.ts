/** Registers every part generator. Import this module once before calling `generatePart`. */
import { capsuleApexCover, capsuleMouldline } from './capsule';
import { engineLiquid } from './engine';
import { landerAscent, landerDescent, landerLegs } from './lander';
import { fairingPetals, lesTower } from './payload';
import { registerGenerator } from './registry';
import { stageTank } from './stage';
import { motorPack, padClamp, rcsPod, stageInterstage, stageRing } from './structures';

registerGenerator('stage.tank', stageTank);
registerGenerator('engine.liquid', engineLiquid);
registerGenerator('stage.interstage', stageInterstage);
registerGenerator('stage.ring', stageRing);
registerGenerator('motor.pack', motorPack);
registerGenerator('rcs.pod', rcsPod);
registerGenerator('pad.clamp', padClamp);
registerGenerator('capsule.mouldline', capsuleMouldline);
registerGenerator('capsule.apexCover', capsuleApexCover);
registerGenerator('lander.descent', landerDescent);
registerGenerator('lander.ascent', landerAscent);
registerGenerator('lander.legs', landerLegs);
registerGenerator('fairing.petals', fairingPetals);
registerGenerator('les.tower', lesTower);

export { generatePart, generatorIds, hasGenerator, registerGenerator } from './registry';
export type { GenContext, PartAnim, PartGenerator, PartLight, PartModel, PartVisual, PoseInput, PoseOpts, PoseSink } from './types';
export { NEUTRAL_ANIM } from './types';
