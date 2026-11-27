// 包装页只调用查看器能力，模型与查看器文件保持原样。版本与 car3d.py 同步。
const WRAPPER_VERSION = 33;
const q = new URLSearchParams(window.viewerParams||location.search);
const year = q.get("year");
let homeView = q.has('home');
let appearanceView = q.has('appearance');
const shared = q.has('shared');
let desiredSurface = 'home', configuredSurface, surfaceFrame = 0;
const appViewer = q.has('app');
if(appViewer)document.documentElement.classList.add('app-viewer');
const cfg = {
  carType:q.get("car")||"C10", year:year ? (/^\d{4}$/.test(year) ? Number(year) : year) : undefined,
  carTypeCode:q.get("trim")||"", colorCode:Number(q.get("color")||0),
  rudder:0, offset:Number(q.get("offset")||.37), radius:Number(q.get("radius")||15),
  seat:Number(q.get("seat")||5), roofColorCode:Number(q.get("roof")||0),
  sdkVersion:q.get("sdk")||"3.15.1", licenseNumber:"", theme:q.get("theme")||"default",
};
if(q.has("alias")) cfg.alias=q.get("alias");
const c01Compat = cfg.carType === 'C01' && q.get('c01Compat') === '1';
let quality = 'high', hostVisible=true, moving=false, testedRenderer=null, softwareRenderer=false;
let ratioViewer=null, desiredRatio=1;
function canDraw(){return hostVisible&&!document.hidden&&innerWidth>0&&innerHeight>0}
function rendererUsesSoftware(renderer){
  if(testedRenderer!==renderer){
    testedRenderer=renderer;
    try{
      const gl=renderer.getContext(), debug=gl.getExtension('WEBGL_debug_renderer_info');
      softwareRenderer=/swiftshader|llvmpipe|lavapipe|software raster|microsoft basic render/i.test(debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER));
    }catch{softwareRenderer=false}
  }
  return softwareRenderer;
}
function applyQuality() {
  const v=window.viewer,renderer=v?.renderer;
  if (!renderer || typeof renderer.setPixelRatio !== 'function') return false;
  if(!appViewer){
    renderer.setPixelRatio(quality==='power'?1:Math.min(2,devicePixelRatio||1));
    return redraw();
  }
  const software=rendererUsesSoftware(renderer),idleCap=quality==='power'?1:software?1.25:2;
  desiredRatio=Math.min(devicePixelRatio||1,idleCap,moving?(software ? 0.75 : 1.25):Infinity);
  if(v.getTargetPixelRatio&&v.viewportSetter?.setViewport){
    if(ratioViewer!==v){
      ratioViewer=v;
      const getTarget=v.getTargetPixelRatio.bind(v);
      v.getTargetPixelRatio=()=>Math.min(desiredRatio,getTarget());
    }
    if(canDraw()&&renderer.getPixelRatio()!==v.getTargetPixelRatio())v.viewportSetter.setViewport();
  }else if(canDraw()&&renderer.getPixelRatio()!==desiredRatio)renderer.setPixelRatio(desiredRatio);
  return true;
}
let radius=cfg.radius, offset=cfg.offset, drop=Number(q.get("drop")||0);
let background=q.get("bg")||"day", paint="", pose={}, full=false, first=false, released=false;
const bootColors={day:"#f3f6fb",night:"#0e1114",studio:"#e9edf2",dusk:"#e5c8bd",aurora:"#142b35",blueprint:"#15324c"};
let nightFloor=bootColors.night;
document.documentElement.style.setProperty("--boot-bg",bootColors[background]||bootColors.day);
document.documentElement.style.colorScheme=["night","aurora","blueprint"].includes(background)?"dark":"light";
let viewApplied=false, skyCache=null, poseCar=null, appliedPose={}, revealing=false;
const started=performance.now();
const parentOrigin=window.viewerParentOrigin||location.origin;
const post=m=>{if(parent!==window)parent.postMessage(m,parentOrigin)};
post({t:'viewer-boot'});
window.addEventListener('webglcontextcreationerror', () => post({t:'runtime-error', kind:'webgl-create'}), true);
window.addEventListener('webglcontextlost', () => post({t:'runtime-error', kind:'webgl-lost'}), true);
function reportRuntimeError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  post({t:'runtime-error', kind: /CarModelModules is not defined|Can't find variable: CarModelModules/i.test(message || '') ? 'missing-modules' : 'script'});
}
window.addEventListener('error', event => reportRuntimeError(event.error || event.message));
window.addEventListener('unhandledrejection', event => reportRuntimeError(event.reason));
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
function sceneOf(){
  let s=window.viewer?.scene||window.viewer?.viewer?.scene;
  if(!s){s=window.car;while(s&&!s.isScene)s=s.parent}
  return s;
}
function skyNode(){
  if(skyCache?.parent)return skyCache;
  sceneOf()?.traverse(o=>{if(o.material?.uniforms?.nightTexture)skyCache=o});
  return skyCache;
}
function redraw(){
  const v=window.viewer, s=sceneOf();
  if(!v?.renderer||!v.camera||!s||(appViewer&&released&&!canDraw()))return false;
  v.renderer.render(s,v.camera);return true;
}
function guardRenderer(){
  const renderer=window.viewer?.renderer;
  if(!appViewer||!renderer||renderer.__leapVisibilityGuard)return;
  renderer.__leapVisibilityGuard=true;
  const render=renderer.render;
  renderer.render=function(...args){
    if(!released||canDraw())return render.apply(this,args);
  };
}
// setRadius 会 reset 相机方向；只在整车定景时用，后续尺寸变化保留用户旋转角度。
function applyView(reset=false){
  const v=window.viewer, c=v?.controls;
  if(!v||!c)return false;
  if(c.target0){
    if(c.__leapBaseY===undefined)c.__leapBaseY=c.target0.y;
    const y=c.__leapBaseY+drop/100*.335*radius;
    c.target0.y=y;if(!reset&&c.target)c.target.y=y;
  }
  if(reset||!viewApplied)v.setRadius(radius);
  else if(c.setRadiusImmediately)c.setRadiusImmediately(radius);
  else v.setRadius(radius);
  v.setOffsetVertical?.(offset*100);commitCamera(c);viewApplied=true;redraw();return true;
}
const images=new Map(), originals=new WeakMap();
function panorama(name,floor){
  const key=name==="night" ? name+floor : name;
  if(images.has(key))return images.get(key);
  const c=document.createElement("canvas");c.width=1024;c.height=512;
  const x=c.getContext("2d"), g=x.createLinearGradient(0,0,0,512);
  const palettes={studio:["#e7ebf2","#f7f8fa","#bfc9d8"],night:["#08111f",floor,floor],dusk:["#333b68","#efb49f","#b89a8e"],
    aurora:["#091b32","#237e86","#122e49"],blueprint:["#071831","#174066","#0c284a"]};
  const p=palettes[name]||palettes.studio;
  g.addColorStop(0,p[0]);g.addColorStop(.55,p[1]);g.addColorStop(1,p[2]);
  x.fillStyle=g;x.fillRect(0,0,1024,512);
  if(name==="night"){
    let state=42;
    const random=()=>((state=Math.imul(state,1664525)+1013904223>>>0)/4294967296);
    for(let i=0;i<340;i++){
      const px=random()*1024,py=random()*236,alpha=(1-py/245)*(.25+random()*.7);
      x.fillStyle=`rgba(219,235,255,${alpha})`;
      x.fillRect(px,py,1+random(),1+random());
    }
    c.dataset.source="procedural-night";
  }
  if(name==="aurora"){
    const a=x.createLinearGradient(0,0,1024,240);a.addColorStop(0,"#46dca000");a.addColorStop(.4,"#58e2b155");a.addColorStop(.7,"#8b70dd44");a.addColorStop(1,"#46dca000");
    x.fillStyle=a;x.beginPath();x.moveTo(0,95);x.bezierCurveTo(300,0,600,300,1024,45);x.lineTo(1024,160);x.bezierCurveTo(600,390,300,90,0,210);x.fill();
  }
  if(name==="blueprint"){
    x.strokeStyle="#8bc8ed25";x.lineWidth=1;
    for(let i=0;i<1024;i+=32){x.beginPath();x.moveTo(i,0);x.lineTo(i,512);x.stroke()}
    for(let j=0;j<512;j+=32){x.beginPath();x.moveTo(0,j);x.lineTo(1024,j);x.stroke()}
  }
  images.set(key,c);return c;
}
function swap(tex,img){
  if(!tex||!img||tex.image===img)return;
  if(!originals.has(tex))originals.set(tex,tex.image);
  tex.dispose();tex.image=img;tex.needsUpdate=true;
}
async function setBackground(name){
  const node=skyNode();if(!node)return false;
  node.visible=true;
  if(window.viewer?.frameState?.bg2D)window.viewer.frameState.bg2D.visible=false;
  const u=node.material.uniforms;
  const image=name==="day"?null:panorama(name,nightFloor);
  if(background!==name)return false;
  for(const key of ["dayTexture","nightTexture"]){
    const tex=u[key]?.value;
    if(image)swap(tex,image);else if(tex&&originals.has(tex))swap(tex,originals.get(tex));
  }
  const night=["night","aurora","blueprint"].includes(name)?1:0,m=node.material;
  m.setDayOrNightImmediately?.(night);if(u.dayOrNight)u.dayOrNight.value=night;
  m.d2n=night;m.d2nAnim=false;m.d2nPoc=1;
  if(u.colorStrength)u.colorStrength.value=night && name!=="night" ? .92 : 1;
  if(window.viewer?.frameState)window.viewer.frameState.updateEnvironment=true;
  redraw();return true;
}
const originalPaint=new WeakMap();
function setPaint(hex){
  if(hex!==""&&!/^#[0-9a-f]{6}$/i.test(hex))return false;
  // 加载期间仅保留最后一次选择，避免把低模或预览色当作原车漆快照。
  if(!full)return false;
  const u=window.car?.carPaint_CarPaintMaterial?.uniforms;
  if(!u?.color?.value?.set||!u?.blendColor?.value?.set)return false;
  if(!originalPaint.has(u)){
    if(!u.color.value.clone||!u.blendColor.value.clone)return false;
    originalPaint.set(u,{color:u.color.value.clone(),blendColor:u.blendColor.value.clone()});
  }
  if(hex===""){
    const original=originalPaint.get(u);
    u.color.value.copy(original.color);u.blendColor.value.copy(original.blendColor);redraw();return true;
  }
  const n=parseInt(hex.slice(1),16),r=(n>>16&255)/255,g=(n>>8&255)/255,b=(n&255)/255;
  u.color?.value?.set(r,g,b,1);u.blendColor?.value?.set(r*.45,g*.45,b*.45,1);redraw();return true;
}
// 只改车漆着色器，不修改共享模型文件或玻璃、饰条材质。
const wrapSides=["left","right","top","front","rear"];
let wrapSerial = 0, wrapConfig = null, wrapTexture = null, wrapApplying = 0;
const wrapAtlasRects = new Map(), wrapImages = new Map(), atlasLayers = new Map();
const wrapMaterials=new Set();let wrapBounds=null,wrapCar=null;
function carBounds(){
  const car=window.car;if(wrapCar===car&&wrapBounds)return wrapBounds;let bounds=null;
  car?.updateMatrixWorld?.(true);
  car?.traverse?.(node=>{
    const materials=Array.isArray(node.material)?node.material:[node.material];
    if(!node.geometry||!materials.some(m=>m?.uniforms?.blendColor&&m?.fragmentShader?.includes('fresnelCol')))return;
    if(!node.geometry.boundingBox)node.geometry.computeBoundingBox?.();const box=node.geometry.boundingBox?.clone();if(!box)return;
    box.applyMatrix4(node.matrixWorld);if(bounds)bounds.union(box);else bounds=box;
  });wrapCar=car;wrapBounds=bounds;return bounds;
}
function wheelPoints(){
  const car=window.car;return ['LF','RF','LR','RR'].map(key=>{const node=car?.['wheel'+key+'2']||car?.['wheel'+key]||car?.getObjectByName?.('Wheel_'+key+'_Main');return node?.getWorldPosition?.(node.position.clone())||null});
}
function wrapFrame(side,box){
  const points=wheelPoints(),up=box.min.clone().set(0,1,0);
  if(!points[0]||!points[1]||!points[2])return null;
  const front=points[0].clone().sub(points[2]).normalize(),left=points[0].clone().sub(points[1]).normalize();
  return side==='top'?{u:left.clone().negate(),v:front,n:up}:side==='front'?{u:left.clone(),v:up,n:front}:side==='rear'?{u:left.clone().negate(),v:up,n:front.clone().negate()}:side==='right'?{u:front.clone().negate(),v:up,n:left.clone().negate()}:{u:front,v:up,n:left};
}
function wrapUniforms(side){return `haWrap${side[0].toUpperCase()+side.slice(1)}`}
// 全景天幕与风挡可能共享材质，每次绘制时按玻璃网格选择是否显示车衣。
const roofGlassMaterials=new Map();
function restoreRoofGlass(){
  for(const [material,{vertex,fragment,before}] of roofGlassMaterials){
    material.vertexShader=vertex;material.fragmentShader=fragment;material.onBeforeRender=before;
    for(const key of Object.keys(material.uniforms))if(key==='haWrapTexture'||key.startsWith('haWrapTop'))delete material.uniforms[key];
    material.needsUpdate=true;
  }
  roofGlassMaterials.clear();
}
function roofGlassLayer(node,box){
  const original=node.material,geometry=node.geometry;
  const installed=roofGlassMaterials.get(original);
  if(installed?.nodes.has(node))return original;
  if(!geometry||!original?.transparent||!original.vertexShader||!original.fragmentShader?.includes('gl_FragColor')||
      !/glass|panoram|sunroof|skylight|天窗/i.test(node.name+' '+original.name))return;
  if(!geometry.boundingBox)geometry.computeBoundingBox();
  const pane=geometry.boundingBox.clone().applyMatrix4(node.matrixWorld);
  const body=box.getSize(box.min.clone()),size=pane.getSize(box.min.clone());
  if(pane.min.y<box.max.y-.19*body.y||size.y>.19*body.y||size.x<body.x*.18||size.z<body.z*.18)return;
  if(installed){installed.nodes.add(node);return original;}
  const main=/void\s+main\s*\(\s*(?:void\s*)?\)\s*\{/;
  const end=original.fragmentShader.lastIndexOf('}');
  if(!main.test(original.vertexShader)||end<0)return;
  const nodes=new Set([node]),before=original.onBeforeRender;
  roofGlassMaterials.set(original,{nodes,before,vertex:original.vertexShader,fragment:original.fragmentShader});
  original.uniforms.haWrapTopEnabled={value:0};
  original.onBeforeRender=function(renderer,scene,camera,geometry,object,group){
    before?.call(this,renderer,scene,camera,geometry,object,group);
    this.uniforms.haWrapTopEnabled.value=nodes.has(object)?1:0;
    this.uniformsNeedUpdate=true;
  };
  original.vertexShader='varying highp vec3 wrapRoofPosition;\n'+original.vertexShader.replace(main,match=>match+'\nwrapRoofPosition=(modelMatrix*vec4(position,1.0)).xyz;');
  original.fragmentShader=`varying highp vec3 wrapRoofPosition;
uniform highp sampler2D haWrapTexture;
uniform highp vec3 haWrapTopCenter,haWrapTopU,haWrapTopV;
uniform highp vec2 haWrapTopSize,haWrapTopRotation;
uniform highp vec4 haWrapTopRect;
uniform highp float haWrapTopOpacity,haWrapTopEnabled;
`+original.fragmentShader.slice(0,end)+`
vec3 wrapDelta=wrapRoofPosition-haWrapTopCenter;
vec2 wrapUV=vec2(dot(wrapDelta,haWrapTopU),dot(wrapDelta,haWrapTopV));
wrapUV=mat2(haWrapTopRotation.x,-haWrapTopRotation.y,haWrapTopRotation.y,haWrapTopRotation.x)*wrapUV/haWrapTopSize+0.5;
if(haWrapTopEnabled>0.5&&all(greaterThanEqual(wrapUV,vec2(0.0)))&&all(lessThanEqual(wrapUV,vec2(1.0)))){
  vec4 decal=texture2D(haWrapTexture,haWrapTopRect.xy+wrapUV*haWrapTopRect.zw);
  gl_FragColor=mix(gl_FragColor,vec4(decal.rgb,1.0),decal.a*haWrapTopOpacity);
}
`+original.fragmentShader.slice(end);
  original.needsUpdate=true;
  return original;
}
function updateWrap(values, centerBase, box){
  if(!values.top)restoreRoofGlass();
  window.car.traverse(node=>{
    const top=values.top,glass=top&&roofGlassLayer(node,box);
    if(glass){
      const uniforms=glass.uniforms;
      uniforms.haWrapTexture={value:wrapTexture};
      for(const [key,value] of Object.entries({Center:top.center,U:top.frame.u,V:top.frame.v,Size:top.size,Rotation:top.rotation,Rect:wrapAtlasRects.get('top'),Opacity:top.opacity}))uniforms['haWrapTop'+key]={value};
      return;
    }
    for(const m of Array.isArray(node.material)?node.material:[node.material]){
    if(!m?.uniforms?.blendColor||!m.fragmentShader?.includes('fresnelCol'))continue;
    if(!m.uniforms.haWrapLeftOpacity){const needle='vec3 diffuse = fresnelCol * NdotL;';if(!m.fragmentShader.includes(needle))continue;
      const declarations=`uniform highp sampler2D haWrapTexture;`+wrapSides.map(side=>{const p=wrapUniforms(side);return `uniform highp vec3 ${p}Center;uniform highp vec3 ${p}U;uniform highp vec3 ${p}V;uniform highp vec3 ${p}N;uniform highp vec2 ${p}Size;uniform highp vec2 ${p}Rotation;uniform highp vec4 ${p}Rect;uniform highp float ${p}Opacity;`}).join('');
      const projections=wrapSides.map(side=>{const p=wrapUniforms(side);return `if(${p}Opacity>0.0){vec3 ${p}wp=posWS.xyz-${p}Center;vec2 ${p}uv=vec2(dot(${p}wp,${p}U),dot(${p}wp,${p}V));${p}uv=mat2(${p}Rotation.x,-${p}Rotation.y,${p}Rotation.y,${p}Rotation.x)*${p}uv/${p}Size+0.5;float ${p}mask=step(0.0,${p}uv.x)*step(${p}uv.x,1.0)*step(0.0,${p}uv.y)*step(${p}uv.y,1.0)*smoothstep(0.15,0.55,dot(normalize(nDirWS),${p}N));vec4 ${p}decal=texture2D(haWrapTexture,clamp(${p}Rect.xy+${p}uv*${p}Rect.zw,0.0,1.0));fresnelCol=mix(fresnelCol,${p}decal.rgb,${p}mask*${p}decal.a*${p}Opacity);}`}).join('');
      m.fragmentShader=`${declarations}\n`+m.fragmentShader.replace(needle,`${projections}\n${needle}`);m.needsUpdate=true;wrapMaterials.add(m);
    }
    for(const side of wrapSides){const p=wrapUniforms(side),v=values[side];Object.assign(m.uniforms,{haWrapTexture:{value:wrapTexture},[p+'Center']:{value:v?.center||centerBase},[p+'U']:{value:v?.frame.u||centerBase},[p+'V']:{value:v?.frame.v||centerBase},[p+'N']:{value:v?.frame.n||centerBase},[p+'Size']:{value:v?.size||[1,1]},[p+'Rotation']:{value:v?.rotation||[1,0]},[p+'Rect']:{value:wrapAtlasRects.get(side)||[0,0,0,0]},[p+'Opacity']:{value:v?.opacity||0}});}
  }});redraw();return wrapMaterials.size>0;
}
function clearWrap() {
  ++wrapSerial;
  wrapConfig = null;
  restoreRoofGlass();
  for (const material of wrapMaterials) {
    material.uniforms.haWrapTexture.value = null;
    for (const side of wrapSides) material.uniforms[wrapUniforms(side) + 'Opacity'].value = 0;
  }
  wrapTexture?.dispose();
  wrapTexture = null;
  wrapAtlasRects.clear();
  wrapImages.clear();
  atlasLayers.clear();
  redraw();
  return true;
}

function normalizeWrap(value) {
  const faces = value.version === 3 || value.version === 2 ? value.faces
    : value.image ? { [wrapSides.includes(value.side) ? value.side : 'left']: value } : null;
  if (!faces || typeof faces !== 'object') return null;
  const result = {};
  for (const side of wrapSides) {
    if (!faces[side]) continue;
    const layers = Array.isArray(faces[side]) ? faces[side] : [faces[side]];
    if (layers.length > 4) return null;
    result[side] = [];
    for (const layer of layers) {
      if (!layer || (layer.side && layer.side !== side)) return null;
      for (const [key,min,max] of [['x',-100,200],['y',-100,200],['scale',5,200],['rotation',-180,180],['opacity',0,100]]) {
        if (!Number.isFinite(layer[key]) || layer[key] < min || layer[key] > max) return null;
      }
      const image = layer.image ?? wrapConfig?.faces[side]?.[result[side].length]?.image;
      if (typeof image !== 'string' || image.length > 1400000 || !/^data:image\/(png|jpeg|webp);base64,/.test(image)) return null;
      result[side].push({ image, kind: layer.kind, x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation, opacity: layer.opacity });
    }
  }
  return { version: 3, faces: result };
}

function decodeWrapImage(source) {
  if (!wrapImages.has(source)) {
    wrapImages.set(source, new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image.width <= 1024 && image.height <= 1024 ? image : null);
      image.onerror = () => resolve(null);
      image.src = source;
    }));
  }
  return wrapImages.get(source);
}

