import { useState, useEffect } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { NotificationCenter } from '../notifications/NotificationCenter';
import { useProjectStore, type Project } from '../../stores/projectStore';
import { useAuthStore } from '../../stores/authStore';

const globalNavItems = [
  { to: '/capture', label: 'Quick Capture', icon: '✍️' },
  { to: '/captures', label: 'Capture Inbox', icon: '📥' },
  { to: '/intelligence', label: 'Intelligence', icon: '🔍' },
  { to: '/goals', label: 'Goals', icon: '🎯' },
  { to: '/themes', label: 'Themes', icon: '🔗' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
];

// Mobile bottom nav
const mobileBottomNav = [
  { to: '/', label: 'Home', icon: '📊' },
  { to: '/goals', label: 'Goals', icon: '🎯' },
  { to: '/capture', label: 'Capture', icon: '✍️', prominent: true },
  { to: '/intelligence', label: 'Intel', icon: '🔍' },
  { to: '/settings', label: 'More', icon: '⚙️' },
];

/**
 * Returns the nav actions relevant to a project based on its type.
 */
function getProjectActions(project: Project) {
  const actions = [
    { to: `/projects/${project.id}/coach`, label: 'Coach', icon: '💬' },
    { to: `/projects/${project.id}/corpus`, label: 'Corpus', icon: '📄' },
  ];

  if (project.project_type === 'promptly') {
    actions.push({ to: `/projects/${project.id}/promptly`, label: 'Queue', icon: '📋' });
  }

  return actions;
}

/**
 * Returns an icon for the project type.
 */
function getProjectIcon(type: string): string {
  switch (type) {
    case 'essay_collection': return '📚';
    case 'substack': return '📰';
    case 'promptly': return '⚡';
    default: return '📁';
  }
}

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { projects, fetchProjects } = useProjectStore();
  const { logout, user } = useAuthStore();

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200
          transform transition-transform duration-200 ease-in-out
          md:translate-x-0 md:static md:z-auto
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="flex flex-col h-full">
          {/* Branding */}
          <div className="flex items-center justify-between px-4 py-4 border-b border-gray-200">
            <NavLink to="/" className="flex items-center gap-2">
              <span className="text-2xl" role="img" aria-label="Quinn">🖋️</span>
              <h1 className="text-lg font-semibold text-gray-900">Quinn</h1>
            </NavLink>
            <NotificationCenter />
          </div>

          {/* Navigation */}
          <nav className="flex-1 overflow-y-auto px-3 py-3">
            {/* Projects with inline actions */}
            <div className="mb-5">
              <p className="px-3 text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
                Projects
              </p>
              {projects.length === 0 ? (
                <p className="px-3 py-2 text-sm text-gray-400">No projects yet</p>
              ) : (
                <div className="space-y-3">
                  {projects.map((project) => (
                    <div key={project.id}>
                      <p className="px-3 py-1 text-sm font-medium text-gray-800 flex items-center gap-2">
                        <span>{getProjectIcon(project.project_type)}</span>
                        <span className="truncate">{project.name}</span>
                      </p>
                      <div className="ml-4 space-y-0.5">
                        {getProjectActions(project).map((action) => (
                          <NavLink
                            key={action.to}
                            to={action.to}
                            className={({ isActive }) =>
                              `flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${
                                isActive
                                  ? 'bg-indigo-50 text-indigo-700 font-medium'
                                  : 'text-gray-600 hover:bg-gray-100'
                              }`
                            }
                          >
                            <span className="text-xs">{action.icon}</span>
                            <span>{action.label}</span>
                          </NavLink>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="border-t border-gray-100 my-3" />

            {/* Global nav */}
            <div>
              <p className="px-3 text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
                Studio
              </p>
              {globalNavItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-gray-700 hover:bg-gray-100'
                    }`
                  }
                >
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          </nav>

          {/* User / Logout */}
          <div className="px-3 py-3 border-t border-gray-200">
            <div className="flex items-center justify-between px-3">
              <span className="text-sm text-gray-600 truncate">{user?.displayName || user?.email}</span>
              <button
                onClick={() => logout()}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-md text-gray-600 hover:bg-gray-100"
              aria-label="Open sidebar"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="text-lg font-semibold text-gray-900">🖋️ Quinn</span>
          </div>
          <NotificationCenter />
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 pb-20 md:pb-6">
          <Outlet />
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 z-30 safe-area-bottom">
        <div className="flex justify-around items-end py-1.5">
          {mobileBottomNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 px-2 py-1 text-xs transition-colors ${
                  item.prominent ? 'relative -top-2' : ''
                } ${isActive ? 'text-indigo-600' : 'text-gray-500'}`
              }
            >
              {item.prominent ? (
                <span className="flex items-center justify-center w-12 h-12 rounded-full bg-indigo-600 text-white text-xl shadow-lg">
                  {item.icon}
                </span>
              ) : (
                <span className="text-lg">{item.icon}</span>
              )}
              <span className={item.prominent ? 'text-indigo-600 font-medium' : ''}>
                {item.label}
              </span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
