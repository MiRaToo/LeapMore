'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function selectButton(button) {
  const group = button.parentElement;
  const buttons = $$('button[aria-pressed]', group);
  if (group.matches('.feature-tabs, .sync-options, .platforms')) {
    group.style.setProperty('--selected', buttons.indexOf(button));
  }
  for (const sibling of buttons) {
    sibling.setAttribute('aria-pressed', String(sibling === button));
  }
}

function enter(element) {
  if (reducedMotion.matches || !element.animate) return;
  element.getAnimations().forEach(animation => animation.cancel());
  element.animate([
    { opacity: .48, transform: 'translateY(5px)' },
    { opacity: 1, transform: 'translateY(0)' }
  ], { duration: 220, easing: 'cubic-bezier(.23, 1, .32, 1)' });
}

const readings = {
  range: { label: '纯电续航', value: '195', unit: 'km' },
  cabin: { label: '车内温度', value: '24.0', unit: '°C' },
  lock: { label: '门锁状态', value: '已锁车', unit: '' },
};

for (const button of $$('[data-sensor]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.sensor;
    if ($('.callout').dataset.reading === key) return;
    selectButton(button);
    const reading = readings[key];
    $('.callout').dataset.reading = key;
    $('#read-label').textContent = reading.label;
    $('#read-value').textContent = reading.value;
    $('#read-unit').textContent = reading.unit;
    enter($('.callout'));
  });
}

const features = {
  vehicle: {
    icon: 'car', title: '出发前，先看一眼车。',
    text: '电量、续航、胎压和门锁状态集中在首页。驻车时，可按车型和账号权限远程操作车锁、车窗和空调。',
    screens: { vehicle: '车况首页', controls: '车辆控制', climate: '空调与加热', widgets: '桌面卡片' },
  },
  trips: {
    icon: 'route', title: '这一程，开了多远？',
    text: '路上查看实时车速、里程和行驶时长。回家后按天翻看历史行程，找到每次出发的时间和平均能耗。',
    screens: { trips: '行程记录', 'data-sources': '记录与数据源' },
  },
  charges: {
    icon: 'charge', title: '补了多少电，随时能看。',
    text: '充电中查看充入电量和功率，结束后按天翻看明细。设置交流与直流电价，还可以估算每次补能的费用。',
    screens: { charges: '充电记录' },
  },
  statistics: {
    icon: 'chart', title: '用电的变化，一周一月看。',
    text: '按周或月查看行驶里程和百公里能耗，比较不同日期的用车情况。电费按电量与电价估算，实际金额以充电账单为准。',
    screens: { statistics: '能耗统计' },
  },
};

let currentScreen = 'vehicle';
const phoneImage = $('#phone-image');
const phoneButton = $('.phone-preview');
const screenOptions = $('.screen-options');
const viewer = $('#viewer');

function showScreen(key, name) {
  currentScreen = key;
  phoneImage.src = './assets/' + key + '.webp';
  phoneImage.alt = name + '的 Android 实拍界面';
  phoneButton.setAttribute('aria-label', '放大查看' + name + '实拍');
  $('#viewer-title').textContent = name;
  enter(phoneImage);
}

for (const button of $$('[data-feature]')) {
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-pressed') === 'true') return;
    selectButton(button);
    const key = button.dataset.feature;
    const feature = features[key];
    $('.feature-icon use').setAttribute('href', '#i-' + feature.icon);
    $('#feature-title').textContent = feature.title;
    $('#feature-text').textContent = feature.text;
    const screens = Object.entries(feature.screens);
    screenOptions.replaceChildren(...screens.map(([id, name], index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.dataset.screen = id;
      option.textContent = name;
      option.setAttribute('aria-pressed', String(index === 0));
      return option;
    }));
    screenOptions.hidden = screens.length < 2;
    showScreen(...screens[0]);
    enter($('#feature-title'));
  });
}

screenOptions.addEventListener('click', event => {
  const option = event.target.closest('button');
  if (!option || currentScreen === option.dataset.screen) return;
  selectButton(option);
  showScreen(option.dataset.screen, option.textContent);
});

