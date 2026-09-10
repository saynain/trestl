import { getPreferenceValues } from '@raycast/api';
import { createClient, webLink, type Connection, type RequestOptions } from './client';
export type { Item, Project, User, ItemDetail, Page } from './client';
export function api<T>(path: string, options?: RequestOptions): Promise<T> {
  return createClient(getPreferenceValues<Connection>())<T>(path, options);
}
export function itemUrl(id: string): string {
  return webLink(getPreferenceValues<Connection>(), 'item', id);
}
export function projectUrl(id: string): string {
  return webLink(getPreferenceValues<Connection>(), 'project', id);
}
