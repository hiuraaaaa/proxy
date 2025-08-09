// /api/proxy.js — CommonJS, tuned for sites like mangaku
async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,User-Agent,Referer,Cookie');
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

    // ----- Header “mirip browser” + Indonesia -----
    const userAgent =
      req.headers['user-agent'] ||
      'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
    const accept = req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    const acceptLang = req.headers['accept-language'] || 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7';

    // Kamu bisa pakai ?ck=<cookie-string> buat nembak cookie manual kalau perlu
    const cookieFromQuery = (req.query.ck || req.query.cookie || '').toString();
    const cookieHeader = cookieFromQuery || ''; // browser TIDAK akan kirim cookie situs target ke domain kamu

    // Beberapa situs minta referer = origin mereka
    const referer = req.query.ref ? String(req.query.ref) : t.origin + '/';

    const forwardedHeaders = {
      'user-agent': userAgent,
      'accept': accept,
      'accept-language': acceptLang,
      'referer': referer,
      'upgrade-insecure-requests': '1',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-user': '?1',
      'sec-fetch-dest': 'document',
      // jangan kirim accept-encoding biar server kirim bentuk mudah didecode
    };
    if (cookieHeader) forwardedHeaders['cookie'] = cookieHeader;
    if (req.headers['authorization']) forwardedHeaders['authorization'] = req.headers['authorization'];

    const r = await fetch(t.toString(), {
      headers: forwardedHeaders,
      redirect: 'follow',
      cache: 'no-store'
    });

    const ab = await r.arrayBuffer();
    const type = r.headers.get('content-type') || 'application/octet-stream';

    // Clone & buang header “penghalang”
    const headers = {};
    for (const [k, v] of r.headers.entries()) headers[k.toLowerCase()] = v;
    delete headers['content-security-policy'];
    delete headers['x-frame-options'];
    delete headers['cross-origin-embedder-policy'];
    delete headers['cross-origin-opener-policy'];
    delete headers['cross-origin-resource-policy'];
    delete headers['content-security-policy-report-only'];

    if (type.includes('text/html')) {
      let html = new TextDecoder(getCharset(type)).decode(new Uint8Array(ab));

      // inject <base> + rewrite semua URL → lewat proxy
      html = injectBase(html, t.toString());
      html = rewriteAttrs(html, t);
      html = rewriteCssUrls(html, t);
      html = rewriteMetaRefresh(html, t);

      // (opsional) tambahkan polyfill kecil agar fetch/XHR di client juga lewat proxy
      html = injectClientHook(html, t.origin);

      if (!/<meta[^>]+charset=/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, m => `${m}\n<meta charset="utf-8">`);
      }

      res.status(r.status);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      for (const k in headers) if (k !== 'content-type') res.setHeader(hname(k), headers[k]);
      return res.send(html);
    }

    // Non-HTML passthrough (gambar, JS, CSS, video)
    res.status(r.status);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    for (const k in headers) if (k !== 'content-type') res.setHeader(hname(k), headers[k]);
    return res.send(Buffer.from(ab));
  } catch (e) {
    return res.status(502).json({ ok:false, error:'fetch_failed', detail:String(e?.message||e) });
  }
}

module.exports = handler;
module.exports.config = { runtime: 'nodejs' };

/* ===== helpers ===== */
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
}

// Hook ringan supaya fetch/XHR di halaman target tetap lewat proxy
function injectClientHook(html, origin){
  const script = `
<script>
(()=>{try{
  const BASE='${locationOriginSafe()}';
  const P='/api/proxy?u=';
  const toProxy=u=>{try{
    if(!u) return u;
    if(u.startsWith('data:')||u.startsWith('about:')||u.startsWith('javascript:')||u.startsWith('mailto:')||u.startsWith('tel:')) return u;
    const abs=new URL(u, '${origin}').toString();
    return P+encodeURIComponent(abs);
  }catch{return u;}};

  // patch fetch
  const _f=window.fetch;
  window.fetch=function(input, init){
    try{
      const url=typeof input==='string'?input:(input&&input.url)||'';
      return _f.call(this, toProxy(url), init);
    }catch(e){ return _f.call(this, input, init); }
  };

  // patch XHR (open)
  const XO=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u,...rest){
    try{ return XO.call(this, m, toProxy(u), ...rest); }
    catch(e){ return XO.call(this, m, u, ...rest); }
  };
}catch(e){}})();
</script>`;
  // sisipkan sebelum </body> (atau di akhir <head> kalau tak ada body)
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, script + '\n</body>');
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, script + '\n</head>');
  return html + script;
}
// helper untuk origin saat disajikan (hindari undefined di server)
function locationOriginSafe(){ try{return (globalThis.location&&location.origin)||'';}catch{return '';} }
