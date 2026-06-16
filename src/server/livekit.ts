import { randomUUID } from "node:crypto";

import { AccessToken } from "livekit-server-sdk";

import type { LiveKitStatus, LiveKitTokenRequest, LiveKitTokenResponse } from "../shared/types.js";

const DEFAULT_TOKEN_TTL_SECONDS = 30 * 60;

function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function liveKitUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue("LIVEKIT_URL", env);
}

function liveKitApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue("LIVEKIT_API_KEY", env);
}

function liveKitApiSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue("LIVEKIT_API_SECRET", env);
}

function tokenTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(envValue("MORTIC_LIVEKIT_TOKEN_TTL_SECONDS", env));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOKEN_TTL_SECONDS;
  return Math.max(60, Math.min(6 * 60 * 60, Math.floor(parsed)));
}

function safeRoomName(value: string | undefined): string {
  const clean = value?.trim().replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 96);
  return clean || `mortic-${randomUUID()}`;
}

function safeIdentity(value: string | undefined): string {
  const clean = value?.trim().replace(/[^A-Za-z0-9_.@-]/g, "-").slice(0, 96);
  return clean || `mortic-user-${randomUUID()}`;
}

export function getLiveKitStatus(env: NodeJS.ProcessEnv = process.env): LiveKitStatus {
  const configured = Boolean(liveKitUrl(env) && liveKitApiKey(env) && liveKitApiSecret(env));
  return {
    configured,
    url: configured ? liveKitUrl(env) : liveKitUrl(env),
    defaultTransport: configured ? "livekit-webrtc" : "local-browser",
    availableTransports: configured ? ["livekit-webrtc", "local-browser"] : ["local-browser"],
    error: configured ? undefined : "Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET to enable LiveKit WebRTC transport."
  };
}

export async function createLiveKitToken(
  request: LiveKitTokenRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<LiveKitTokenResponse> {
  const status = getLiveKitStatus(env);
  const url = liveKitUrl(env);
  const apiKey = liveKitApiKey(env);
  const apiSecret = liveKitApiSecret(env);
  if (!status.configured || !url || !apiKey || !apiSecret) {
    return {
      configured: false,
      url,
      error: status.error
    };
  }

  const roomName = safeRoomName(request.roomName);
  const identity = safeIdentity(request.identity);
  const ttl = tokenTtlSeconds(env);
  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    ttl
  });
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  });

  return {
    configured: true,
    url,
    token: await token.toJwt(),
    roomName,
    identity,
    expiresInSeconds: ttl
  };
}
