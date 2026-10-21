const encoder = new TextEncoder(), decoder = new TextDecoder();
const windows = new Map();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const unb64 = s => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')), c=>c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(24)));
export async function seal(value, secret, purpose) {
  const key = await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(secret)),{name:'AES-GCM'},false,['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(purpose)},key,encoder.encode(JSON.stringify(value)));
  return b64(iv)+'.'+b64(bytes);
}
export async function unseal(token,secret,purpose) {
  try { const [iv,data,...extra] = token.split('.'); if(extra.length||token.length>4096)return null;
    const key = await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(secret)),{name:'AES-GCM'},false,['decrypt']);
    const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:encoder.encode(purpose)},key,unb64(data));
    const result = JSON.parse(decoder.decode(plain)); return result.exp>Date.now()?result:null;
  } catch { return null; }
}
function cookie(req,name) {return (req.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';}
function setCookie(name,value,secure,age=1800){return `${name}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;}
function limit(id,max=35){const now=Date.now();for(const[k,v]of windows)if(now-v.time>60000)windows.delete(k);let v=windows.get(id);if(!v){if(windows.size>3000)return false;v={time:now,n:0};windows.set(id,v);}return ++v.n<=max;}
const coord = p => p && typeof p.lat==='number' && typeof p.lng==='number' && Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&p.lat>=32&&p.lat<=40&&p.lng>=123&&p.lng<=133;
const json = (status,data,headers={}) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers}});
async function body(req){if(!req.headers.get('content-type')?.startsWith('application/json'))throw Object.assign(Error(),{status:415});let size=0,chunks=[];const reader=req.body?.getReader();if(!reader)throw Object.assign(Error(),{status:400});while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16000){await reader.cancel();throw Object.assign(Error(),{status:413});}chunks.push(value);}let all=new Uint8Array(size),i=0;for(const c of chunks){all.set(c,i);i+=c.length;}try{return JSON.parse(decoder.decode(all));}catch{throw Object.assign(Error(),{status:400});}}
async function upstream(url,options={},fetcher=fetch){const r=await fetcher(url,{...options,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Object.assign(Error(),{status:502});return r.json();}
export function routeSamples(route, departure) {
 const roads=route.sections?.flatMap(s=>s.roads||[])||[];let elapsed=0,dist=0,points=[],vertices=[];
 for(const r of roads){const v=r.vertexes||[];const part=[];for(let i=0;i+1<v.length;i+=2){const p={lng:v[i],lat:v[i+1]};if(coord(p)){part.push(p);vertices.push(p);}}
 if(part.length)points.push({label:r.name||'경로 구간',...part[Math.floor(part.length/2)],seconds:elapsed+Number(r.duration||0)/2,distance:dist+Number(r.distance||0)/2});elapsed+=Number(r.duration||0);dist+=Number(r.distance||0);}
 if(!points.length)throw Object.assign(Error(),{status:502});
 const count=Math.min(5,points.length),used=new Set(),samples=[];
 for(let i=0;i<count;i++){const target=(i+.5)*elapsed/count;const idx=points.reduce((best,p,j)=>Math.abs(p.seconds-target)<Math.abs(points[best].seconds-target)?j:best,0);if(used.has(idx))continue;used.add(idx);const p=points[idx];samples.push({...p,eta:new Date(departure+p.seconds*1000).toISOString()});}
 return {vertices:vertices.filter((_,i)=>i%Math.max(1,Math.ceil(vertices.length/3500))===0||i===vertices.length-1),samples,distance:route.summary.distance,duration:route.summary.duration,departure:new Date(departure).toISOString(),source:'Kakao Mobility',fetchedAt:new Date().toISOString(),etaMethod:'도로별 예상 소요시간 누적 · 교통상황에 따라 변동'};
}
export function matchForecast(data,eta){const h=data?.hourly;const ts=Date.parse(eta)/1000;if(!h?.time?.length||!Number.isFinite(ts))return null;let idx=h.time.reduce((best,t,i)=>Math.abs(t-ts)<Math.abs(h.time[best]-ts)?i:best,0);if(Math.abs(h.time[idx]-ts)>3600)return null;const read=k=>typeof h[k]?.[idx]==='number'&&Number.isFinite(h[k][idx])?h[k][idx]:null;return {time:new Date(h.time[idx]*1000).toISOString(),temperature:read('temperature_2m'),rain:read('precipitation'),gust:read('wind_gusts_10m'),visibility:read('visibility')};}
export async function handle(req,env={},fetcher=fetch){
 const path=new URL(req.url).pathname;
 const origin=env.APP_ORIGIN||new URL(req.url).origin,secure=origin.startsWith('https:'),secret=env.SESSION_SECRET;
 try{
 const configured=new URL(origin);if(configured.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(configured.hostname))return json(503,{error:'HTTPS 배포 설정이 필요합니다.'});
 if(req.headers.get('sec-fetch-site')==='cross-site'||(req.headers.get('origin')&&req.headers.get('origin')!==origin))return json(403,{error:'허용되지 않은 요청입니다.'});
 if(req.method!=='GET'&&req.headers.get('origin')!==origin)return json(403,{error:'요청 출처를 확인하지 못했습니다.'});
 if(!secret||secret.length<43)return json(503,{error:'운영자 보안 설정을 준비 중입니다. 시연과 기본 음성은 사용할 수 있습니다.'});
 const uid=req.headers.get('oai-authenticated-user-id')||'local-browser';
 let session=await unseal(cookie(req,'sunny_session'),secret,'session');
 if(session?.uid!==uid)session=null;
 if(path==='/api/session'&&req.method==='GET'){
 let created=false;if(!session){created=true;session={sid:random(),csrf:random(),uid,exp:Date.now()+1800000};}
 const voice=await unseal(cookie(req,'sunny_voice'),secret,'voice:'+session.sid+':'+uid);
 const result=json(200,{csrf:session.csrf,connected:!!voice,expiresAt:session.exp,mapConfig:{kakao:env.KAKAO_JAVASCRIPT_KEY||'',vworld:env.VWORLD_API_KEY||''},connections:{route:!!env.KAKAO_REST_API_KEY,weather:true,gk2a:false,road:false,terrain:false},voiceStorage:'암호화된 HttpOnly 쿠키 · 최대 30분'});
 if(created)result.headers.append('Set-Cookie',setCookie('sunny_session',await seal(session,secret,'session'),secure));return result;
 }
 if(!session)return json(401,{error:'세션이 만료되었습니다. 페이지를 새로 열어주세요.'});
 if(req.method!=='GET'&&req.headers.get('x-csrf-token')!==session.csrf)return json(403,{error:'요청을 확인하지 못했습니다.'});
 if(!limit(session.sid))return json(429,{error:'요청이 많습니다. 1분 뒤 다시 시도해주세요.'});
 if(path==='/api/voice/key'&&req.method==='POST'){const {key}=await body(req);if(typeof key!=='string'||!/^AIza[A-Za-z0-9_-]{20,120}$/.test(key))return json(400,{error:'Google Cloud API 키 형식을 확인해주세요.'});const token=await seal({key,exp:session.exp},secret,'voice:'+session.sid+':'+uid);return json(200,{connected:true,message:'암호화해 임시 연결했습니다. 실제 사용 가능 여부는 음성 재생 시 확인됩니다.'},{'Set-Cookie':setCookie('sunny_voice',token,secure,Math.max(0,Math.floor((session.exp-Date.now())/1000)))});}
 if(path==='/api/voice/key'&&req.method==='DELETE')return json(200,{connected:false},{'Set-Cookie':setCookie('sunny_voice','',secure,0)});
 if(path==='/api/voice/speak'&&req.method==='POST'){const {text,rate}=await body(req);if(typeof text!=='string'||!text.trim()||text.length>800)return json(400,{error:'음성 문장은 1~800자로 입력해주세요.'});const voice=await unseal(cookie(req,'sunny_voice'),secret,'voice:'+session.sid+':'+uid);if(!voice)return json(409,{error:'고급 음성이 연결되지 않았거나 만료되었습니다.'});let data;try{data=await upstream('https://texttospeech.googleapis.com/v1/text:synthesize',{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':voice.key},body:JSON.stringify({input:{text},voice:{languageCode:'ko-KR',ssmlGender:'FEMALE'},audioConfig:{audioEncoding:'MP3',speakingRate:typeof rate==='number'?Math.max(.7,Math.min(1.3,rate)):1}})},fetcher);}catch{return json(502,{error:'Google 음성을 사용할 수 없습니다. 키 제한·API 활성화·할당량을 확인해주세요.'});}if(typeof data.audioContent!=='string'||data.audioContent.length>2000000)return json(502,{error:'음성 응답을 확인하지 못했습니다.'});return json(200,{audioContent:data.audioContent});}
 if(path==='/api/search'&&req.method==='POST'){if(!env.KAKAO_REST_API_KEY)return json(503,{error:'카카오 REST 키가 아직 연결되지 않았습니다. 진천 → 서울 시연을 이용해주세요.'});const {query}=await body(req);if(typeof query!=='string'||!query.trim()||query.length>100)return json(400,{error:'검색어를 확인해주세요.'});const url=new URL('https://dapi.kakao.com/v2/local/search/keyword.json');url.searchParams.set('query',query.trim());url.searchParams.set('size','5');const d=await upstream(url.toString(),{headers:{Authorization:'KakaoAK '+env.KAKAO_REST_API_KEY}},fetcher);return json(200,{places:(d.documents||[]).map(p=>({name:p.place_name,address:p.road_address_name||p.address_name,lat:Number(p.y),lng:Number(p.x)})).filter(coord)});}
 if(path==='/api/route'&&req.method==='POST'){if(!env.KAKAO_REST_API_KEY)return json(503,{error:'운영자의 카카오 길찾기 REST 키 연결이 필요합니다.'});const {origin:start,destination,departure}=await body(req);if(!coord(start)||!coord(destination))return json(400,{error:'대한민국 내 출발지와 목적지를 다시 선택해주세요.'});const time=Date.parse(departure);if(!Number.isFinite(time)||time<Date.now()-600000||time>Date.now()+86400000)return json(400,{error:'출발시각은 지금부터 24시간 이내로 선택해주세요.'});const future=time>Date.now()+900000;const url=new URL('https://apis-navi.kakaomobility.com/v1/'+(future?'future/directions':'directions'));url.searchParams.set('origin',start.lng+','+start.lat);url.searchParams.set('destination',destination.lng+','+destination.lat);url.searchParams.set('priority','RECOMMEND');url.searchParams.set('summary','false');if(future){const kst=new Date(time+9*3600000).toISOString();url.searchParams.set('departure_time',kst.slice(0,10).replaceAll('-','')+kst.slice(11,16).replaceAll(':',''));}const d=await upstream(url.toString(),{headers:{Authorization:'KakaoAK '+env.KAKAO_REST_API_KEY}},fetcher);const r=d.routes?.find(r=>r.result_code===0);if(!r)return json(422,{error:'차량 경로를 찾지 못했습니다. 장소와 출발시각을 확인해주세요.'});return json(200,routeSamples(r,time));}
 if(path==='/api/weather'&&req.method==='POST'){const {samples}=await body(req);if(!Array.isArray(samples)||!samples.length||samples.length>5||samples.some(p=>!coord(p)||!Number.isFinite(Date.parse(p.eta))||Math.abs(Date.parse(p.eta)-Date.now())>2*86400000))return json(400,{error:'경로와 예보시각을 확인해주세요.'});const results=await Promise.all(samples.map(async p=>{try{const url=new URL('https://api.open-meteo.com/v1/forecast');Object.entries({latitude:p.lat,longitude:p.lng,hourly:'temperature_2m,precipitation,wind_gusts_10m,visibility',forecast_days:3,timeformat:'unixtime',timezone:'GMT',wind_speed_unit:'ms'}).forEach(([k,v])=>url.searchParams.set(k,String(v)));const data=await upstream(url.toString(),{},fetcher);const forecast=matchForecast(data,p.eta);return{...p,forecast,status:forecast?'forecast':'unavailable'};}catch{return{...p,forecast:null,status:'unavailable'};}}));return json(200,{samples:results,source:'Open-Meteo · 모델 예보',sourceUrl:'https://open-meteo.com/',license:'CC BY 4.0',fetchedAt:new Date().toISOString(),caution:'시간당 강수량·모델 격자 예보이며 실제 도로상태나 공식 특보가 아닙니다.'});}
 return json(404,{error:'지원하지 않는 요청입니다.'});
 }catch(e){return json(e.status||502,{error:e.status===413?'입력 크기를 초과했습니다.':'요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.'});}
}