function openViewer() {
  if (!viewer.showModal) {
    window.location.href = phoneImage.src;
    return;
  }
  $('#viewer-image').src = phoneImage.src;
  $('#viewer-image').alt = phoneImage.alt;
  viewer.showModal();
}

phoneButton.addEventListener('click', openViewer);
$('.zoom').addEventListener('click', openViewer);
$('.viewer-head button').addEventListener('click', () => viewer.close());
viewer.addEventListener('click', event => {
  if (event.target !== viewer) return;
  const rect = viewer.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) viewer.close();
});

const syncModes = {
  phone: [2, '手机记录了早上和中午的行程，共 2 条。'],
  ha: [2, 'HA 保存了中午和傍晚的行程，共 2 条。'],
  both: [3, '手机 2 条 + HA 2 条，其中 1 条重叠，合并后保留 3 条。'],
};
const flow = $('.flow');
function playFlow() {
  if (reducedMotion.matches) return;
  flow.getAnimations({ subtree: true }).forEach(animation => {
    if (animation.animationName === 'transfer') animation.currentTime = 0;
  });
  flow.classList.add('playing');
}
for (const button of $$('[data-sync]')) {
  button.addEventListener('click', () => {
    const key = button.dataset.sync;
    selectButton(button);
    flow.dataset.mode = key;
    const [count, detail] = syncModes[key];
    $('#sync-count').firstChild.textContent = count + ' ';
    $('#sync-detail').textContent = detail;
    playFlow();
    enter($('.result-main strong'));
  });
}

const releaseBase = 'https://github.com/MiRaToo/LeapMore';
const guide = releaseBase + '/blob/v0.1.0/app/README.md';
const platforms = {
  android: { title: 'Android 安装包', meta: 'v0.1.0 预发布 · Android 7.0+ · 4.1 MiB', icon: 'download', action: '免费下载 APK', url: releaseBase + '/releases/download/v0.1.0/LeapMore-v0.1.0-android.apk' },
  ios: { title: '从源码构建 iOS 版', meta: '使用 Xcode 编译，配置自己的签名团队后安装。', icon: 'code', action: '查看 iOS 构建指南', url: guide + '#ios' },
  harmony: { title: '从源码构建鸿蒙版', meta: '使用 DevEco Studio 构建 HAP，并配置自己的签名。', icon: 'code', action: '查看鸿蒙构建指南', url: guide + '#鸿蒙' },
};
for (const button of $$('[data-platform]')) {
  button.addEventListener('click', () => {
    if (button.getAttribute('aria-pressed') === 'true') return;
    selectButton(button);
    const platform = platforms[button.dataset.platform];
    $('#platform-title').textContent = platform.title;
    $('#platform-meta').textContent = platform.meta;
    $('#platform-link').href = platform.url;
    $('#platform-link span').textContent = platform.action;
    $('#platform-link use').setAttribute('href', '#i-' + platform.icon);
    enter($('.install-content'));
  });
}

const menu = $('.mobile-menu');
document.addEventListener('click', event => {
  if (menu.open && (!menu.contains(event.target) || event.target.closest('a'))) menu.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.open) {
    menu.open = false;
    $('summary', menu).focus();
  }
});

const head = $('.site-head');
const sections = $$('.wide-nav a').map(link => ({ link, section: $(link.hash) }));
function updateNavigation() {
  head.classList.toggle('scrolled', window.scrollY > 24);
  const position = window.scrollY + head.offsetHeight + 36;
  let active;
  for (const { link, section } of sections) {
    if (section.offsetTop <= position) active = link;
  }
  if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) active = sections.at(-1).link;
  for (const { link } of sections) {
    if (link === active) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
let frame = 0;
function requestNavigationUpdate() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; updateNavigation(); });
}
window.addEventListener('scroll', requestNavigationUpdate, { passive: true });
window.addEventListener('resize', requestNavigationUpdate);
updateNavigation();

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target === flow) playFlow();
      else entry.target.classList.add('revealed');
      observer.unobserve(entry.target);
    }
  }, { threshold: .24 });
  for (const el of $$('.section-heading, .sync-intro, .install-intro, .flow')) observer.observe(el);
}