function layerGeometry(side, layer, image, span, height) {
  const angle = layer.rotation * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  let width = span * layer.scale / 100;
  if (side === 'top' && layer.kind !== 'image' && layer.kind && layer.scale > 100) {
    const across = span * Math.abs(cos) + height * Math.abs(sin);
    const along = span * Math.abs(sin) + height * Math.abs(cos);
    const cover = Math.max(across, along * image.width / image.height);
    width += Math.max(0, cover * 1.01 - span * 1.8) * (layer.scale - 100) / 80;
  }
  return { angle, width, height: width * image.height / image.width };
}

function sameTile(previous, layers) {
  if (!previous || layers.length !== previous.length) return false;
  return layers.every((layer, index) => {
    const before = previous[index];
    return layer.image === before.image && (layers.length === 1 ||
      ['x','y','scale','rotation','opacity','kind'].every(key => layer[key] === before[key]));
  });
}

// Each face uses one atlas tile. Composite additional slots in vehicle coordinates so the
// physical scale, rotation and image aspect ratio match the single-slot shader.
function drawWrapTile(canvas, side, layers, images, span, height) {
  const index = wrapSides.indexOf(side);
  const cellWidth = 1024, cellHeight = 682;
  const left = (index % 2) * cellWidth, top = Math.floor(index / 2) * cellHeight;
  const first = images.get(layers[0].image);
  const iw = layers.length === 1 ? first.width : span, ih = layers.length === 1 ? first.height : height;
  const zoom = Math.min((cellWidth - 4) / iw, (cellHeight - 4) / ih);
  const w = iw * zoom, h = ih * zoom, x = left + (cellWidth - w) / 2, y = top + (cellHeight - h) / 2;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(left, top, cellWidth, cellHeight);
  ctx.imageSmoothingQuality = 'high';
  if (layers.length === 1) {
    ctx.drawImage(first, x, y, w, h);
  } else {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.translate(x, y);
    ctx.scale(w / span, h / height);
    for (const layer of layers) {
      const image = images.get(layer.image);
      const size = layerGeometry(side, layer, image, span, height);
      ctx.save();
      ctx.translate(layer.x * span / 100, (1 - layer.y / 100) * height);
      ctx.rotate(-size.angle);
      ctx.globalAlpha = layer.opacity / 100;
      ctx.drawImage(image, -size.width / 2, -size.height / 2, size.width, size.height);
      ctx.restore();
    }
    ctx.restore();
  }
  return [(x + .5) / canvas.width, (canvas.height - y - h + .5) / canvas.height,
    (w - 1) / canvas.width, (h - 1) / canvas.height];
}

