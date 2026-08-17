// scripts/refresh-data.mjs
// Runs in GitHub Actions (hourly) - NO 10s limit. Replaces Coupler.
// Pulls Meta Graph (both ad accounts) + LeadSquared (leads + MQL) +
// Shopify (orders net), and writes data.json at the repo root. Vercel
// serves that file statically; the dashboard reads it instantly.
//
// Resilient: each source is independent. If one fails, the previous
// value for that source (from the existing data.json) is preserved so
// a transient outage never blanks the dashboard.
//
// Env (GitHub repo Secrets): META_ACCESS_TOKEN, LSQ_HOST,
//   LSQ_ACCESS_KEY, LSQ_SECRET_KEY, SHOPIFY_STORE_DOMAIN,
//   SHOPIFY_ADMIN_TOKEN.

import { readFileSync, writeFileSync } from 'fs';

const GRAPH_VERSION = 'v23.0';
const AD_ACCOUNTS = ['267120132089369', '1673404820349968']; // TatvaCare, GoodFlip_GLP
const EXCLUDE = ['tatva practice', 'tatvapractice', 'bihar abdm', 'lookalike dr data'];
const PERF_DAYS = 45, MQL_DAYS = 60, SHOP_DAYS = 45;
const PROGRAM_REV_DAYS = 240;
const PROGRAM_REV_URL = process.env.PROGRAM_REVENUE_XLSX_URL || '';

