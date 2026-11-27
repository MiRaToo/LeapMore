import { CapacitorPlugin, PluginCall } from 'harmony-capacitor';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { Vault } from './LeapNative';

const pageUrl: string = 'https://apptec.leapmotor.com/lpv/user-level/my-level.html';
const storageKey: string = 'leapmoreCheckInRun';
interface Account { userId: string; token: string; }
interface Session { account: Account; }
interface Identity { LMAccID: string; APPToken: string; APPPlatform: string; }
interface Step { state: string; }
let controller: webview.WebviewController | undefined;

@Component
export struct CheckInSurface {
  @StorageLink('leapmoreCheckInRun') run: string = '';
  build() {
    Stack() {
      if (this.run && controller) {
        Web({ src: pageUrl + '?APPFullScreen=true', controller: controller })
          .javaScriptAccess(true).fileAccess(false).domStorageAccess(true)
      }
    }.width('100%').height('100%').opacity(0).hitTestBehavior(HitTestMode.None).accessibilityLevel('no-hide-descendants')
  }
}

export class LeapCheckIn extends CapacitorPlugin {
  private run: string = '';
  private script: string = '';
  private timer: number = -1;
  private readonly context: common.UIAbilityContext;
  constructor(context: common.UIAbilityContext) {
    super();
    this.context = context;
    this.registerMethod('checkInOpen', call => { this.open(call); });
    this.registerMethod('checkInStep', call => { this.step(call); });
    this.registerMethod('checkInClose', call => { if (this.run === call.getString('run')) this.close(); call.resolve(); });
  }
  private close(): void {
    clearTimeout(this.timer);
    AppStorage.setOrCreate(storageKey, '');
    try { controller?.stop(); } catch {}
    controller = undefined;
    this.run = '';
    this.script = '';
  }
  private async open(call: PluginCall): Promise<void> {
    this.close();
    try {
      const value = await new Vault().get('leapmotor-session');
      if (!value) throw new Error();
      const session = JSON.parse(value) as Session;
      if (!session.account.token || session.account.userId !== call.getString('account')) throw new Error();
      const identity: Identity = { LMAccID: session.account.userId, APPToken: session.account.token, APPPlatform: 'HarmonyOS' };
      const source = this.context.resourceManager.getRawFileContentSync('www/checkin-page.js');
      this.script = new util.TextDecoder().decodeToString(source) + '(' + JSON.stringify(identity) + ',';
      this.run = call.getString('run');
      controller = new webview.WebviewController();
      AppStorage.setOrCreate(storageKey, this.run);
      this.timer = setTimeout(() => this.close(), 60000);
      call.resolve();
    } catch { this.close(); call.rejectMessage('CHECKIN', '无法打开官方签到页'); }
  }
  private async step(call: PluginCall): Promise<void> {
    if (!controller || this.run !== call.getString('run')) { call.rejectMessage('CHECKIN', '签到已停止'); return; }
    const result: Step = { state: 'waiting' };
    try {
      if (controller.getUrl().split(/[?#]/)[0] === pageUrl) {
        const value = (await controller.runJavaScript(this.script + String(call.getBoolean('submit')) + ')')).replace(/^"|"$/g, '');
        if (['ready', 'signed', 'submitted', 'manual'].includes(value)) result.state = value;
      }
    } catch {}
    call.resolve(result);
  }
}
