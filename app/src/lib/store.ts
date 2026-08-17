import { get, set } from 'idb-keyval';
import type { LogItem, Provision, QueueItem, Settings } from './types';
import { QUEUE_WARN_MS } from './types';

const K = {
  provision: 'ssw.provision',
  settings: 'ssw.settings',
  queue: 'ssw.queue',
  log: 'ssw.log'
};

export const defaultSettings = (): Settings => ({ site: '', maxEdge: 1600, iosVerdict: 'assume-safe' });

export async function getProvision(): Promise<Provision | null> {
  return (await get<Provision>(K.provision)) || null;
}
export async function setProvision(p: Provision): Promise<void> {
  await set(K.provision, p);
}
export async function clearProvision(): Promise<void> {
  await set(K.provision, null);
}

export async function getSettings(): Promise<Settings> {
  return { ...defaultSettings(), ...(await get<Partial<Settings>>(K.settings)) };
}
export async function setSettings(s: Settings): Promise<void> {
  await set(K.settings, s);
}

export function isStale(item: QueueItem): boolean {
  const age = Date.now() - Date.parse(item.created_at);
  return Number.isFinite(age) && age > QUEUE_WARN_MS;
}

export async function getQueue(): Promise<QueueItem[]> {
  return (await get<QueueItem[]>(K.queue)) || [];
}

export async function saveQueue(items: QueueItem[]): Promise<void> {
  await set(K.queue, items);
}

export async function upsertQueue(item: QueueItem): Promise<void> {
  const q = await getQueue();
  const i = q.findIndex(x => x.submission_id === item.submission_id);
  if (i >= 0) q[i] = item;
  else q.unshift(item);
  await saveQueue(q);
}

export async function dropQueueWire(submissionId: string): Promise<void> {
  const q = await getQueue();
  const i = q.findIndex(x => x.submission_id === submissionId);
  if (i < 0) return;
  q[i] = { ...q[i], wire: new ArrayBuffer(0) };
  await saveQueue(q);
}

export async function removeQueue(submissionId: string): Promise<void> {
  await saveQueue((await getQueue()).filter(x => x.submission_id !== submissionId));
}

export async function getLog(): Promise<LogItem[]> {
  return (await get<LogItem[]>(K.log)) || [];
}

export async function saveLog(log: LogItem[]): Promise<void> {
  await set(K.log, log.slice(0, 20));
}

export async function pushLog(entry: LogItem): Promise<void> {
  const log = await getLog();
  log.unshift(entry);
  await saveLog(log);
}

export async function markLog(createdAt: string, patch: Partial<LogItem>): Promise<void> {
  const log = await getLog();
  const i = log.findIndex(x => x.at === createdAt);
  if (i < 0) return;
  log[i] = { ...log[i], ...patch };
  await saveLog(log);
}