const ymd = d => d.toISOString().slice(0, 10);
// GoodFlip runs in India (IST = UTC+5:30). Bucket every "today" / day-window in IST so the dashboard's
// current day flips at IST midnight, not UTC midnight (which lags India by 5.5 hours).
const IST_MS = 5.5 * 3600 * 1000;
const istYmd = d => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
// LeadSquared CreatedOn is UTC ("YYYY-MM-DD HH:MM:SS"); convert to the IST calendar date.
const istDate = s => { if (!s) return ''; const d = new Date(String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? String(s).slice(0, 10) : istYmd(d); };
const daysAgo = n => istYmd(new Date(Date.now() - n * 86400000));
const TODAY = istYmd(new Date());

// ---------- Meta Graph performance ----------
function classify(campaign) {
  const lc = (campaign || '').toLowerCase();
  if (EXCLUDE.some(p => lc.includes(p))) return null;
  let t = '';
  if (lc.includes('pre-diabetes') || lc.includes('prediabetes')) t = 'Pre-Diabetes';
  else if (lc.includes('diabetes')) t = 'Diabetes';
  else if (lc.includes('obesity') || lc.includes('weight')) t = 'Obesity';
  else if (lc.includes('glp')) t = 'GLP-1';
  else if (lc.includes('cgm')) t = 'CGM';
  else if (lc.includes('bca')) t = 'BCA';
  else if (lc.includes('pcos')) t = lc.includes('program') ? 'PCOS' : 'PCOS Store';
  if (!t) return null;
  const o = (lc.includes('inlead') || lc.includes('in-lead') || lc.includes('program')) ? 'lead' : 'purchase';
  return { therapy: t, objective: o };
}
function actionVal(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) { const h = actions.find(a => a.action_type === t); if (h && h.value != null) return Math.round(parseFloat(h.value) || 0); }
  return 0;
}
async function fetchAccountInsights(acct, token, since, until) {
  const params = new URLSearchParams({
    level: 'ad', time_increment: '1',
    fields: 'ad_id,ad_name,campaign_name,adset_name,spend,impressions,inline_link_clicks,actions',
    time_range: JSON.stringify({ since, until }), limit: '500', access_token: token
  });
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/act_${acct}/insights?` + params.toString();
  const rows = []; let pages = 0;
  while (url && pages < 80) {
    const r = await fetch(url);
    if (!r.ok) { const t = await r.text(); throw new Error(`Meta insights ${r.status} act_${acct}: ${t.slice(0,300)}`); }
    const j = await r.json();
    for (const row of j.data || []) rows.push(row);
    url = j.paging && j.paging.next ? j.paging.next : null; pages++;
  }
  return rows;
}
async function fetchAccountInsightsChunked(acct, token, since, until, chunkDays = 15) {
  // Meta's ad-level daily insights call times out (error_subcode 1504018) when the date
  // window is large for a high-volume account, but firing many chunk calls quickly can trip
  // the app-level rate limit (code 4 / subcode 1504022, transient). So walk the window in
  // modest date slices, pace the calls, shrink a slice that still times out, and back off and
  // retry a slice that hits a transient rate limit.
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const startD = new Date(since + 'T00:00:00Z');
  const endD = new Date(until + 'T00:00:00Z');
  const all = [];
  let cur = new Date(startD);
  let firstCall = true;
  while (cur <= endD) {
    let span = chunkDays;
    let rateTries = 0;
    while (true) {
      const sStart = new Date(cur);
      const sEnd = new Date(cur);
      sEnd.setUTCDate(sEnd.getUTCDate() + span - 1);
      if (sEnd > endD) sEnd.setTime(endD.getTime());
      if (!firstCall) await sleep(1500);
      firstCall = false;
      try {
        const part = await fetchAccountInsights(acct, token, ymd(sStart), ymd(sEnd));
        for (const row of part) all.push(row);
        cur = new Date(sEnd);
        cur.setUTCDate(cur.getUTCDate() + 1);
        break;
      } catch (e) {
        const msg = (e && e.message) || '';
        const timedOut = /1504018|request timed out|reduce the amount of data|smaller date range|fetch less data/i.test(msg);
        const rateLimited = /1504022|request limit reached|too many|"code":4|user request limit/i.test(msg);
        if (rateLimited && rateTries < 5) { rateTries++; await sleep(20000 * rateTries); continue; }
        if (timedOut && span > 1) { span = Math.max(1, Math.floor(span / 2)); continue; }
        throw e;
      }
    }
  }
  return all;
}

async function getPerformance(token) {
  const since = daysAgo(PERF_DAYS), until = TODAY;
  const dailyCreatives = {}; const accountStatus = {}; let any = false;
  const settled = [];
  for (const a of AD_ACCOUNTS) {
    try { const rows = await fetchAccountInsightsChunked(a, token, since, until); settled.push({ a, rows }); }
    catch (e) { settled.push({ a, error: e }); }
  }
  for (const s of settled) {
    if (s.error) { accountStatus[s.a] = 'error: ' + s.error.message; console.error('[perf]', s.a, s.error.message); continue; }
    for (const row of s.rows) {
      const date = (row.date_start || '').trim(); const campaign = (row.campaign_name || '').trim();
      if (!date || !campaign) continue;
      const cls = classify(campaign); if (!cls) continue;
      const spend = Math.round((parseFloat(row.spend) || 0) * 100) / 100;
      const impr = Math.round(parseFloat(row.impressions) || 0);
      if (spend === 0 && impr === 0) continue;
      (dailyCreatives[date] = dailyCreatives[date] || []).push({
        n: (row.ad_name || '').trim(), c: campaign, as: (row.adset_name || '').trim(),
        t: cls.therapy, o: cls.objective, s: spend, i: impr,
        cl: Math.round(parseFloat(row.inline_link_clicks) || 0),
        l: actionVal(row.actions, ['lead', 'onsite_conversion.lead_grouped']),
        p: actionVal(row.actions, ['omni_purchase', 'purchase']),
        atc: actionVal(row.actions, ['omni_add_to_cart', 'add_to_cart']),
        ci: actionVal(row.actions, ['omni_initiated_checkout', 'initiate_checkout']),
        lpv: actionVal(row.actions, ['landing_page_view'])
      });
    }
    accountStatus[s.a] = 'ok(' + s.rows.length + ' rows)'; any = true;
  }
  if (!any) throw new Error('All Meta accounts failed: ' + JSON.stringify(accountStatus));
  Object.keys(dailyCreatives).forEach(d => dailyCreatives[d].sort((a, b) => b.s - a.s));
  return { dailyCreatives, accountStatus, window: { since, until } };
}

// ---------- LeadSquared MQL ----------
const QUALIFYING_CITIES = ['mumbai','bombay','navi mumbai','thane','thane west','vasai','kalyan','dombivli','dahisar','new panvel','panvel','delhi','new delhi','delhi-ncr','west delhi','najafgarh','dwarka','rohini','gurugram','gurgaon','noida','greater noida','noida extension','ghaziabad','gaziabad','indirapuram','faridabad','bengaluru','bangalore','banglore','bangaluru','bengalore','hyderabad','secunderabad','chennai','madras','pune','pimpri-chinchwad','pcmc','kolkata','calcutta','howrah','madhyamgram','barrackpore','ahmedabad','gandhinagar','lucknow','chandigarh','mohali','panchkula','jaipur','indore','kochi','cochin','ernakulam','nagpur','bhubaneswar','meerut'];
const LSQ_FIELDS = ['ProspectID','CreatedOn','mx_utm_disease','mx_Age_Group','mx_City','mx_Do_you_remember_your_HbA1c_levels','mx_Do_you_know_your_recent_blood_sugar_level','mx_Are_you_open_to_investing_in_this_paid_program_of','mx_Waist_Circumference','mx_Is_your_weight_or_BMI_higher_than_recommended','ProspectStage','Source','mx_are_you_open_to_a_medically_supervised_GLP_program','mx_user_source','OwnerIdName'];
// ---------- Counsellor leaderboard helpers (shared: LSQ lead owner + sheet Health Counsellor) ----------
// The counsellor who OWNS a lead in LeadSquared is the same person who closes the sale in the SharePoint
// sheet, but a few names differ slightly between systems, so normalise both through one map. System /
// team-lead / ops owners are excluded so the board shows only floor counsellors.
const COUNSELLOR_EXCLUDE = new Set(['','system','shantha s','prakash chandra']);
const COUNSELLOR_ALIAS = { 'md shaqib ahmad':'Md Shaqib', 'rahul kumar singhal':'Rahul Singhal', 'nisha v':'Nisha v' };
function canonCounsellor(raw){ const t=(raw==null?'':raw.toString()).replace(/\s+/g,' ').trim(); const lc=t.toLowerCase(); if(COUNSELLOR_EXCLUDE.has(lc))return null; const base=(COUNSELLOR_ALIAS[lc]||t).toLowerCase(); return base.replace(/\b\w/g,c=>c.toUpperCase()); } // Title-case so LSQ lead owners (e.g. "jaspreet singh") and revenue-sheet sales names (e.g. "Jaspreet Singh") reconcile to one key.
// Care program (workspace 'Program' rule) = Care Plan + Sema Care Plan + Smart CGM; everything else
// (Standalone CGM/BCA/Transmitter, Diagnostics, ...) is non-care. GLP Drug is already excluded upstream.
function isCareSale(saleType){ const x=(saleType||'').toString().toLowerCase(); return x.includes('care plan')||x.includes('sema')||(x.includes('smart')&&x.includes('cgm')); }
const LSQ_SOURCE_MAP = {'fb lead ads':'FB Lead Ads','whatsapp marketing':'WhatsApp Marketing','webpage lead':'Webpage Lead','tata 1mg':'TATA 1MG','affiliate':'Affiliate'};
// Canonicalise EVERY lead source into a friendly label (not just the mapped 5) so the dashboard can
// show a full Leads-by-Source breakdown and count Instagram / Facebook / Social. Keeps the exact keys
// the dashboard already reads ('FB Lead Ads','WhatsApp Marketing','Webpage Lead','TATA 1MG','Affiliate').
function canonSource(raw){
  const s=(raw||'').toString().trim().toLowerCase();
  if(!s) return '';
  if(s.includes('fb lead')||s.includes('fblead')) return 'FB Lead Ads';
  if(s==='ig'||s.includes('instagram')) return 'Instagram';
  if(s==='facebook'||s==='fb'||s==='meta') return 'Facebook';
  if(s.includes('social')) return 'Social';
  if(s.includes('whatsapp')) return 'WhatsApp Marketing';
  if(s.includes('tata')) return 'TATA 1MG';
  if(s.includes('webpage')) return 'Webpage Lead';
  if(s.includes('affiliate')) return 'Affiliate';
  if(s.includes('inbound')&&s.includes('phone')) return 'Inbound Phone';
  if(s.includes('outbound')&&s.includes('phone')) return 'Outbound Phone';
  if(s.includes('doc led')||s.includes('doc-led')) return 'Doc-Led GTM';
  if(s.includes('pharmeasy')) return 'PharmEasy';
  if(s.includes('direct traffic')) return 'Direct Traffic';
  if(s.includes('contact form')) return 'Contact Form';
  if(s.includes('spin the wheel')) return 'Spin the Wheel';
  if(s.includes('self sourced')) return 'Self Sourced';
  if(s.includes('direct purchase')) return 'Direct Purchase';
  if(s.includes('referral')) return 'Referral';
  return raw.toString().trim().replace(/\s+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
}
function lsqTherapy(d){ d=(d||'').toLowerCase(); if(d.includes('pre-diabetes')||d.includes('pre_diabetes')||d.includes('prediabetes'))return 'Pre-Diabetes'; if(d.includes('diabetes'))return 'Diabetes'; if(d.includes('obesity')||d.includes('weight'))return 'Obesity'; if(d.includes('glp'))return 'GLP-1'; if(d.includes('pcos'))return 'PCOS'; return null; }
function normalizeStage(s){ s=(s||'').toString().replace(/\s+/g,' ').trim(); if(!s)return ''; const lc=s.toLowerCase(); if(lc.indexOf('reinquir')>=0||lc.indexOf('re-enquir')>=0)return 'Re-enquired'; return s; }
function ageFails(t,age){ const a=(age||'').toLowerCase().trim(); if(!a)return false;
  const sixtyPlus=a.includes('60+')||a.includes('61-65')||a.includes('65+'); if(t==='Diabetes'){ if(a.includes('under'))return true; if(a.includes('25')&&a.includes('30'))return true; if(sixtyPlus)return true; return false; } if(t==='Obesity'||t==='GLP-1'){ if(a.includes('under'))return true; if(sixtyPlus)return true; return false; }
  if(t==='Pre-Diabetes'){ if(a.includes('under'))return true; if(a.includes('65+'))return true; return false; }
  if(t==='PCOS'){ if(a.includes('under'))return true; if(a.includes('41')&&a.includes('50'))return true; if(a.includes('51')&&a.includes('60'))return true; if(a.includes('60+')||a.includes('65+'))return true; return false; }
  return false; }
function cityStatus(c){ c=(c||'').trim().toLowerCase(); if(!c)return null; for(const qc of QUALIFYING_CITIES){ if(c.includes(qc)||qc.includes(c))return true; } return false; }
function flatten(lead){ if(lead&&Array.isArray(lead.LeadPropertyList)){ const o={}; for(const p of lead.LeadPropertyList)o[p.Attribute]=p.Value; return o; } return lead||{}; }
function scoreLead(rec){ const t=lsqTherapy(rec.mx_utm_disease); if(!t)return null; let route=false;
  const rs={age:false,city:false,pay:false,payBlank:false,clin:false,clinBlank:false};
  if(ageFails(t,rec.mx_Age_Group))rs.age=true;
  const cs=cityStatus(rec.mx_City); if(cs===false)rs.city=true;
  const pay=(rec.mx_Are_you_open_to_investing_in_this_paid_program_of||'').toLowerCase().trim(); const dog=(t==='Diabetes'||t==='Obesity'||t==='GLP-1');
  if(dog){ if(pay===''){rs.pay=true;rs.payBlank=true;} else if(pay.includes('not_at_this_time'))rs.pay=true; } else { if(pay.includes('not_at_this_time'))rs.pay=true; }
  const hb=(rec.mx_Do_you_remember_your_HbA1c_levels||'').toLowerCase().trim();
  if(t==='Diabetes'){ if(hb===''){rs.clin=true;rs.clinBlank=true;} else if(hb.includes("don't")||hb.includes('dont')||hb.includes('unknown')||hb.includes('below_5.7')||hb.includes('normal')||hb.includes('below7.5'))rs.clin=true; } // MQL def (2026-08): HbA1c >=5.7 qualifies; rs.clinBlank = truly empty vs answered-disqualifying
  if(t==='Obesity'){ const bmi=(rec.mx_Is_your_weight_or_BMI_higher_than_recommended||'').toLowerCase().trim(); if(bmi===''){rs.clin=true;rs.clinBlank=true;} else if(!bmi.includes('obese'))rs.clin=true; } // MQL def (2026-08): only obese (BMI>=25) qualifies; rs.clinBlank = truly empty vs overweight/idk/legacy
  const fails=(rs.age?1:0)+(rs.city?1:0)+(rs.pay?1:0)+(rs.clin?1:0);
  let v; if(fails>0)v='fl'; else if(route)v='ro'; else if(cs===null)v='rv'; else v='pa';
  return { therapy:t, verdict:v, rs }; }
async function getMQL(){
  const host=process.env.LSQ_HOST, ak=process.env.LSQ_ACCESS_KEY, sk=process.env.LSQ_SECRET_KEY;
  if(!host||!ak||!sk) throw new Error('LSQ creds missing');
  const since=daysAgo(MQL_DAYS), until=TODAY;
  const base=`https://${host}/v2/LeadManagement.svc/Leads.RecentlyModified?accessKey=${encodeURIComponent(ak)}&secretKey=${encodeURIComponent(sk)}`;
  const seen={};
  for(let page=1; page<=60; page++){
    const body={ Parameter:{FromDate:since+' 00:00:00',ToDate:until+' 23:59:59'}, Columns:{Include_CSV:LSQ_FIELDS.join(',')}, Sorting:{ColumnName:'CreatedOn',Direction:'1'}, Paging:{PageIndex:page,PageSize:1000} };
    const r=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok){ const t=await r.text(); throw new Error(`LSQ ${r.status}: ${t.slice(0,300)}`); }
    const j=await r.json(); const leads=j.Leads||j.RecentlyModifiedLeads||(Array.isArray(j)?j:[])||[];
    if(!leads.length)break;
    for(const raw of leads){ const rec=flatten(raw); if(rec.ProspectID&&!seen[rec.ProspectID])seen[rec.ProspectID]=rec; }
    if(leads.length<1000)break;
  }
  const mqlDaily={}, lsqAllDaily={}, lsqStageDaily={}, lsqSourceDaily={}, glpYesDaily={}, mqlCityDaily={}, mqlAgeDaily={}, counsellorLeadsDaily={};
  for(const rec of Object.values(seen)){
    const co=istDate(rec.CreatedOn); if(!co||co<since||co>until)continue;
    lsqAllDaily[co]=(lsqAllDaily[co]||0)+1; { const _cn=canonCounsellor(rec.OwnerIdName); if(_cn){ (counsellorLeadsDaily[co]=counsellorLeadsDaily[co]||{}); counsellorLeadsDaily[co][_cn]=(counsellorLeadsDaily[co][_cn]||0)+1; } } const srcL=(rec.Source||'').trim().toLowerCase(); let srcKey=canonSource(rec.Source); const us=(rec.mx_user_source||'').toLowerCase(); if(!srcKey){ srcKey = us.includes('glp') ? 'GLP (no source)' : '(no source)'; } (lsqSourceDaily[co]=lsqSourceDaily[co]||{}); lsqSourceDaily[co][srcKey]=(lsqSourceDaily[co][srcKey]||0)+1;
      if(srcL==='fb lead ads'){ const glpA=(rec.mx_are_you_open_to_a_medically_supervised_GLP_program||'').toLowerCase(); const glpTh=lsqTherapy(rec.mx_utm_disease); if(glpA.includes('yes')&&(glpTh==='Diabetes'||glpTh==='Obesity')){ glpYesDaily[co]=(glpYesDaily[co]||0)+1; } }
    const sc=scoreLead(rec); if(!sc)continue;
    if(srcL==='fb lead ads'){ (mqlDaily[co]=mqlDaily[co]||{}); (mqlDaily[co][sc.therapy]=mqlDaily[co][sc.therapy]||{t:0,pa:0,ro:0,rv:0,fl:0,r:{age:0,city:0,pay:0,payBlank:0,clin:0,clinBlank:0}});
    const c=mqlDaily[co][sc.therapy]; if(!c.r)c.r={age:0,city:0,pay:0,payBlank:0,clin:0,clinBlank:0}; c.t++; c[sc.verdict]++; { const R=sc.rs; if(R.age)c.r.age++; if(R.city)c.r.city++; if(R.pay)c.r.pay++; if(R.payBlank)c.r.payBlank++; if(R.clin)c.r.clin++; if(R.clinBlank)c.r.clinBlank++; } if(sc.verdict==='pa'||sc.verdict==='ro'){ const cty=(rec.mx_City||'').trim()||'(blank)', ag=(rec.mx_Age_Group||'').trim()||'(blank)'; (mqlCityDaily[co]=mqlCityDaily[co]||{}); mqlCityDaily[co][cty]=(mqlCityDaily[co][cty]||0)+1; (mqlAgeDaily[co]=mqlAgeDaily[co]||{}); mqlAgeDaily[co][ag]=(mqlAgeDaily[co][ag]||0)+1; } }
    const stg=normalizeStage(rec.ProspectStage);
    if(stg){ (lsqStageDaily[co]=lsqStageDaily[co]||{}); (lsqStageDaily[co][sc.therapy]=lsqStageDaily[co][sc.therapy]||{}); lsqStageDaily[co][sc.therapy][stg]=(lsqStageDaily[co][sc.therapy][stg]||0)+1; }
  }
  return { mqlDaily, lsqAllDaily, lsqStageDaily, lsqSourceDaily, glpYesDaily, mqlCityDaily, mqlAgeDaily, counsellorLeadsDaily, pulled:Object.keys(seen).length, window:{since,until} };
}

