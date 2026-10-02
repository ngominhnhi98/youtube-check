"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Client-side Google OAuth via Google Identity Services (GIS) token flow.
 *
 * PRIVACY BY DESIGN: each browser holds its OWN short-lived Sheets access token
 * in localStorage. Nothing about the Google account is stored server-side, so
 * different users of the same app never share a Google identity. The token is
 * only sent to /api/run for that single request (server uses it as the Bearer
 * token for the Sheets API, then forgets it).
 *
 * The OAuth *client id* is public (NEXT_PUBLIC_GOOGLE_CLIENT_ID); no client
 * secret is involved. The OAuth client must list this site under
 * "Authorized JavaScript origins".
 */

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets email";
const STORE_KEY = "yc_gtoken";

interface StoredToken {
  accessToken: string;
  expiresAt: number;
  email: string | null;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  error?: string;
}

interface TokenClient {
  requestAccessToken: (opts?: { prompt?: string }) => void;
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (resp: TokenResponse) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

function loadStored(): StoredToken | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as StoredToken;
    if (!t.accessToken || t.expiresAt < Date.now() + 30_000) return null;
    return t;
  } catch {
    return null;
  }
}

export interface GoogleConnection {
  loading: boolean;
  configured: boolean;
  connected: boolean;
  email: string | null;
  connecting: boolean;
  connect: () => void;
  disconnect: () => void;
  refresh: () => void;
  /** Returns a valid access token (prompting if needed), or null. */
  getToken: () => Promise<string | null>;
}

export function useGoogleConnection(): GoogleConnection {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<StoredToken | null>(null);
  const [connecting, setConnecting] = useState(false);
  const clientRef = useRef<TokenClient | null>(null);
  const pendingRef = useRef<((t: string | null) => void) | null>(null);

  useEffect(() => {
    if (!CLIENT_ID) {
      setReady(true);
      return;
    }
    setToken(loadStored());
    if (window.google?.accounts?.oauth2) {
      setReady(true);
      return;
    }
    const existing = document.getElementById("gis-script");
    if (existing) {
      existing.addEventListener("load", () => setReady(true));
      return;
    }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.id = "gis-script";
    s.onload = () => setReady(true);
    document.body.appendChild(s);
  }, []);

  const initClient = useCallback(() => {
    if (clientRef.current || !window.google?.accounts?.oauth2) return;
    clientRef.current = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: async (resp: TokenResponse) => {
        setConnecting(false);
        if (resp.error || !resp.access_token) {
          pendingRef.current?.(null);
          pendingRef.current = null;
          return;
        }
        const expiresAt = Date.now() + resp.expires_in * 1000;
        let email: string | null = null;
        try {
          const info = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${resp.access_token}` },
          });
          if (info.ok) email = (await info.json())?.email ?? null;
        } catch {
          /* ignore */
        }
        const stored: StoredToken = { accessToken: resp.access_token, expiresAt, email };
        localStorage.setItem(STORE_KEY, JSON.stringify(stored));
        setToken(stored);
        pendingRef.current?.(resp.access_token);
        pendingRef.current = null;
      },
    });
  }, []);

  const connect = useCallback(() => {
    initClient();
    if (!clientRef.current) return;
    setConnecting(true);
    clientRef.current.requestAccessToken({ prompt: "consent" });
  }, [initClient]);

  const disconnect = useCallback(() => {
    localStorage.removeItem(STORE_KEY);
    setToken(null);
  }, []);

  const refresh = useCallback(() => setToken(loadStored()), []);

  const getToken = useCallback(async (): Promise<string | null> => {
    const fresh = loadStored();
    if (fresh) {
      setToken(fresh);
      return fresh.accessToken;
    }
    initClient();
    if (!clientRef.current) return null;
    return new Promise<string | null>((resolve) => {
      pendingRef.current = resolve;
      setConnecting(true);
      // Silent if already consented; falls back to a popup otherwise.
      clientRef.current!.requestAccessToken({ prompt: "" });
    });
  }, [initClient]);

  return {
    loading: !ready,
    configured: Boolean(CLIENT_ID),
    connected: Boolean(token && token.expiresAt > Date.now()),
    email: token?.email ?? null,
    connecting,
    connect,
    disconnect,
    refresh,
    getToken,
  };
}
