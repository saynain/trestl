import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoApi, ApiError } from './api';
import type { Bootstrap, WorkItem, ItemDetail, ProjectCanvas, Project, CanvasCollection } from '../../shared/types';
const write = (method: string, body: unknown) => ({method,body:JSON.stringify(body)});

test('the real application gets an authenticated sample workspace and isolated state', async () => {
  const first=createDemoApi(),second=createDemoApi();
  assert.equal((await first<{authenticated:boolean}>('/auth/status')).authenticated,true);
  const seed=await first<Bootstrap>('/bootstrap');
  assert.ok(seed.items.length>=20); assert.ok(seed.projects[0].roadmap!.features.length>=4);
  seed.items[0].title='Cannot mutate the backing state';
  assert.notEqual((await first<Bootstrap>('/bootstrap')).items[0].title,seed.items[0].title);
  const item=await first<WorkItem>('/items',write('POST',{title:'A new idea',projectId:'studio'}));
  const updated=await first<{item:WorkItem}>(`/items/${item.id}`,write('PATCH',{status:'done',expectedRevision:item.revision}));
  assert.equal(updated.item.status,'done');assert.equal(updated.item.revision,2);
  const detail=await first<ItemDetail>(`/items/${item.id}`);
  assert.equal(detail.item.status,'done');assert.ok(detail.item.completedAt);
  assert.equal((await second<Bootstrap>('/bootstrap')).items.length,seed.items.length);
  await assert.rejects(first(`/items/${item.id}`,write('PATCH',{title:'Stale write',expectedRevision:1})),(error:unknown)=>error instanceof ApiError&&error.status===409);
});

test('task details support internal comments, links, and relationships',async()=>{
  const api=createDemoApi();
  await api('/items/task-1/comments',write('POST',{body:'A local demo comment'}));
  await api('/items/task-1/relations',write('POST',{targetId:'task-2',kind:'related'}));
  await api('/links',write('POST',{itemId:'task-1',title:'Reference',url:'https://example.test',kind:'link'}));
  const detail=await api<ItemDetail>('/items/task-1');
  assert.ok(detail.activity.some(a=>a.body==='A local demo comment'));
  assert.ok(detail.relations.some(r=>r.targetId==='task-2'));assert.equal(detail.links[0].title,'Reference');
});

test('roadmap edits and canvas editor autosaves use revisioned local state',async()=>{
  const api=createDemoApi();const seed=await api<Bootstrap>('/bootstrap');
  await api('/projects/studio/roadmap',write('PATCH',{...seed.projects[0].roadmap,expectedRevision:1,headline:'The next chapter'}));
  assert.equal((await api<Project>('/projects/studio')).roadmap!.headline,'The next chapter');
  const canvas=await api<ProjectCanvas>('/projects/studio/canvases/launch-map');
  const group=await api<CanvasCollection>('/projects/studio/canvas-collections',write('POST',{name:'Launch'}));
  await api('/projects/studio/canvases/launch-map',write('PATCH',{expectedRevision:canvas.revision,collectionId:group.id,scene:{...canvas.scene,elements:[]}}));
  assert.equal((await api<ProjectCanvas>('/projects/studio/canvases/launch-map')).scene.elements.length,0);
  await api(`/projects/studio/canvas-collections/${group.id}`,write('DELETE',{expectedRevision:1}));
  assert.equal((await api<ProjectCanvas>('/projects/studio/canvases/launch-map')).collectionId,null);
});

test('deleting a project removes dependent sample records',async()=>{
  const api=createDemoApi();await api('/projects/studio',{method:'DELETE'});const seed=await api<Bootstrap>('/bootstrap');
  assert.ok(!seed.projects.some(p=>p.id==='website'||p.id==='studio'));
  assert.ok(!seed.items.some(i=>i.projectId==='studio'||i.projectId==='website'));
  assert.ok(seed.relations!.every(r=>seed.items.some(i=>i.id===r.itemId)&&seed.items.some(i=>i.id===r.targetId)));
});

test('unsupported, credential, and provider operations fail closed without a network fallback',async()=>{
  const api=createDemoApi();
  for(const path of ['/git/connections','/auth/logout','/tokens','/integrations/github-demo/sync','/unknown-new-feature']) await assert.rejects(api(path,write('POST',{token:'example-not-a-secret'})),(error:unknown)=>error instanceof ApiError&&error.status===403);
  const controller=new AbortController();controller.abort();await assert.rejects(api('/bootstrap',{signal:controller.signal}),{name:'AbortError'});
});
