// "Sign in with Google": check the ID token the browser got from Google.
// Google's tokeninfo endpoint checks the signature for us; we check that the
// token was made for this game (aud), by Google (iss) and hasn't expired.
// Only the account id (sub) and first name are used; the email is never stored.

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/** Returns {sub, name} or null. */
export async function verifyGoogleToken(credential, clientId, fetchFn = fetch) {
  if (!clientId || typeof credential !== 'string' || credential.length > 4000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(credential)) return null;
  try {
    const res = await fetchFn(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const t = await res.json();
    if (t.aud !== clientId || !ISSUERS.has(t.iss) || !(Number(t.exp) * 1000 > Date.now()) || typeof t.sub !== 'string' || !t.sub) return null;
    return { sub: t.sub, name: String(t.given_name || t.name || '').slice(0, 30) };
  } catch {
    return null;
  }
}
