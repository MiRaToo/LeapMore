import { ColorPicker } from '../../ui/Picker';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { WrapPresets } from './WrapPresets';
import { defaultGradientEnd, slotCount, slotsOf, texture, type Decoration, type Face, type useVehicleVisual } from './VehicleModel';

const faces = [['front', '车头'], ['rear', '车尾'], ['left', '左侧'], ['right', '右侧'], ['top', '车顶']] as const;
const patterns = [['solid', '纯色'], ['stripe', '条纹'], ['gradient', '渐变'], ['carbon', '碳纤维']] as const;
const colors = [['薄荷绿', '#2fb8a6'], ['冰川蓝', '#70a1c7'], ['靛紫', '#8b76bf'], ['珊瑚红', '#d9655d'],
  ['琥珀黄', '#dba848'], ['珍珠白', '#f3f0e9'], ['石墨黑', '#343b42']] as const;
const sliders = [['scale', '缩放', 20, 180, '%'], ['rotation', '旋转', -180, 180, '°'], ['x', '水平移动', -100, 200, '%'],
  ['y', '垂直移动', -100, 200, '%'], ['opacity', '不透明度', 0, 100, '%']] as const;
const blank: Decoration = { kind: 'solid', color: '#2fb8a6', x: 50, y: 50, scale: 100, rotation: 0, opacity: 85 };

async function upload(file: File) {
  if (file.size > 12_000_000 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择小于 12 MB 的 PNG、JPEG 或 WebP。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try { await image.decode(); }
    catch { throw new Error('无法读取这张图片，请重新选择。'); }
    const canvas = document.createElement('canvas');
    function encode(maxSide: number) {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', .8);
    }
    const source = encode(640);
    // WebViews without a WebP encoder fall back to PNG. Keep its alpha within the viewer's size limit.
    return source.length <= 1_400_000 ? source : encode(480);
  } finally { URL.revokeObjectURL(url); }
}

