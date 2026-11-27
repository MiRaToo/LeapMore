// Runs only in the isolated, first-party check-in page. Its own button handles verification and signing.
(function (identity, submit) {
  if (window !== window.top || location.origin !== 'https://apptec.leapmotor.com' ||
      location.pathname !== '/lpv/user-level/my-level.html') return 'waiting';
  if (!window.LMGetID1) window.LMGetID1 = () => identity;
  if (document.querySelector('.sign .sign-btn')) return 'signed';
  const button = document.querySelector('.sign .task-btn-sign');
  if (document.querySelector('.geetest_box, .geetest_panel, iframe[src*="geetest"]')?.getBoundingClientRect().height) return 'manual';
  if (!button?.getBoundingClientRect().height || button.textContent.trim() !== '签到' ||
      typeof window.SMSdk?.getDeviceId !== 'function') return 'waiting';
  if (!submit) return 'ready';
  button.click();
  return 'submitted';
})
