import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionVault } from './vault.mjs';
export function createApp({ origin = process.env.APP_ORIGIN || 'http://localhost:3000', googleFetch = fetch, ttl } = {}) {
  const configured = new URL(origin);
  if (configured.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(configured.hostname)) throw new Error('HTTPS required');
  const vault = new SessionVault({ ttl }), sessions = new Map();
  const secure = configured.protocol === 'https:';
  const files = new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']],['/manifest.webmanifest',['manifest.webmanifest','application/manifest+json']],['/icon.svg',['icon.svg','image/svg+xml']]]);
  return http.createServer(async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy','camera=(), microphone=(self), geolocation=(self)');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://unpkg.com https://dapi.kakao.com https://t1.daumcdn.net https://t1.kakaocdn.net https://s1.daumcdn.net; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https://*.daumcdn.net https://*.kakaocdn.net https://*.kakao.com https://*.vworld.kr; connect-src 'self' https://*.kakao.com https://*.daum.net https://*.vworld.kr; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    const json = (status,data) => { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
    try {
      const path = new URL(req.url,origin).pathname;
      if (files.has(path) && req.method === 'GET') { const [file,type] = files.get(path); res.writeHead(200,{'Content-Type':type}); res.end(await readFile(new URL('./public/'+file,import.meta.url))); return; }
      if (!path.startsWith('/api/')) { json(404,{error:'찾을 수 없습니다.'}); return; }
      res.setHeader('Cache-Control','no-store');
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== configured.origin)) { json(403,{error:'허용되지 않은 요청입니다.'});return; }
      if (req.method !== 'GET' && req.headers.origin !== configured.origin) { json(403,{error:'요청 출처를 확인할 수 없습니다.'});return; }
      for (const [sid,s] of sessions) if(s.expires <= Date.now()) {sessions.delete(sid);vault.delete(sid);}
      const match = (req.headers.cookie || '').match(/(?:^|;\s*)sunny_session=([a-f0-9]{64})(?:;|$)/); let id = match?.[1], session = sessions.get(id);
      if (!session && path === '/api/session' && req.method === 'GET') {
        if(sessions.size>=500){json(503,{error:'잠시 후 다시 시도해주세요.'});return;}
        id=randomBytes(32).toString('hex'); session={expires:Date.now()+30*60_000,csrf:randomBytes(32).toString('hex'),window:Date.now(),calls:0};sessions.set(id,session);
        res.setHeader('Set-Cookie',`sunny_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800${secure?'; Secure':''}`);
      }
      if (!session) {json(401,{error:'설정 세션이 만료되었습니다. 페이지를 새로 열어주세요.'});return;}
      if(req.method!=='GET' && req.headers['x-csrf-token']!==session.csrf){json(403,{error:'요청을 확인할 수 없습니다.'});return;}
      if(path==='/api/session'&&req.method==='GET'){json(200,{csrf:session.csrf,connected:!!vault.get(id),expiresAt:session.expires,mapConfig:{kakao:process.env.KAKAO_JAVASCRIPT_KEY||'',vworld:process.env.VWORLD_API_KEY||''}});return;}
      if(Date.now()-session.window>60_000){session.calls=0;session.window=Date.now();}
      if(++session.calls>20){json(429,{error:'요청이 많습니다. 잠시 기다려주세요.'});return;}
      const readJson = async () => {if(!req.headers['content-type']?.startsWith('application/json'))throw Object.assign(new Error(),{status:415});let chunks=[],size=0;for await(const b of req){size+=b.length;if(size>8192)throw Object.assign(new Error(),{status:413});chunks.push(b);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw Object.assign(new Error(),{status:400});}};
      if(path==='/api/voice/key'&&req.method==='POST'){
        const {key}=await readJson();if(typeof key!=='string'||!/^AIza[A-Za-z0-9_-]{20,120}$/.test(key)){json(400,{error:'Google Cloud API 키 형식을 확인해주세요.'});return;}
        vault.put(id,key);json(200,{connected:true,message:'형식 확인 후 임시 보관했습니다. 실제 사용 가능 여부는 음성 재생 시 확인됩니다.'});return;
      }
      if(path==='/api/voice/key'&&req.method==='DELETE'){vault.delete(id);json(200,{connected:false});return;}
      if(path==='/api/voice/speak'&&req.method==='POST'){
        const {text}=await readJson();if(typeof text!=='string'||!text.trim()||text.length>800){json(400,{error:'음성 문장은 1~800자로 입력해주세요.'});return;}
        const key=vault.get(id);if(!key){json(409,{error:'고급 음성 키가 없거나 만료되었습니다.'});return;}
        let upstream;try{upstream=await googleFetch('https://texttospeech.googleapis.com/v1/text:synthesize',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify({input:{text},voice:{languageCode:'ko-KR',ssmlGender:'FEMALE'},audioConfig:{audioEncoding:'MP3',speakingRate:0.9}}),signal:AbortSignal.timeout(15000)});}catch{json(502,{error:'음성 서비스에 연결하지 못했습니다.'});return;}
        if(!upstream.ok){json(502,{error:'Google 음성을 사용할 수 없습니다. API 활성화·결제·키 제한을 확인해주세요.'});return;}
        const data=await upstream.json();if(typeof data.audioContent!=='string'||data.audioContent.length>2_000_000){json(502,{error:'음성 응답을 확인하지 못했습니다.'});return;}
        json(200,{audioContent:data.audioContent});return;
      }
      json(404,{error:'지원하지 않는 요청입니다.'});
    } catch(e){if(!res.headersSent)json(e.status||500,{error:'요청을 처리하지 못했습니다.'});else res.end();}
  });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const port=Number(process.env.PORT||3000);createApp().listen(port,'0.0.0.0',()=>console.log(`Sunny SAI listening on port ${port}`));}
