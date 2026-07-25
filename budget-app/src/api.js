export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let data = null;
    try {
      data = await res.json();
      if (data.error) msg = data.error;
    } catch { /* non-JSON error body */ }
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return res.json();
}