async function setWrap(value) {
  if (!value) return clearWrap();
  const config = normalizeWrap(value);
  if (!config) return false;
  const sources = new Set(Object.values(config.faces).flat().map(layer => layer.image));
  if (!sources.size) return clearWrap();
  wrapConfig = config;
  const serial = ++wrapSerial;
  if (!full) return true;
  const box = carBounds();
  const original = window.car?.carPaint_CarPaintMaterial?.uniforms?.mainTexture?.value;
  if (!box || !original?.clone) return false;
  const gl = window.viewer?.renderer?.getContext?.();
  if (gl && (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) < 8 || gl.getParameter(gl.MAX_TEXTURE_SIZE) < 2048)) return false;
  const paint = window.car.carPaint_CarPaintMaterial;
  const samplers = paint.fragmentShader?.match(/uniform\s+(?:lowp|mediump|highp)?\s*sampler\w*\s+(\w+)/g) || [];
  if (gl && samplers.filter(decl => !/\bhaWrapTexture\b/.test(decl)).length + 1 > gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)) return false;
  for (const source of wrapImages.keys()) if (!sources.has(source)) wrapImages.delete(source);
  const images = new Map(await Promise.all([...sources].map(async source => [source, await decodeWrapImage(source)])));
  if (serial !== wrapSerial) return true;
  for (const [source, image] of images) if (!image) { wrapImages.delete(source); return false; }

  const centerBase = box.min.clone().add(box.max).multiplyScalar(.5);
  const bounds = box.getSize(box.min.clone());
  const extent = axis => Math.abs(axis.x) * bounds.x + Math.abs(axis.y) * bounds.y + Math.abs(axis.z) * bounds.z;
  if (!wrapTexture) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2048;
    wrapTexture = original.clone();
    if (original.source?.constructor) wrapTexture.source = new original.source.constructor(canvas);
    else wrapTexture.image = canvas;
    wrapTexture.flipY = true;
    wrapTexture.generateMipmaps = false;
    wrapTexture.minFilter = original.magFilter ?? original.minFilter;
  }
  const values = {};
  for (const side of wrapSides) {
    const layers = config.faces[side];
    if (!layers?.length) { atlasLayers.delete(side); wrapAtlasRects.delete(side); continue; }
    const frame = wrapFrame(side, box);
    if (!frame) continue;
    const span = extent(frame.u), height = extent(frame.v);
    if (span <= 0 || height <= 0) continue;
    if (!sameTile(atlasLayers.get(side), layers)) {
      wrapAtlasRects.set(side, drawWrapTile(wrapTexture.image, side, layers, images, span, height));
      atlasLayers.set(side, layers);
      wrapTexture.needsUpdate = true;
    }
    if (layers.length === 1) {
      const layer = layers[0], size = layerGeometry(side, layer, images.get(layer.image), span, height);
      const center = centerBase.clone().addScaledVector(frame.u, (layer.x / 100 - .5) * span).addScaledVector(frame.v, (layer.y / 100 - .5) * height);
      values[side] = { center, frame, size: [size.width, size.height], rotation: [Math.cos(size.angle), Math.sin(size.angle)], opacity: layer.opacity / 100 };
    } else {
      values[side] = { center: centerBase, frame, size: [span, height], rotation: [1, 0], opacity: 1 };
    }
  }
  return updateWrap(values, centerBase, box);
}
let tireView=false,savedView=null,motionSpeed=-1,inView=true,tireFrame=0,tireTransition=false;
let tireLayoutKey='',tireLabels=null,tireOpacity=0,tireResizeFrame=0;
const tireKeys=['tire_fl','tire_fr','tire_rl','tire_rr'];
const reduced=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):null;
// SDK 的 update 在没有角度标记时会从旧位置重算半径；锁定 controls 后也需标记才能更新。
function commitCamera(c){const theta=c.getAzimuthalAngle?.();if(Number.isFinite(theta))c.setThetaImmediately?.(theta);c.update?.();}
const bound=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const smoothStep=p=>p*p*(3-2*p);
function tireBounds(){
  const width=Number.isFinite(pose.tireWidth)?pose.tireWidth:64,height=Number.isFinite(pose.tireHeight)?pose.tireHeight:34;
  const top=bound(Number.isFinite(pose.tireTop)?pose.tireTop:120,0,innerHeight);
  const bottom=bound(Number.isFinite(pose.tireBottom)?pose.tireBottom:innerHeight-85,0,innerHeight);
  return {width,height,top,bottom,left:width/2+8,right:innerWidth-width/2-8,
    first:top+height/2,last:bottom-height/2,gap:width/2+12,
    valid:innerWidth>=width*2+24&&bottom-top>=height*2+8};
}
function projectWheels(points){
  const v=window.viewer;if(!v?.camera||points.some(p=>!p))return null;
  v.camera.updateMatrixWorld?.();
  const h=innerHeight+(v.viewportSetter?.__cur_offset__||0);
  const out=points.map(p=>{const n=p.clone().project(v.camera);return {x:(n.x+1)*innerWidth/2,y:(1-n.y)*h/2}});
  return out.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y))?out:null;
}
function fitTireCamera(points,b){
  const v=window.viewer,c=v.controls;
  // 用两根轮轴的中心求车头方向，避免单个轮位误差；世界 Y 为查看器的竖直轴。
  const front=points[0].clone().addScaledVector(points[1],1).addScaledVector(points[2],-1).addScaledVector(points[3],-1);
  if(!Number.isFinite(front.x)||!Number.isFinite(front.z)||Math.hypot(front.x,front.z)<.001)return null;
  const center=points[0].clone();center.x=center.y=center.z=0;
  points.forEach(p=>center.addScaledVector(p,.25));
  cameraAt(c,{theta:Math.atan2(-front.x,-front.z),phi:.001,radius,target:center});
  let projected=projectWheels(points);if(!projected)return null;
  const span=key=>Math.max(...projected.map(p=>p[key]))-Math.min(...projected.map(p=>p[key]));
  const distance=radius*Math.max(1,span('x')/Math.max(1,b.right-b.left-2*b.gap),span('y')/Math.max(1,b.last-b.first-8))*1.08;
  c.setRadiusImmediately?.(distance);commitCamera(c);
  projected=projectWheels(points);if(!projected)return null;
  const dx=innerWidth/2-(Math.min(...projected.map(p=>p.x))+Math.max(...projected.map(p=>p.x)))/2;
  const dy=(b.top+b.bottom-Math.min(...projected.map(p=>p.y))-Math.max(...projected.map(p=>p.y)))/2;
  const scale=2*Math.tan(v.camera.fov*Math.PI/360)*distance/(innerHeight+(v.viewportSetter?.__cur_offset__||0));
  if(!Number.isFinite(scale))return null;
  const matrix=v.camera.matrixWorld?.elements;if(!matrix||matrix.length<11)return null;
  const right=center.clone(),up=center.clone();
  [right.x,right.y,right.z]=matrix.slice(0,3);[up.x,up.y,up.z]=matrix.slice(4,7);
  c.target.addScaledVector(right,-dx*scale).addScaledVector(up,dy*scale);commitCamera(c);
  projected=projectWheels(points);if(!projected)return null;
  // 四轮身份决定左右列；不再以当前屏幕中线作 ±48px 的不连续判断。
  // 部分素材的 LF/RF 节点在世界空间镜像；仅在车头已朝上后取屏幕左右轮列。
  // 标签仍按车辆语义固定为左前/右前/左后/右后，不随起始视角重新分配。
  const left=bound(Math.min(...projected.map(p=>p.x))-b.gap,b.left,innerWidth/2-b.width/2-4);
  const rightX=bound(Math.max(...projected.map(p=>p.x))+b.gap,innerWidth/2+b.width/2+4,b.right);
  const frontY=(projected[0].y+projected[1].y)/2,rearY=(projected[2].y+projected[3].y)/2;
  const separation=bound(rearY-frontY,b.height+8,b.last-b.first);
  const middle=bound((frontY+rearY)/2,b.first+separation/2,b.last-separation/2);
  return [0,1,2,3].map(i=>({x:i%2?rightX:left,y:middle+(i<2?-1:1)*separation/2}));
}
function projectTires(){
  if(!tireView||!tireLabels||innerWidth<=0||innerHeight<=0)return;
  post({t:'tires',opacity:tireOpacity,points:JSON.stringify(tireLabels.map((p,i)=>({key:tireKeys[i],x:p.x/innerWidth*100,y:p.y/innerHeight*100})))});
}
function cameraState(c){return {theta:c.getAzimuthalAngle?.(),phi:c.getPolarAngle?.(),radius:c.getDistance?.()||window.viewer?.camera?.position?.distanceTo?.(c.target)||radius,target:c.target?.clone?.(),enabled:c.enabled};}
function cameraAt(c,s){if(Number.isFinite(s.theta))c.setThetaImmediately?.(s.theta);if(Number.isFinite(s.phi))c.setPhiImmediately?.(s.phi);c.setRadiusImmediately?.(s.radius);if(s.target)c.target?.copy?.(s.target);c.update?.();}
function projectedCarScale(camera,xLimit,yLimit){
  const box=carBounds();if(!box)return 1;
  camera.updateMatrixWorld();
  let scale=0;
  for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
    const point=box.min.clone().set(x,y,z).project(camera);
    scale=Math.max(scale,Math.abs(point.x)/xLimit,Math.abs(point.y)/yLimit);
  }
  return Number.isFinite(scale)&&scale>0?scale:1;
}
function fitPreviewCamera(){
  const v=window.viewer,c=v?.controls;
  if(!c?.setRadiusImmediately)return;
  const editing=configuredSurface==='wrap';
  if(editing){
    const box=carBounds();
    if(box&&c.target){box.getCenter(c.target);commitCamera(c);}
  }
  // 车身边缘随车型和取景宽高比变化，两次投影为左右与顶部留出余量。
  for(let i=0;i<2;i++){
    const scale=projectedCarScale(v.camera,editing ? .94 : homeView ? .70 : .78,editing ? .79 : homeView ? .65 : .63);
    if(Math.abs(scale-1)<.04)break;
    radius=bound(radius*scale,editing ? (c.minDistance??7) : 9.75,homeView?22:28);
    c.setRadiusImmediately(radius);commitCamera(c);
  }
}
let defaultOrbit=null, orbitZoom=1, orbitFrame=0, motionIdle=0;
const surfaceOrbits=new Map();
function configureCamera(){
  const controls=window.viewer?.controls;
  if(!controls)return;
  if(shared){
    if(configuredSurface&&configuredSurface!=='wrap'&&defaultOrbit)surfaceOrbits.set(configuredSurface,{view:cameraState(controls),zoom:orbitZoom});
    configuredSurface=desiredSurface;
    homeView=configuredSurface==='home';appearanceView=!homeView;
    radius=homeView ? 11.5 : cfg.radius;offset=homeView ? .04 : 0;drop=homeView ? 18 : 0;
  }
  controls.minPolarAngle=.001;
  controls.maxPolarAngle=appearanceView?5*Math.PI/12:Math.PI/2;
  applyView(true);
  const view=cameraState(controls);
  if(view.phi>controls.maxPolarAngle)cameraAt(controls,{...view,phi:controls.maxPolarAngle});
  if(homeView||appearanceView)fitPreviewCamera();
  defaultOrbit=cameraState(controls);orbitZoom=1;
  const memory=surfaceOrbits.get(configuredSurface);
  if(memory){
    orbitZoom=memory.zoom;
    placeOrbit(window.viewer,controls,{...defaultOrbit,theta:memory.view.theta,phi:memory.view.phi});
  }
}
function scheduleSurface(){
  if(!shared||!released||desiredSurface===configuredSurface)return;
  stopOrbit();cancelAnimationFrame(surfaceFrame);
  surfaceFrame=requestAnimationFrame(()=>{
    if(canDraw()&&desiredSurface!==configuredSurface){configureCamera();redraw();}
  });
}
function orbitDistanceLimits(c){return {min:homeView ? 8 : c.minDistance ?? 7,max:Math.min(40,c.maxDistance??40)};}
function placeOrbit(v,c,view){
  const base=defaultOrbit.radius,{min,max}=orbitDistanceLimits(c);
  const next={...view,radius:base};
  let fit=base;
  if(homeView){
    cameraAt(c,next);
    // 俯视时车身投影会变长，先留出完整取景，再应用缩放比例。
    fit*=Math.max(1,projectedCarScale(v.camera,.92,.78));
  }
  const distance=bound(fit*orbitZoom,min,max);
  if(!homeView||Math.abs(distance-base)>.01)cameraAt(c,{...next,radius:distance});
  redraw();
}
function orbitCamera(azimuth,pitch,zoom=1){
  const v=window.viewer,c=v?.controls;
  if(!released||!defaultOrbit||!c||savedView||![azimuth,pitch,zoom].every(Number.isFinite)||zoom<=0)return;
  const view=cameraState(c), base=defaultOrbit.radius, {min,max}=orbitDistanceLimits(c);
  orbitZoom=bound(orbitZoom*zoom,homeView ? .7 : min/base,homeView ? 4 : max/base);
  placeOrbit(v,c,{...view,theta:view.theta+azimuth,phi:bound(view.phi+pitch,c.minPolarAngle,c.maxPolarAngle)});
}
function stopOrbit(){cancelAnimationFrame(orbitFrame);orbitFrame=0;}
function markMoving(wait=165){
  if(!appViewer)return;
  clearTimeout(motionIdle);
  if(!moving){moving=true;applyQuality()}
  motionIdle=setTimeout(()=>{
    moving=false;
    if(canDraw()){applyQuality();redraw()}
  },wait);
}
function releaseOrbit(azimuth,pitch){
  stopOrbit();
  const speed=Math.hypot(azimuth,pitch);
  if(reduced?.matches||!Number.isFinite(speed)||speed<.4||!released||savedView||!canDraw())return;
  const friction=20, maxSpeed=4.5, duration=.2;
  markMoving(duration*1000+95);
  const scale=Math.min(1,maxSpeed/speed)/friction;
  const began=performance.now();let previous=1;
  function step(now){
    if(!canDraw()){stopOrbit();return;}
    const elapsed=bound((now-began)/1000,0,duration);
    const decay=Math.exp(-friction*elapsed);
    const distance=(previous-decay)*scale;
    previous=decay;
    if(distance>0)orbitCamera(azimuth*distance,pitch*distance);
    orbitFrame=elapsed<duration?requestAnimationFrame(step):0;
  }
  orbitFrame=requestAnimationFrame(step);
}
function resetOrbit(animate,face){
  stopOrbit();
  const v=window.viewer,c=v?.controls;
  if(!released||!c||!defaultOrbit||savedView||!canDraw())return;
  const end={...defaultOrbit},start=cameraState(c),zoom=orbitZoom;
  if(face){
    const bounds=carBounds(),frame=bounds&&wrapFrame(face,bounds);
    if(!appearanceView||!frame)return;
    const direction=face==='top'?frame.v:frame.n;
    end.theta=Math.atan2(direction.x,direction.z);
    end.phi=face==='top'?c.minPolarAngle:c.maxPolarAngle;
    if(configuredSurface==='wrap'){
      cameraAt(c,end);
      const {min,max}=orbitDistanceLimits(c);
      end.radius=bound(end.radius*projectedCarScale(v.camera,.93,.79),min,max);
      cameraAt(c,start);
    }
  }
  const turn=Math.atan2(Math.sin(end.theta-start.theta),Math.cos(end.theta-start.theta));
  const tilt=end.phi-start.phi;
  function finish(){orbitFrame=0;orbitZoom=end.radius/defaultOrbit.radius;cameraAt(c,end);redraw();}
  if(!animate||reduced?.matches||Math.abs(turn)+Math.abs(tilt)+Math.abs(end.radius-start.radius)<.01){finish();return;}
  markMoving(315);
  const began=performance.now();
  function step(now){
    const progress=bound((now-began)/220,0,1);
    if(progress===1){finish();return;}
    const t=smoothStep(progress);
    orbitZoom=zoom+(end.radius/defaultOrbit.radius-zoom)*t;
    placeOrbit(v,c,{...start,theta:start.theta+turn*t,phi:start.phi+tilt*t});
    orbitFrame=requestAnimationFrame(step);
  }
  orbitFrame=requestAnimationFrame(step);
}
function transitionCamera(c,start,end,done,labels=tireLabels){
  cancelAnimationFrame(tireFrame);tireTransition=true;
  const fromLabels=tireLabels,fromOpacity=tireOpacity,toOpacity=tireView?1:0;
  const placeLabels=t=>{if(labels&&fromLabels)tireLabels=labels.map((p,i)=>({x:fromLabels[i].x+(p.x-fromLabels[i].x)*t,y:fromLabels[i].y+(p.y-fromLabels[i].y)*t}));tireOpacity=fromOpacity+(toOpacity-fromOpacity)*t;projectTires();};
  const finish=()=>{cameraAt(c,end);placeLabels(1);tireFrame=0;tireTransition=false;done();};
  if(reduced?.matches||!start.target?.lerp||!Number.isFinite(start.theta)||!Number.isFinite(start.phi)){finish();return;}
  const began=performance.now();let last=-Infinity;const delta=Math.atan2(Math.sin(end.theta-start.theta),Math.cos(end.theta-start.theta));
  const step=()=>{const now=performance.now(),p=Math.min(1,(now-began)/460);if(p===1){finish();return;}if(now-last>=1000/30){last=now;const t=smoothStep(p);cameraAt(c,{theta:start.theta+delta*t,phi:start.phi+(end.phi-start.phi)*t,radius:start.radius+(end.radius-start.radius)*t,target:start.target.clone().lerp(end.target,t)});redraw();placeLabels(t);}tireFrame=requestAnimationFrame(step);};
  cameraAt(c,start);placeLabels(0);tireFrame=requestAnimationFrame(step);
}
function restoreTireView(c,start){
  const restore=savedView;if(!restore)return;
  transitionCamera(c,start,restore,()=>{
    c.minPolarAngle=restore.minPolar;c.maxDistance=restore.maxDistance;
    c.minAzimuthAngle=restore.minAzimuth;c.maxAzimuthAngle=restore.maxAzimuth;
    c.enableDamping=restore.damping;c.autoRotate=restore.autoRotate;c.enabled=restore.enabled;
    savedView=null;tireLayoutKey='';tireLabels=null;tireOpacity=0;redraw();
  });
}
function setTireView(on,force=false){
  const c=window.viewer?.controls;if(!c||!full)return;
  if(!on){if(savedView&&(tireView||force||!tireTransition)){tireView=false;restoreTireView(c,cameraState(c));}return;}
  const b=tireBounds(),key=JSON.stringify([radius,offset,drop,innerWidth,innerHeight,b]);
  if(tireView&&key===tireLayoutKey&&!force)return;
  const points=wheelPoints(),initial=projectWheels(points);
  if(!b.valid||!initial){
    cancelAnimationFrame(tireFrame);tireFrame=0;tireTransition=false;tireLayoutKey='';tireLabels=null;tireOpacity=0;
    post({t:'tires',available:false});return;
  }
  const start=cameraState(c);
  if(!savedView){
    savedView={...start,minPolar:c.minPolarAngle,maxDistance:c.maxDistance,minAzimuth:c.minAzimuthAngle,maxAzimuth:c.maxAzimuthAngle,damping:c.enableDamping,autoRotate:c.autoRotate};
    c.stopViewControl?.();c.enabled=false;c.autoRotate=false;c.enableDamping=false;
    // stopViewControl 不清除 SDK 的 sphericalDelta。无阻尼提交一次可消费并清空惯性，
    // 再还原快照；两次更新之间不绘制，避免这次消费造成可见的首帧跳动。
    commitCamera(c);cameraAt(c,start);
  }
  if(!tireLabels){tireLabels=initial.map(p=>({x:bound(p.x,b.left,b.right),y:bound(p.y,b.first,b.last)}));tireOpacity=0;}
  c.minPolarAngle=.001;c.maxDistance=Infinity;c.minAzimuthAngle=-Infinity;c.maxAzimuthAngle=Infinity;
  const labels=fitTireCamera(points,b),end=cameraState(c);cameraAt(c,start);
  if(!labels){tireView=false;restoreTireView(c,start);post({t:'tires',available:false});return;}
  tireView=true;tireLayoutKey=key;
  transitionCamera(c,start,end,()=>{redraw();projectTires();},labels);
}
function syncMotion(){
  const speed=full&&canDraw()&&inView&&!reduced?.matches&&typeof pose.speed==='number'?Math.max(0,Math.min(200,pose.speed)):0;
  if(motionSpeed===speed)return;motionSpeed=speed;
  // 仅作运动提示，避免 SDK 按实际车速滚动地面产生过强视觉刺激。
  window.car?.handleVehicleMove?.(speed>0?Math.min(6,Math.max(.6,speed*.06)):0);
  // 覆盖同名需求：行驶时至多 20 fps，驻车即结束持续渲染。
  window.viewer?.setFPS?.(20,0,'VehicleMove');
  if(speed)window.viewer?.setFPS?.(20,Infinity,'VehicleMove');
}
reduced?.addEventListener?.('change',()=>{if(reduced.matches)stopOrbit();syncMotion();if(savedView)setTireView(tireView,true);});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopOrbit();});
window.addEventListener('resize',()=>{
  cancelAnimationFrame(tireResizeFrame);
  // 包装层监听先于 SDK 注册；等 SDK 更新 viewport/aspect 后再计算投影。
  tireResizeFrame=requestAnimationFrame(()=>{
    tireResizeFrame=0;
    if(savedView)setTireView(tireView,true);
    else if(shared&&released&&canDraw()){scheduleSurface();redraw();}
  });
});
if(typeof IntersectionObserver==='function')new IntersectionObserver(entries=>{inView=entries.some(e=>e.isIntersecting);syncMotion()}).observe(document.documentElement);
function applyPose(){
  const car=window.car,v=window.viewer;
  if(!full||!car||!v?.controls)return false;
  if(poseCar!==car){poseCar=car;appliedPose={}}
  const enabled=v.controls.enabled;v.controls.enabled=false;let changed=false;
  try{
    for(const [key,method] of [["lf","handleDoorLFWindow"],["rf","handleDoorRFWindow"],["lr","handleDoorLRWindow"],["rr","handleDoorRRWindow"],["trunk","handleTrunk"]]){
      const val=pose[key];
      if(typeof val!=="number"||!Number.isFinite(val)||val<0||val>1||appliedPose[key]===val||typeof car[method]!=="function")continue;
      // 暂停自动转向；初次直接定态，后续只做部件动画。
      car[method](key==="trunk"?val===1:val,!released);appliedPose[key]=val;changed=true;
    }
    if(changed){car.update?.();v.setFPS?.(30,released?4600:120,"ha-state");redraw()}
    return true;
  }finally{v.controls.enabled=enabled;if(released){setTireView(pose.tires===1);syncMotion();}}
}
let appearance=null, appliedAppearance=null, resolveAppearance;
const initialAppearance=new Promise(resolve=>{resolveAppearance=resolve});
async function applyAppearance(current, force=false){
  if(released&&!canDraw())return;
  const was=appliedAppearance;
  if(force||!was||was.background!==background||background==="night"&&was.floor!==nightFloor)await setBackground(background);
  if(current!==appearance||released&&!canDraw())return;
  if(force||!was||was.paint!==paint)setPaint(paint);
  if(force||!was||was.quality!==quality){applyQuality();redraw()}
  if(!current||force||was?.wrap!==current.wrap||wrapApplying){
    const value=current?JSON.parse(current.wrap):wrapConfig;
    // Skip clearing an already unwrapped model. This otherwise submits an extra draw.
    if(value||wrapTexture||wrapConfig){wrapApplying++;try{await setWrap(value)}catch{}finally{wrapApplying--}}
  }
  if(current===appearance)appliedAppearance=current;
}
function updateVisibility(){
  if(!canDraw()){
    stopOrbit();
    clearTimeout(motionIdle);moving=false;
  }else if(released){
    applyQuality();
    scheduleSurface();
    if(appearance&&appearance!==appliedAppearance)void applyAppearance(appearance);
    redraw();
  }
  syncMotion();
}
async function reveal(){
  if(released||revealing)return;
  revealing=true;
  if(appViewer&&!appearance)await Promise.race([initialAppearance,new Promise(resolve=>setTimeout(resolve,800))]);
  let applied;
  do{applied=appearance;await applyAppearance(applied,true)}while(applied!==appearance);
  applyPose();
  configureCamera();
  setTireView(pose.tires===1);await nextFrame();await nextFrame();redraw();projectTires();
  document.documentElement.classList.remove("pending");released=true;syncMotion();scheduleSurface();
  post({t:"ready",full,ms:performance.now()-started});
}
window.onFirstFrame=()=>{
  first=true;guardRenderer();applyQuality();post({t:"first",ms:performance.now()-started});
  if(c01Compat&&full&&!released)void reveal();
};
window.onFullCarLoaded=()=>{
  full=true;guardRenderer();clearTimeout(timeout);
  post({t:"full",ms:performance.now()-started});
  // C01 loads its trim table after starting the full-model worker.
  if(c01Compat&&!first)return;
  if(released)void applyAppearance(appearance,true).then(async()=>{
    await nextFrame();redraw();post({t:"ready",full:true,ms:performance.now()-started});
  });else void reveal();
};
window.addEventListener("message",ev=>{
  if(ev.source!==parent||ev.origin!==parentOrigin)return;
  const d=ev.data;if(!d||typeof d!=="object")return;
  if(d.t==="surface"&&shared&&['home','appearance','wrap'].includes(d.view)){
    desiredSurface=d.view;scheduleSurface();
  }else if(d.t==="visibility"&&appViewer){
    const visible=d.visible===true;
    if(hostVisible!==visible){hostVisible=visible;updateVisibility()}
  }else if(d.t==="appearance"&&appViewer){
    if(typeof d.wrap!=="string"||!Object.hasOwn(bootColors,d.background)||!(d.paint===""||/^#[0-9a-f]{6}$/i.test(d.paint)))return;
    const floor=typeof d.floor==="string"&&/^#[0-9a-f]{6}$/i.test(d.floor)?d.floor:bootColors.night;
    if(appearance?.background===d.background&&appearance.floor===floor&&appearance.paint===d.paint&&appearance.quality===d.quality&&appearance.wrap===d.wrap)return;
    appearance={...d,floor};background=d.background;nightFloor=floor;paint=d.paint;quality=d.quality==="power"?"power":"high";
    document.documentElement.style.setProperty("--boot-bg",background==="night"?nightFloor:bootColors[background]);
    resolveAppearance();
    if(released&&canDraw())void applyAppearance(appearance);
  }else if(d.t==="background"||d.t==="daynight"){
    background=d.t==="daynight"?(Number(d.v)===1?"night":"day"):String(d.name);
    if(!["day","night","studio","dusk","aurora","blueprint"].includes(background))background="day";
    void setBackground(background).then(ok=>post({t:"ack",of:"background",ok}));
  }else if(d.t==="paint"){
    if(typeof d.hex!=="string"||(d.hex!==""&&!/^#[0-9a-f]{6}$/i.test(d.hex)))return;
    paint=d.hex;post({t:"ack",of:"paint",ok:setPaint(paint)});
  }
  else if(d.t==="vehicle"){pose=d;post({t:"ack",of:"vehicle",ok:applyPose()})}
  else if(d.t==="quality"){quality=d.name==="power"?"power":"high";post({t:"ack",of:"quality",ok:applyQuality()})}
  else if(d.t==="orbit"&&released&&canDraw()){stopOrbit();markMoving();orbitCamera(d.azimuth,d.pitch,d.zoom);}
  else if(d.t==="orbit-stop")stopOrbit();
  else if(d.t==="orbit-release")releaseOrbit(d.azimuth,d.pitch);
  else if(d.t==="orbit-reset")resetOrbit(d.animate===true);
  else if(d.t==='wrap-face'&&wrapSides.includes(d.face))resetOrbit(true,d.face);
  else if(d.t==='wrap'){try{void setWrap(JSON.parse(d.value)).then(ok=>post({t:'ack',of:'wrap',ok}),()=>post({t:'ack',of:'wrap',ok:false}))}catch{post({t:'ack',of:'wrap',ok:false})}}
  else if(d.t==="view"){
    if(Number.isFinite(d.radius)&&d.radius>0)radius=d.radius;
    if(Number.isFinite(d.offset))offset=d.offset;
    if(Number.isFinite(d.drop))drop=d.drop;
    if(released&&savedView){
      // 记住新尺寸下的普通取景；胎压过渡由同一个动画接管，不能被 applyView 抢写。
      savedView.radius=radius;
      if(savedView.target&&window.viewer.controls.__leapBaseY!==undefined)savedView.target.y=window.viewer.controls.__leapBaseY+drop/100*.335*radius;
      window.viewer.setOffsetVertical?.(offset*100);setTireView(tireView,true);
      post({t:'ack',of:'view',ok:true});
    }else post({t:"ack",of:"view",ok:released?applyView():true});
  }else if(d.t==="probe")post({t:"ack",of:"probe",version:WRAPPER_VERSION,full,first,released,
    hasPaint:!!window.car?.carPaint_CarPaintMaterial,hasSky:!!skyNode(),background,
    stateMethods:["handleDoorLFWindow","handleDoorRFWindow","handleDoorLRWindow","handleDoorRRWindow","handleTrunk"].filter(k=>typeof window.car?.[k]==="function")});
});
if(appViewer)post({t:"appearance-request"});
window.__api={setBackground,setPaint,setWrap,applyView,applyPose,redraw,sceneOf,skyNode,version:WRAPPER_VERSION};
const timeout=setTimeout(()=>{if(!full){if(first)void reveal();post({t:"err",msg:first?"完整模型未就绪，当前显示简化车模":"车模加载超时，请导出诊断检查素材完整性"})}},25000);
try{
  window.web3dPerformanceOptions={metricsEnabled:false,dynamicDprEnabled:true,transitionPixelRatioCap:1.25};
  const entry = c01Compat ? './index.c01-v1.js' : './index.js';
  await import(window.viewerAsset ? window.viewerAsset(entry) : entry + '?v=' + WRAPPER_VERSION);
  await window.newInit(JSON.stringify(cfg),JSON.stringify({width:innerWidth,height:innerHeight,energy:0,inland:0}));
}catch(e){clearTimeout(timeout);reportRuntimeError(e);post({t:"err",msg:"查看器初始化失败"})}
document.addEventListener("visibilitychange",()=>{
  if(appViewer)updateVisibility();
  else{syncMotion();if(document.hidden)window.onBackend?.();else window.onFrontend?.()}
});