// ---------- Shopify ----------
function productBucket(title){ const t=(title||'').trim();
  if(t==='GoodFlip Continuous Glucose Monitor'||t==='Sensor | GoodFlip Continuous Glucose Monitor')return 'CGM';
  if(t==='GoodFlip Smart Body Composition Analyser')return 'BCA';
  if(t==='PCOS Care | With Enhanced Absorption')return 'PCOS'; return null; }
function nextLink(h){ if(!h)return null; for(const p of h.split(',')){ if(p.includes('rel="next"')){ const m=p.match(/<([^>]+)>/); if(m)return m[1]; } } return null; }
async function getShopify(){
  const domain=process.env.SHOPIFY_STORE_DOMAIN, token=process.env.SHOPIFY_ADMIN_TOKEN;
  if(!domain||!token) throw new Error('Shopify creds missing');
  const since=daysAgo(SHOP_DAYS), until=TODAY;
  let url=`https://${domain}/admin/api/2024-10/orders.json?status=any&created_at_min=${since}T00:00:00Z&created_at_max=${until}T23:59:59Z&limit=250`;
  const orders=[]; let pages=0;
  while(url&&pages<60){
    const r=await fetch(url,{headers:{'X-Shopify-Access-Token':token,'Content-Type':'application/json'}});
    if(!r.ok){ const t=await r.text(); throw new Error(`Shopify ${r.status}: ${t.slice(0,300)}`); }
    const j=await r.json(); for(const o of j.orders||[])orders.push(o);
    url=nextLink(r.headers.get('link')); pages++;
  }
  const daily={};
  const cell=(d,b)=>{ (daily[d]=daily[d]||{}); (daily[d][b]=daily[d][b]||{rev:0,it:0,or:0}); return daily[d][b]; };
  for(const o of orders){ const date=(o.created_at||'').slice(0,10); if(!date)continue; const bk={};
    for(const li of o.line_items||[]){ const b=productBucket(li.title||li.name); if(!b)continue; const q=parseInt(li.quantity)||0; let disc=0; for(const da of li.discount_allocations||[])disc+=parseFloat(da.amount)||0; const c=cell(date,b); c.rev+=(parseFloat(li.price)||0)*q-disc; c.it+=q; bk[b]=1; }
    for(const ref of o.refunds||[]){ for(const rli of ref.refund_line_items||[]){ const title=(rli.line_item&&(rli.line_item.title||rli.line_item.name))||''; const b=productBucket(title); if(!b)continue; cell(date,b).rev-=parseFloat(rli.subtotal)||0; cell(date,b).it-=parseInt(rli.quantity)||0; bk[b]=1; } }
    for(const b in bk)cell(date,b).or+=1;
  }
  for(const d in daily)for(const b in daily[d])daily[d][b].rev=Math.round(daily[d][b].rev*100)/100;
  return { shopifyDaily:daily, orders:orders.length, window:{since,until} };
}

