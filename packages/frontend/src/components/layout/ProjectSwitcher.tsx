import { useEffect, useState, useRef } from 'react';
import { useProjectStore } from '../../stores/projectStore';

export function ProjectSwitcher() {
  const { projects, activeProject, isLoading, fetchProjects, setActiveProject } =
    useProjectStore();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-md bg-gray-50 hover:bg-gray-100 border border-gray-200 transition-colors text-left"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <div className="min-w-0 flex-1">
          {activeProject ? (
            <>
              <p className="text-sm font-medium text-gray-900 truncate">
                {activeProject.name}
              </p>
              {activeProject.central_question && (
                <p className="text-xs text-gray-500 truncate mt-0.5">
                  {activeProject.central_question}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-gray-500">Select a project</p>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-gray-400 ml-2 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 mt-1 bg-white border border-gray-200 rounded-md shadow-lg z-50 max-h-64 overflow-y-auto">
          {isLoading ? (
            <div className="px-3 py-2 text-sm text-gray-500">Loading...</div>
          ) : projects.length === 0 ? (
            <div className="px-3 py-2 text-sm text-gray-500">No projects yet</div>
          ) : (
            <ul role="listbox" aria-label="Select project">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    onClick={() => {
                      setActiveProject(project);
                      setIsOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 hover:bg-gray-50 transition-colors ${
                      activeProject?.id === project.id ? 'bg-indigo-50' : ''
                    }`}
                    role="option"
                    aria-selected={activeProject?.id === project.id}
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {project.name}
                    </p>
                    {project.central_question && (
                      <p className="text-xs text-gray-500 truncate mt-0.5">
                        {project.central_question}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
