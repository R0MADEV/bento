/**
 * Public entry point for the Tasks panel.
 *
 * The implementation lives in TasksPanelRuntime.ts so this module remains a
 * small, stable integration boundary for the panel registry and lazy loader.
 */
export { createTasksPanel } from './TasksPanelRuntime'
