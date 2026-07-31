import { resolveBrandEnv } from '../../config/converact-env.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface MediaInviteInput {
  tenantId: string;
  roomName: string;
  role: 'customer';
  media: 'voice' | 'video';
  expiresAt?: string | number;
}

export interface MediaInviteToken {
  invite: string;
  expires_at: string;
}

const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

function inviteSecret(): string {
  return resolveBrandEnv(process.env, 'MEDIA_INVITE_SECRET') || process.env.LIVEKIT_MEDIA_INVITE_SECRET || '';
}

function inviteTtlMs(): number {
  const value = Number(resolveBrandEnv(process.env, 'MEDIA_INVITE_TTL_MS') || DEFAULT_INVITE_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INVITE_TTL_MS;
}

function invitePayload(input: Required<MediaInviteInput>): string {
  return [input.tenantId, input.roomName, input.role, input.media, input.expiresAt].join('\n');
}

function signInvite(secret: string, input: Required<MediaInviteInput>): string {
  return createHmac('sha256', secret).update(invitePayload(input)).digest('base64url');
}

export function isMediaInviteConfigured(): boolean {
  return Boolean(inviteSecret());
}

export function createMediaInvite(input: MediaInviteInput): MediaInviteToken | null {
  const secret = inviteSecret();
  if (!secret) return null;
  const expiresAt = String(input.expiresAt || Date.now() + inviteTtlMs());
  return {
    expires_at: expiresAt,
    invite: signInvite(secret, { ...input, expiresAt })
  };
}

export function verifyMediaInvite(
  input: MediaInviteInput & { invite?: string | null; expiresAt?: string | number | null }
): boolean {
  const secret = inviteSecret();
  if (!secret) return true;
  if (!input.invite || !input.expiresAt) return false;

  const expiresAt = String(input.expiresAt);
  const expiresAtMs = Number(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false;

  const expected = signInvite(secret, {
    tenantId: input.tenantId,
    roomName: input.roomName,
    role: input.role,
    media: input.media,
    expiresAt
  });
  const actualBuffer = Buffer.from(input.invite);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
