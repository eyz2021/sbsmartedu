// ==UserScript==
// @name         SmartEdu 教材 PDF 工具（链接 + Token + URL 拼接）
// @namespace    https://basic.smartedu.cn/
// @version      2.1.0
// @description  抓取教材 PDF 主体链接与 access_token，提供参数拼接 / viewer 包裹 / curl 三种输出
// @author       -
// @match        https://basic.smartedu.cn/tchMaterial*
// @match        https://basic.smartedu.cn/pdfjs/*
// @run-at       document-start
// @grant        none
// @noframes     false
// ==/UserScript==

/*
 * 三个能力，一个面板
 *
 * ── 1. PDF 主体链接 ────────────────────────────────────────────────
 *   页面结构（实测）：React 渲染 <iframe src="/pdfjs/2.15/web/viewer.html?hasCatalog=true&file=<PDF地址>">
 *   四条来源合并去重：iframe[src] 的 file 参数 / fetch hook / XHR hook / 资源时序
 *
 * ── 2. access_token ───────────────────────────────────────────────
 *   来源优先级：JSONP 响应体 "access_token"  >  x-nd-auth 里的 id  >  storage/cookie  >  上次缓存
 *   兼容纯 JSON、JSONP 包裹 nd_uc_sdk_xxx({...})、$body 嵌套（含二次转义）三种形态
 *
 *   ⚠ v2.1 关键修复：sso 的 token 接口是 <script> JSONP，不走 fetch/XHR
 *     （HAR 实证：sso.basic.smartedu.cn/v1.1/sso/tokens?...&callback=nd_uc_sdk_xxx
 *       _resourceType: script / Sec-Fetch-Dest: script）
 *     → 新增 script 标签 + callback 全局函数拦截；
 *     → 再加一层「重放」兜底：从 performance 里拿到这条 URL，去掉 callback 直接 fetch（带 cookie），
 *       拿到纯 JSON 解析；fetch 被 CORS 拒时退回注入 script 的 JSONP 方式。
 *
 * ── 3. URL 拼接 ───────────────────────────────────────────────────
 *   param  : <pdf>?accessToken=<token>            —— 原方案；实测服务端不校验此参数
 *   viewer : /pdfjs/.../viewer.html?file=<pdf>    —— 实测可用：站内 pdf.js 会自动加 x-nd-auth
 *   curl   : 带 x-nd-auth 头的下载命令             —— 实测可用：鉴权在请求头，不在 URL
 *
 * 默认不改写任何请求（autoRewrite = false）。需要自动拼接再手动打开。
 */

