import { useState, useEffect, useCallback, useRef } from "react";

// ═══════════════════════════════════════════════════════════
// CONVERSION LOGIC (Broadlink → Tuya/MQTT raw IR)
// ═══════════════════════════════════════════════════════════
const BRDLNK_UNIT = 269 / 8192;
const filterSignal = arr => arr.filter(x => x < 65535);

function getRawFromBroadlink(hex) {
  const dec = [];
  if (hex.length < 8) return dec;
  const length = parseInt(hex.slice(6, 8) + hex.slice(4, 6), 16);
  let i = 8;
  while (i < length * 2 + 8) {
    let hv = hex.slice(i, i + 2);
    if (hv === "00") { hv = hex.slice(i+2,i+4)+hex.slice(i+4,i+6); i += 4; }
    const p = parseInt(hv, 16);
    if (!isNaN(p) && hv.length === 2) dec.push(Math.ceil(p / BRDLNK_UNIT));
    i += 2;
  }
  return dec;
}

function emitLiteralBlock(out, data) { out.push(data.length-1); for (const b of data) out.push(b); }
function emitLiteralBlocks(out, data) { for (let i=0;i<data.length;i+=32) emitLiteralBlock(out,data.slice(i,i+32)); }
function emitDistanceBlock(out, length, distance) {
  distance -= 1; length -= 2;
  const block = [];
  if (length >= 7) { block.push(length-7); length=7; }
  block.unshift((length<<5)|(distance>>8)); block.push(distance&0xff);
  for (const b of block) out.push(b);
}
function compress(data) {
  const out=[], W=8192, L=264;
  const suffixes=[]; let nextPos=0;
  function cmp(a,b){const m=Math.min(data.length-a,data.length-b);for(let k=0;k<m;k++){if(data[a+k]<data[b+k])return -1;if(data[a+k]>data[b+k])return 1;}return(data.length-a)-(data.length-b);}
  function findIdx(n){let lo=0,hi=suffixes.length;while(lo<hi){const m=(lo+hi)>>1;if(cmp(suffixes[m],n)<0)lo=m+1;else hi=m;}return lo;}
  function getCands(){while(nextPos<=pos){if(suffixes.length===W)suffixes.splice(findIdx(nextPos-W),1);suffixes.splice(findIdx(nextPos),0,nextPos);nextPos++;}const idx=findIdx(pos);return[+1,-1].map(d=>idx+d).filter(i=>i>=0&&i<suffixes.length).map(i=>pos-suffixes[i]);}
  function lenFor(start){let l=0;const lim=Math.min(L,data.length-pos);while(l<lim&&data[pos+l]===data[start+l])l++;return l;}
  function best(){const cs=getCands();let b=null;for(const d of cs){const l=lenFor(pos-d);if(!b||l>b[0]||(l===b[0]&&d<b[1]))b=[l,d];}return b;}
  let pos=0, bs=0;
  while(pos<data.length){const c=best();if(c&&c[0]>=3){emitLiteralBlocks(out,data.slice(bs,pos));emitDistanceBlock(out,c[0],c[1]);pos+=c[0];bs=pos;}else pos++;}
  emitLiteralBlocks(out,data.slice(bs,pos));
  return new Uint8Array(out);
}
function encodeIR(command) {
  const bin=atob(command), hex=Array.from(bin).map(c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
  const signal=filterSignal(getRawFromBroadlink(hex));
  const payload=new Uint8Array(signal.length*2);
  const view=new DataView(payload.buffer);
  signal.forEach((s,i)=>view.setUint16(i*2,s,true));
  const comp=compress(Array.from(payload));
  let b2=''; for(const b of comp) b2+=String.fromCharCode(b);
  return btoa(b2);
}
function processRec(commands) {
  const r={};
  for(const [k,v] of Object.entries(commands)){
    if(typeof v==='string') r[k]=v?encodeIR(v):v;
    else if(typeof v==='object'&&v!==null) r[k]=processRec(v);
    else r[k]=v;
  }
  return r;
}
function convertJSON(txt, ctrl) {
  const d=JSON.parse(txt);
  d.commands=processRec(d.commands||{});
  d.supportedController=ctrl;
  d.commandsEncoding='Raw';
  return JSON.stringify(d,null,2);
}

// ═══════════════════════════════════════════════════════════
// PARSE CLIMATE.md → device catalog
// ═══════════════════════════════════════════════════════════
function parseClimateMd(md) {
  const devices = [];
  let currentBrand = null;
  const tableRowRe = /^\|\s*\[(\d+)\][^\|]*\|\s*([^\|]+)\|\s*([^\|]+)\|/;
  const brandRe = /^####\s+(.+)/;
  for (const line of md.split('\n')) {
    const bm = line.match(brandRe);
    if (bm) { currentBrand = bm[1].trim(); continue; }
    const rm = line.match(tableRowRe);
    if (rm && currentBrand) {
      devices.push({
        brand: currentBrand,
        code: parseInt(rm[1]),
        models: rm[2].trim().replace(/\*\*/g,''),
        controller: rm[3].trim().replace(/\*\*/g,''),
      });
    }
  }
  return devices;
}

// ═══════════════════════════════════════════════════════════
// GITHUB URLs
// ═══════════════════════════════════════════════════════════
const GH_RAW = "https://raw.githubusercontent.com/smartHomeHub/SmartIR/master";
const CLIMATE_MD_URL = `${GH_RAW}/docs/CLIMATE.md`;
const CLIMATE_DIR_API = "https://api.github.com/repos/smartHomeHub/SmartIR/contents/codes/climate";
const RAW_BASE = `${GH_RAW}/codes/climate/`;

const CTRL_COLORS = {
  Broadlink:"#00ff87", Xiaomi:"#3b9eff", "Xiaomi v2":"#5ec8ff",
  "Xiaomi (v2)":"#5ec8ff", ESPHome:"#ff9f3b", LOOKin:"#cc88ff",
};
function ctrlColor(c) {
  for (const [k,v] of Object.entries(CTRL_COLORS)) if (c.toLowerCase().includes(k.toLowerCase())) return v;
  return "#888";
}

const G = {
  bg:"#08080d", surface:"#0d0f1a", border:"#1a2035", accent:"#00ff87",
  accentDim:"#00ff8720", text:"#c8d0e8", muted:"#3a4060", dim:"#1a2035",
};

// ═══════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════
export default function App() {
  const [tab, setTab] = useState("repo");
  const [controller, setController] = useState("MQTT");

  // Catalog state
  const [loadStatus, setLoadStatus] = useState("idle"); // idle|loading|done|error
  const [loadError, setLoadError] = useState("");
  const [allDevices, setAllDevices] = useState([]);     // from CLIMATE.md (brand/model info)
  const [allCodes, setAllCodes] = useState(new Set());  // from GitHub API (actual files)
  const [lastUpdated, setLastUpdated] = useState(null);

  // Browse state
  const [search, setSearch] = useState("");
  const [selectedBrand, setSelectedBrand] = useState(null);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [fetchStatus, setFetchStatus] = useState("idle");
  const [sourceJSON, setSourceJSON] = useState("");

  // Conversion state
  const [output, setOutput] = useState("");
  const [convStatus, setConvStatus] = useState("idle");
  const [convError, setConvError] = useState("");

  // Manual tab
  const [manualInput, setManualInput] = useState("");
  const [manualFilename, setManualFilename] = useState("");
  const [manualOutput, setManualOutput] = useState("");
  const [manualConvStatus, setManualConvStatus] = useState("idle");
  const [manualConvError, setManualConvError] = useState("");
  const fileRef = useRef();

  // ── Load catalog on mount ──────────────────────────────
  async function loadCatalog() {
    setLoadStatus("loading");
    setLoadError("");
    try {
      // Fetch CLIMATE.md and GitHub dir listing in parallel
      const [mdRes, apiRes] = await Promise.all([
        fetch(CLIMATE_MD_URL),
        fetch(CLIMATE_DIR_API),
      ]);
      if (!mdRes.ok) throw new Error(`CLIMATE.md: HTTP ${mdRes.status}`);
      const md = await mdRes.text();
      const devices = parseClimateMd(md);
      setAllDevices(devices);

      if (apiRes.ok) {
        const files = await apiRes.json();
        const codes = new Set(
          Array.isArray(files)
            ? files.filter(f=>f.name.endsWith('.json')).map(f=>parseInt(f.name))
            : []
        );
        setAllCodes(codes);
      } else {
        // Fallback: derive code set from parsed md
        setAllCodes(new Set(devices.map(d=>d.code)));
      }

      setLastUpdated(new Date().toLocaleTimeString());
      setLoadStatus("done");
    } catch(e) {
      setLoadError(e.message);
      setLoadStatus("error");
    }
  }

  useEffect(() => { loadCatalog(); }, []);

  // ── Derived lists ──────────────────────────────────────
  const brands = [...new Set(allDevices.map(d=>d.brand))].sort();

  const filteredDevices = allDevices.filter(d => {
    if (selectedBrand && d.brand !== selectedBrand) return false;
    if (search) {
      const q = search.toLowerCase();
      return d.brand.toLowerCase().includes(q)
          || d.models.toLowerCase().includes(q)
          || String(d.code).includes(q);
    }
    return true;
  });

  // ── Fetch a device's JSON ──────────────────────────────
  async function fetchDevice(device) {
    if (selectedDevice?.code === device.code) return;
    setSelectedDevice(device);
    setFetchStatus("loading");
    setSourceJSON(""); setOutput(""); setConvStatus("idle");
    try {
      const res = await fetch(`${RAW_BASE}${device.code}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const txt = await res.text();
      setSourceJSON(txt);
      setFetchStatus("done");
    } catch(e) {
      setFetchStatus("error:" + e.message);
    }
  }

  // ── Convert ───────────────────────────────────────────
  function doConvert(inputText, setOut, setStatus, setErr) {
    setStatus("converting"); setErr(""); setOut("");
    setTimeout(() => {
      try {
        setOut(convertJSON(inputText, controller));
        setStatus("done");
      } catch(e) { setErr(e.message); setStatus("error"); }
    }, 30);
  }

  function handleDownload(json, name) {
    const blob = new Blob([json],{type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href=url; a.download=`${name}_mqtt.json`; a.click();
    URL.revokeObjectURL(url);
  }

  // ── Styles ────────────────────────────────────────────
  const pill = (active, color=G.accent) => ({
    padding:"5px 13px", borderRadius:20, cursor:"pointer", fontSize:11,
    fontFamily:"inherit", letterSpacing:"0.06em", transition:"all 0.15s",
    background: active ? color+"30" : "transparent",
    color: active ? color : G.muted,
    border: `1px solid ${active ? color : G.border}`,
    fontWeight: active ? "bold" : "normal",
  });

  const scrollArea = { overflowY:"auto", scrollbarWidth:"thin", scrollbarColor:`${G.border} ${G.bg}` };

  return (
    <div style={{minHeight:"100vh",background:G.bg,fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace",color:G.text,display:"flex",flexDirection:"column"}}>

      {/* ── Header ── */}
      <div style={{background:G.surface,borderBottom:`1px solid ${G.border}`,padding:"13px 24px",display:"flex",alignItems:"center",gap:14,flexShrink:0}}>
        <div style={{width:30,height:30,background:`linear-gradient(135deg,${G.accent},#00c660)`,borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:"bold",color:"#000",fontSize:12,boxShadow:`0 0 16px ${G.accentDim}`}}>IR</div>
        <div>
          <div style={{fontSize:14,fontWeight:"bold",color:G.accent,letterSpacing:"0.15em"}}>SMARTIR CONVERTER</div>
          <div style={{fontSize:9,color:G.muted,letterSpacing:"0.1em"}}>BROADLINK → MQTT · LIVE FROM GITHUB</div>
        </div>
        <div style={{flex:1}}/>
        {/* Status badge */}
        {loadStatus==="loading" && <span style={{fontSize:10,color:G.accent,display:"flex",alignItems:"center",gap:5}}><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span>Loading catalog…</span>}
        {loadStatus==="done" && <span style={{fontSize:10,color:"#2a6a3a"}}>✓ {allDevices.length} devices · {allCodes.size} files · {lastUpdated}</span>}
        {loadStatus==="error" && <span style={{fontSize:10,color:"#ff6060",cursor:"pointer"}} onClick={loadCatalog}>✗ Load failed — retry</span>}
        <div style={{width:1,height:20,background:G.border}}/>
        <span style={{fontSize:10,color:G.muted}}>TARGET:</span>
        {["MQTT","UFOR11"].map(c=>(
          <button key={c} onClick={()=>setController(c)} style={pill(controller===c)}>{c}</button>
        ))}
      </div>

      {/* ── Tabs ── */}
      <div style={{background:G.surface,borderBottom:`1px solid ${G.border}`,padding:"0 24px",display:"flex",flexShrink:0}}>
        {[["repo","📦  Browse SmartIR Repo"],["manual","📄  Paste / Upload JSON"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:"11px 18px",background:"transparent",border:"none",borderBottom:`2px solid ${tab===id?G.accent:"transparent"}`,color:tab===id?G.accent:G.muted,cursor:"pointer",fontFamily:"inherit",fontSize:11,letterSpacing:"0.08em",transition:"all 0.15s"}}>{label}</button>
        ))}
      </div>

      {/* ── Body ── */}
      <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>

        {/* ══ REPO TAB ══ */}
        {tab==="repo" && (<>

          {/* Brand sidebar */}
          <div style={{width:175,borderRight:`1px solid ${G.border}`,display:"flex",flexDirection:"column",background:G.surface,flexShrink:0,...scrollArea}}>
            <div style={{padding:"10px 12px 6px",fontSize:9,color:G.muted,letterSpacing:"0.12em",borderBottom:`1px solid ${G.border}`,flexShrink:0}}>BRANDS ({brands.length})</div>
            {loadStatus==="loading" && (
              <div style={{padding:16,color:G.muted,fontSize:10,textAlign:"center",display:"flex",flexDirection:"column",gap:6,alignItems:"center"}}>
                <span style={{animation:"spin 1s linear infinite",display:"inline-block",fontSize:16}}>⟳</span>
                Fetching…
              </div>
            )}
            {loadStatus==="error" && (
              <div style={{padding:12}}>
                <div style={{fontSize:10,color:"#ff6060",marginBottom:8}}>Failed to load</div>
                <button onClick={loadCatalog} style={{...pill(true),display:"block",width:"100%",textAlign:"center"}}>Retry</button>
              </div>
            )}
            {loadStatus==="done" && <>
              <button onClick={()=>{setSelectedBrand(null);}} style={{padding:"7px 12px",background:!selectedBrand?G.accentDim:"transparent",border:"none",borderLeft:`2px solid ${!selectedBrand?G.accent:"transparent"}`,color:!selectedBrand?G.accent:G.muted,cursor:"pointer",fontFamily:"inherit",fontSize:10,textAlign:"left",letterSpacing:"0.05em"}}>
                All brands <span style={{float:"right",opacity:.4}}>{allDevices.length}</span>
              </button>
              {brands.map(b=>{
                const cnt=allDevices.filter(d=>d.brand===b).length;
                return (
                  <button key={b} onClick={()=>{setSelectedBrand(b);setSelectedDevice(null);setOutput("");setSourceJSON("");}} style={{padding:"6px 12px",background:selectedBrand===b?G.accentDim:"transparent",border:"none",borderLeft:`2px solid ${selectedBrand===b?G.accent:"transparent"}`,color:selectedBrand===b?G.accent:G.text,cursor:"pointer",fontFamily:"inherit",fontSize:10,textAlign:"left",letterSpacing:"0.04em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {b} <span style={{float:"right",color:G.muted,fontSize:9}}>{cnt}</span>
                  </button>
                );
              })}
            </>}
          </div>

          {/* Device list */}
          <div style={{width:320,borderRight:`1px solid ${G.border}`,display:"flex",flexDirection:"column",background:G.bg,flexShrink:0}}>
            <div style={{padding:"8px 10px",borderBottom:`1px solid ${G.border}`,flexShrink:0}}>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search brand, model, code…"
                style={{width:"100%",background:G.surface,border:`1px solid ${G.border}`,borderRadius:4,color:G.text,fontFamily:"inherit",fontSize:10,padding:"6px 10px",outline:"none",boxSizing:"border-box"}}/>
            </div>
            <div style={{flex:1,...scrollArea}}>
              {loadStatus==="loading" && Array.from({length:8}).map((_,i)=>(
                <div key={i} style={{padding:"10px 14px",borderBottom:`1px solid ${G.dim}`,opacity:0.3+i*0.05}}>
                  <div style={{height:12,background:G.border,borderRadius:3,width:`${50+i*5}%`,marginBottom:6}}/>
                  <div style={{height:8,background:G.dim,borderRadius:3,width:"40%"}}/>
                </div>
              ))}
              {loadStatus==="done" && filteredDevices.length===0 && (
                <div style={{padding:20,color:G.muted,fontSize:10,textAlign:"center"}}>No devices found</div>
              )}
              {loadStatus==="done" && filteredDevices.map(d=>{
                const hasFIle = allCodes.size===0 || allCodes.has(d.code);
                const isSelected = selectedDevice?.code===d.code;
                const cc = ctrlColor(d.controller);
                return (
                  <div key={`${d.code}`} onClick={()=>fetchDevice(d)} style={{padding:"9px 12px",cursor:"pointer",background:isSelected?G.accentDim:"transparent",borderLeft:`2px solid ${isSelected?G.accent:"transparent"}`,borderBottom:`1px solid ${G.dim}`,transition:"background 0.1s"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                      <span style={{fontSize:13,color:isSelected?G.accent:G.text,fontWeight:"bold"}}>{d.code}</span>
                      <span style={{fontSize:8,padding:"2px 6px",borderRadius:10,background:`${cc}18`,color:cc,border:`1px solid ${cc}30`,letterSpacing:"0.05em"}}>{d.controller}</span>
                    </div>
                    <div style={{fontSize:9,color:G.muted}}>{d.brand}</div>
                    <div style={{fontSize:9,color:"#3a4060",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.models}</div>
                    {!hasFIle && <div style={{fontSize:8,color:"#886040",marginTop:2}}>⚠ file may not exist</div>}
                  </div>
                );
              })}
            </div>
            {loadStatus==="done" && (
              <div style={{padding:"6px 12px",borderTop:`1px solid ${G.border}`,fontSize:9,color:G.muted,display:"flex",justifyContent:"space-between",flexShrink:0}}>
                <span>{filteredDevices.length} shown</span>
                <span style={{cursor:"pointer",color:G.accent}} onClick={loadCatalog}>↺ refresh</span>
              </div>
            )}
          </div>

          {/* Right: detail + convert */}
          <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
            {!selectedDevice ? (
              <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:10,color:G.muted}}>
                <div style={{fontSize:36,opacity:.3}}>←</div>
                <div style={{fontSize:11}}>Select a device to load its JSON from GitHub</div>
                {loadStatus==="done" && <div style={{fontSize:9,color:G.dim}}>{allDevices.length} devices across {brands.length} brands</div>}
              </div>
            ) : (<>
              {/* Device header bar */}
              <div style={{padding:"11px 18px",borderBottom:`1px solid ${G.border}`,background:G.surface,display:"flex",alignItems:"center",gap:14,flexShrink:0,flexWrap:"wrap"}}>
                <div>
                  <div style={{fontSize:14,fontWeight:"bold",color:G.accent}}>{selectedDevice.brand} <span style={{color:G.muted}}>·</span> #{selectedDevice.code}</div>
                  <div style={{fontSize:10,color:G.muted,marginTop:1}}>{selectedDevice.models}</div>
                </div>
                <div style={{flex:1}}/>
                <span style={{fontSize:9,padding:"3px 9px",borderRadius:10,background:`${ctrlColor(selectedDevice.controller)}18`,color:ctrlColor(selectedDevice.controller),border:`1px solid ${ctrlColor(selectedDevice.controller)}30`}}>{selectedDevice.controller}</span>
                <a href={`https://github.com/smartHomeHub/SmartIR/blob/master/codes/climate/${selectedDevice.code}.json`} target="_blank" style={{fontSize:10,color:G.muted,textDecoration:"none",border:`1px solid ${G.border}`,borderRadius:4,padding:"5px 10px"}}>↗ GitHub</a>
                {fetchStatus==="done" && convStatus!=="done" && (
                  <button onClick={()=>doConvert(sourceJSON,setOutput,setConvStatus,setConvError)} style={{padding:"7px 18px",background:G.accent,color:"#000",border:"none",borderRadius:4,cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:"bold",letterSpacing:"0.1em",boxShadow:`0 0 18px ${G.accentDim}`}}>
                    ⟶ CONVERT TO {controller}
                  </button>
                )}
                {convStatus==="done" && (<>
                  <button onClick={()=>{setOutput("");setConvStatus("idle");}} style={{padding:"6px 12px",background:"transparent",color:G.muted,border:`1px solid ${G.border}`,borderRadius:4,cursor:"pointer",fontFamily:"inherit",fontSize:10}}>↺</button>
                  <button onClick={()=>navigator.clipboard.writeText(output)} style={{padding:"6px 12px",background:"transparent",color:G.accent,border:`1px solid ${G.accent}`,borderRadius:4,cursor:"pointer",fontFamily:"inherit",fontSize:10,letterSpacing:"0.06em"}}>⎘ Copy</button>
                  <button onClick={()=>handleDownload(output,selectedDevice.code)} style={{padding:"6px 14px",background:G.accent,color:"#000",border:"none",borderRadius:4,cursor:"pointer",fontFamily:"inherit",fontSize:10,fontWeight:"bold",letterSpacing:"0.08em"}}>↓ Download</button>
                </>)}
              </div>

              {/* Source + Output panels */}
              <div style={{flex:1,display:"grid",gridTemplateColumns:convStatus==="done"?"1fr 1fr":"1fr",overflow:"hidden",minHeight:0}}>
                {/* Source */}
                <div style={{display:"flex",flexDirection:"column",borderRight:convStatus==="done"?`1px solid ${G.border}`:"none",overflow:"hidden"}}>
                  <div style={{padding:"6px 14px",fontSize:9,color:G.muted,letterSpacing:"0.1em",borderBottom:`1px solid ${G.border}`,background:G.surface,display:"flex",justifyContent:"space-between",flexShrink:0}}>
                    <span>SOURCE · {selectedDevice.code}.json</span>
                    {fetchStatus==="loading" && <span style={{color:G.accent,display:"flex",alignItems:"center",gap:4}}><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span>fetching…</span>}
                    {fetchStatus==="done" && <span style={{color:"#2a5a3a"}}>✓ {(sourceJSON.length/1024).toFixed(1)} KB</span>}
                    {fetchStatus.startsWith("error:") && <span style={{color:"#ff6060"}}>✗ failed</span>}
                  </div>
                  <div style={{flex:1,...scrollArea,padding:12}}>
                    {fetchStatus==="loading" && (
                      <div style={{color:G.accent,fontSize:11,display:"flex",gap:8,alignItems:"center"}}>
                        <span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span>
                        Fetching {selectedDevice.code}.json from GitHub…
                      </div>
                    )}
                    {fetchStatus.startsWith("error:") && (
                      <div style={{fontSize:10,color:"#ff6060",lineHeight:1.7}}>
                        <div style={{marginBottom:8}}>✗ {fetchStatus.slice(6)}</div>
                        <div style={{color:G.muted}}>Try opening directly:</div>
                        <a href={`${RAW_BASE}${selectedDevice.code}.json`} target="_blank" style={{color:G.accent,wordBreak:"break-all"}}>{RAW_BASE}{selectedDevice.code}.json</a>
                      </div>
                    )}
                    {fetchStatus==="done" && (
                      <pre style={{margin:0,fontSize:9,color:"#4a6a55",lineHeight:1.5,whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{sourceJSON}</pre>
                    )}
                  </div>
                </div>

                {/* Output */}
                {convStatus!=="idle" && (
                  <div style={{display:"flex",flexDirection:"column",overflow:"hidden"}}>
                    <div style={{padding:"6px 14px",fontSize:9,color:G.accent,letterSpacing:"0.1em",borderBottom:`1px solid ${G.border}`,background:G.surface,display:"flex",justifyContent:"space-between",flexShrink:0}}>
                      <span>OUTPUT · {controller} · {selectedDevice.code}_mqtt.json</span>
                      {convStatus==="done" && <span style={{color:G.accent}}>✓ converted</span>}
                    </div>
                    <div style={{flex:1,...scrollArea,padding:12}}>
                      {convStatus==="converting" && <div style={{color:G.accent,fontSize:11,display:"flex",gap:8,alignItems:"center"}}><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span>Converting…</div>}
                      {convStatus==="error" && <div style={{color:"#ff6060",fontSize:10}}>✗ {convError}</div>}
                      {convStatus==="done" && <pre style={{margin:0,fontSize:9,color:"#4aaa65",lineHeight:1.5,whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{output}</pre>}
                    </div>
                  </div>
                )}
              </div>
            </>)}
          </div>
        </>)}

        {/* ══ MANUAL TAB ══ */}
        {tab==="manual" && (
          <div style={{flex:1,display:"flex",flexDirection:"column",padding:18,gap:14,overflow:"hidden",minHeight:0}}>
            <div style={{display:"flex",gap:14,flex:1,overflow:"hidden",minHeight:0}}>
              {/* Input */}
              <div style={{flex:1,display:"flex",flexDirection:"column",gap:7,minWidth:0}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:9,color:G.muted,letterSpacing:"0.1em"}}>INPUT · BROADLINK JSON</span>
                  <div style={{display:"flex",gap:5}}>
                    <input ref={fileRef} type="file" accept=".json" onChange={e=>{const f=e.target.files[0];if(!f)return;setManualFilename(f.name);const r=new FileReader();r.onload=ev=>setManualInput(ev.target.result);r.readAsText(f);}} style={{display:"none"}}/>
                    <button onClick={()=>fileRef.current.click()} style={{padding:"4px 9px",background:"transparent",color:G.muted,border:`1px solid ${G.border}`,borderRadius:3,cursor:"pointer",fontFamily:"inherit",fontSize:9}}>↑ Upload</button>
                    <button onClick={()=>{setManualInput("");setManualFilename("");setManualOutput("");setManualConvStatus("idle");}} style={{padding:"4px 9px",background:"transparent",color:G.muted,border:`1px solid ${G.border}`,borderRadius:3,cursor:"pointer",fontFamily:"inherit",fontSize:9}}>✕</button>
                  </div>
                </div>
                {manualFilename && <div style={{fontSize:9,color:G.accent}}>📄 {manualFilename}</div>}
                <textarea value={manualInput} onChange={e=>setManualInput(e.target.value)}
                  placeholder={'{\n  "supportedController": "Broadlink",\n  "commands": { ... }\n}'}
                  style={{flex:1,background:G.surface,border:`1px solid ${G.border}`,borderRadius:6,color:"#4a6a55",fontFamily:"inherit",fontSize:9,padding:12,resize:"none",outline:"none",lineHeight:1.5,minHeight:0}}/>
              </div>
              {/* Output */}
              <div style={{flex:1,display:"flex",flexDirection:"column",gap:7,minWidth:0}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:9,color:G.accent,letterSpacing:"0.1em"}}>OUTPUT · {controller} RAW JSON</span>
                  {manualOutput && (
                    <div style={{display:"flex",gap:5}}>
                      <button onClick={()=>navigator.clipboard.writeText(manualOutput)} style={{padding:"4px 9px",background:"transparent",color:G.accent,border:`1px solid ${G.accent}`,borderRadius:3,cursor:"pointer",fontFamily:"inherit",fontSize:9}}>⎘ Copy</button>
                      <button onClick={()=>handleDownload(manualOutput,manualFilename.replace(".json","")||"converted")} style={{padding:"4px 9px",background:G.accent,color:"#000",border:"none",borderRadius:3,cursor:"pointer",fontFamily:"inherit",fontSize:9,fontWeight:"bold"}}>↓ Download</button>
                    </div>
                  )}
                </div>
                <div style={{flex:1,background:G.surface,border:`1px solid ${manualOutput?G.accent:G.border}`,borderRadius:6,...scrollArea,padding:12,position:"relative",minHeight:0}}>
                  {!manualOutput && manualConvStatus==="idle" && <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:6,color:G.dim,fontSize:10}}><span style={{fontSize:20}}>⟳</span>Output here</div>}
                  {manualConvStatus==="converting" && <div style={{color:G.accent,fontSize:10,display:"flex",gap:8,alignItems:"center"}}><span style={{animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</span>Converting…</div>}
                  {manualConvStatus==="error" && <div style={{color:"#ff6060",fontSize:10}}>✗ {manualConvError}</div>}
                  {manualOutput && <pre style={{margin:0,fontSize:9,color:"#4aaa65",lineHeight:1.5,whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{manualOutput}</pre>}
                </div>
              </div>
            </div>
            <div style={{display:"flex",justifyContent:"center",flexShrink:0}}>
              <button onClick={()=>doConvert(manualInput,setManualOutput,setManualConvStatus,setManualConvError)}
                disabled={!manualInput.trim()||manualConvStatus==="converting"}
                style={{padding:"11px 36px",background:manualInput.trim()?G.accent:"transparent",color:manualInput.trim()?"#000":G.muted,border:`1px solid ${manualInput.trim()?G.accent:G.border}`,borderRadius:5,cursor:manualInput.trim()?"pointer":"default",fontFamily:"inherit",fontSize:11,fontWeight:"bold",letterSpacing:"0.12em",boxShadow:manualInput.trim()?`0 0 22px ${G.accentDim}`:"none",transition:"all 0.2s"}}>
                ⟶  CONVERT TO {controller}
              </button>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:${G.bg}}
        ::-webkit-scrollbar-thumb{background:${G.border};border-radius:3px}
        input::placeholder{color:${G.muted}}
        textarea::placeholder{color:${G.dim};font-size:10px}
        textarea:focus,input:focus{border-color:${G.accent}!important}
      `}</style>
    </div>
  );
}
