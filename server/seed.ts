import { demoRoadmap } from './roadmap-demo.ts';
import type { User, Project, WorkItem } from '../shared/types.ts';
import { nextItemIdentifier } from './item-identifiers.ts';
import { workspaceOf } from './workspaces.ts';
import type { Database, Store } from './db.ts';
import { randomUUID } from 'node:crypto';
export async function seedDemo(store: Store, user: User, db: Database) {
  const today = new Date();
  const date = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const projects: Project[] = [
    {
      id: randomUUID(),
      key: 'K8S',
      name: 'Kubernetes Platform',
      description: 'A reliable foundation for everything we build.',
      color: '#34775a',
      icon: 'box',
      parentId: null,
      lifecycle: 'ongoing',
      status: 'active',
      startDate: null,
      dueDate: null,
      visibility: 'workspace',
      ownerId: user.id,
      createdAt: today.toISOString(),
    },
    {
      id: randomUUID(),
      key: 'TEAM',
      name: 'Team leadership',
      description:
        'Make room for the work that helps the team thrive. Follow-ups, ideas, and priorities for the week ahead.',
      color: '#a394c4',
      icon: 'users',
      parentId: null,
      lifecycle: 'ongoing',
      status: 'active',
      startDate: null,
      dueDate: null,
      visibility: 'private',
      ownerId: user.id,
      createdAt: today.toISOString(),
    },
    {
      id: randomUUID(),
      key: 'DEV',
      name: 'Developer experience',
      description: 'Remove friction between an idea and production.',
      color: '#c09a6b',
      icon: 'code',
      parentId: null,
      lifecycle: 'fixed',
      status: 'active',
      startDate: date(-14),
      dueDate: date(30),
      visibility: 'workspace',
      ownerId: user.id,
      createdAt: today.toISOString(),
    },
    {
      id: randomUUID(),
      key: 'UPG',
      name: 'Platform upgrades',
      description:
        'Plan, validate, and roll out the next Kubernetes version across all environments.',
      color: '#769fa6',
      icon: 'arrow-up',
      parentId: null,
      lifecycle: 'fixed',
      status: 'active',
      startDate: date(-7),
      dueDate: date(14),
      visibility: 'workspace',
      ownerId: user.id,
      createdAt: today.toISOString(),
    },
  ];
  projects.push({
    id: randomUUID(),
    key: 'INIT',
    name: 'Team initiatives',
    description: 'Small improvements that help our team do their best work.',
    color: '#a394c4',
    icon: 'users',
    parentId: projects[1].id,
    lifecycle: 'ongoing',
    status: 'active',
    startDate: null,
    dueDate: null,
    visibility: 'workspace',
    ownerId: user.id,
    createdAt: today.toISOString(),
  });
  projects.push({
    id: randomUUID(),
    key: 'TOOLS',
    name: 'Internal tools',
    description: 'Useful tools for the work around the work.',
    color: '#7799ad',
    icon: 'code',
    parentId: null,
    lifecycle: 'ongoing',
    status: 'planned',
    startDate: null,
    dueDate: null,
    visibility: 'workspace',
    ownerId: user.id,
    createdAt: today.toISOString(),
  });
  projects[2].parentId = projects[0].id;
  projects[3].parentId = projects[0].id;
  projects[0].roadmap = demoRoadmap(date(0));
  for (const project of projects) await store.put('projects', project);
  const entries: Array<
    [
      number,
      string,
      WorkItem['status'],
      WorkItem['priority'],
      WorkItem['type'],
      number | null,
      string[],
    ]
  > = [
    [
      0,
      'Improve resource limits for production workloads',
      'in_progress',
      'high',
      'task',
      3,
      ['reliability'],
    ],
    [
      0,
      'Investigate intermittent DNS resolution failures',
      'in_progress',
      'urgent',
      'bug',
      0,
      ['networking'],
    ],
    [0, 'Document the incident response playbook', 'todo', 'medium', 'task', 5, ['documentation']],
    [
      0,
      'Review cluster autoscaling thresholds',
      'in_review',
      'high',
      'task',
      2,
      ['infrastructure'],
    ],
    [0, 'Explore namespace cost allocation', 'backlog', 'low', 'idea', null, ['observability']],
    [0, 'Rotate service account credentials', 'todo', 'high', 'task', 7, ['security']],
    [0, 'Set up application-level SLO dashboards', 'todo', 'medium', 'task', 10, ['observability']],
    [0, 'Simplify ingress configuration', 'done', 'medium', 'task', -2, ['networking']],
    [1, 'Prepare talking points for the team retrospective', 'todo', 'medium', 'task', 2, ['team']],
    [1, 'Follow up on the on-call workload', 'in_progress', 'high', 'followup', 1, ['team']],
    [1, 'Make space for a monthly learning afternoon', 'backlog', 'low', 'idea', null, ['team']],
    [1, 'Review next quarter’s platform priorities', 'todo', 'high', 'task', 4, ['planning']],
    [
      2,
      'Create a golden path for new services',
      'in_progress',
      'high',
      'task',
      12,
      ['developer-experience'],
    ],
    [2, 'Reduce CI pipeline feedback time', 'todo', 'medium', 'task', 8, ['pipelines']],
    [
      2,
      'Gather feedback on the onboarding flow',
      'in_review',
      'medium',
      'followup',
      3,
      ['developer-experience'],
    ],
    [3, 'Audit deprecated APIs across workloads', 'done', 'high', 'task', -1, ['upgrade']],
    [3, 'Validate the upgrade in staging', 'in_progress', 'high', 'task', 4, ['upgrade']],
    [3, 'Schedule the production rollout window', 'todo', 'medium', 'task', 10, ['upgrade']],
  ];
  const descriptions = [
    'Several production services still use the default resource requests. We need realistic limits before the next capacity review.\n\n## Next steps\n\n- [ ] Review 30 days of CPU and memory usage\n- [ ] Propose limits for the busiest namespaces\n- [ ] Roll out to staging and compare throttling',
    'Some workloads report short bursts of name resolution errors during peak traffic. Correlate CoreDNS metrics with node and network events.\n\n## Investigation\n\n- [ ] Collect failing query examples\n- [ ] Check connection tracking saturation\n- [ ] Test a mitigation in staging',
    'Make the first fifteen minutes of an incident less stressful. Link the finished playbook from Confluence once it is reviewed.\n\n## Outline\n\n- [ ] Triage and severity levels\n- [ ] Escalation contacts and ownership\n- [ ] Recovery checklist and handover',
    'The new thresholds are ready for review. Check whether the scale-down delay protects bursty workloads without keeping unnecessary capacity overnight.\n\n## Review\n\n- [ ] Compare weekday and weekend patterns\n- [ ] Review proposed minimum node counts\n- [ ] Agree on rollout and rollback criteria',
    'Could teams see the cost of their namespaces without a spreadsheet? Explore allocation by requests, actual usage, and shared platform overhead.\n\n## Questions\n\n- Which number would help teams make a better decision?\n- How should we allocate shared services?',
    'Review long-lived service account credentials and rotate the remaining legacy tokens. Prefer projected tokens where possible.\n\n## Checklist\n\n- [ ] Inventory affected service accounts\n- [ ] Confirm owners and consumers\n- [ ] Rotate and verify before revoking old tokens',
    'Infrastructure dashboards are useful, but they do not tell us whether users can complete their work. Define an initial set of service-level indicators with application owners.\n\n- [ ] Pick two representative applications\n- [ ] Agree on availability and latency objectives\n- [ ] Build an error budget dashboard',
    'Consolidated duplicated ingress annotations into the shared chart and documented supported overrides. Staging validation and a small production rollout are complete.\n\n## Outcome\n\nNew services now need only a hostname and service port for the standard ingress configuration.',
    'Bring a short set of observations to the retrospective and leave space for the team to shape the discussion.\n\n## Talking points\n\n- What slowed us down this sprint?\n- Where did collaboration work especially well?\n- What is one experiment worth trying next?',
    'Check whether recent on-call changes have reduced interruptions and made recovery time practical. Keep individual feedback private.\n\n## Follow-up\n\n- [ ] Ask about the last two rotations\n- [ ] Identify repeated sources of toil\n- [ ] Agree on one improvement and review it next week',
    'A regular afternoon for learning could help us share context and try ideas that never reach the sprint. Start small and let the team choose the format.\n\n## Ideas\n\n- A short peer-led workshop\n- Pairing on an unfamiliar part of the platform\n- A show-and-tell with no slides required',
    'Prepare a focused set of platform priorities for the next quarter. Balance delivery work with reliability and the team’s capacity.\n\n- [ ] Gather input from service teams\n- [ ] Review unfinished commitments\n- [ ] Draft priorities with explicit tradeoffs',
    'A new service should get from a repository to a healthy staging deployment with a clear, documented path. Build the smallest useful template first.\n\n- [ ] Define the default service structure\n- [ ] Wire build, deployment, and observability\n- [ ] Test the flow with a team outside the platform group',
    'Developers currently wait too long for an initial result. Measure queue time, dependency installation, and test execution before choosing changes.\n\n## Target\n\nMake the common pull request feedback loop meaningfully faster without weakening verification.',
    'The first draft of the onboarding flow has been tried by two teams. Follow up on where they got stuck and what required help from the platform team.\n\n- [ ] Collect concrete examples\n- [ ] Separate missing documentation from product friction\n- [ ] Pick the next two improvements',
    'Completed the workload audit for deprecated Kubernetes APIs. Owners have resolved the affected manifests and the updated resources are running in staging.\n\n## Evidence\n\nKeep the audit output and owner sign-offs linked here before the production change.',
    'Run the upgrade against staging before scheduling production. Verify controllers, storage, networking, and representative application flows.\n\n## Acceptance criteria\n\n- [ ] Control plane and nodes healthy\n- [ ] Critical controllers reconciled\n- [ ] Application smoke checks pass\n- [ ] Rollback approach reviewed',
    'Choose a production maintenance window after staging validation is complete. Record owners, prerequisites, and the point at which we stop or roll back.\n\n- [ ] Confirm availability with service owners\n- [ ] Check the change calendar\n- [ ] Link the runbook and verification checklist',
  ];
  let sequence = 0;
  for (const [projectIndex, title, status, priority, type, days, labels] of entries) {
    const project = projects[projectIndex];
    sequence++;
    const item: WorkItem = {
      id: randomUUID(),
      identifier: await nextItemIdentifier(db, project.id, workspaceOf(user)),
      title,
      description: descriptions[sequence - 1],
      projectId: project.id,
      parentId: null,
      type,
      status,
      priority,
      assigneeId: sequence % 4 === 0 ? null : user.id,
      dueDate: days === null ? null : date(days),
      followUpDate: type === 'followup' ? date(1) : null,
      recurrence: null,
      labels,
      visibility: 'workspace',
      creatorId: user.id,
      createdAt: new Date(today.getTime() - sequence * 3600000).toISOString(),
      updatedAt: today.toISOString(),
      completedAt: status === 'done' ? today.toISOString() : null,
      position: sequence,
    };
    await store.put('items', item);
    if (sequence === 1)
      await store.put('activity', {
        id: randomUUID(),
        itemId: item.id,
        userId: user.id,
        kind: 'comment',
        body: 'Let’s start with the busiest namespaces and measure the impact before rolling this out everywhere.',
        createdAt: today.toISOString(),
      });
  }
  await store.put('views', {
    id: randomUUID(),
    name: 'Upcoming deadlines',
    icon: 'calendar',
    filters: { due: 'upcoming' },
    layout: 'list',
    userId: user.id,
  });
  await store.put('views', {
    id: randomUUID(),
    name: 'Waiting on others',
    icon: 'clock',
    filters: { followUp: 'true' },
    layout: 'list',
    userId: user.id,
  });
  await store.put('views', {
    id: randomUUID(),
    name: 'Ideas & someday',
    icon: 'lightbulb',
    filters: { type: 'idea' },
    layout: 'list',
    userId: user.id,
  });
  await store.put('views', {
    id: randomUUID(),
    name: 'High priority',
    icon: 'flag',
    filters: { priority: 'high' },
    layout: 'list',
    userId: user.id,
  });
  await store.put('milestones', {
    id: randomUUID(),
    projectId: projects[3].id,
    title: 'Production rollout',
    dueDate: date(14),
    completed: false,
  });
}