// ---------- GoKwik (checkout funnel + abandoned cart, via scheduled report emails) ----------
// GoKwik's appid/appsecret only reach the transactional User API; the analytics/report
// service rejects them (401). Funnel data arrives as scheduled-report emails from
// no-reply@gokwik.co with a presigned S3 CSV link. We read the inbox over IMAP, grab the
// newest Checkout Analytics Funnel + Abandoned Cart reports, fetch the CSVs, and aggregate
// to COUNTS ONLY (no PII is ever written to data.json).
//   Funnel report (store-wide, Date x Sales Channel): the 4 funnel stages.
//   Abandoned Cart report (row-level): per-product abandonment by drop stage.
function gkParseCsv(text){ const rows=[]; let row=[],field='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; } else field+=c; }
    else { if(c==='"')q=true; else if(c===','){row.push(field);field='';}
      else if(c==='\n'){row.push(field);field='';if(row.length>1||row[0]!=='')rows.push(row);row=[];}
      else if(c==='\r'){} else field+=c; } }
  if(field!==''||row.length){row.push(field);if(row.length>1||row[0]!=='')rows.push(row);} return rows; }
function gkRowsToObjs(rows){ if(!rows.length)return []; const h=rows[0].map(s=>s.trim());
  return rows.slice(1).map(r=>{const o={};h.forEach((k,i)=>o[k]=(r[i]??'').trim());return o;}); }
function gkBucket(s){ s=(s||'').toLowerCase();
  if(s.includes('lemon fizz')||s.includes('lemon-fizz')||s.includes('gfntrdbt'))return null;
  if(s.includes('melatonin'))return null;
  if(s.includes('continuous glucose')||s.includes('cgm')||s.includes('gftcgm')||s.includes('gfbtcgms'))return 'CGM';
  if(s.includes('body composition')||s.includes('bca')||s.includes('gfwlmkt'))return 'BCA';
  if(s.includes('pcos'))return 'PCOS'; return null; }