(function () {
  'use strict';

  /* ══════════════ 0. 作用域 ══════════════ */
  const PATH = location.pathname;
  const IS_VIEWER = PATH.indexOf('/pdfjs/') === 0;
  const IS_MATERIAL = PATH.indexOf('/tchMaterial') === 0;
  if (!IS_VIEWER && !IS_MATERIAL) return;

  const SITE = 'https://basic.smartedu.cn';
  const IS_TOP = (function () {
    try { return window.top === window; } catch (e) { return false; }
  })();

  /* ══════════════ 1. 配置 ══════════════ */
  const CONFIG = {
    paramName: 'accessToken',      // 参数拼接用的 key
    tokenField: 'access_token',    // 响应体里的字段名
    authName: 'x-nd-auth',         // 真实鉴权头
    viewerPath: '/pdfjs/2.15/web/viewer.html',
    viewerCatalog: 'hasCatalog=true',
    autoRewrite: false,            // 默认不改写请求
    inspectMax: 2 * 1024 * 1024,   // 超过此体积的响应不解析
    maxPdf: 8,                     // PDF 列表上限
    cacheKey: 'pdfToolkit.cache',
    ui: true
  };

  /* ══════════════ 2. 纯函数（可单测） ══════════════ */
  function toUrl(raw, base) {
    try { return new URL(String(raw), base || location.href); } catch (e) { return null; }
  }

  /** 路径以 .pdf 结尾（文件名是 percent-encoded 中文，仍以 .pdf 结尾） */
  function looksPdf(raw) {
    const u = toUrl(raw);
    return !!u && /\.pdf$/i.test(u.pathname);
  }

  /** 教材主体资源：/edu_product/esp/assets/<uuid>.pkg/<name>.pdf */
  function isAsset(raw) {
    const u = toUrl(raw);
    return !!u && /\/edu_product\/esp\/assets\//i.test(u.pathname) && /\.pdf$/i.test(u.pathname);
  }

  function shorten(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function mask(s) {
    if (!s) return '';
    return s.length <= 18 ? s : s.slice(0, 8) + '…' + s.slice(-6);
  }

  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = function (n) { return n < 10 ? '0' + n : String(n); };
    return (d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function decodeName(url) {
    try {
      const seg = new URL(url).pathname.split('/').pop() || '';
      return decodeURIComponent(seg) || 'file.pdf';
    } catch (e) { return 'file.pdf'; }
  }

  /** 从 Headers / 数组 / 普通对象里按名字取头 */
  function headerGet(h, name) {
    if (!h) return '';
    const lower = name.toLowerCase();
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get(name) || '';
    } catch (e) { /* ignore */ }
    if (Array.isArray(h)) {
      for (let i = 0; i < h.length; i += 1) {
        const p = h[i];
        if (p && String(p[0]).toLowerCase() === lower) return String(p[1]);
      }
      return '';
    }
    if (typeof h === 'object') {
      const ks = Object.keys(h);
      for (let i = 0; i < ks.length; i += 1) {
        if (ks[i].toLowerCase() === lower) return String(h[ks[i]]);
      }
    }
    return '';
  }

  /**
   * 从任意文本里取 access_token。
   * 兼容：纯 JSON / JSONP 包裹 nd_uc_sdk_xxx({...}) / $body 嵌套 / $body 是转义字符串
   */
  const TOKEN_KEY_RE = /access_?token/i;

  /** 时间戳/日期串 → 毫秒；解析不出来返回 0 */
  function toMs(v) {
    if (v === undefined || v === null || v === '') return 0;
    if (typeof v === 'number') return v > 1e12 ? v : (v > 1e9 ? v * 1000 : 0);
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return toMs(Number(s));
    const n = Date.parse(s);
    return n > 0 ? n : 0;
  }

  /** 在对象树里递归找 token（$body 是 JSON 字符串时二次 parse） */
  function deepFindToken(obj, depth) {
    if (!obj || depth > 4) return null;
    if (typeof obj === 'string') {
      const s = obj.trim();
      if (s.charAt(0) !== '{' && s.charAt(0) !== '[') return null;
      try { return deepFindToken(JSON.parse(s), depth + 1); } catch (e) { return null; }
    }
    if (typeof obj !== 'object') return null;

    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i += 1) {
      if (TOKEN_KEY_RE.test(keys[i])) {
        const v = obj[keys[i]];
        if (typeof v === 'string' && v.length >= 8) {
          const ex = obj.expires_at || obj.expiresAt || obj.expire_at || obj.expired_at;
          return { token: v, expiresAt: toMs(ex) };
        }
      }
    }
    for (let i = 0; i < keys.length; i += 1) {
      const v = obj[keys[i]];
      if (v && typeof v === 'object') {
        const hit = deepFindToken(v, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  function parseTokenFromText(text) {
    if (typeof text !== 'string' || !text) return null;
    if (!TOKEN_KEY_RE.test(text)) return null;

    let token = '';
    let expRaw = '';

    // ① 原样 JSON / JSONP：{"access_token":"xxx"}
    let m = /"access_?token"\s*:\s*"([^"]{8,})"/i.exec(text);
    if (m) {
      token = m[1];
      const e = /"expires?_?at"\s*:\s*"?([^",}]+)"?/i.exec(text);
      expRaw = e ? e[1] : '';
    }

    // ② 被转义的嵌套 JSON：\"access_token\":\"xxx\"（$body 是字符串时最常见）
    if (!token) {
      m = /\\"access_?token\\"\s*:\s*\\"([^"\\]{8,})\\"/i.exec(text);
      if (m) {
        token = m[1];
        const e = /\\"expires?_?at\\"\s*:\s*\\?"?([^",}\\]+)/i.exec(text);
        expRaw = e ? e[1] : '';
      }
    }

    // ③ 宽松兜底：key 不带引号，或 key/value 用了单引号
    if (!token) {
      m = /[\s{,]access_?token["']?\s*[:=]\s*["']([A-Za-z0-9._~+\/=%-]{8,})/i.exec(text);
      if (m) token = m[1];
    }

    if (token) {
      // token 里可能残留转义反斜杠
      token = token.replace(/\\+/g, '');
      return { token: token, expiresAt: toMs(expRaw) };
    }

    // ④ 结构兜底：能 parse 就递归找（处理任意包裹层级）
    try {
      const hit = deepFindToken(JSON.parse(text), 0);
      if (hit) return hit;
    } catch (e) { /* 不是合法 JSON，正常 */ }

    // ⑤ JSONP 包裹剥壳后再 parse 一次
    const p = /^[\s\w.$]*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/.exec(text);
    if (p && p[1]) {
      try {
        const hit = deepFindToken(JSON.parse(p[1]), 0);
        if (hit) return hit;
      } catch (e) { /* ignore */ }
    }

    return null;
  }

  /** 拆 x-nd-auth: MAC id="..",nonce="..",mac=".." */
  function parseAuth(h) {
    if (!h) return null;
    const id = /id="([^"]+)"/.exec(h);
    const nonce = /nonce="([^"]+)"/.exec(h);
    const mac = /mac="([^"]+)"/.exec(h);
    if (!id && !nonce && !mac) return null;
    return {
      id: id ? id[1] : '',
      nonce: nonce ? nonce[1] : '',
      mac: mac ? mac[1] : ''
    };
  }

  /** 参数拼接：<pdf>?accessToken=<token>（已有 query 用 &，幂等） */
  function buildParamUrl(raw, token) {
    const u = toUrl(raw);
    if (!u || !token) return '';
    if (!/\.pdf$/i.test(u.pathname)) return '';
    if (u.searchParams.get(CONFIG.paramName) === token) return u.toString();
    u.searchParams.set(CONFIG.paramName, token);
    return u.toString();
  }

  /** viewer 包裹：让站内 pdf.js 去请求它，pdf.js 会自己加 x-nd-auth */
  function buildViewerUrl(raw) {
    const u = toUrl(raw);
    if (!u) return '';
    return SITE + CONFIG.viewerPath + '?' + CONFIG.viewerCatalog + '&file=' + encodeURIComponent(u.href);
  }

  /** 带鉴权头的下载命令（单行，bash / PowerShell 均可） */
  function buildCurl(url, auth) {
    if (!url) return '';
    const parts = ['curl.exe -L --compressed'];
    parts.push('-o "' + decodeName(url) + '"');
    const a = String(auth || '').trim();
    if (a) parts.push("-H '" + CONFIG.authName + ': ' + a + "'");
    parts.push("-H 'Origin: " + SITE + "'");
    parts.push("-H 'Referer: " + SITE + "/'");
    parts.push("'" + url + "'");
    return parts.join(' ');
  }

  /** 带签名 / 走 API 的请求绝不改写 */
  function isProtected(raw) {
    const u = toUrl(raw);
    if (!u) return true;
    if (/(^|\.)api\./.test(u.hostname)) return true;
    if (/(^|\.)[a-z0-9-]+-api\./.test(u.hostname)) return true;
    if (u.pathname.indexOf('/api/') === 0) return true;
    const keys = ['sign', 'signature', 'mac', 'hmac', 'timestamp', 'nonce', 'appid', 'sdp-app-id'];
    for (let i = 0; i < keys.length; i += 1) {
      if (u.searchParams.has(keys[i])) return true;
    }
    return false;
  }

  /* ══════════════ 3. 状态 ══════════════ */
  const state = {
    token: '',
    expiresAt: 0,
    source: '',
    autoRewrite: CONFIG.autoRewrite
  };
  const pdfList = [];        // [{ key, url, via, auth, ctype, status, fromViewer, confirmed, hits, at }]
  let ui = null;
  let mode = 'param';        // param | viewer | curl
  let pendingRender = false;

  /* ══════════════ 4. 缓存 ══════════════ */
  function saveCache() {
    try {
      localStorage.setItem(CONFIG.cacheKey, JSON.stringify({
        token: state.token, expiresAt: state.expiresAt, at: Date.now()
      }));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CONFIG.cacheKey);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (!o || !o.token) return;
      if (o.expiresAt && Date.now() > o.expiresAt) return;
      state.token = o.token;
      state.expiresAt = o.expiresAt || 0;
      state.source = '缓存';
    } catch (e) { /* ignore */ }
  }

  /* ══════════════ 5. token ══════════════ */
  function isExpired() {
    return !!state.expiresAt && Date.now() > state.expiresAt;
  }

  function setTokenLocal(value, expiresAt, source) {
    if (!value || value.length < 8) return;
    if (value === state.token) {
      if (expiresAt && !state.expiresAt) state.expiresAt = expiresAt;
      return;
    }
    state.token = value;
    state.expiresAt = expiresAt || state.expiresAt || 0;
    state.source = source || '';
    saveCache();
    scheduleRender();
  }

  /** 子 frame 抓到的 token 交给顶层面板；顶层面板再回传给其它 frame 用 */
  function setToken(value, expiresAt, source) {
    if (IS_TOP) { setTokenLocal(value, expiresAt, source); return; }
    try {
      if (window.top.__pdfToolkit && window.top.__pdfToolkit.setToken) {
        window.top.__pdfToolkit.setToken(value, expiresAt, source);
        return;
      }
    } catch (e) { /* ignore */ }
    setTokenLocal(value, expiresAt, source);
  }

  /** 任意 frame 都能读到的当前 token */
  function currentToken() {
    if (IS_TOP) return state.token;
    try {
      if (window.top.__pdfToolkit && window.top.__pdfToolkit.getToken) {
        return window.top.__pdfToolkit.getToken() || state.token;
      }
    } catch (e) { /* ignore */ }
    return state.token;
  }

  /* ══════════════ 6. PDF 登记 ══════════════ */
  function keyOf(url) {
    const u = toUrl(url);
    return u ? u.origin + u.pathname : String(url);
  }

  function registerPdfLocal(entry) {
    if (!entry || !entry.url) return;
    const k = keyOf(entry.url);

    let it = null;
    for (let i = 0; i < pdfList.length; i += 1) {
      if (pdfList[i].key === k) { it = pdfList[i]; break; }
    }

    if (!it) {
      it = {
        key: k, url: entry.url, via: entry.via || '',
        auth: '', ctype: '', status: 0,
        fromViewer: false, confirmed: false, hits: 0, at: Date.now()
      };
      pdfList.unshift(it);
      if (pdfList.length > CONFIG.maxPdf) pdfList.pop();
    }

    it.hits += 1;
    it.at = Date.now();
    if (entry.auth) it.auth = entry.auth;
    if (entry.status) it.status = entry.status;
    if (entry.ctype) {
      it.ctype = entry.ctype;
      if (/application\/pdf/i.test(entry.ctype)) it.confirmed = true;
    }
    if (entry.via === 'viewer') it.fromViewer = true;

    // 抓到的 x-nd-auth 里的 id 就是当前生效的 accessToken，比响应体里的更权威
    if (entry.auth) {
      const a = parseAuth(entry.auth);
      if (a && a.id) setToken(a.id, 0, 'x-nd-auth');
    }

    if (isAsset(it.url)) {
      const idx = pdfList.indexOf(it);
      if (idx > 0) { pdfList.splice(idx, 1); pdfList.unshift(it); }
    }

    scheduleRender();
  }

  function reportPdf(entry) {
    if (IS_TOP) { registerPdfLocal(entry); return; }
    try {
      if (window.top.__pdfToolkit && window.top.__pdfToolkit.addPdf) {
        window.top.__pdfToolkit.addPdf(entry);
        return;
      }
    } catch (e) { /* ignore */ }
    registerPdfLocal(entry);
  }

  if (IS_TOP) {
    try {
      window.__pdfToolkit = {
        setToken: setTokenLocal,
        addPdf: registerPdfLocal,
        getToken: function () { return state.token; },
        getAuto: function () { return state.autoRewrite; },
        replay: function () { replayToken(false); },   // 控制台手动重抓
        debug: function () {
          return { token: state.token, source: state.source, armed: Object.keys(armed), urls: findTokenUrls() };
        }
      };
    } catch (e) { /* ignore */ }
  }

  /* ══════════════ 7. 响应体扫描（token 主来源） ══════════════ */
  const SKIP_CT = /pdf|octet-stream|image\/|video\/|audio\/|font/;

  function inspectText(text, url, via) {
    const hit = parseTokenFromText(text);
    if (!hit) return false;
    const host = (toUrl(url) || {}).hostname || '';
    setToken(hit.token, hit.expiresAt, via + (host ? ' · ' + host : ''));
    return true;
  }

  /* ══════════════ 8. fetch ══════════════ */
  function hookFetch() {
    const raw = window.fetch;
    if (typeof raw !== 'function' || raw.__pdfToolkit) return;

    const wrapped = function (input, init) {
      let url = '';
      let auth = '';

      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          url = input.url;
          auth = headerGet(input.headers, CONFIG.authName);
        } else {
          url = String(input);
        }
        if (!auth && init && init.headers) auth = headerGet(init.headers, CONFIG.authName);
      } catch (e) { /* ignore */ }

      const isPdfReq = !!url && looksPdf(url);
      const wantInspect = !!url && !isPdfReq;

      // 自动拼接（默认关）：命中且非保护请求才换 URL
      let args = arguments;
      try {
        const next = isPdfReq ? rewrite(url) : url;
        if (next && next !== url) {
          if (typeof Request !== 'undefined' && input instanceof Request) {
            args = [new Request(next, input)].concat(Array.prototype.slice.call(arguments, 1));
          } else {
            args = [next].concat(Array.prototype.slice.call(arguments, 1));
          }
        }
      } catch (e) { args = arguments; }

      const p = raw.apply(this, args);

      try {
        if (isPdfReq) {
          reportPdf({ url: url, via: 'fetch', auth: auth });
        }
        if (isPdfReq || wantInspect) {
          p.then(function (res) {
            try {
              const ct = (res.headers.get('content-type') || '').toLowerCase();
              if (isPdfReq) {
                reportPdf({ url: url, via: 'fetch', auth: auth, ctype: ct, status: res.status });
                return;
              }
              if (SKIP_CT.test(ct)) return;
              if (ct && !/(json|text|javascript|html)/.test(ct)) return;
              const len = Number(res.headers.get('content-length') || 0);
              if (len && len > CONFIG.inspectMax) return;
              res.clone().text().then(function (t) { inspectText(t, url, 'fetch'); }).catch(function () {});
            } catch (e) { /* ignore */ }
          }).catch(function () { /* ignore */ });
        }
      } catch (e) { /* ignore */ }

      return p;
    };

    wrapped.__pdfToolkit = true;
    window.fetch = wrapped;
  }

  /* ══════════════ 9. XMLHttpRequest ══════════════ */
  function hookXhr() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.open.__pdfToolkit) return;

    const rawOpen = proto.open;
    const rawSet = proto.setRequestHeader;
    const rawSend = proto.send;

    proto.open = function (method, url) {
      let finalUrl = url;
      try {
        this.__tkUrl = String(url);
        this.__tkAuth = '';
        const next = looksPdf(url) ? rewrite(String(url)) : null;
        if (next) finalUrl = next;
      } catch (e) { finalUrl = url; }
      const rest = Array.prototype.slice.call(arguments, 2);
      return rawOpen.apply(this, [method, finalUrl].concat(rest));
    };
    proto.open.__pdfToolkit = true;

    proto.setRequestHeader = function (k, v) {
      try {
        if (String(k).toLowerCase() === CONFIG.authName) this.__tkAuth = String(v);
      } catch (e) { /* ignore */ }
      return rawSet.apply(this, arguments);
    };

    proto.send = function () {
      try {
        const self = this;
        const url = self.__tkUrl;
        if (!url) return rawSend.apply(this, arguments);

        const isPdfReq = looksPdf(url);
        self.addEventListener('loadend', function () {
          try {
            const ct = (self.getResponseHeader('content-type') || '').toLowerCase();
            if (isPdfReq) {
              reportPdf({
                url: url, via: 'xhr', auth: self.__tkAuth || '',
                ctype: ct, status: self.status
              });
              return;
            }
            if (SKIP_CT.test(ct)) return;
            if (self.responseType && self.responseType !== 'text' && self.responseType !== 'json') return;
            const text = self.responseType === 'json'
              ? JSON.stringify(self.response)
              : (self.responseText || '');
            if (text && text.length <= CONFIG.inspectMax) inspectText(text, url, 'xhr');
          } catch (e) { /* ignore */ }
        }, { once: true });
      } catch (e) { /* ignore */ }
      return rawSend.apply(this, arguments);
    };
  }

  /* ══════════════ 10. JSONP（<script>）拦截 —— token 的真正来源 ══════════════ */
  /*
   * HAR 实证：uc-sdk 用 <script src="https://sso.basic.smartedu.cn/v1.1/sso/tokens?...
   *   &callback=nd_uc_sdk_17947124403900"> 拉 token，_resourceType=script，
   * 既不进 fetch 也不进 XHR —— 所以 v2.0 只挂 fetch/XHR 时永远抓不到。
   * 这里从两处下手：script 的 src（拿到 callback 名）+ 全局 callback 函数（拿 payload）。
   */
  const CB_PARAM_RE = /[?&](callback|cb|jsonp|jsonpcallback|_callback)=([A-Za-z_$][\w$]*)/i;
  const JSONP_NAME_RE = /^(nd_uc_sdk_|nd_.*_sdk_|jsonp_|__jsonp|_?callback_|cb_)/i;

  const armed = Object.create(null);      // callback 名 → 已接管
  const cbOrigin = Object.create(null);   // callback 名 → 该 JSONP 的 URL

  /** 回调入参里找 token：可能是对象，也可能是 JSON 文本 */
  function consumeJsonp(args, url) {
    const where = url || 'jsonp';
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i];
      try {
        if (typeof a === 'string') {
          if (inspectText(a, where, 'JSONP')) return true;
        } else if (a && typeof a === 'object') {
          if (inspectText(JSON.stringify(a), where, 'JSONP')) return true;
        }
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  /** 把 fn 包一层：调用前先读 payload，调用后原样把返回值透传 */
  function wrapFn(name, fn) {
    const wrapped = function () {
      try { consumeJsonp(arguments, cbOrigin[name] || ''); } catch (e) { /* ignore */ }
      return typeof fn === 'function' ? fn.apply(this, arguments) : undefined;
    };
    wrapped.__tkWrap = true;
    return wrapped;
  }

  /**
   * 接管一个全局 callback 名。
   * 两种 SDK 写法都要覆盖：
   *   a) 先 window[cb] = handler，再插 script  → 赋值时已被我们包住
   *   b) 先插 script，再 window[cb] = handler  → defineProperty 先把已有函数包住
   */
  function armCallback(name, url) {
    if (!name) return;
    if (url && !cbOrigin[name]) cbOrigin[name] = url;
    if (armed[name]) return;

    // 关键：SDK 若已经赋过值，defineProperty 会让它凭空消失，所以先取出来包住
    let exist = null;
    try { exist = window[name]; } catch (e) { exist = null; }
    if (typeof exist === 'function' && exist.__tkWrap) { armed[name] = true; return; }

    armed[name] = true;
    // 默认给一个「只读不转调」的占位：万一 JSONP 在 SDK 赋值前就被调用（缓存命中、
    // 或 document.write 同步执行），至少 token 还能拿到，也不会因为 null 而抛错
    let store = wrapFn(name, typeof exist === 'function' ? exist : null);

    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: false,
        get: function () { return store; },
        set: function (fn) {
          if (typeof fn !== 'function') { store = fn; return; }
          if (fn.__tkWrap) { store = fn; return; }
          store = wrapFn(name, fn);
        }
      });
    } catch (e) {
      // 属性不可配置：退回原地替换
      delete armed[name];
      if (typeof exist === 'function') {
        try {
          window[name] = wrapFn(name, exist);
          armed[name] = true;
        } catch (e2) { /* ignore */ }
      }
    }
  }

  /** 包装一个已经存在的全局函数（armCallback 失效时的退路） */
  function wrapGlobalFn(name) {
    let cur;
    try { cur = window[name]; } catch (e) { return false; }
    if (typeof cur !== 'function' || cur.__tkWrap || armed[name]) return false;
    try {
      window[name] = wrapFn(name, cur);
      armed[name] = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function armByUrl(url) {
    const s = String(url || '');
    if (!s) return;
    const m = CB_PARAM_RE.exec(s);
    if (m) armCallback(m[2], s);
  }

  /**
   * 在原型上挂 src —— 比覆盖元素实例干净得多：
   * 只多一次 armByUrl 调用，attribute 反射、加载行为全部保持原样。
   */
  function hookScriptCreate() {
    // ① script.src = url
    try {
      const proto = window.HTMLScriptElement && HTMLScriptElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, 'src');
      if (desc && typeof desc.set === 'function' && desc.configurable) {
        const setter = function (v) {
          try { armByUrl(v); } catch (e) { /* ignore */ }
          return desc.set.call(this, v);
        };
        setter.__tkPatched = true;
        Object.defineProperty(proto, 'src', {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set: setter
        });
      }
    } catch (e) { /* ignore */ }

    // ② script.setAttribute('src', url) —— 很多 JSONP 库走这条
    try {
      const proto = window.Element && Element.prototype;
      const rawSA = proto && proto.setAttribute;
      if (typeof rawSA === 'function' && !rawSA.__tkSetAttr) {
        const patched = function (n, v) {
          try {
            if (this && this.tagName === 'SCRIPT' && String(n).toLowerCase() === 'src') armByUrl(v);
          } catch (e) { /* ignore */ }
          return rawSA.call(this, n, v);
        };
        patched.__tkSetAttr = true;
        proto.setAttribute = patched;
      }
    } catch (e) { /* ignore */ }
  }

  /** innerHTML / document.write 注入的 script：插入时补一次 arm（arm 幂等） */
  function watchScriptTags() {
    const scan = function (root) {
      let list = [];
      try { list = (root || document).querySelectorAll('script[src]'); } catch (e) { return; }
      for (let i = 0; i < list.length; i += 1) {
        try { armByUrl(list[i].src); } catch (e) { /* ignore */ }
      }
    };
    scan(document);
    try {
      const mo = new MutationObserver(function (records) {
        for (let i = 0; i < records.length; i += 1) {
          const nodes = records[i].addedNodes;
          for (let j = 0; j < nodes.length; j += 1) {
            const n = nodes[j];
            if (n.nodeType !== 1) continue;
            try {
              if (n.tagName === 'SCRIPT') armByUrl(n.src);
              else if (n.querySelector) scan(n);
            } catch (e) { /* ignore */ }
          }
        }
      });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  /** 全局名字轮询：万一 SDK 绕过了上面两道（不因已有 token 提前退出，refresh 也要接住） */
  function pollJsonpGlobals(ms) {
    const deadline = Date.now() + (ms || 8000);
    const step = function () {
      if (Date.now() > deadline) return;
      let names = [];
      try { names = Object.getOwnPropertyNames(window); } catch (e) { return; }
      for (let i = 0; i < names.length; i += 1) {
        if (JSONP_NAME_RE.test(names[i])) wrapGlobalFn(names[i]);
      }
      setTimeout(step, 250);
    };
    step();
  }

  /* ══════════════ 11. 重放兜底：拿 performance 里的 token URL 再要一次 ══════════════ */
  /*
   * 即使拦截全失效，页面自己一定发过那条 JSONP —— URL 完整躺在 performance 里。
   * 去掉 callback 参数用 fetch 重放（HAR 显示该响应带 ACAO: basic.smartedu.cn +
   * Allow-Credentials: true，跨子域可读），fetch 不行再退回注入 <script>。
   */
  const TOKEN_URL_RE = /\/sso\/tokens?(\?|$)|\/v1\.\d+\/sso\/tokens/i;
  let replaying = false;

  function findTokenUrls() {
    const out = [];
    try {
      const list = performance.getEntriesByType('resource') || [];
      for (let i = 0; i < list.length; i += 1) {
        const n = (list[i] && list[i].name) || '';
        if (!n || !CB_PARAM_RE.test(n)) continue;
        if (TOKEN_URL_RE.test(n) || /\/sso\//i.test(n)) out.push(n);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function replayToken(silent) {
    if (replaying) return;
    if (state.token && !isExpired() && !silent) { flash('已有可用 token'); return; }

    const all = findTokenUrls();
    const base = all.length ? all[all.length - 1] : '';
    if (!base) { if (!silent) flash('没找到 token 请求，先打开一本教材', true); return; }

    const m = CB_PARAM_RE.exec(base);
    const paramName = m ? m[1] : 'callback';

    let probe;
    try { probe = new URL(base); } catch (e) { return; }
    probe.searchParams.delete(paramName);     // 去掉 callback → 期望纯 JSON

    replaying = true;
    const done = function (ok) {
      replaying = false;
      if (!ok && !silent) flash('重放没拿到 token，试试刷新页面', true);
    };

    let p;
    try {
      p = fetch(probe.href, { credentials: 'include', headers: { Accept: 'application/json' } });
    } catch (e) {
      jsonpReplay(base, paramName, done, silent);
      return;
    }

    p.then(function (r) { return r.text(); })
      .then(function (t) {
        if (inspectText(t, probe.href, '重放')) { done(true); flash('已重抓到 token'); return; }
        jsonpReplay(base, paramName, done, silent);
      })
      .catch(function () { jsonpReplay(base, paramName, done, silent); });
  }

  /** fetch 不通时的退路：注入 <script>，用自己的 callback 名接结果 */
  function jsonpReplay(base, paramName, done, silent) {
    let u;
    try { u = new URL(base); } catch (e) { done(false); return; }

    const name = '__tk_cb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    u.searchParams.set(paramName, name);
    armed[name] = true;      // 别让 armCallback 抢走我们自己的接收函数

    let settled = false;
    let s = null;
    const finish = function (ok) {
      if (settled) return;
      settled = true;
      try { delete window[name]; } catch (e) { /* ignore */ }
      try { if (s && s.parentNode) s.parentNode.removeChild(s); } catch (e) { /* ignore */ }
      done(ok);
      if (ok) flash('已重抓到 token');
    };

    window[name] = function (data) {
      let ok = false;
      try {
        if (typeof data === 'string') ok = inspectText(data, base, '重放');
        if (!ok) ok = inspectText(JSON.stringify(data), base, '重放');
      } catch (e) { /* ignore */ }
      finish(ok);
    };

    s = document.createElement('script');
    s.src = u.href;
    s.onerror = function () { finish(false); };
    (document.head || document.documentElement).appendChild(s);
    setTimeout(function () { if (!settled) finish(false); }, 8000);
  }

  /* ══════════════ 12. 自动拼接（默认关闭） ══════════════ */
  /** 开关在顶层，但 PDF 请求发生在 iframe 里，所以要跨 frame 读 */
  function autoOn() {
    if (IS_TOP) return state.autoRewrite;
    try {
      if (window.top.__pdfToolkit && window.top.__pdfToolkit.getAuto) {
        return !!window.top.__pdfToolkit.getAuto();
      }
    } catch (e) { /* ignore */ }
    return state.autoRewrite;
  }

  /** 改写出口：只在开关打开、有 token、非保护请求时生效 */
  function rewrite(raw) {
    if (!autoOn()) return raw;
    const token = currentToken();
    if (!token) return raw;
    if (isProtected(raw)) return raw;
    return buildParamUrl(raw, token) || raw;
  }

  /* ══════════════ 13. viewer 的 file 参数 & 顶层 iframe 扫描 ══════════════ */
  function scanViewerParam() {
    try {
      const file = new URL(location.href).searchParams.get('file');
      if (file) reportPdf({ url: file, via: 'viewer' });
    } catch (e) { /* ignore */ }
  }

  const VIEWER_SELECTOR = 'iframe[src*="viewer.html"], iframe[src*="pdfjs"]';

  function scanFrames(root) {
    let list = [];
    try { list = (root || document).querySelectorAll(VIEWER_SELECTOR); } catch (e) { return; }
    for (let i = 0; i < list.length; i += 1) {
      let file = '';
      try {
        const u = toUrl(list[i].getAttribute('src') || '');
        file = u ? (u.searchParams.get('file') || '') : '';
      } catch (e) { file = ''; }
      if (file) reportPdf({ url: file, via: 'viewer' });
    }
  }

  function watchFrames() {
    scanFrames(document);
    try {
      const mo = new MutationObserver(function (records) {
        for (let i = 0; i < records.length; i += 1) {
          const nodes = records[i].addedNodes;
          for (let j = 0; j < nodes.length; j += 1) {
            const n = nodes[j];
            if (n.nodeType !== 1) continue;
            if (n.matches && n.matches(VIEWER_SELECTOR)) scanFrames(n.parentNode || document);
            else if (n.querySelector) scanFrames(n);
          }
        }
      });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  /* ══════════════ 14. 资源时序兜底 ══════════════ */
  function watchPerf() {
    try {
      const perf = window.performance;
      if (!perf) return;
      const handle = function (entries) {
        for (let i = 0; i < entries.length; i += 1) {
          const name = entries[i] && entries[i].name;
          if (name && looksPdf(name)) reportPdf({ url: name, via: 'network' });
        }
      };
      if (typeof perf.getEntriesByType === 'function') {
        handle(perf.getEntriesByType('resource') || []);
      }
      if (typeof PerformanceObserver === 'function') {
        const po = new PerformanceObserver(function (l) { handle(l.getEntries()); });
        po.observe({ type: 'resource', buffered: true });
      }
    } catch (e) { /* ignore */ }
  }

  /* ══════════════ 15. storage / cookie 兜底找 token ══════════════ */
  function scanStorage() {
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k) || '';
        if (!TOKEN_KEY_RE.test(v)) continue;
        if (inspectText(v, k, 'localStorage')) return;
      }
    } catch (e) { /* ignore */ }
    try {
      if (document.cookie && TOKEN_KEY_RE.test(document.cookie)) {
        inspectText(document.cookie, 'cookie', 'cookie');
      }
    } catch (e) { /* ignore */ }
  }

  /* ══════════════ 16. 输出计算 ══════════════ */
  function findPdf(raw) {
    const k = keyOf(raw);
    for (let i = 0; i < pdfList.length; i += 1) {
      if (pdfList[i].key === k) return pdfList[i];
    }
    return null;
  }

  function computeOutput(raw) {
    const input = String(raw || '').trim();
    if (!input) return { text: '', ok: false, note: '等待地址' };

    const u = toUrl(input);
    if (!u) return { text: '', ok: false, note: '地址无法解析' };

    if (mode === 'viewer') {
      return {
        text: buildViewerUrl(input),
        ok: true,
        note: '站内 pdf.js 打开，会自动补 x-nd-auth'
      };
    }

    if (mode === 'curl') {
      const it = findPdf(input);
      const auth = it ? it.auth : '';
      return {
        text: buildCurl(input, auth),
        ok: !!auth,
        note: auth ? '带上抓到的鉴权头，可直接下载' : '还没抓到该地址的 x-nd-auth，可能被拒'
      };
    }

    // param
    if (!/\.pdf$/i.test(u.pathname)) return { text: '', ok: false, note: '不是 .pdf 结尾，无法拼接' };
    const token = currentToken();
    if (!token) return { text: '', ok: false, note: '还没有 accessToken' };
    return {
      text: buildParamUrl(input, token),
      ok: true,
      note: isProtected(input)
        ? '该地址带签名/走 API，服务端大概率不认此参数'
        : '实测服务端不校验 accessToken 参数，仅供对照'
    };
  }

  /* ══════════════ 17. 面板 ══════════════ */
  const CSS = `
  :host { all: initial; }
  .panel {
    position: fixed; right: 16px; bottom: 16px; width: 330px; z-index: 2147483000;
    font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    color: #1f2328; background: #ffffff; border: 1px solid #e3e6ea; border-radius: 10px;
    box-shadow: 0 8px 28px rgba(16, 24, 40, 0.16); overflow: hidden;
  }
  .head {
    display: flex; align-items: center; gap: 6px; padding: 8px 10px;
    background: #f7f8fa; border-bottom: 1px solid #eef0f3;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #12b76a; flex: 0 0 auto; }
  .dot.idle { background: #f79009; }
  .title { font-weight: 600; font-size: 12px; white-space: nowrap; }
  .ver { font-style: normal; font-size: 10px; font-weight: 400; color: #98a2b3; }
  .count {
    margin-left: auto; font-size: 10px; color: #667085; background: #eef0f3;
    padding: 1px 6px; border-radius: 8px;
  }
  .fold {
    border: 0; background: transparent; font-size: 14px; line-height: 1;
    color: #667085; cursor: pointer; padding: 0 2px;
  }
  .body { padding: 8px 10px 10px; }
  .panel.folded .body { display: none; }

  .kv {
    display: flex; align-items: baseline; gap: 6px;
    font-size: 11px; padding: 1px 0;
  }
  .kv > span:first-child { flex: 0 0 40px; color: #98a2b3; }
  .kv > span:last-child, .kv > code {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px;
    color: #1f2328; word-break: break-all;
  }
  .kv .muted { color: #667085; }
  .mini {
    flex: 0 0 auto; width: 20px; height: 17px; padding: 0; line-height: 15px;
    font: 11px/15px inherit; font-family: inherit; color: #667085;
    background: #f5f6f8; border: 1px solid #e4e7ec; border-radius: 4px; cursor: pointer;
  }
  .mini:hover { background: #eef1f5; color: #1a73e8; }
  .mini.busy { color: #b54708; }

  .sec { margin-top: 8px; border-top: 1px dashed #e6e9ed; padding-top: 7px; }
  .sec-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; }
  .sec-title { font-size: 11px; font-weight: 600; color: #344054; }
  .sec-hint { margin-left: auto; font-size: 9px; color: #b0b7c3; }

  .list { list-style: none; margin: 0; padding: 0; max-height: 88px; overflow: auto; }
  .row {
    display: flex; align-items: center; gap: 5px; padding: 3px 0;
    border-bottom: 1px solid #f4f5f7; border-radius: 4px;
  }
  .row:last-child { border-bottom: 0; }
  .row.active { background: #f0f6ff; }
  .tag { flex: 0 0 auto; font-size: 9px; padding: 0 4px; border-radius: 3px; line-height: 15px; }
  .tag.ok { color: #027a48; background: #e7f6ee; }
  .tag.viewer { color: #1a5fd0; background: #e8f1fe; }
  .tag.cand { color: #b54708; background: #fef3e6; }
  .tag.net { color: #475467; background: #f0f1f4; }
  .fname {
    flex: 1 1 auto; min-width: 0;
    font: 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; color: #344054;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
  }
  .empty { font-size: 10px; color: #b0b7c3; padding: 2px 0; }

  .input {
    display: block; width: 100%; box-sizing: border-box; margin-bottom: 5px;
    padding: 5px 6px; font: 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
    color: #1f2328; background: #ffffff; border: 1px solid #e4e7ec; border-radius: 6px;
  }
  .input:focus { outline: none; border-color: #1a73e8; }

  .tabs { display: flex; gap: 4px; margin-bottom: 5px; }
  .tabs button {
    flex: 1 1 0; min-width: 0; padding: 4px 0;
    font: 10px/1.4 inherit; font-family: inherit;
    color: #475467; background: #f5f6f8; border: 1px solid #e4e7ec;
    border-radius: 5px; cursor: pointer;
  }
  .tabs button.on { color: #ffffff; background: #1a73e8; border-color: #1a73e8; }

  .box {
    display: block; box-sizing: border-box; width: 100%; margin: 0; padding: 5px 6px;
    font: 10px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; color: #1f2328;
    background: #f8f9fb; border: 1px solid #e6e9ed; border-radius: 6px;
    max-height: 62px; overflow: auto; white-space: pre-wrap; word-break: break-all;
  }
  .box.bad { color: #b42318; background: #fef4f3; border-color: #fadbd6; }
  .note { font-size: 9px; color: #98a2b3; margin: 3px 0 6px; }

  .actions { display: flex; gap: 5px; }
  .actions + .actions { margin-top: 6px; }
  .actions button {
    flex: 1 1 0; min-width: 0; padding: 6px 0; font-size: 11px; font-family: inherit;
    color: #344054; background: #f5f6f8; border: 1px solid #e4e7ec;
    border-radius: 6px; cursor: pointer;
  }
  .actions button:hover { background: #eef1f5; }
  .actions button.pri { color: #ffffff; background: #1a73e8; border-color: #1a73e8; }
  .actions button.pri:hover { background: #1667cf; }
  .actions button.warn { color: #b54708; }
  `;

  function flash(msg, bad) {
    if (!ui) return;
    ui.note.textContent = msg;
    ui.note.style.color = bad ? '#b42318' : '#02748a';
    clearTimeout(flash.timer);
    flash.timer = setTimeout(function () {
      if (ui) { ui.note.style.color = ''; refreshOutput(); }
    }, 1800);
  }

  function copyText(text) {
    if (!text) return;
    const ok = function () { flash('已复制到剪贴板'); };
    const fallback = function () {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        ok();
      } catch (e) { /* ignore */ }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok).catch(fallback);
        return;
      }
    } catch (e) { /* ignore */ }
    fallback();
  }

  function tagOf(it) {
    if (it.confirmed) return { cls: 'ok', text: 'PDF' };
    if (it.fromViewer) return { cls: 'viewer', text: 'viewer' };
    if (it.via === 'network') return { cls: 'net', text: 'network' };
    return { cls: 'cand', text: '候选' };
  }

  function refreshOutput() {
    if (!ui) return;
    const res = computeOutput(ui.input.value);
    ui.box.textContent = res.text || '—';
    ui.box.classList.toggle('bad', !res.ok);
    ui.note.textContent = res.note;
    ui.note.style.color = '';
  }

  function render() {
    if (!ui) return;

    const token = currentToken();
    const usable = !!token && !isExpired();

    ui.token.textContent = token ? (mask(token) + (isExpired() ? '（已过期）' : '')) : '等待捕获…';
    ui.status.textContent = state.source
      ? (state.source + (state.expiresAt ? ' · ' + fmtDate(state.expiresAt) + ' 到期' : ''))
      : '未捕获';
    ui.status.classList.toggle('muted', !state.source);
    ui.dot.classList.toggle('idle', !usable);

    const n = Object.keys(armed).length;
    ui.jp.textContent = n ? (n + ' 个回调已接管') : '未接管（等 SDK 起请求）';
    ui.jp.classList.toggle('muted', !n);

    ui.count.textContent = String(pdfList.length);
    ui.autoBtn.textContent = '自动拼接：' + (state.autoRewrite ? '开' : '关');
    ui.autoBtn.classList.toggle('warn', state.autoRewrite);

    // 列表
    ui.list.textContent = '';
    if (!pdfList.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '暂无 .pdf 请求，点开一本教材后重试';
      ui.list.appendChild(empty);
    } else {
      for (let i = 0; i < pdfList.length; i += 1) {
        const it = pdfList[i];
        const li = document.createElement('li');
        li.className = 'row' + (ui.selected === it ? ' active' : '');

        const tag = document.createElement('span');
        const t = tagOf(it);
        tag.className = 'tag ' + t.cls;
        tag.textContent = t.text;

        const fn = document.createElement('span');
        fn.className = 'fname';
        fn.textContent = shorten(decodeName(it.url), 32);

        li.appendChild(tag);
        li.appendChild(fn);
        li.addEventListener('click', function () {
          ui.selected = it;
          ui.input.value = it.url;
          render();
        });
        ui.list.appendChild(li);
      }
    }

    // 没有手输也没选中时，自动带出第一条，省一次点击
    if (!ui.input.value && pdfList.length) {
      ui.selected = pdfList[0];
      ui.input.value = pdfList[0].url;
    }

    refreshOutput();
  }

  function scheduleRender() {
    if (!ui || pendingRender) return;
    pendingRender = true;
    setTimeout(function () { pendingRender = false; render(); }, 60);
  }

  function build() {
    if (!CONFIG.ui || !IS_TOP) return;
    if (document.getElementById('pdf-toolkit-host')) return;

    const host = document.createElement('div');
    host.id = 'pdf-toolkit-host';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = [
      '<div class="head">',
      '  <i class="dot idle"></i>',
      '  <span class="title">PDF 工具 <em class="ver">v2.1</em></span>',
      '  <span class="count">0</span>',
      '  <button class="fold" title="折叠">−</button>',
      '</div>',
      '<div class="body">',
      '  <div class="kv"><span>Token</span><code class="tk">等待捕获…</code><button class="mini" data-act="refetch" title="重新抓取 token">↻</button></div>',
      '  <div class="kv"><span>来源</span><span class="src muted">未捕获</span></div>',
      '  <div class="kv"><span>JSONP</span><span class="jp muted">0 个回调已接管</span></div>',
      '  <div class="sec">',
      '    <div class="sec-head"><span class="sec-title">网络中的 PDF</span><span class="sec-hint">点击选用</span></div>',
      '    <ul class="list"></ul>',
      '  </div>',
      '  <div class="sec">',
      '    <div class="sec-head"><span class="sec-title">URL 拼接</span><span class="sec-hint">三种输出</span></div>',
      '    <input class="input" type="text" spellcheck="false" placeholder="选中上方条目，或粘贴 .pdf 地址">',
      '    <div class="tabs">',
      '      <button data-mode="param" class="on">参数拼接</button>',
      '      <button data-mode="viewer">viewer 包裹</button>',
      '      <button data-mode="curl">curl</button>',
      '    </div>',
      '    <pre class="box">—</pre>',
      '    <div class="note">等待地址</div>',
      '    <div class="actions">',
      '      <button data-act="copy" class="pri">复制结果</button>',
      '      <button data-act="copy-token">复制 Token</button>',
      '    </div>',
      '  </div>',
      '  <div class="actions">',
      '    <button data-act="auto">自动拼接：关</button>',
      '    <button data-act="clear">清除缓存</button>',
      '  </div>',
      '</div>'
    ].join('');

    shadow.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);

    const q = function (s) { return shadow.querySelector(s); };
    ui = {
      panel: panel,
      list: q('.list'),
      dot: q('.dot'),
      count: q('.count'),
      fold: q('.fold'),
      token: q('.tk'),
      status: q('.src'),
      jp: q('.jp'),
      refetch: q('[data-act="refetch"]'),
      input: q('.input'),
      box: q('.box'),
      note: q('.note'),
      autoBtn: q('[data-act="auto"]'),
      selected: null
    };

    ui.fold.addEventListener('click', function () {
      panel.classList.toggle('folded');
      ui.fold.textContent = panel.classList.contains('folded') ? '+' : '−';
    });

    ui.input.addEventListener('input', refreshOutput);

    const tabs = shadow.querySelectorAll('.tabs button');
    for (let i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', function () {
        for (let j = 0; j < tabs.length; j += 1) tabs[j].classList.remove('on');
        this.classList.add('on');
        mode = this.getAttribute('data-mode');
        refreshOutput();
      });
    }

    q('[data-act="copy"]').addEventListener('click', function () {
      copyText(ui.box.textContent === '—' ? '' : ui.box.textContent);
    });

    q('[data-act="copy-token"]').addEventListener('click', function () {
      const t = currentToken();
      if (t) copyText(t); else flash('还没有 token', true);
    });

    ui.refetch.addEventListener('click', function () {
      if (replaying) { flash('正在抓取…'); return; }
      ui.refetch.classList.add('busy');
      replayToken(false);
      setTimeout(function () { if (ui) ui.refetch.classList.remove('busy'); }, 2500);
    });

    ui.autoBtn.addEventListener('click', function () {
      state.autoRewrite = !state.autoRewrite;
      render();
      flash(state.autoRewrite ? '已开启：会改写 PDF 请求 URL' : '已关闭：不改写任何请求', state.autoRewrite);
    });

    q('[data-act="clear"]').addEventListener('click', function () {
      try { localStorage.removeItem(CONFIG.cacheKey); } catch (e) { /* ignore */ }
      state.token = '';
      state.expiresAt = 0;
      state.source = '';
      pdfList.length = 0;
      ui.selected = null;
      ui.input.value = '';
      render();
      flash('已清除 token 与列表');
    });

    render();
  }

  /* ══════════════ 18. 启动 ══════════════ */
  loadCache();
  hookFetch();
  hookXhr();
  hookScriptCreate();     // 先装 script 拦截
  watchScriptTags();      // 再兜 DOM 里已有的
  pollJsonpGlobals(8000); // 最后是全局名字轮询（拿到 token 自动停）

  function ensureBody(fn) {
    if (document.body) { fn(); return; }
    try {
      const mo = new MutationObserver(function () {
        if (document.body) { mo.disconnect(); fn(); }
      });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) { /* ignore */ }
  }

  function boot() {
    if (IS_VIEWER) scanViewerParam();
    if (IS_TOP) {
      ensureBody(function () {
        build();
        if (IS_MATERIAL) watchFrames();
        render();
      });
    }
    watchPerf();
    scanStorage();

    // 站在材料页 6 秒还没 token：多半是 JSONP 没接住，自动重放一次（不发第二条新请求，
    // 只是把页面自己发过的那条 URL 再要一次，幂等查询）
    if (IS_MATERIAL && !currentToken()) {
      setTimeout(function () { if (!state.token || isExpired()) replayToken(true); }, 6000);
    }
  }

  if (document.documentElement) {
    boot();
  } else {
    const mo = new MutationObserver(function () {
      if (document.documentElement) { mo.disconnect(); boot(); }
    });
    mo.observe(document, { childList: true });
  }
})();