type Visual = ReturnType<typeof useVehicleVisual>;
export function WrapEditor({ vehicleId, visual, ready, focusFace, finish }: {
  vehicleId: string; visual: Visual; ready: boolean; focusFace: (face: Face) => void; finish: () => void;
}) {
  const { wrap, setWrap } = visual;
  const [face, setFace] = useState<Face>('front');
  const [slot, setSlot] = useState(0);
  const [notice, setNotice] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const uploads = useRef(new Map<string, symbol>());
  const pendingFocus = useRef<Face | null>(null);
  useEffect(() => {
    if (ready && pendingFocus.current) {
      focusFace(pendingFocus.current);
      pendingFocus.current = null;
    }
  }, [ready, focusFace]);
  useEffect(() => {
    const pending = uploads.current;
    return () => pending.clear();
  }, []);
  const layers = slotsOf(wrap[face]);
  const applied = layers[slot];
  const uploadKey = face + ':' + slot;
  const material = applied ?? blank;
  const colorFields: readonly ('color' | 'endColor')[] = material.kind === 'gradient' ? ['color', 'endColor']
    : material.kind === 'solid' || material.kind === 'stripe' ? ['color'] : [];

  function selectFace(side: Face) {
    setFace(side);
    if (side !== face) setSlot(0);
    setNotice('');
    if (ready) focusFace(side);
    else pendingFocus.current = side;
  }
  function changeSlot(update: Partial<Decoration>) {
    setWrap(previous => {
      const next = Array.from(slotsOf(previous[face]));
      while (next.length <= slot) next.push(null);
      next[slot] = { ...(next[slot] ?? blank), ...update };
      return { ...previous, [face]: next };
    });
  }
  function choosePattern(kind: Decoration['kind']) {
    uploads.current.delete(uploadKey);
    setUploading(uploads.current.size);
    setNotice('');
    changeSlot({ kind });
  }
  async function chooseImage(file: File) {
    const task = Symbol();
    uploads.current.set(uploadKey, task);
    setUploading(uploads.current.size);
    setNotice('');
    try {
      const image = await upload(file);
      if (uploads.current.get(uploadKey) === task) changeSlot({ kind: 'image', image });
    } catch (error) {
      if (uploads.current.get(uploadKey) === task) setNotice(error instanceof Error ? error.message : '无法读取图片，请重试。');
    } finally {
      if (uploads.current.get(uploadKey) === task) {
        uploads.current.delete(uploadKey);
        setUploading(uploads.current.size);
      }
    }
  }
  function clear(scope: 'slot' | 'face' | 'all') {
    for (const key of uploads.current.keys()) {
      if (scope === 'all' || (scope === 'face' ? key.startsWith(face + ':') : key === uploadKey)) uploads.current.delete(key);
    }
    setUploading(uploads.current.size);
    setNotice('');
    setWrap(previous => {
      if (scope === 'all') return {};
      const next = { ...previous };
      const items = scope === 'slot' ? [...slotsOf(next[face])] : [];
      if (scope === 'slot') items[slot] = null;
      if (items.some(Boolean)) next[face] = items;
      else delete next[face];
      return next;
    });
  }

  return <section className="wrap-editor" id="appearance-settings" aria-labelledby="wrap-editor-title">
    <header className="wrap-header">
      <div><h2 id="wrap-editor-title">自定义车衣</h2><span>{visual.modelName}</span></div>
      <div className="wrap-header-actions"><button className="wrap-presets-button" disabled={uploading > 0} onClick={() => setPresetsOpen(true)}>预设</button>
        <button className="btn accent sm" disabled={uploading > 0} onClick={finish}>完成</button></div>
    </header>
    <div className="wrap-body">
      <div className="wrap-faces" role="group" aria-label="车身部位">{faces.map(([key, label]) =>
        <button key={key} aria-pressed={face === key} aria-label={label} aria-description={wrap[key] ? '已设置车衣' : undefined}
          onClick={() => selectFace(key)}>{label}{wrap[key] && <i />}</button>)}</div>
      {!ready && <p className="wrap-notice" role="status">图案可预览，车模加载后可查看上车效果。</p>}
      <div className="wrap-slot-row"><h3>图案槽位</h3><div className="wrap-slots" role="group" aria-label="图案槽位">
        {Array.from({ length: slotCount }, (_, i) => <button key={i} aria-label={'槽位 ' + (i + 1)} aria-pressed={slot === i}
          onClick={() => { setSlot(i); setNotice(''); }}><i style={layers[i] ? { backgroundImage: 'url(' + texture(layers[i]) + ')' } : undefined} />{i + 1}</button>)}
      </div></div>
      <div className="wrap-section-heading"><h3>图案</h3>
        <label className="wrap-upload"><Icon name="plus" size={15} />上传图片
          <input type="file" accept="image/jpeg,image/png,image/webp" aria-label="上传车衣图片" onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void chooseImage(file);
          }} /></label>
      </div>
      <div className="wrap-materials" role="group" aria-label="车衣图案">
        {([...patterns, ...(material.image ? [['image', '图片'] as const] : [])]).map(([kind, label]) =>
          <button key={kind} aria-pressed={applied?.kind === kind} onClick={() => choosePattern(kind)}>
            <span className="wrap-sample" style={{ backgroundImage: 'url(' + texture({ ...material, kind }) + ')' }}>
              {applied?.kind === kind && <i><Icon name="check" size={12} /></i>}
            </span><span>{label}</span>
          </button>)}
      </div>
      {(notice || uploading > 0) && <p className="wrap-notice" role="status">{notice || '正在导入图片…'}</p>}
      {colorFields.map(field => {
        const label = material.kind !== 'gradient' ? '颜色' : field === 'color' ? '起始色' : '结束色';
        const current = material[field] ?? defaultGradientEnd;
        return <div className="wrap-colors" key={field}>
          <div className="wrap-section-heading"><h3>{label}</h3>
            <ColorPicker aria-label={material.kind === 'gradient' ? '渐变' + label : '自定义车衣颜色'} value={current} onValue={color => changeSlot({ [field]: color })} />
          </div>
          <div className="wrap-palette" role="group" aria-label={label}>{colors.map(([name, hex]) =>
            <button key={hex} aria-label={name} aria-pressed={!!applied && current.toLowerCase() === hex}
              onClick={() => changeSlot({ [field]: hex })}><i style={{ backgroundColor: hex }} /></button>)}</div>
        </div>;
      })}
      <details className="wrap-adjustments">
        <summary><Icon name="climatePresets" size={18} /><span>位置与透明度</span><Icon name="chevrond" size={16} /></summary>
        {sliders.map(([key, label, min, max, unit]) => <label className="wrap-slider" key={key}><span>{label}</span>
          <input type="range" min={min} max={max} aria-label={label} value={material[key]} aria-valuetext={material[key] + unit}
            onChange={e => changeSlot({ [key]: e.target.valueAsNumber })} /><output>{material[key]}{unit}</output></label>)}
      </details>
      <div className="wrap-clear"><button disabled={!applied && !uploads.current.has(uploadKey)} onClick={() => clear('slot')}>清除本槽</button>
        <button disabled={!wrap[face] && ![...uploads.current.keys()].some(key => key.startsWith(face + ':'))} onClick={() => clear('face')}>清除本面</button>
        <button disabled={!Object.keys(wrap).length && !uploading} onClick={() => clear('all')}>清除全部</button></div>
    </div>
    {presetsOpen && <WrapPresets vehicleId={vehicleId} wrap={wrap} close={() => setPresetsOpen(false)} apply={saved => {
      uploads.current.clear();
      setNotice('');
      setSlot(0);
      setWrap(() => saved);
    }} />}
  </section>;
}