function gkDropClass(d){ d=(d||'').toLowerCase(); if(d.includes('address'))return 'addr'; if(d.includes('pay'))return 'pay'; return 'other'; }
function gkDmyToIso(s){ const m=(s||'').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if(!m)return ''; return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'); }
function gkParseFunnel(text){ const objs=gkRowsToObjs(gkParseCsv(text)); const daily={};
  for(const o of objs){ const date=(o['Date']||'').slice(0,10); if(!/^\d{4}-\d\d-\d\d$/.test(date))continue;
    const d=daily[date]=daily[date]||{ci:0,addr:0,pay:0,pm:0,conv:0};
    d.ci+=+o['Checkout Started']||0; d.addr+=+o['Address Landed']||0; d.pay+=+o['Payment Step Reached']||0;
    d.pm+=+o['Payment Method Selected']||0; d.conv+=+o['Sessions Converted']||0; } return daily; }
function gkParseAbandoned(text){ const objs=gkRowsToObjs(gkParseCsv(text)); const daily={}; let total=0,mapped=0;
  for(const o of objs){ total++;
    const b=gkBucket((o['Line items']||'')+' '+(o['Variant title']||'')+' '+(o['Landing Page']||'')+' '+(o['Discount Code']||''));
    if(!b)continue; mapped++; const date=gkDmyToIso(o['Created At']); if(!date)continue; const dc=gkDropClass(o['Drop Stage']);
    const cell=((daily[date]=daily[date]||{})[b]=daily[date][b]||{ab:0,addr:0,pay:0});
    cell.ab++; if(dc==='addr')cell.addr++; else if(dc==='pay')cell.pay++; } return {daily,total,mapped}; }
async function gkLatestReport(client, simpleParser, subjectIncludes, exclude){
  const sinceD=new Date(); sinceD.setUTCDate(sinceD.getUTCDate()-21);
  const lock=await client.getMailboxLock('INBOX');
  try{ let best=null;
    for await (const msg of client.fetch({from:'no-reply@gokwik.co',since:sinceD},{envelope:true,uid:true})){
      const subj=(msg.envelope&&msg.envelope.subject)||''; const lc=subj.toLowerCase();
      if(lc.includes(subjectIncludes.toLowerCase()) && !(exclude&&lc.includes(exclude))){
        if(!best||msg.envelope.date>best.date) best={uid:msg.uid,date:msg.envelope.date,subj}; } }
    if(!best)return null;
    const dl=await client.download(best.uid,undefined,{uid:true}); const chunks=[];
    for await (const c of dl.content)chunks.push(c);
    const parsed=await simpleParser(Buffer.concat(chunks)); const html=parsed.html||parsed.text||'';
    const m=html.replace(/&amp;/g,'&').match(/https:\/\/s3[^\s"'<>)]+amazonaws\.com[^\s"'<>)]+/);
    return {subj:best.subj,date:best.date,url:m?m[0]:null};
  } finally { lock.release(); } }
async function getGokwik(){
  const user=process.env.GMAIL_IMAP_USER, pass=process.env.GMAIL_IMAP_APP_PASSWORD;
  if(!user||!pass) throw new Error('GMAIL_IMAP_USER / GMAIL_IMAP_APP_PASSWORD missing');
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client=new ImapFlow({host:'imap.gmail.com',port:993,secure:true,logger:false,auth:{user,pass}});
  await client.connect();
  let funnelDaily=null, abandonedDaily=null, info={};
  try{
    const fl=await gkLatestReport(client,simpleParser,'Checkout Analytics Funnel Report','marketing params');
    if(fl&&fl.url){ const t=await (await fetch(fl.url)).text(); funnelDaily=gkParseFunnel(t); info.funnel=fl.subj; }
    const al=await gkLatestReport(client,simpleParser,'Abandoned Cart Report');
    if(al&&al.url){ const t=await (await fetch(al.url)).text(); const r=gkParseAbandoned(t); abandonedDaily=r.daily; info.abandoned=al.subj; info.abandonedRows=r.total+'/'+r.mapped; }
  } finally { await client.logout().catch(()=>{}); }
  if(!funnelDaily && !abandonedDaily) throw new Error('no GoKwik report emails found (schedule Checkout Analytics Funnel + Abandoned Cart to '+user+')');
  return { funnelDaily, abandonedDaily, info }; }


// ---------- Program Revenue (from SharePoint sales sheet, anonymous download) ----------
// Source is a personal SharePoint share set to "anyone with the link can view", so an
// unattended download.aspx?share=<token> call returns the .xlsx with no auth (verified:
// HTTP 200, spreadsheet content-type). We parse only the GoodFlip monthly transaction
// tabs (tab name starts "gf" AND header has the txn signature, which excludes Aggregated
// data, summaries, pivots and the TatvaPractice tabs), map each sale to a Program, and sum
// Net Revenue (ex-GST, INR) per day. COUNTS/AMOUNTS ONLY: no patient name, phone, city or
// any PII is ever written to data.json.
//   Program rule (confirmed with Archana): Sale Type contains "sema" => GLP-1 (Sema Care
//   Plan = semaglutide; carved OUT of Obesity, no double-count); else Therapy Area =>
//   Diabetes | Obesity | Pre-Diabetes | PCOS; anything else (Fatty Liver, B2B, blank) =>
//   Unattributed (surfaced + flagged, never invented into a split).
const PROG_SIG = ['Date', 'Therapy Area', 'Net Revenue', 'Sale Type', 'Lead Campaign'];
function progBucket(therapyArea, saleType) {
  const st = (saleType || '').toString().trim().toLowerCase();
  if (st.includes('sema')) return 'GLP-1';
  const t = (therapyArea || '').toString().trim().toLowerCase();
  if (t === 'diabetes') return 'Diabetes';
  if (t === 'obesity') return 'Obesity';
  if (t === 'pre-diabetes' || t === 'prediabetes' || t === 'pre diabetes') return 'Pre-Diabetes';
  if (t === 'pcos') return 'PCOS';
  return 'Unattributed';
}
function progExcelIso(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const d = new Date(v); return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}
async function getProgramRevenue() {
  if (!PROGRAM_REV_URL) throw new Error('PROGRAM_REVENUE_XLSX_URL secret not set');
  const XLSX = await import('xlsx');
  const cut = daysAgo(PROGRAM_REV_DAYS);
  // Cache-bust the SharePoint share-link download. The anonymous download.aspx URL can be served
  // from SharePoint's CDN cache for up to ~an hour, so without this a 10-minute pull could keep
  // fetching a STALE copy of the sheet and newly-entered sales would only surface ~hourly. A unique
  // query param per run defeats any URL-keyed CDN cache; no-store + no-cache headers cover the rest.
  const revUrl = PROGRAM_REV_URL + (PROGRAM_REV_URL.includes('?') ? '&' : '?') + 'nocache=' + Date.now();
  const r = await fetch(revUrl, { cache: 'no-store', headers: { 'User-Agent': 'adradar-refresh', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`SharePoint ${r.status}: ${t.slice(0, 160)}`); }
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/html')) throw new Error('got HTML not xlsx (share link likely no longer anonymous / login required)');
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(buf, { cellDates: false });

  const daily = {};   // programRevenueDaily: { date: { Program: netRevenue } } (unchanged)
  const sales = {};   // programSalesDaily: rich per-program aggregates (counts + amounts only, no PII)
  const csales = {};  // counsellorSalesDaily: per-counsellor Care vs Non-care sales/revenue (leaderboard)
  const seen = new Set(); const unattr = {}; const tabsUsed = [];
  let rowsKept = 0, dupes = 0;
  // canonical-casing maps so "smart CGM" / "Smart CGM" etc. merge across the whole parse
  const srcC = {}, planC = {}, cityC = {}, repC = {};
  const canon = (m, raw) => { const t = (raw == null ? '' : raw.toString()).replace(/\s+/g, ' ').trim(); if (!t) return ''; const lc = t.toLowerCase(); return (m[lc] || (m[lc] = t)); };
  const isMeta = v => (v || '').toString().trim().toLowerCase().startsWith('fb');
  const bucketOf = d => d <= 7 ? '0-7' : d <= 14 ? '8-14' : d <= 30 ? '15-30' : d <= 60 ? '31-60' : '60+';
  const r2 = x => Math.round(x * 100) / 100;

  // Record WHY each sheet was skipped. A month tab that gets renamed, or loses one of the five
  // required headers, was previously dropped in silence: because programSalesDaily is merged by
  // date, that month's old numbers simply froze and went on looking plausible forever. June 2026
  // is currently in exactly that state. Surfacing the reason makes the failure visible instead.
  const tabsSkipped = [], tabsDegraded = [];
  for (const name of wb.SheetNames) {
    if (!name.trim().toLowerCase().startsWith('gf')) { tabsSkipped.push(name + ' :: name does not start with GF'); continue; }
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    if (!rows.length) continue;
    const hdr = rows[0].map(h => (h == null ? '' : h.toString().trim()));
    // Resolve headers TOLERANTLY. Matching the exact string meant a single renamed or
    // re-spaced column silently dropped a whole month (GF-June-26 lost 'Therapy Area' and
    // froze at its last good value for weeks). Normalise away case, spaces and punctuation,
    // and accept the spellings people actually use.
    const norm = s => s.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
    const HDR_ALIASES = {
      'Date': ['date', 'saledate', 'dateofsale'],
      'Therapy Area': ['therapyarea', 'therapy', 'therapyareas', 'diseasearea', 'disease'],
      'Net Revenue': ['netrevenue', 'netrev', 'netrevenueingst', 'netrevexgst'],
      'Sale Type': ['saletype', 'typeofsale', 'saletypes'],
      'Lead Campaign': ['leadcampaign', 'campaign', 'campaignname']
    };
    const hidx = want => {
      const exact = hdr.indexOf(want);
      if (exact >= 0) return exact;
      const alts = HDR_ALIASES[want] || [norm(want)];
      return hdr.findIndex(h => h && alts.includes(norm(h)));
    };
    // Date, Net Revenue and Sale Type are load-bearing: without them a row cannot be placed or
    // valued at all, so a tab missing any of them is genuinely unusable. Therapy Area and Lead
    // Campaign are NOT: a row missing them is still real money and belongs in the totals, it
    // just lands in Unattributed (which the dashboard now shows). Degrading beats freezing.
    const CORE = ['Date', 'Net Revenue', 'Sale Type'];
    const missingCore = CORE.filter(x => hidx(x) < 0);
    if (missingCore.length) {
      tabsSkipped.push(name + ' :: missing required header(s) ' + missingCore.join(', '));
      continue;
    }
    const missingSoft = ['Therapy Area', 'Lead Campaign'].filter(x => hidx(x) < 0);
    if (missingSoft.length) tabsDegraded.push(name + ' :: missing ' + missingSoft.join(', ') + ' (rows loaded, therapy shown as Unattributed)');
    const di = hidx('Date'), thi = hidx('Therapy Area'), sti = hidx('Sale Type'),
      ni = hidx('Net Revenue'), naoi = hdr.indexOf('Net Rev of all'), coi = hdr.indexOf('Contact Number'), gi = hdr.indexOf('Selling Price Gross'),
      cami = hidx('Lead Campaign'), lpi = hdr.indexOf('Listed Price'),
      lci = hdr.indexOf('Lead Created Date'), cityi = hdr.indexOf('City'), hci = hdr.indexOf('Health Counsellor');
    let kept = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]; if (!row) continue;
      const iso = progExcelIso(row[di]); if (!iso || iso < cut) continue;   // 120-day window only
      const net = parseFloat(row[ni]); if (!isFinite(net)) continue;        // skip blank / non-numeric revenue
      // GLP Drug is a pass-through purchase (the actual GLP medication). GoodFlip earns NO revenue
      // on it, which is why its "Net Rev of all" is intentionally left blank in the sheet. Exclude
      // these rows from revenue entirely (do not fall back to the gross Net Revenue and over-count).
      const _st = (row[sti] == null ? '' : row[sti].toString()).toLowerCase();
      if (_st.includes('glp drug')) continue;
      const dedupeKey = iso + '|' + (row[coi] ?? '') + '|' + (row[gi] ?? '') + '|' + net;
      if (seen.has(dedupeKey)) { dupes++; continue; } seen.add(dedupeKey);  // guard against tab overlap
      const grossV = parseFloat(row[gi]); const gross = isFinite(grossV) ? grossV : 0;
      const listedV = parseFloat(row[lpi]); const hasDisc = isFinite(listedV) && listedV > 0 && gross > 0;
      const p = progBucket(row[thi], row[sti]);
      // programRevenueDaily (unchanged shape, powers the existing Revenue/ROAS cards)
      (daily[iso] = daily[iso] || {}); daily[iso][p] = r2((daily[iso][p] || 0) + net);
      kept++; rowsKept++;
      if (p === 'Unattributed') { const k = ((row[thi] || '(blank)') + '').trim() + ' / ' + ((row[sti] || '(blank)') + '').trim(); unattr[k] = r2((unattr[k] || 0) + net); }
      // programSalesDaily (rich aggregates: dimensions are source/plan/city/rep, all non-PII labels)
      const a = (sales[iso] = sales[iso] || {})[p] = (sales[iso][p] || { n: 0, rev: 0, gross: 0, mN: 0, mRev: 0, dListed: 0, dGross: 0, src: {}, plan: {}, city: {}, rep: {}, cyc: { sum: 0, n: 0, b: {} } });
      a.n += 1; a.rev = r2(a.rev + net); a.gross = r2(a.gross + gross);
      if (isMeta(row[cami])) { a.mN += 1; a.mRev = r2(a.mRev + net); }
      if (hasDisc) { a.dListed = r2(a.dListed + listedV); a.dGross = r2(a.dGross + gross); }
      const sk = canon(srcC, row[cami]); if (sk) { const o = a.src[sk] = a.src[sk] || { n: 0, rev: 0 }; o.n++; o.rev = r2(o.rev + net); }
      const pk = canon(planC, row[sti]); if (pk) { const o = a.plan[pk] = a.plan[pk] || { n: 0, rev: 0 }; o.n++; o.rev = r2(o.rev + net); o.revAll = r2((o.revAll||0) + (isFinite(parseFloat(row[naoi]))?parseFloat(row[naoi]):net)); }
      const ck = canon(cityC, row[cityi]); if (ck) { const o = a.city[ck] = a.city[ck] || { n: 0, rev: 0 }; o.n++; o.rev = r2(o.rev + net); }
      const rk = canon(repC, row[hci]); if (rk) { const o = a.rep[rk] = a.rep[rk] || { n: 0, rev: 0, dListed: 0, dGross: 0 }; o.n++; o.rev = r2(o.rev + net); if (hasDisc) { o.dListed = r2(o.dListed + listedV); o.dGross = r2(o.dGross + gross); } }
      const _cs = canonCounsellor(row[hci]); if (_cs) { const cc = (csales[iso] = csales[iso] || {})[_cs] = (csales[iso][_cs] || { cN:0, cRev:0, nN:0, nRev:0, careTh:{} }); if (isCareSale(row[sti])) { cc.cN += 1; cc.cRev = r2(cc.cRev + net); const _th = (p === 'Unattributed' ? 'Other' : p); (cc.careTh = cc.careTh || {}); const _to = cc.careTh[_th] = cc.careTh[_th] || { n:0, rev:0 }; _to.n += 1; _to.rev = r2(_to.rev + net); } else { cc.nN += 1; cc.nRev = r2(cc.nRev + net); } }
      const liso = progExcelIso(row[lci]);
      if (liso) { const days = Math.round((new Date(iso) - new Date(liso)) / 86400000); if (days >= 0 && days <= 3650) { a.cyc.sum += days; a.cyc.n += 1; const b = bucketOf(days); a.cyc.b[b] = (a.cyc.b[b] || 0) + 1; } }
    }
    if (kept) tabsUsed.push(name + ':' + kept);
  }
  if (rowsKept === 0) throw new Error('no in-window rows parsed (sheet shape may have changed)');
  if (tabsSkipped.length) console.log('[programRevenue] SKIPPED tab(s): ' + tabsSkipped.join(' | '));
  if (tabsDegraded.length) console.log('[programRevenue] DEGRADED tab(s): ' + tabsDegraded.join(' | '));
  return { programRevenueDaily: daily, programSalesDaily: sales, counsellorSalesDaily: csales, info: { rowsKept, dupes, tabsUsed, tabsSkipped, tabsDegraded, unattributed: unattr, window: { since: cut, until: TODAY } } };
}

// ---------- main ----------
// Public-repo build: prior state comes from the Blob feed (data.json is never committed here, so
// no revenue/lead data is exposed). Loading prev from Blob also lets the frequent light runs
// preserve Meta/GoKwik from the last full run. Fail-soft: if Blob is unreachable, start empty.
let prev={};
// The feed now lives in KV (Blob was suspended). Load prev from KV first so carry-forward of
// Meta spend / dailyCreatives keeps working when an account errors on a run. Blob is a fallback.
try {
  const KV_URL = process.env.KV_REST_API_URL, KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (KV_URL && KV_TOKEN) {
    const _kv = await fetch(`${KV_URL}/get/${encodeURIComponent('goodflip:feed')}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` }, cache: 'no-store' });
    if (_kv.ok) {
      const j = await _kv.json();
      if (j && j.result) { prev = typeof j.result === 'string' ? JSON.parse(j.result) : j.result; console.log('[prev] loaded from KV:', Object.keys(prev).length, 'keys'); }
      else console.log('[prev] KV empty - will try Blob');
    } else console.log('[prev] KV returned ' + _kv.status + ' - will try Blob');
  }
} catch (e) { console.log('[prev] KV load failed:', e.message); }
if (!Object.keys(prev).length) {
  try {
    const BLOB_FEED = process.env.BLOB_FEED_URL || 'https://lh0xjabzcqzdnpyx.public.blob.vercel-storage.com/feed.json';
    const _pr = await fetch(BLOB_FEED + '?_=' + Date.now(), { cache: 'no-store' });
    if (_pr.ok) { prev = await _pr.json(); console.log('[prev] loaded from Blob:', Object.keys(prev).length, 'keys'); }
    else console.log('[prev] Blob returned ' + _pr.status + ' - starting empty');
  } catch (e) { console.log('[prev] Blob load failed (starting empty):', e.message); }
}

