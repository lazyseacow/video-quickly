import { useMemo } from 'react';
import type { ProjectDocument } from '@video-quickly/contracts';
import type { ScenePreviewProject } from '../components/ScenePreview';

/** Preserve exactly the rendering context, without invalidating every row for a title edit. */
export function useScenePreviewContext(project: ProjectDocument): ScenePreviewProject {
  const { profile, claims, researchSources, referenceDisplay, captionStyle, clipEditSources, clipEditPlans } = project;
  const referenceFooter = useMemo(() => referenceDisplay === 'numbers' && project.shots.some(shot => shot.claimIds.length > 0), [referenceDisplay, project.shots]);
  return useMemo(() => ({
    profile, claims, researchSources, referenceDisplay, captionStyle, clipEditSources, clipEditPlans,
    shots: undefined, referenceFooter,
  } satisfies ScenePreviewProject & Record<keyof ScenePreviewProject, unknown>), [profile, claims, researchSources, referenceDisplay, captionStyle, clipEditSources, clipEditPlans, referenceFooter]);
}
