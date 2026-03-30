import axios from 'axios';
import { config } from '../config.js';

const LOGIN_URL = 'https://identitysso.betfair.com/api/login';

interface LoginResponse {
  token: string;
  status: string;
  error: string;
}

let sessionToken: string | null = null;
let sessionExpiry: Date | null = null;

export async function login(): Promise<string> {
  const params = new URLSearchParams();
  params.append('username', config.betfair.username);
  params.append('password', config.betfair.password);

  const response = await axios.post<LoginResponse>(LOGIN_URL, params.toString(), {
    headers: {
      'X-Application': config.betfair.appKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  if (response.data.status !== 'SUCCESS') {
    throw new Error(`Betfair login failed: ${response.data.error || response.data.status}`);
  }

  sessionToken = response.data.token;
  // Betfair sessions expire after 4 hours; renew at 3.5 hours
  sessionExpiry = new Date(Date.now() + 3.5 * 60 * 60 * 1000);

  console.log('[Auth] Betfair login successful');
  return sessionToken;
}

export async function getSessionToken(): Promise<string> {
  if (!sessionToken || !sessionExpiry || new Date() >= sessionExpiry) {
    await login();
  }
  return sessionToken!;
}

export function clearSession(): void {
  sessionToken = null;
  sessionExpiry = null;
}
