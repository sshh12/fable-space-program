/** Registers every launch-complex structure generator. */
import { padBuilding, padTankFarm, padWaterTower } from './farm';
import { padApron, padCrawlerway, padFlameTrench, padFloodlight, padLaunchMount, padPipeRun } from './pad';
import { padCatenary, padLightningMast, padUmbilicalTower } from './tower';
import { registerSiteGenerator } from './types';

registerSiteGenerator('pad.apron', padApron);
registerSiteGenerator('pad.flameTrench', padFlameTrench);
registerSiteGenerator('pad.launchMount', padLaunchMount);
registerSiteGenerator('pad.crawlerway', padCrawlerway);
registerSiteGenerator('pad.pipeRun', padPipeRun);
registerSiteGenerator('pad.floodlight', padFloodlight);
registerSiteGenerator('pad.umbilicalTower', padUmbilicalTower);
registerSiteGenerator('pad.lightningMast', padLightningMast);
registerSiteGenerator('pad.catenary', padCatenary);
registerSiteGenerator('pad.waterTower', padWaterTower);
registerSiteGenerator('pad.tankFarm', padTankFarm);
registerSiteGenerator('pad.building', padBuilding);

export { generateStructure, registerSiteGenerator, siteGeneratorIds } from './types';
export type { SiteGenContext, SiteGenerator, SiteState, SiteVisual, StructureParams } from './types';
