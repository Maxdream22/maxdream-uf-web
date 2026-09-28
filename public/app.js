'use strict';
const $=id=>document.getElementById(id),fmt=(v,n=2)=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(n):'--';
const labels={IDLE:'ĐANG LỌC / CHỜ LỆNH',REQUEST_SENT:'ĐÃ GỬI YÊU CẦU – CHỜ PLC',CLEANING:'ĐANG SỤC RỬA',UNCONFIRMED:'CHƯA XÁC NHẬN PLC ĐÃ CHẠY',COMPLETED:'ĐANG ĐO HIỆU QUẢ PHỤC HỒI',OVERTIME:'SỤC RỬA QUÁ THỜI GIAN'};
let busy=false,notice='',admin=false,csrf=null,canClean=false,relayEnabled=false,relayFresh=false;
function setRole(){
 $('role').textContent=admin?'CHẾ ĐỘ: QUẢN TRỊ':'CHẾ ĐỘ: CHỈ XEM';
 $('login').hidden=admin;$('logout').hidden=!admin;
 $('clean').disabled=busy||!admin||!canClean;
 $('relayToggle').disabled=busy||!admin||!relayFresh;
 if(!admin)$('notice').textContent='Chế độ chỉ xem. Đăng nhập để sử dụng điều khiển.';
}
async function checkAuth(){try{const r=await fetch('/api/auth',{cache:'no-store'}),v=await r.json();admin=!!v.admin;csrf=v.csrf||null;}catch(_){admin=false;csrf=null;}setRole();}
$('login').onclick=()=>{$('loginError').textContent='';$('password').value='';$('loginDialog').showModal();$('password').focus();};
$('cancelLogin').onclick=()=>$('loginDialog').close();
$('loginForm').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})}),v=await r.json();if(!r.ok)throw Error(v.error||'LOGIN_FAILED');admin=true;csrf=v.csrf;$('password').value='';$('loginDialog').close();notice='';setRole();await refresh();}catch(e){$('loginError').textContent='Không đăng nhập được: '+e.message;}};
$('logout').onclick=async()=>{try{await fetch('/api/logout',{method:'POST',headers:{'X-CSRF-Token':csrf}});}finally{admin=false;csrf=null;notice='';setRole();}};

async function refresh(){
 try{
  const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
  const x=await r.json(),s=x.status||{},d=x.telemetry||{};
  const fresh=x.mqtt_online&&x.status_age_s!==null&&x.status_age_s<12;
  $('online').textContent=fresh?'ESP32 TRỰC TUYẾN':'OFFLINE / DỮ LIỆU CŨ';
  $('state').textContent=fresh?(labels[s.state]||s.state||'CHƯA RÕ'):'KHÔNG XÁC ĐỊNH';
  $('detail').textContent=fresh?`Mã lệnh: ${s.request_id||'--'} · ${s.state_elapsed_s||0} giây`:'Khóa điều khiển cho đến khi ESP32 gửi trạng thái mới.';
  $('qi').textContent=fmt(d.Q_IN??s.Q_IN);$('qf').textContent=fmt(s.Q_FILT??d.Q_FILT);
  $('qd').textContent=fmt(s.Q_DRAIN??d.Q_DRAIN);$('ti').textContent=fmt(d.TDS_IN,1);
  $('to').textContent=fmt(d.TDS_OUT,1);$('vf').textContent=fmt(d.V_FILT,3);
  $('q5').textContent=fmt(s.Q5);$('q30').textContent=fmt(s.Q30);
  $('before').textContent=fmt(s.before_clean);$('after').textContent=fmt(s.after_clean);
  $('recovery').textContent=s.recovery_pct==null?'--':fmt(s.recovery_pct,1)+'%';
  const seconds=Math.min(1800,Math.max(0,s.auto_stable_s||0));
  $('progress').textContent=`${Math.floor(seconds/60)}/30 phút`;
  $('fill').style.width=(seconds/18)+'%';
  $('auto').textContent=!s.auto_armed?'AUTO CHƯA REARM (cần Q_FILT >1,45 trong 5 phút)':'AUTO SẴN SÀNG · Q_FILT < 1,30 sẽ đếm 30 phút';
  relayEnabled=s.output_enabled===true;relayFresh=fresh;
  $('relayMode').textContent=relayEnabled?'ENABLED':'LOCKED';
  $('relayToggle').textContent=relayEnabled?'KHÓA X1 (OFF)':'BẬT QUYỀN X1 (ON)';
  $('relayNotice').textContent=admin?(relayEnabled?'X1 đang được cấp quyền phát xung.':'X1 đang khóa an toàn.'):'Chế độ chỉ xem. Đăng nhập để thay đổi.';
  canClean=fresh&&s.state==='IDLE'&&s.output_enabled===true;setRole();
  if(admin&&!busy&&!notice&&s.output_enabled!==true)$('notice').textContent='Relay đang khóa trong firmware (chế độ an toàn).';
  else if(admin&&notice)$('notice').textContent=notice;
 }catch(_){$('online').textContent='KHÔNG KẾT NỐI';$('state').textContent='KHÔNG XÁC ĐỊNH';$('clean').disabled=true;$('notice').textContent='Không xác minh được trạng thái hệ thống.';}
}
$('relayToggle').addEventListener('click',async()=>{
 if(!admin){$('login').click();return;}if(busy||!relayFresh)return;
 const target=!relayEnabled;
 if(target&&!confirm('Bật quyền phát xung PLC X1? Thao tác này KHÔNG phát xung ngay.'))return;
 if(!target&&!confirm('Khóa quyền phát xung PLC X1?'))return;
 busy=true;setRole();$('relayNotice').textContent='Đang gửi thay đổi đến ESP32...';
 try{
  const r=await fetch('/api/relay-mode',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({enabled:target})}),x=await r.json();
  $('relayNotice').textContent=r.ok?'Đã gửi yêu cầu; chờ ESP32 xác nhận trạng thái.':'Không đổi được: '+(x.error||r.status);
 }catch(_){$('relayNotice').textContent='Lỗi mạng; trạng thái không được tự suy đoán.';}
 finally{busy=false;setRole();setTimeout(refresh,800);}
});
$('clean').addEventListener('click',async()=>{
 if(!admin){$('login').click();return;}if(busy||$('clean').disabled)return;
 if(!confirm('Xác nhận gửi yêu cầu sục rửa đến PLC X1? Chu trình PLC dự kiến 3 phút.'))return;
 busy=true;$('clean').disabled=true;notice='Đang gửi đến MQTT...';$('notice').textContent=notice;
 try{
  const r=await fetch('/api/clean',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'}),x=await r.json();
  notice=r.ok?`Đã gửi broker; chờ ESP32 xác nhận. ID: ${x.request_id}`:`Không gửi: ${x.error||r.status}`;
 }catch(_){notice='Lỗi mạng: không tự gửi lại; kiểm tra trạng thái trước.';}
 finally{busy=false;await checkAuth();await refresh();}
});checkAuth().then(refresh);setInterval(refresh,3000);setInterval(checkAuth,60000);
