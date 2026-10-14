window.__ModuleLoader__.load({
  id: '@satanfire/dsh-wechat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PATH = '/api/dsh-wechat';
    const NS = 'dsh-wechat';
    const COPY = {
      en: {
        nav: 'WeChat', title: 'WeChat', status: 'Connection', connected: 'Connected',
        connecting: 'Connecting…',
        disconnected: 'Disconnected', enabled: 'Running', stopped: 'Stopped',
        session: 'Session', outbox: 'Unsent', uncertain: 'Delivery unclear',
        login: 'Scan to connect', start: 'Start', stop: 'Stop', logout: 'Log out',
        bound: 'Account bound. Select Start to connect.',
        confirmLogout: 'Log out and discard unsent or unprocessed WeChat messages?',
        loading: 'Loading status', working: 'Working', failed: 'Could not complete the request',
        unavailable: 'Could not reach the WeChat service', qr: 'WeChat login QR code',
        loginPending: 'Waiting for scan', loginExpired: 'QR code expired',
      },
      zh: {
        nav: '微信', title: '微信', status: '连接状态', connected: '已连接',
        connecting: '连接中…',
        disconnected: '未连接', enabled: '运行中', stopped: '已停止',
        session: '会话', outbox: '待发送', uncertain: '发送状态待确认',
        login: '扫码连接', start: '启动', stop: '停止', logout: '退出登录',
        bound: '已绑定微信账号，点击启动以连接。',
        confirmLogout: '退出登录并清空待处理、待发送的微信消息？',
        loading: '正在获取状态', working: '处理中', failed: '操作未完成',
        unavailable: '无法连接微信服务', qr: '微信登录二维码',
        loginPending: '等待扫码', loginExpired: '二维码已过期',
      },
    };
    const CSS = `
      .dsh-wechat-page { box-sizing:border-box; max-width:100%; min-width:0; padding:20px 24px;
        color:var(--dsw-alias-label-primary); font-size:13px; }
      .dsh-wechat-page * { box-sizing:border-box; }
      .dsh-wechat-page h2 { font-size:17px; line-height:24px; margin:0 0 20px; font-weight:600; }
      .dsh-wechat-row { display:flex; align-items:center; justify-content:space-between; gap:16px;
        padding:12px 0; border-bottom:1px solid var(--dsw-alias-border-l1); min-width:0; }
      .dsh-wechat-row span:last-child { min-width:0; overflow-wrap:anywhere; text-align:right; }
      .dsh-wechat-muted { color:var(--dsw-alias-label-secondary); }
      .dsh-wechat-connected { color:var(--dsw-alias-state-success-primary); }
      .dsh-wechat-actions { display:flex; flex-wrap:wrap; gap:8px; padding:20px 0; }
      .dsh-wechat-actions button { border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1);
        color:var(--dsw-alias-label-primary); border-radius:4px; min-height:32px; padding:6px 12px;
        cursor:pointer; font:inherit; }
      .dsh-wechat-actions button:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
      .dsh-wechat-actions button:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
      .dsh-wechat-actions button:disabled { opacity:.55; cursor:not-allowed; }
      .dsh-wechat-error { color:var(--dsw-alias-state-error-primary); padding:8px 0; }
      .dsh-wechat-qr { display:block; width:min(220px,100%); height:auto; margin:12px 0;
        border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
      @media (max-width:480px) { .dsh-wechat-page { padding:16px; } }
    `;

    function WeChatSettings({ locale }) {
      React.useSyncExternalStore((notify) => locale.subscribe(notify),
        () => locale.getLocale(), () => locale.getLocale());
      const t = locale.bind(NS);
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const active = React.useRef(null);
      const actionBusy = React.useRef(false);
      const actionEpoch = React.useRef(0);
      const refreshRef = React.useRef(() => {});

      React.useEffect(() => {
        const controller = new AbortController();
        active.current = controller;
        let inFlight = false;
        async function refresh() {
          if (inFlight || actionBusy.current) return;
          inFlight = true;
          const epoch = actionEpoch.current;
          try {
            const reply = await fetch(PATH, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
            if (!reply.ok) throw new Error('status');
            const next = await reply.json();
            if (!controller.signal.aborted && !actionBusy.current && epoch === actionEpoch.current) {
              setStatus(next);
              setError('');
            }
          } catch {
            if (!controller.signal.aborted && !actionBusy.current) setError(t('unavailable'));
          } finally { inFlight = false; }
        }
        refreshRef.current = refresh;
        refresh();
        const timer = setInterval(refresh, 1000);
        return () => { clearInterval(timer); controller.abort(); active.current = null; refreshRef.current = () => {}; };
      }, [locale]);

      async function act(name) {
        const controller = active.current;
        if (!controller || actionBusy.current) return;
        if (name === 'logout' && !window.confirm(t('confirmLogout'))) return;
        actionBusy.current = true;
        actionEpoch.current += 1;
        setBusy(name);
        setError('');
        try {
          const reply = await fetch(PATH, {
            method: 'POST', credentials: 'same-origin', cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: name }), signal: controller.signal,
          });
          if (!reply.ok) throw new Error('action');
          const next = await reply.json();
          if (!controller.signal.aborted) setStatus(next);
        } catch {
          if (!controller.signal.aborted) setError(t('failed'));
        } finally {
          actionBusy.current = false;
          if (!controller.signal.aborted) {
            setBusy('');
            refreshRef.current();
          }
        }
      }

      const row = (label, value, className) => h('div', { className: 'dsh-wechat-row', key: label },
        h('span', { className: 'dsh-wechat-muted' }, label), h('span', { className }, value));
      const button = (name, disabled) => h('button', {
        key: name, type: 'button', onClick: () => act(name), disabled: !!busy || disabled,
      }, busy === name ? t('working') : t(name));
      const qr = status?.login?.qrDataUrl;
      const safeQr = typeof qr === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(qr);
      const login = status?.login?.status;
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('section', { className: 'dsh-wechat-page', 'aria-label': t('title') },
          h('h2', null, t('title')),
          status ? h(React.Fragment, null,
            row(t('status'), status.connected ? t('connected') : status.enabled ? t('connecting') : t('disconnected'),
              status.connected ? 'dsh-wechat-connected' : ''),
            row(t('enabled'), status.enabled ? t('enabled') : t('stopped')),
            status.sessionId && row(t('session'), status.sessionId),
            row(t('outbox'), String(status.outboxDepth ?? 0)),
            row(t('uncertain'), String(status.uncertainCount ?? 0)))
            : h('p', { className: 'dsh-wechat-muted' }, t('loading')),
          h('div', { className: 'dsh-wechat-actions' },
            button('login', !status || !!status.bound),
            button('start', !status?.bound || !!status.enabled),
            button('stop', !status?.enabled && login !== 'waiting'),
            button('logout', !status?.bound)),
          status?.bound && !status.enabled && h('p', { className: 'dsh-wechat-muted' }, t('bound')),
          safeQr && h('img', { className: 'dsh-wechat-qr', src: qr, alt: t('qr') }),
          login === 'waiting' && h('p', { className: 'dsh-wechat-muted' }, t('loginPending')),
          login === 'expired' && h('p', { className: 'dsh-wechat-muted' }, t('loginExpired')),
          (error || status?.error) && h('p', { className: 'dsh-wechat-error', role: 'alert' },
            error || t('failed'))));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const offEn = ctx.locale.register(NS, 'en', COPY.en);
          const offZh = ctx.locale.register(NS, 'zh', COPY.zh);
          return () => { offZh(); offEn(); };
        });
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-wechat', order: 90,
          label: () => ctx.locale.bind(NS)('nav'),
        }, () => h(WeChatSettings, { locale: ctx.locale })));
      },
    };
  },
});
