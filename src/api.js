// 后端 API 封装
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.status = res.status
    err.payload = data
    throw err
  }
  return data
}

export const api = {
  state: () => request('GET', '/api/state'),
  saveBody: (title, body) => request('PUT', '/api/documents/d1/body', { title, body }),
  scan: () => request('POST', '/api/documents/d1/scan'),
  scanView: (id) => request('GET', `/api/scans/${id}`),
  processAssets: (id) => request('POST', `/api/scans/${id}/process-assets`),
  exempt: (issueId, reason) => request('POST', `/api/issues/${issueId}/exempt`, { reason }),
  publish: (scanId, idempotencyKey) =>
    request('POST', '/api/documents/d1/publish', { scanId, idempotencyKey }),
  withdraw: (assetId, withdrawn) =>
    request('POST', `/api/assets/${encodeURIComponent(assetId)}/withdraw`, { withdrawn }),
  setComment: (id, open) => request('POST', `/api/comments/${id}/open`, { open }),
  setAuthor: (isAuthor) => request('POST', '/api/documents/d1/author', { isAuthor }),
  activateRule: (version, note) => request('POST', '/api/rules/activate', { version, note }),
  setDbOutage: (on) => request('POST', '/api/faults/db-outage', { on }),
}
