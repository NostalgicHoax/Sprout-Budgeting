import { api } from './api.js';

// Passkey helpers. Registration requires the WebAuthn PRF extension: the
// authenticator-derived PRF output wraps the user's data key, which is what
// lets a passkey unlock encrypted budgets without a password.

const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
};

const PRF_SALT = new TextEncoder().encode('budget-app-dek-wrap-v1');

export function passkeysSupported() {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential;
}

export async function registerPasskey(name) {
  const options = await api('/api/auth/webauthn/register-options', { method: 'POST', body: {} });
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: b64u.dec(options.challenge),
      user: { ...options.user, id: b64u.dec(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map(c => ({ ...c, id: b64u.dec(c.id) })),
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  if (!cred) throw new Error('Passkey creation was cancelled');

  let prf = cred.getClientExtensionResults().prf?.results?.first;
  if (!prf) {
    // some platforms only release PRF output on an assertion, not at creation
    const probe = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: cred.rawId }],
        userVerification: 'preferred',
        extensions: { prf: { eval: { first: PRF_SALT } } },
      },
    });
    prf = probe?.getClientExtensionResults().prf?.results?.first;
  }
  if (!prf) {
    throw new Error('This device can\'t be used as a passkey here. Try Windows Hello, your phone, or a security key.');
  }

  return api('/api/auth/webauthn/register-verify', {
    method: 'POST',
    body: {
      name,
      prfOutput: b64u.enc(prf),
      attResp: {
        id: cred.id,
        rawId: b64u.enc(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: b64u.enc(cred.response.clientDataJSON),
          attestationObject: b64u.enc(cred.response.attestationObject),
          transports: cred.response.getTransports?.() ?? [],
        },
        clientExtensionResults: {},
      },
    },
  });
}

export async function passkeyLogin() {
  const { flowId, options } = await api('/api/auth/webauthn/login-options', { method: 'POST', body: {} });
  const assertion = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: b64u.dec(options.challenge),
      allowCredentials: undefined, // discoverable credential picker
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  if (!assertion) throw new Error('Passkey sign-in was cancelled');
  const prf = assertion.getClientExtensionResults().prf?.results?.first;

  return api('/api/auth/webauthn/login-verify', {
    method: 'POST',
    body: {
      flowId,
      prfOutput: prf ? b64u.enc(prf) : null,
      assertion: {
        id: assertion.id,
        rawId: b64u.enc(assertion.rawId),
        type: assertion.type,
        response: {
          clientDataJSON: b64u.enc(assertion.response.clientDataJSON),
          authenticatorData: b64u.enc(assertion.response.authenticatorData),
          signature: b64u.enc(assertion.response.signature),
          userHandle: assertion.response.userHandle ? b64u.enc(assertion.response.userHandle) : null,
        },
        clientExtensionResults: {},
      },
    },
  });
}
