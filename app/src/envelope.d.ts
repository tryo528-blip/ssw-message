declare module '@ssw/envelope' {
  export const SCHEMA: string;
  export function ulid(now?: number): string;
  export function sha256hex(bytes: BufferSource): Promise<string>;
  export function packWire(x: { header: unknown; ct: Uint8Array }): Uint8Array;
  export function seal(opts: {
    inner: Record<string, unknown>;
    files?: Uint8Array[];
    officePubB64: string;
    keyId: string;
    deviceId: string;
    deviceSecret: string;
  }): Promise<{ header: Record<string, unknown>; ct: Uint8Array }>;
  export function signStatus(submissionId: string, deviceId: string, secretB64: string): Promise<string>;
}