// Two-speed refresh. REFRESH_MODE=light refreshes only the fast, frequently-changing sources
// (LeadSquared, Shopify, Program Revenue) and PRESERVES the slow/periodic ones (Meta Graph and
// GoKwik) from the previous data.json. A light run finishes in ~1 min, so an external cron can
// rebuild the feed every few minutes without paying Meta's ~4-min paced pull each time. The
// default (full) run refreshes everything, and should stay on an hourly cadence for Meta.
const modeEnv = (process.env.REFRESH_MODE||'').toLowerCase();
// Auto-escalate: a light run promotes itself to a FULL (Meta) pull if the last full run was more
// than ~55 min ago. This keeps Meta fresh on the SAME reliable external trigger, with zero
// dependence on GitHub's unreliable internal scheduler. Explicit REFRESH_MODE=full still forces full.
const _lastFull = (prev.meta && prev.meta.lastFullRun) ? Date.parse(prev.meta.lastFullRun) : 0;
const _metaStale = !_lastFull || (Date.now() - _lastFull) > 55*60*1000;
const LIGHT = (modeEnv === 'light') && !_metaStale;
const out={ dailyCreatives:prev.dailyCreatives||{}, creativeImages:{}, mqlDaily:prev.mqlDaily||{}, lsqAllDaily:prev.lsqAllDaily||{}, lsqStageDaily:prev.lsqStageDaily||{}, lsqSourceDaily:prev.lsqSourceDaily||{}, glpYesDaily:prev.glpYesDaily||{}, mqlCityDaily:prev.mqlCityDaily||{}, mqlAgeDaily:prev.mqlAgeDaily||{}, shopifyDaily:prev.shopifyDaily||{}, gokwikFunnelDaily:prev.gokwikFunnelDaily||{}, gokwikAbandonedDaily:prev.gokwikAbandonedDaily||{}, programRevenueDaily:prev.programRevenueDaily||{}, programSalesDaily:prev.programSalesDaily||{}, counsellorSalesDaily:prev.counsellorSalesDaily||{}, counsellorLeadsDaily:prev.counsellorLeadsDaily||{}, meta: Object.assign({}, prev.meta||{}, { sources: Object.assign({}, (prev.meta&&prev.meta.sources)||{}), version:'gha-v1', lastRun:new Date().toISOString(), mode: LIGHT?'light':'full' }) };
// Mark when a full (Meta) pull is attempted so auto-escalation waits ~1h before the next one
// (prevents hammering Meta's rate limit if a pull fails).
if(!LIGHT) out.meta.lastFullRun = new Date().toISOString();

