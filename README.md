# LeapMore

<img src="icons/brand/leaplink-icon-simple.png" alt="LeapMore 应用图标" width="72">

**开源免费 · 面向中国大陆零跑车主的第三方车辆助手**

用手机看车况、远程控车、记录行程和充电，也可以把同一辆车的 Home Assistant（HA）历史记录同步到手机。LeapMore 可以免费下载和使用，项目代码按 [GNU GPL v3.0](LICENSE)（GPL-3.0-only）发布。

## 下载与安装

各平台的安装包和版本说明可在[最新发布页](https://github.com/MiRaToo/LeapMore/releases/latest)查看。

| 系统 | 安装方式 |
| --- | --- |
| Android | 下载 APK，可覆盖安装之前的正式版。 |
| 鸿蒙 | 下载 HAP。文件名带有 unsigned 的安装包需要自行签名后安装。 |
| iOS / iPadOS | 同一个 IPA 包含主应用和桌面小组件。使用 SideStore 时选择「Keep App Extensions」，安装后打开 App 同步一次车况，再到桌面添加卡片。使用 LiveContainer 可以运行主应用，容器内的小组件无法添加到系统桌面。 |

打开 App 或从后台返回时会自动检查更新。在「我的 → 关于 LeapMore」可关闭提醒、手动检查或直接下载安装包。GitHub、GitCode 和夸克网盘入口始终可见。GitCode 与网盘更新可能稍晚，下载时请核对版本号。[GitCode 发布页](https://gitcode.com/MiraRato/LeapMore/releases) · [夸克网盘备用下载](https://pan.quark.cn/s/9e6168a73f21) · [LeapMore 官网](https://leapmore.mirato66.cloud/) · [源码构建指南](app/README.md)

## 界面与功能

[![LeapMore 的 3D 车况首页、实时行程、实时充电和能耗统计](docs/screenshots/overview.png)](docs/screenshots/overview.png)

介绍图由 Android 模拟器实拍合成，使用演示数据，地图区域已遮盖。

- 在**车况与远控**中查看续航、胎压和车辆状态。驻车时可按车型和账号权限操作门锁、车窗、后备箱和空调，支持操作密码或系统生物识别。[3D 车况](docs/screenshots/vehicle.png) · [车辆控制](docs/screenshots/controls.png) · [空调与加热](docs/screenshots/climate.png)
- **行程与充电**支持左右滑动切换。「最近」直接显示进行中或最近一次记录的地图和详情，历史记录可按周、月或全部查看。有采样时，可以分别查看车速或充电功率、电量和电池最低温曲线。每笔充电都可填写实付电费，也可恢复自动估算。[行程记录](docs/screenshots/trips.png) · [充电记录](docs/screenshots/charges.png)
- **能耗统计**可查看本周、本月行驶里程，以及累计天数、里程和能耗。可按需添加、移除或拖动卡片。手机与 HA 记录支持合并和导出 CSV。[能耗统计](docs/screenshots/statistics.png) · [记录与数据源](docs/screenshots/data-sources.png)
- **自定义车衣**为车头、车尾、左右侧和车顶各提供 4 个独立槽位，可叠放图片或内置图案、设置渐变两端颜色，并按车辆保存预设。
- **桌面小组件**在 Android、iOS 和鸿蒙提供小、中、大三种布局。中、大卡片右上角使用 LeapMore 的 L+ 标识。在「我的 → 桌面卡片预览」可查看各尺寸。[小组件预览](docs/screenshots/widgets.png)

## 开始使用

1. 打开 App 后使用你自己的零跑账号登录并选车。首次选车时，可以选择车型的电池容量预设，或在「我的 → 车辆管理」中稍后填写。也可以先使用演示账号体验界面。
2. 行程和充电采样默认关闭。在「记录 → 记录设置」选择「手机记录」或「手机记录 + HA 同步」，支持后台采样的手机会随即开始记录。选择「HA 同步」可读取已连接的 HA 行程。切换数据源或关闭采样后，仍可查看本车已保存的手机和 HA 历史，重叠里程只计一次。
3. 如需连接 HA，在记录设置中进入「HA 同步设置」，填写自己的服务器地址并授权。只想查看 HA 历史时，也可直接从登录页连接。[LeapToHA 集成](https://github.com/MiRaToo/ha-leapmotor-cn)提供所需的车辆记录。
4. 如需显示停车和行程起终点地址、搜索常用地点或把手填地址发给车机导航，可在「我的 → 高德地图 Key」按指引注册高德开发者，创建「Web 服务」类型的 Key 并保存。

手机采样可能受到车辆上报、网络和后台限制影响。耗电量与电费包含按 SOC、容量及电价计算的估算，实际金额以充电账单为准。

## 隐私与反馈

系统版本将会话凭据放在设备的安全存储中，历史记录保存在本机。零跑车况、HA 同步和地址查询会访问相应服务。在「我的 → 实验功能」为当前账号开启自动签到后，App 会通过零跑官方页面检查并办理当日签到。反馈问题前，请移除手机号、车架号、精确位置、令牌和操作密码。

遇到网络或车况异常，可从登录页或「我的 → 故障诊断与导出」检测连接。登录并选车后，还可以检查车辆列表、车况和 3D 车模，查看动力类型与续航的判定依据。诊断支持导出 TXT 和 CSV，分享前可先查看文件内容。

LeapMore 与零跑汽车无隶属关系。遇到问题可在 [GitHub Issues](https://github.com/MiRaToo/LeapMore/issues) 提交版本号、设备系统和复现步骤。

## 赞赏

如果 LeapMore 对你有帮助，欢迎自愿支持项目维护。下载、使用及全部功能均免费。

- 爱发电：[支持 LeapMore](https://afdian.com/a/mirato)
- 微信：扫一扫下方赞赏码。

<img src="docs/wechat-reward.png" alt="LeapMore 微信赞赏码" width="220">
