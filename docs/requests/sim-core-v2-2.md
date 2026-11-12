Status: resolved (commit 37d3ad2)
From: sim-core-v2
Owner path: src/render/vehicle/site/survey.ts (vehicle-pad)
Blocking: no

## Problem
A site whose ground survey section is missing is drawn on level ground without any message. The survey is
found by the site id (`visuals/sites/<site id>`), so a renamed site, a new site (Madrakah) or a mistyped
file name silently loses the survey: the complex stops meeting the real ground, which is the defect the
survey was made to remove, and nothing fails until someone looks at a picture.

This was one `git mv` away from happening at the site rename of MIGRATION_V2 step 3.6 (`ka-lae-lc1` ->
`ka-lae`); the section was moved in the same commit (10057fe), so it did not.

## Evidence
`src/render/vehicle/site/survey.ts`:

```ts
export function siteSurvey(defs: DefLibrary, site: LaunchSiteDef): SiteSurveyDef | null {
  const section = defs.sections[surveySectionOf(site.id)] as { survey?: SiteSurveyDef } | undefined;
  const s = section?.survey;
  if (!s) return null;
```

and `siteGround` returns `LEVEL_GROUND` for `null`. With `data/defs/visuals/sites/ka-lae-lc1.json` under
the new site id the library loads, the site builds, and every earthwork stands on a plane.

## Requested change
Decide the missing survey where the site is built, not by a fall-back: a site that has structures and no
survey section is an error that names the site and the section it looked for (for example in `siteSurvey`,
or where the site model is assembled), and level ground is used only where the caller asks for it
explicitly (a lab or a unit test that builds a site without terrain). The lead asked for this wording: "a
site with structures and no survey section is an error at load, not level ground".

For the pads that follow (sixteen per site): the survey is per site today. Whether one survey covers every
pad of a site or each pad has its own section is yours to decide; `padsOf(site)` and
`padLocationOf(site, padId)` of `src/core/defs/sites.ts` give every pad and its place.

## Resolution
By vehicle-pad (visual close-out round 2), commit 37d3ad2.

- `siteGround(defs, site)` (`src/render/vehicle/site/survey.ts`) throws for a site that has structures and no
  survey section: `site "<id>": no ground survey (section visuals/sites/<id>); its structures cannot be built
  on the terrain. Run tools/vehicle/site-ground.ts survey`. It is called where the site is assembled
  (`generateStructure`, from `createSiteFeature().init`), so the page fails at load with the site and the
  section named. A malformed section throws as before. A site without structures needs no survey.
- Level ground is used only where the caller asks for it: `generateStructure(..., ground = LEVEL_GROUND)` and
  `createSiteFeature({ levelGround: true })`. Two callers do: the vehicle lab (its pad stands on a reference
  sphere, not on terrain) and the survey tool's own pass that measures the extent of the structures.
- Unit test: `tests/unit/vehicle/site.test.ts`, "a site with structures and no ground survey does not load;
  level ground has to be asked for".
- The survey is per SITE and stays so for this close-out: it is a grid in the frame of `site.location` (east /
  north of the site's reference point) over everything the structures of `site.structures` cover, and the
  tool takes its extent from them. When the sixteen pads have structures of their own, the tool's extent
  pass has to walk `padsOf(site)` and place each pad's structures by `padLocationOf`; one grid for the site
  still serves (5 m nodes; the file grows with the area), and the reader needs no change because every
  structure asks the grid in site coordinates. That step is not done here (the deprecated single-pad fields
  are what this package reads; they are still filled by the loader).
- No spec of this package names a site id any more (`SiteFeature.siteIds()`).

