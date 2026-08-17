import jsQR from 'jsqr';

export async function scanQrOnce(video: HTMLVideoElement): Promise<string | null> {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return null;

  const BD = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (s: ImageBitmapSource) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  if (typeof BD === 'function') {
    try {
      const det = new BD({ formats: ['qr_code'] });
      const found = await det.detect(video);
      if (found[0]?.rawValue) return found[0].rawValue;
    } catch { /* 폴백 */ }
  }

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(video, 0, 0);
  const img = c.getContext('2d')!.getImageData(0, 0, w, h);
  c.width = c.height = 0;
  const r = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
  return r?.data || null;
}
