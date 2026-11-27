import { Picker, TimePicker } from '../../ui/Picker';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CloudSessionExpired } from '../../data/cloud/LiveClient';
import { allowsPreparationContent, applyPreparationEdit, planExpired, preparationContent, preparationKey } from '../../data/cloud/preparation';
import type { PreparationEdit, PreparationPlan, PreparationPreset } from '../../data/cloud/preparation';
import { readSetting, saveSetting } from '../../data/localDatabase';
import { useModelContext } from '../context';
import { Icon } from '../../ui/Icon';
import { Seg, Sheet, Switch } from '../../ui/components';
import { useCommands } from './commands';
import { repeatLabel, WeekdaySelector } from './WeekdaySelector';
import { initialPresets, PreparationFields, presetSummary } from './PreparationPresets';

function planTitle(plan: PreparationPlan) {
  if (typeof plan.name === 'string' && plan.name.trim()) return plan.name;
  const actions = [['syn_path', '导航'], ['air_condition', '空调'], ['seat_setting', '座椅'], ['steeringWheelHeatCtrl', '方向盘加热'],
    ['rearMirrorHeating', '后视镜加热'], ['childSeatAfterCtr', '儿童座椅']].filter(([key]) => plan.datacontent[key]);
  return actions.map(([, title]) => title).join('、') || '车辆备车配置';
}

export function PreparationSchedules({ presets, selected, close }: { presets: PreparationPreset[]; selected?: string; close: () => void }) {
  const m = useModelContext();
  const cmd = useCommands();
  const demoKey = 'demo-preparation:' + m.vehicleId;
  const [demoPlans, setDemoPlans] = useState<PreparationPlan[]>(() => m.simulated ? readSetting(demoKey, []) : []);
  const query = useQuery({ queryKey: preparationKey(m.cloudKey), enabled: !!m.client && !cmd.reason('prepareSchedule'), retry: false,
    queryFn: async () => {
      const read = async (force = false) => (await m.controlClient(force)).getPreparationSchedules(m.vehicleId);
      try { return await read(); } catch (error) { if (error instanceof CloudSessionExpired) return read(true); throw error; }
    } });
  const plans = m.simulated ? demoPlans : query.data;
  const blocked = !!cmd.reason('prepareSchedule') || !plans || (!m.simulated && query.isError);
  const [editor, setEditor] = useState<{ plan?: PreparationPlan; time: string; days: number[]; presetId: string; mode: 'preset' | 'custom'; custom: PreparationPreset }>();
  const available = presets.filter(p => m.vehicle && allowsPreparationContent(m.vehicle, preparationContent(p, m.vehicle), true, m.canSee('location')));
  const preset = editor?.mode === 'custom' ? editor.custom : available.find(p => p.id === editor?.presetId);
  const begin = (plan?: PreparationPlan) => setEditor({ plan, time: plan?.start_time.slice(11, 16) ?? '07:30', days: plan?.days ?? [],
    mode: plan || available.length ? 'preset' : 'custom', custom: { ...initialPresets[0], id: 'custom', name: '自定义备车', climate: false },
    presetId: plan ? '' : available.find(p => p.id === selected)?.id ?? available[0]?.id ?? '' });

  function send(edit: PreparationEdit, title: string, description: string) {
    if (blocked || !m.vehicle) return;
    const vin = m.vehicle.vin;
    let simulation;
    try { simulation = m.simulated ? applyPreparationEdit(demoPlans, edit, vin) : undefined; }
    catch (error) { m.setToast(error instanceof Error ? error.message : '预约备车暂不可用'); return; }
    cmd.ask({ kind: 'prepareSchedule', icon: 'clock', title, description, remote: { kind: 'prepareSchedule', edit },
      apply: () => { if (simulation) { saveSetting(demoKey, simulation.controls); setDemoPlans(simulation.controls); } },
      onComplete: () => setEditor(undefined) });
  }
  if (editor) {
    const { plan, days, time } = editor;
    const content = preset && m.vehicle ? preparationContent(preset, m.vehicle) : undefined;
    const valid = content && m.vehicle ? allowsPreparationContent(m.vehicle, content, true, m.canSee('location')) : !!plan && editor.mode === 'preset';
    const description = [time, repeatLabel(days), preset?.name ?? (plan && planTitle(plan))].filter(Boolean).join(' · ');
    return <Sheet title={plan ? '编辑预约备车' : '添加预约备车'} close={() => setEditor(undefined)} showClose className="prep-editor">
      <div className="prep-edit-body">
        <label className="prep-field">备车时间<TimePicker aria-label="备车时间" value={time} onValue={v => setEditor({ ...editor, time: v })} /></label>
        <Seg label="预约配置方式" current={editor.mode} options={[['preset', '使用预设'], ['custom', '自定义']]} choose={mode => setEditor({ ...editor, mode })} />
        {editor.mode === 'preset' ? <label className="prep-field">备车预设<Picker aria-label="备车预设" value={editor.presetId} onValue={v => setEditor({ ...editor, presetId: v })}>
            {plan && <option value="">保留原配置</option>}{available.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Picker></label> : <PreparationFields scheduled draft={editor.custom}
              patch={update => setEditor(previous => previous && ({ ...previous, custom: { ...previous.custom, ...update } }))} />}
        {editor.mode === 'preset' && <p className="tiny muted">{preset ? presetSummary(preset) : plan ? planTitle(plan) : '暂无可用预设'}</p>}
        <WeekdaySelector label="备车重复日期" days={days} disabled={blocked} change={days => setEditor({ ...editor, days })} />
      </div>
      <footer>
        <button className="btn accent" disabled={blocked || !time || !valid} onClick={() => send({
        action: 'save', time, days, previous: plan, preset: preset && content ? { name: preset.name, content } : undefined,
      }, '保存预约备车', description)}>保存预约</button>
        {plan && <button className="btn ghost" disabled={blocked} onClick={() => send({ action: 'delete', previous: plan }, '删除预约备车', description)}>删除预约</button>}
      </footer>
    </Sheet>;
  }
  return <Sheet title="预约备车" close={close} showClose className="prep-schedules">
    {plans && [...plans].sort((a,b) => a.start_time.slice(11).localeCompare(b.start_time.slice(11))).map(plan => {
      const expired = planExpired(plan);
      const active = plan.enable && !expired;
      const repeat = plan.days?.length ? repeatLabel(plan.days) : plan.start_time.slice(0, 10);
      return <div key={plan.set_id} className="prep-plan"><button disabled={blocked} className="prep-plan-details" onClick={() => begin(plan)}>
        <b className="num">{plan.start_time.slice(11,16)}</b><span>{planTitle(plan)}</span><small>{repeat}{expired ? ' · 已过期' : ''}</small></button>
        <Switch checked={active} label={planTitle(plan) + '预约开关'} disabled={blocked}
          action={() => send({ action: 'toggle', previous: plan }, (active ? '关闭' : '启用') + '预约备车', plan.start_time.slice(11,16) + ' · ' + planTitle(plan))} /></div>;
    })}
    {!m.simulated && query.isError ? <p role="status">预约读取失败。<button className="link" onClick={() => void query.refetch()}>重新读取</button></p>
      : !plans ? <p className="muted" role="status">正在读取预约…</p> : !plans.length && <p className="muted">暂无预约备车</p>}
    <button className="btn secondary" disabled={blocked || (plans?.length ?? 0) >= 5} onClick={() => begin()}>
      <Icon name="plus" size={16} />添加预约</button>
    {(plans?.length ?? 0) >= 5 && <p className="tiny muted">已达到 5 条预约上限</p>}
  </Sheet>;
}
