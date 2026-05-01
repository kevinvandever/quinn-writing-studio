import { create } from 'zustand';
import { get, post, put, del } from '../services/api-client';

export interface Project {
  id: string;
  name: string;
  description: string | null;
  central_question: string | null;
  project_type: string;
  created_at: string;
  updated_at: string;
}

interface CreateProjectInput {
  name: string;
  description?: string;
  central_question?: string;
  project_type: string;
}

interface UpdateProjectInput {
  name?: string;
  description?: string;
  central_question?: string;
  project_type?: string;
}

interface ProjectState {
  projects: Project[];
  activeProject: Project | null;
  isLoading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  updateProject: (id: string, input: UpdateProjectInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  setActiveProject: (project: Project | null) => void;
}

export const useProjectStore = create<ProjectState>((set, _get) => ({
  projects: [],
  activeProject: null,
  isLoading: false,
  error: null,

  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await get<{ projects: Project[] }>('/api/projects');
      set({ projects: response.projects, isLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch projects';
      set({ error: message, isLoading: false });
    }
  },

  createProject: async (input: CreateProjectInput) => {
    set({ isLoading: true, error: null });
    try {
      const response = await post<{ project: Project }>('/api/projects', input);
      set((state) => ({
        projects: [response.project, ...state.projects],
        isLoading: false,
      }));
      return response.project;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create project';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  updateProject: async (id: string, input: UpdateProjectInput) => {
    set({ isLoading: true, error: null });
    try {
      const response = await put<{ project: Project }>(`/api/projects/${id}`, input);
      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === id ? response.project : p
        ),
        activeProject:
          state.activeProject?.id === id ? response.project : state.activeProject,
        isLoading: false,
      }));
      return response.project;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update project';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  deleteProject: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      await del(`/api/projects/${id}`);
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== id),
        activeProject: state.activeProject?.id === id ? null : state.activeProject,
        isLoading: false,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete project';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  setActiveProject: (project: Project | null) => {
    set({ activeProject: project });
  },
}));
