Status: open
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
