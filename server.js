'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),mqtt=require('mqtt');
const need=['MQTT_HOST','MQTT_USER','MQTT_PASS','WEB_USER','WEB_PASS','PUBLIC_ORIGIN'];
for(const k of need)if(!process.env[k]){console.error('Missing '+k);process.exit(1);}
const origin=new URL(process.env.PUBLIC_ORIGIN).origin;
if(!origin.startsWith('https://')&&!origin.startsWith('http://localhost')){console.error('PUBLIC_ORIGIN must use HTTPS (except localhost)');process.exit(1);}
const TOP='maxdream_uf_system/';
const mc=mqtt.connect('mqtts://'+process.env.MQTT_HOST+':'+(process.env.MQTT_PORT||8883),{
 username:process.env.MQTT_USER,password:process.env.MQTT_PASS,
 clientId:'maxdream_web_'+crypto.randomBytes(6).toString('hex'),rejectUnauthorized:true,
 reconnectPeriod:5000,connectTimeout:12000,clean:true
});
let connected=false,telemetry=null,status=null,telemetryAt=0,statusAt=0,lastSent=0;
mc.on('connect',()=>{connected=true;mc.subscribe([TOP+'data',TOP+'status']);});
mc.on('close',()=>{connected=false;});mc.on('error',e=>console.error('MQTT:',e.message));
mc.on('message',(topic,payload)=>{if(payload.length>8192)return;try{
 const v=JSON.parse(payload.toString());if(!v||typeof v!=='object'||Array.isArray(v))return;
 if(topic===TOP+'data'){telemetry=v;telemetryAt=Date.now();}
 if(topic===TOP+'status'){status=v;statusAt=Date.now();}
}catch(_){}});
function eq(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function auth(req){const h=req.headers.authorization||'';if(!h.startsWith('Basic '))return false;
 let s;try{s=Buffer.from(h.slice(6),'base64').toString('utf8');}catch(_){return false;}
 const i=s.indexOf(':');return i>0&&eq(s.slice(0,i),process.env.WEB_USER)&&eq(s.slice(i+1),process.env.WEB_PASS);}
const baseHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
 'Content-Security-Policy':"default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"};
function json(res,code,data,headers={}){res.writeHead(code,{...baseHeaders,'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data));}
const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
http.createServer((req,res)=>{
 if(!auth(req))return json(res,401,{error:'LOGIN_REQUIRED'},{'WWW-Authenticate':'Basic realm="MAXDREAM UF"'});
 if(req.method==='GET'&&req.url==='/api/status')return json(res,200,{
  mqtt_online:connected,telemetry,status,
  telemetry_age_s:telemetryAt?Math.round((Date.now()-telemetryAt)/1000):null,
  status_age_s:statusAt?Math.round((Date.now()-statusAt)/1000):null
 });
 if(req.method==='POST'&&req.url==='/api/clean'){
  if(req.headers.origin!==origin)return json(res,403,{error:'ORIGIN_MISMATCH'});
  if(!(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'JSON_REQUIRED'});
  if(!connected||!status||Date.now()-statusAt>12000)return json(res,503,{error:'ESP32_OFFLINE_OR_STALE'});
  if(status.output_enabled!==true)return json(res,409,{error:'RELAY_DISABLED'});
  if(status.state!=='IDLE')return json(res,409,{error:'SYSTEM_BUSY',state:status.state});
  if(Date.now()-lastSent<10000)return json(res,429,{error:'PLEASE_WAIT'});
  lastSent=Date.now();const id='web-'+crypto.randomUUID();
  mc.publish(TOP+'control',JSON.stringify({command:'CLEAN_REQUEST',request_id:id,source:'PHONE',issued_at:Math.floor(Date.now()/1000)}),
   {qos:1,retain:false},err=>{if(res.writableEnded)return;return err?json(res,502,{error:'MQTT_FAILED'}):json(res,202,{queued_to_broker:true,request_id:id});});
  return;
 }
 if(req.method==='GET'&&assets[req.url]){
  const [name,type]=assets[req.url];res.writeHead(200,{...baseHeaders,'Content-Type':type});
  return fs.createReadStream(path.join(__dirname,'public',name)).pipe(res);
 }
 return json(res,404,{error:'NOT_FOUND'});
}).listen(Number(process.env.PORT||3000),()=>console.log('MAXDREAM UF web started; HTTPS required on hosting provider'));
