// /api/proxy.js — Vercel (Node runtime, bukan Edge)
export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,User-Agent,Referer');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const target = (req.query.u || req.query.url || '').toString();
  if (!target) return res.status(400).json({ ok:false, error:'missing ?u=' });

  try {
    const t = new URL(target);
    if (!/^https?:$/.test(t.protocol)) throw new Error('protocol not allowed');
    const host = t.hostname;
    if (
      host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') ||
      /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
      host === '0.0.0.0'
    ) throw new Error('local address blocked');

    const r = await fetch(t.toString(), {
      headers: {
        'user-agent': req.headers['user-agent'] ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept': req.headers['accept'] || '*/*',
        'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      cache: 'no-store'
    });

    const ab = await r.arrayBuffer();
    const type = r.headers.get('content-type') || 'application/octet-stream';

    const headers = {};
    for (const [k,v] of r.headers.entries()) headers[k.toLowerCase()] = v;
    delete headers['content-security-policy'];
    delete headers['x-frame-options'];
    delete headers['cross-origin-embedder-policy'];
    delete headers['cross-origin-opener-policy'];
    delete headers['cross-origin-resource-policy'];
    delete headers['content-security-policy-report-only'];

    if (type.includes('text/html')) {
      let html = new TextDecoder(getCharset(type)).decode(new Uint8Array(ab));
      html = injectBase(html, t.toString());
      html = rewriteAttrs(html, t);
      html = rewriteCssUrls(html, t);
      html = rewriteMetaRefresh(html, t);
      if (!/<meta[^>]+charset=/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, m => `${m}\n<meta charset="utf-8">`);
      }
      res.status(r.status);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      for (const k in headers) if (k !== 'content-type') res.setHeader(hname(k), headers[k]);
      return res.send(html);
    }

    res.status(r.status);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    for (const k in headers) if (k !== 'content-type') res.setHeader(hname(k), headers[k]);
    return res.send(Buffer.from(ab));
  } catch (e) {
    return res.status(502).json({ ok:false, error:'fetch_failed', detail:String(e?.message||e) });
  }
}

function hname(k){ return k.split('-').map(s=>s[0]?.toUpperCase()+s.slice(1)).join('-'); }
function getCharset(ct){ const m = ct.match(/charset=([^;]+)/i); return m ? m[1].trim() : 'utf-8'; }
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function injectBase(html, baseUrl){
  if (/<base\s/i.test(html)) return html;
  return html.replace(/<head[^>]*>/i, m => `${m}\n<base href="${escapeHtml(baseUrl)}">`);
}
function rewriteAttrs(html, base){
  const attrs = ['href','src','action','poster','data-src'];
  for (const a of attrs) {
    html = html.replace(new RegExp(`(${a}\\s*=\\s*")(.*?)"`, 'ig'), (all,p1,val)=>`${p1}${proxify(val, base)}"`);
    html = html.replace(new RegExp(`(${a}\\s*=\\s*')(.*?)'`, 'ig'), (all,p1,val)=>`${p1}${proxify(val, base)}'`);
  }
  return html;
}
function rewriteCssUrls(html, base){
  return html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/ig, (m,q,val)=>`url("${proxify(val, base)}")`);
}
function rewriteMetaRefresh(html, base){
  return html.replace(/<meta[^>]+http-equiv=["']refresh["'][^>]*>/ig, (tag)=>{
    const m = tag.match(/content=["']\s*\d+\s*;\s*url=([^"']+)["']/i);
    if (!m) return tag;
    const url = m[1];
    return tag.replace(url, proxify(url, base));
  });
}
function proxify(val, base){
  val = (val||'').trim();
  if (!val) return val;
  if (val.startsWith('data:') || val.startsWith('about:') || val.startsWith('javascript:') || val.startsWith('mailto:') || val.startsWith('tel:')) return val;
  let abs; try { abs = new URL(val, base).toString(); } catch { return val; }
  return '/api/proxy?u=' + encodeURIComponent(abs);
}  return html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/ig, (m, q, val) => `url("${proxify(val, base)}")`);
}

function rewriteMetaRefresh(html, base){
  // <meta http-equiv="refresh" content="3; url=/next">
  return html.replace(/<meta[^>]+http-equiv=["']refresh["'][^>]*>/ig, (tag)=>{
    const m = tag.match(/content=["']\s*\d+\s*;\s*url=([^"']+)["']/i);
    if (!m) return tag;
    const url = m[1];
    const newUrl = proxify(url, base);
    return tag.replace(url, newUrl);
  });
}

function proxify(val, base){
  val = (val||'').trim();
  if (!val) return val;
  // abaikan skema yang bukan web
  if (val.startsWith('data:') || val.startsWith('about:') || val.startsWith('javascript:') || val.startsWith('mailto:') || val.startsWith('tel:')) return val;
  let abs;
  try { abs = new URL(val, base).toString(); } catch { return val; }
  return '/api/proxy?u=' + encodeURIComponent(abs);
}
