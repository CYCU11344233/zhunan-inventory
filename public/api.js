/*
 * public/api.js — 呼叫後端的小工具
 *   api.get('/api/state')            讀資料
 *   api.post('/api/inbound', {...})  送資料
 * 後端回 400 / 500 時會丟出錯誤，錯誤訊息就是後端寫好的中文，呼叫端 catch 起來 toast(e.message) 即可。
 */
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `連線失敗（${res.status}）`);
  return data;
}
const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body || {}),
  put: (url, body) => request('PUT', url, body || {}),
  del: (url, body) => request('DELETE', url, body || {}),
};