const token=process.env.META_ACCESS_TOKEN;
async function run(name, fn, apply){ try{ const r=await fn(); apply(r); out.meta.sources[name]='ok'; console.log('['+name+'] ok'); }catch(e){ out.meta.sources[name]='error: '+e.message; console.error('['+name+'] FAILED:', e.message); } }

if(!LIGHT) await run('performance', ()=>{ if(!token)throw new Error('META_ACCESS_TOKEN missing'); return getPerformance(token); },
    r=>{ const bad=Object.values(r.accountStatus||{}).filter(v=>!String(v).startsWith('ok'));
      if(bad.length){ console.log('[performance] PARTIAL - '+bad.length+' account(s) failed; keeping previous dailyCreatives');
        out.meta.spendStale=true; out.meta.spendAsOfRun=(prev.meta&&prev.meta.lastRun)||null; }
      else { Object.assign(out.dailyCreatives, r.dailyCreatives); out.meta.spendStale=false; out.meta.spendAsOfRun=null; }
      out.meta.accountStatus=r.accountStatus; out.meta.perfWindow=r.window; });

// One-off historical Meta spend (29 Nov 2025 - 13 May 2026), sourced from Coupler because the
// TatvaCare ad account returns a 500 on wide historical Insights queries. Reconciled against the
// API for July to within 1%. Only fills days the API did NOT return, so it can never double-count
// and it quietly stops mattering if Meta history ever becomes fetchable.
if(!LIGHT) try{
  const seed=JSON.parse(readFileSync('spend-backfill.json','utf8'));
  let filled=0;
  // Merge PER THERAPY, not per day. Some days (14 May - 11 Jun) were written while the TatvaCare
  // account was erroring, so they hold GLP-1 rows only. Adding just the therapies that are absent
  // repairs those days without touching the GLP-1 spend that is already correct, and stays
  // idempotent: once a therapy exists for a day it is never added again.
  for(const d in seed){
    const rows=out.dailyCreatives[d]=out.dailyCreatives[d]||[];
    const have={}; for(const r of rows) have[r.t]=true;
    for(const t in seed[d]){
      if(have[t]) continue;
      rows.push({t:t,s:seed[d][t],l:0,seed:1});
      filled++;
    }
  }
  console.log('[spend-backfill] filled '+filled+' historical day(s)');
}catch(e){ console.log('[spend-backfill] skipped: '+e.message); }
await run('mql', getMQL, r=>{ for(const k of ['mqlDaily','lsqAllDaily','lsqStageDaily','lsqSourceDaily','glpYesDaily','mqlCityDaily','mqlAgeDaily','counsellorLeadsDaily']){ if(r[k]) Object.assign(out[k]=out[k]||{}, r[k]); } out.meta.mqlPulled=r.pulled; });
await run('shopify', getShopify, r=>{ out.shopifyDaily=r.shopifyDaily; out.meta.shopifyOrders=r.orders; });
if(!LIGHT) await run('gokwik', getGokwik, r=>{
  // MERGE by date (not replace): each daily report updates the days it carries and
  // preserves all prior days, so history accumulates even if a report comes through
  // narrow. Then prune to the last 120 days to keep data.json bounded.
  if(r.funnelDaily) Object.assign(out.gokwikFunnelDaily, r.funnelDaily);
  if(r.abandonedDaily) Object.assign(out.gokwikAbandonedDaily, r.abandonedDaily);
  out.meta.gokwik=r.info;
  const cut=daysAgo(400);
  for(const k of Object.keys(out.gokwikFunnelDaily)) if(k<cut) delete out.gokwikFunnelDaily[k];
  for(const k of Object.keys(out.gokwikAbandonedDaily)) if(k<cut) delete out.gokwikAbandonedDaily[k];
});

