/**
 * Reference links a repository. Inbound mirror imports issues and comments.
 * Two-way also lets opted-in fields flow back to the repository.
 */
export type SyncMode = 'reference' | 'inbound' | 'two_way';
export const syncModes = ['reference', 'inbound', 'two_way'] as const;
export const mirrors = (mode: SyncMode) => mode !== 'reference';

/** The only local changes that may ever be published, each opted into separately. */
export type OutboundField = 'comments' | 'status' | 'assignee';
export const outboundFields = ['comments', 'status', 'assignee'] as const;
export type Publication = Record<OutboundField, boolean>;
export const noPublication: Publication = { comments: false, status: false, assignee: false };

export const outboundLabels: Record<OutboundField, { title: string; detail: string }> = {
  comments: {
    title: 'Replies',
    detail: 'Comments you post as a reply after enabling two-way. Internal notes stay in Trestl.',
  },
  status: {
    title: 'Status',
    detail: 'Completing or reopening an item closes or reopens the issue.',
  },
  assignee: {
    title: 'Assignee',
    detail: 'Assigning an item assigns the matching repository user.',
  },
};

/** Who owns each field in each mode. The server enforces the outbound column. */
export const fieldOwnership: {
  field: string;
  reference: string;
  inbound: string;
  two_way: string;
  opt?: OutboundField;
}[] = [
  {
    field: 'Link to the repository',
    reference: 'Shown',
    inbound: 'Shown',
    two_way: 'Shown',
  },
  {
    field: 'Title and description',
    reference: 'Not imported',
    inbound: 'Repository',
    two_way: 'Repository',
  },
  {
    field: 'Open or closed state',
    reference: 'Not imported',
    inbound: 'Repository',
    two_way: 'Repository',
  },
  {
    field: 'Repository comments',
    reference: 'Not imported',
    inbound: 'Repository → Trestl',
    two_way: 'Repository → Trestl',
  },
  {
    field: 'Replies',
    reference: 'Never published',
    inbound: 'Never published',
    two_way: 'Trestl → repository when opted in',
    opt: 'comments',
  },
  {
    field: 'Status',
    reference: 'Trestl',
    inbound: 'Trestl',
    two_way: 'Trestl; closes or reopens the issue when opted in',
    opt: 'status',
  },
  {
    field: 'Assignee',
    reference: 'Trestl',
    inbound: 'Trestl',
    two_way: 'Trestl; published when opted in',
    opt: 'assignee',
  },
  {
    field: 'Priority, dates, labels and follow-ups',
    reference: 'Trestl',
    inbound: 'Trestl',
    two_way: 'Trestl, never published',
  },
  {
    field: 'Internal notes and private items',
    reference: 'Trestl',
    inbound: 'Trestl',
    two_way: 'Trestl, never published',
  },
];
