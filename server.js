'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),mqtt=require('mqtt');
const need=['MQTT_HOST','MQTT_USER','MQTT_PASS','WEB_PASS','PUBLIC_ORIGIN'];
for(const k of need)if(!process.env[k]){console.error('Missing '+k);process.exit(1);}
const origin=new URL(process.env.PUBLIC_ORIGIN).origin;
if(!origin.startsWith('https://')&&!origin.startsWith('http://localhost')){console.error('PUBLIC_ORIGIN must use HTTPS except localhost');process.exit(1);}
const TOP='maxdream_uf_system/', IDLE_MS=30*60*1000;
const mc=mqtt.connect('mqtts://'+process.env.MQTT_HOST+':'+(process.env.MQTT_PORT||8883),{
 username:process.env.MQTT_USER,password:process.env.MQTT_PASS,clientId:'maxdream_web_'+crypto.randomBytes(6).toString('hex'),rejectUnauthorized:true,reconnectPeriod:5000,connectTimeout:12000,clean:true
});
let connected=false,telemetry=null,status=null,telemetryAt=0,statusAt=0,lastSent=0;
mc.on('connect',()=>{connected=true;mc.subscribe([TOP+'data',TOP+'status']);});
mc.on('close',()=>{connected=false;});mc.on('error',e=>console.error('MQTT:',e.message));
mc.on('message',(topic,payload)=>{if(payload.length>8192)return;try{const v=JSON.parse(payload.toString());if(!v||typeof v!=='object'||Array.isArray(v))return;if(topic===TOP+'data'){telemetry=v;telemetryAt=Date.now();}if(topic===TOP+'status'){status=v;statusAt=Date.now();}}catch(_){}});
const sessions=new Map(),failures=new Map();
function eq(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function cookie(req){const m=(req.headers.cookie||'').match(/(?:^|;\s*)md_session=([a-f0-9]{64})(?:;|$)/);return m&&m[1];}
function session(req,touch=false){const token=cookie(req),s=token&&sessions.get(token);if(!s)return null;if(Date.now()-s.last>IDLE_MS){sessions.delete(token);return null;}if(touch)s.last=Date.now();return s;}
function csrfOK(req,s){return s&&req.headers['x-csrf-token']===s.csrf&&req.headers.origin===origin;}
const baseHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"};
function json(res,code,data,headers={}){res.writeHead(code,{...baseHeaders,'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(data));}
function readJSON(req,done){let data='',ended=false;req.on('data',b=>{data+=b;if(data.length>2048&&!ended){ended=true;done(new Error('BODY_TOO_LARGE'));req.destroy();}});req.on('end',()=>{if(ended)return;try{done(null,JSON.parse(data||'{}'));}catch(_){done(new Error('BAD_JSON'));}});}
const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const cookieOpts='Path=/; HttpOnly; SameSite=Strict'+(origin.startsWith('https://')?'; Secure':'');
http.createServer((req,res)=>{
 const u=req.url.split('?')[0];
 if(req.method==='GET'&&u==='/api/status')return json(res,200,{mqtt_online:connected,telemetry,status,telemetry_age_s:telemetryAt?Math.round((Date.now()-telemetryAt)/1000):null,status_age_s:statusAt?Math.round((Date.now()-statusAt)/1000):null});
 if(req.method==='GET'&&u==='/api/auth'){const s=session(req,true);return json(res,200,{admin:!!s,csrf:s?s.csrf:null});}
 if(req.method==='POST'&&u==='/api/login'){
  if(req.headers.origin!==origin)return json(res,403,{error:'ORIGIN_MISMATCH'});
  if(!(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'JSON_REQUIRED'});
  const ip=(req.socket.remoteAddress||'unknown'),f=failures.get(ip)||{count:0,until:0};if(f.until>Date.now())return json(res,429,{error:'TOO_MANY_ATTEMPTS'});
  return readJSON(req,(err,body)=>{if(err)return json(res,400,{error:'BAD_REQUEST'});
   if(!body||typeof body.password!=='string'||!eq(body.password,process.env.WEB_PASS)){
    f.count++;f.until=Date.now()+(f.count>=5?60000:1500);failures.set(ip,f);return json(res,401,{error:'WRONG_PASSWORD'});
   }
   failures.delete(ip);const old=cookie(req);if(old)sessions.delete(old);
   const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');sessions.set(token,{csrf,last:Date.now()});
   return json(res,200,{admin:true,csrf},{'Set-Cookie':'md_session='+token+'; '+cookieOpts});
  });
 }
 if(req.method==='POST'&&u==='/api/logout'){const s=session(req);if(!csrfOK(req,s))return json(res,403,{error:'AUTH_REQUIRED'});sessions.delete(cookie(req));return json(res,200,{admin:false},{'Set-Cookie':'md_session=; Max-Age=0; '+cookieOpts});}
 if(req.method==='POST'&&u==='/api/clean'){
  const s=session(req);if(!s)return json(res,401,{error:'ADMIN_REQUIRED'});
  if(!csrfOK(req,s))return json(res,403,{error:'CSRF_OR_ORIGIN_MISMATCH'});
  if(!(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'JSON_REQUIRED'});
  if(!connected||!status||Date.now()-statusAt>12000)return json(res,503,{error:'ESP32_OFFLINE_OR_STALE'});
  if(status.output_enabled!==true)return json(res,409,{error:'RELAY_DISABLED'});
  if(status.state!=='IDLE')return json(res,409,{error:'SYSTEM_BUSY',state:status.state});
  if(Date.now()-lastSent<10000)return json(res,429,{error:'PLEASE_WAIT'});
  s.last=Date.now();lastSent=Date.now();const id='web-'+crypto.randomUUID();
  mc.publish(TOP+'control',JSON.stringify({command:'CLEAN_REQUEST',request_id:id,source:'PHONE',issued_at:Math.floor(Date.now()/1000)}),{qos:1,retain:false},err=>{if(res.writableEnded)return;return err?json(res,502,{error:'MQTT_FAILED'}):json(res,202,{queued_to_broker:true,request_id:id});});return;
 }
 if(req.method==='GET'&&assets[u]){const [name,type]=assets[u];res.writeHead(200,{...baseHeaders,'Content-Type':type});return fs.createReadStream(path.join(__dirname,'public',name)).pipe(res);}
 return json(res,404,{error:'NOT_FOUND'});
}).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('MAXDREAM UF V2.2 web started'));
