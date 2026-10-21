export function assess(f){
 if(!f)return {kind:'unknown',icon:'◌',title:'예보를 확인하지 못했어요',text:'자료가 없거나 예보 범위를 벗어났습니다. 추가 확인이 필요합니다.'};
 const flags=[];
 if(typeof f.rain==='number'&&f.rain>=5)flags.push(`시간당 강수량 ${f.rain.toFixed(1)} mm 예보`);
 if(typeof f.gust==='number'&&f.gust>=14)flags.push(`순간풍속 ${f.gust.toFixed(1)} m/s 예보`);
 if(typeof f.visibility==='number'&&f.visibility<1000)flags.push(`모델 가시거리 ${Math.round(f.visibility)} m`);
 if(flags.length)return {kind:'attention',icon:'☂',title:'출발 전 확인할 기상조건',text:flags.join(' · ')+'. 실제 도로상태는 별도 확인하세요.'};
 const values=[];if(typeof f.temperature==='number')values.push(`${Math.round(f.temperature)}°C`);if(typeof f.rain==='number')values.push(`강수 ${f.rain.toFixed(1)} mm/h`);if(typeof f.gust==='number')values.push(`돌풍 ${f.gust.toFixed(1)} m/s`);
 const missing=['rain','gust','visibility'].some(k=>typeof f[k]!=='number');
 return {kind:missing?'unknown':'normal',icon:missing?'◌':'☁',title:missing?'일부 예보 항목 확인 필요':'구간별 모델 예보',text:values.join(' · ')+(missing?' · 일부 항목 결측':' · 현재 설정한 알림 기준 미해당')};
}
export class AlertGate { constructor(){this.seen=new Set();} take(id){if(this.seen.has(id))return false;this.seen.add(id);return true;} reset(){this.seen.clear();} }
