import { useParams } from 'react-router-dom';
import { CorpusBrowser as ScrivenerCorpusBrowser } from '../corpus/CorpusBrowser';
import { SubstackSettings } from '../settings/SubstackSettings';
import { ProjectBriefEditor } from '../projects/ProjectBriefEditor';
import { DraftUploader } from '../projects/DraftUploader';
import { useProjectStore } from '../../stores/projectStore';

/**
 * Corpus page that renders different content based on project type:
 * - essay_collection → Scrivener upload + document tree
 * - substack / promptly → Substack connection + sync
 */
export function CorpusBrowser() {
  const { id: projectId } = useParams<{ id: string }>();
  const { projects } = useProjectStore();

  const project = projects.find((p) => p.id === projectId);

  if (!project) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <p className="text-gray-500">Project not found</p>
      </div>
    );
  }

  // Substack-based projects show the Substack integration
  if (project.project_type === 'substack' || project.project_type === 'promptly') {
    return (
      <div className="max-w-2xl mx-auto">
        <ProjectBriefEditor project={project} />
        <SubstackSettings projectId={project.id} projectName={project.name} />
        <DraftUploader projectId={project.id} />
      </div>
    );
  }

  // Essay collection and custom projects show the Scrivener corpus browser
  return (
    <div>
      <ProjectBriefEditor project={project} />
      <ScrivenerCorpusBrowser />
    </div>
  );
}
