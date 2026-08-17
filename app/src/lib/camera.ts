import type { IosVerdict } from './types';

export function isAppleMobile(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** assume-leak 이면 웹 카메라는 C1을 지킬 수 없다. 두 번째 웹 촬영법은 없다. */
export function photoCaptureAllowed(iosVerdict: IosVerdict): boolean {
  if (!isAppleMobile()) return true;
  return iosVerdict !== 'assume-leak';
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
}

export async function openCamera(facing: 'environment' | 'user'): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false
  });
}

export async function captureFrame(video: HTMLVideoElement, maxEdge: number, quality = 0.8): Promise<{
  bytes: Uint8Array;
  w: number;
  h: number;
  thumb: HTMLCanvasElement;
}> {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) throw new Error('프리뷰 준비 중입니다');
  const sc = Math.min(1, maxEdge / Math.max(vw, vh));
  const w = Math.round(vw * sc), h = Math.round(vh * sc);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(video, 0, 0, w, h);
  const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('JPEG 인코딩 실패');
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const thumb = document.createElement('canvas');
  thumb.width = thumb.height = 128;
  const s = Math.min(w, h);
  thumb.getContext('2d')!.drawImage(c, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 128, 128);
  c.width = c.height = 0;
  return { bytes, w, h, thumb };
}
