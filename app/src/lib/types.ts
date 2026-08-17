export type Screen = 'home' | 'memo' | 'camera' | 'settings' | 'queue';

export type Category = 'TODO' | 'AS' | 'QUOTE' | 'PURCHASE' | 'ETC';

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'TODO', label: '할일' },
  { id: 'AS', label: 'AS' },
  { id: 'QUOTE', label: '견적' },
  { id: 'PURCHASE', label: '구매' },
  { id: 'ETC', label: '기타' }
];

export type Provision = {
  v: number;
  url: string;
  device_id: string;
  secret: string;
  key_id: string;
  pub: string;
  user: string;
};

/** 아이폰 실기 전 가정. 실측이 오면 이 값만 바꾸면 된다. */
export type IosVerdict = 'assume-safe' | 'assume-leak';

export type Settings = {
  site: string;
  maxEdge: 1200 | 1600 | 2200;
  iosVerdict: IosVerdict;
};

export type QueueStatus = 'queued' | 'sent' | 'verified' | 'rejected' | 'expired';

export type QueueItem = {
  submission_id: string;
  created_at: string;
  kind: 'memo' | 'photo';
  label: string;
  wire: ArrayBuffer;
  status: QueueStatus;
  error?: string;
};

export type LogItem = {
  at: string;
  kind: 'memo' | 'photo';
  label: string;
  ok: boolean;
  pending?: boolean;
};

export const APP_VER = '0.1.0';
/** 7일 넘으면 경고만. 확인 전에는 자동 삭제하지 않음. PIPELINE §5 */
export const QUEUE_WARN_MS = 7 * 24 * 60 * 60 * 1000;
export const STATUS_POLL_MS = 1000;
export const STATUS_POLL_MAX_MS = 15_000;
export const MEMO_MAX = 2000;
export const PHOTO_MAX = 5;