await run('programRevenue', getProgramRevenue, r=>{
  // MERGE by date like GoKwik: each run recomputes the full 120-day window from the
  // authoritative sheet and replaces those days; days outside the window are preserved
  // then pruned. A successful run never blanks history; a failed run skips apply entirely
  // so the prior values stand.
  Object.assign(out.programRevenueDaily, r.programRevenueDaily);
  Object.assign(out.programSalesDaily, r.programSalesDaily);
  Object.assign(out.counsellorSalesDaily, r.counsellorSalesDaily||{});
  out.meta.programRevenue = r.info;
  const cut=daysAgo(400);
  for(const k of Object.keys(out.programRevenueDaily)) if(k<cut) delete out.programRevenueDaily[k];
  for(const k of Object.keys(out.programSalesDaily)) if(k<cut) delete out.programSalesDaily[k];
  for(const k of Object.keys(out.counsellorSalesDaily||{})) if(k<cut) delete out.counsellorSalesDaily[k];
  for(const k of Object.keys(out.counsellorLeadsDaily||{})) if(k<cut) delete out.counsellorLeadsDaily[k];
});

const dates=Object.keys(out.dailyCreatives).sort();
out.meta.dateRange={ min:dates[0]||'', max:dates[dates.length-1]||'' };
// Keep the dashboard's current day (perfWindow.until) advancing every run in IST, even on light runs.
out.meta.perfWindow = Object.assign({ since: daysAgo(PERF_DAYS) }, out.meta.perfWindow || {}, { until: TODAY });
writeFileSync('data.json', JSON.stringify(out));
console.log('Wrote data.json ['+(out.meta.mode||'full')+'] | perf dates:', dates.length, '| sources:', JSON.stringify(out.meta.sources));
// Publish the canonical feed to Vercel Blob - the neutral store BOTH dashboards read as
// peers (scorecard + Meta dashboard). data.json is already written above and still gets
// committed, so this is purely additive. FAIL-SOFT: a Blob outage must never fail the ETL.
try {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (blobToken) {
    const { put } = await import('@vercel/blob');
    const res = await put('feed.json', JSON.stringify(out), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      token: blobToken
    });
    console.log('[blob] published feed ->', res.url);
  } else {
    console.log('[blob] skipped: BLOB_READ_WRITE_TOKEN not set');
  }
} catch (e) {
  console.error('[blob] publish FAILED (data.json still committed, feed just not refreshed):', e.message);
}

// Publish a SLIM scorecard feed to Vercel KV - the permanent, bandwidth-proof store the dashboard
// reads via /api/feed. KV is metered by request COUNT (not data transfer), so the always-on TV
// can't exhaust it the way it exhausted Blob. Only the ~10 keys the scorecard uses are sent
// (creativeImages etc. stay out), keeping the value small. FAIL-SOFT.
try {
  const KV_URL = process.env.KV_REST_API_URL, KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (KV_URL && KV_TOKEN) {
    const SLIM = ['meta','dailyCreatives','mqlDaily','lsqAllDaily','lsqStageDaily','lsqSourceDaily','glpYesDaily','mqlCityDaily','mqlAgeDaily','programSalesDaily','programRevenueDaily','counsellorSalesDaily','counsellorLeadsDaily'];
    const slim = {}; for (const k of SLIM) slim[k] = out[k];
    const payload = JSON.stringify(slim);
    const r = await fetch(`${KV_URL}/set/${encodeURIComponent('goodflip:feed')}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: payload
    });
    if (!r.ok) throw new Error('KV set ' + r.status + ': ' + (await r.text()).slice(0, 140));
    console.log('[kv] published slim feed -> goodflip:feed (' + (payload.length / 1024 | 0) + ' KB)');
  } else {
    console.log('[kv] skipped: KV_REST_API_URL / KV_REST_API_TOKEN not set');
  }
} catch (e) {
  console.error('[kv] publish FAILED:', e.message);
}

// Fail the job only if EVERY source errored (so a partial outage still commits good data).
const oks=Object.values(out.meta.sources).filter(v=>v==='ok').length;
if(oks===0){ console.error('All sources failed.'); process.exit(1); }
