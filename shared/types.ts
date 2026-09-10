export type Status = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type ItemType = 'task' | 'bug' | 'idea' | 'followup';
export type Visibility = 'workspace' | 'private';
export interface Workspace {
  id: string;
  name: string;
  kind: 'personal' | 'shared';
  ownerId: string;
  createdAt: string;
}
export interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  userId: string;
  role: 'admin' | 'member';
}
export interface User {
  disabledAt?: string;
  personalWorkspaceId?: string;
  lastWorkspaceId?: string;
  workspaceId?: string;
  id: string;
  name: string;
  email: string;
  color: string;
  role: 'admin' | 'member';
}
export interface Project {
  roadmap?: Roadmap;
  workspaceId?: string;
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  parentId: string | null;
  lifecycle: 'ongoing' | 'fixed';
  status: 'active' | 'planned' | 'completed' | 'archived';
  startDate: string | null;
  dueDate: string | null;
  visibility: Visibility;
  ownerId: string;
  /** Additional workspace members allowed into a private project; absent on older records. */
  memberIds?: string[];
  createdAt: string;
}
export type RoadmapHorizon = 'current' | 'next' | 'future' | 'deferred';
export interface RoadmapFeature {
  id: string;
  title: string;
  summary: string;
  area: string;
  horizon: RoadmapHorizon;
  status: string;
  scope: string;
  rationale: string;
  targetDate: string | null;
}
export interface Roadmap {
  revision: number;
  headline: string;
  reviewNote: string;
  reviewedAt: string | null;
  features: RoadmapFeature[];
}
export interface IssueSource {
  provider: 'github' | 'gitea';
  integrationId: string;
  repository: string;
  number: number;
  url: string;
  state: 'open' | 'closed';
  lastSyncedAt: string | null;
  connected: boolean;
}
export interface WorkItem {
  revision?: number;
  workspaceId?: string;
  id: string;
  identifier: string;
  title: string;
  description: string;
  projectId: string | null;
  parentId: string | null;
  type: ItemType;
  status: Status;
  priority: Priority;
  assigneeId: string | null;
  /** Optional for records created before timeline scheduling. */
  startDate?: string | null;
  dueDate: string | null;
  followUpDate: string | null;
  recurrence: 'daily' | 'weekly' | 'monthly' | null;
  labels: string[];
  visibility: Visibility;
  creatorId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  position: number;
  externalUrl?: string | null;
  source?: IssueSource;
}
export interface Activity {
  id: string;
  itemId: string;
  userId: string;
  kind: 'comment' | 'event';
  source?: { provider: 'github' | 'gitea'; author: string };
  body: string;
  createdAt: string;
}
export interface Relation {
  id: string;
  itemId: string;
  targetId: string;
  kind: 'blocks' | 'related';
}
export interface ResourceLink {
  id: string;
  projectId: string | null;
  itemId: string | null;
  title: string;
  url: string;
  kind: 'confluence' | 'repository' | 'link';
}
export interface SavedView {
  workspaceId?: string;
  id: string;
  name: string;
  icon: string;
  filters: Record<string, string>;
  layout: 'list' | 'board';
  userId: string;
}
export interface Milestone {
  revision?: number;
  id: string;
  projectId: string;
  title: string;
  dueDate: string | null;
  completed: boolean;
}
export interface Bootstrap {
  authMode?: 'local' | 'google' | 'oidc' | 'proxy';
  installation?: boolean;
  workspace?: Workspace;
  workspaces?: (Workspace & { role: User['role'] })[];
  /** Only relationships whose two endpoints are visible to the signed-in user. */
  relations?: Relation[];
  user: User;
  users: User[];
  projects: Project[];
  items: WorkItem[];
  views: SavedView[];
  links: ResourceLink[];
  milestones: Milestone[];
}
export interface ItemDetail {
  item: WorkItem;
  activity: Activity[];
  relations: Relation[];
  links: ResourceLink[];
}
export interface ApiError {
  error: string;
  message: string;
}

/** Editable scene data, independent of the editor package on the server. */
export interface CanvasScene {
  elements: {
    id: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    [key: string]: unknown;
  }[];
  appState: { viewBackgroundColor?: string; gridSize?: number | null };
  files: Record<
    string,
    {
      id: string;
      mimeType: string;
      dataURL: string;
      created: number;
      lastRetrieved?: number;
      version?: number;
    }
  >;
}
export interface ProjectCanvas {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  collectionId?: string | null;
  scene: CanvasScene;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}
export type CanvasSummary = Omit<ProjectCanvas, 'scene'>;
export interface CanvasCollection {
  id: string;
  projectId: string;
  workspaceId: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
