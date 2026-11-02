import { useMemo } from 'react';
import type { ProjectDocument } from '@video-quickly/contracts';
import type { ScenePreviewProject } from '../components/ScenePreview';

/** Preserve exactly the rendering context, without invalidating every row for a title edit. */
export function useScenePreviewContext(project: ProjectDocument): ScenePreviewProject {
  const { profile, captionStyle, clipEditSources, clipEditPlans } = project;
  return useMemo(() => ({ profile, captionStyle, clipEditSources, clipEditPlans } satisfies ScenePreviewProject), [profile, captionStyle, clipEditSources, clipEditPlans]);
}
