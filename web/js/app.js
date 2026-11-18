/* ==========================================================================
 * AJBLE119 取暖桌智联 · 网页控制台（纯静态 / 零依赖 / 零构建）
 *
 * 依赖同目录模块（契约见 demo/CONTRACT.md）：
 *   ./protocol.js  协议纯函数库（CMD / buildFrame / parseState / toHex ...）
 *   ./ble.js       Web Bluetooth 传输层（BleClient）
 *   ./mock.js      模拟设备（MockBleClient，与 BleClient 同接口）
 *
 * 本文件只负责：DOM 绑定、状态渲染、日志/提示、Mock 与真实设备的选择。
 * ========================================================================== */

import * as protocol from './protocol.js';
import { BleClient } from './ble.js';
import { MockBleClient } from './mock.js';

const {
  CMD = {},
  buildFrame,
  buildVolume,
  buildTimer,
  buildCancelTimer,
  buildOrder,
  buildCancelOrder,
  bleRateLabel = (rate) => (rate === 1 ? '最低' : rate === 5 ? '中等' : '最高'),
  toHex = (bytes) =>
    Array.from(bytes || [], (b) => (b & 0xff).toString(16).padStart(2, '0'))
      .join(' ')
      .toUpperCase(),
} = protocol;

/* ----------------------------- 模式选择（契约 §8） ----------------------------- */

const useMock = new URLSearchParams(location.search).get('mock') === '1' || !BleClient.supported;
const client = useMock ? new MockBleClient() : new BleClient();

/* ------------------------------- 运行状态 ------------------------------- */

let state = null; // protocol.parseState 的结果；未连接/未收到状态时为 null
let connected = false;
let connecting = false;
let syncTimer = 0;
let toastTimer = 0;
let noticeTimer = 0;

// 自动化验收钩子（契约 §8）
window.__AJBLE119_DEMO__ = { client, protocol, getState: () => state, useMock };

/* ---------------------------- 契约 §8 必备 DOM id ---------------------------- */

const REQUIRED_IDS = [
  'conn-status',
  'btn-connect',
  'btn-disconnect',
  'btn-power',
  'power-state',
  'full-level',
  'btn-full-plus',
  'btn-full-minus',
  'btn-const-plus',
  'btn-const-minus',
  'const-value',
  'btn-foot',
  'foot-value',
  'timer-input',
  'btn-timer-set',
  'btn-timer-cancel',
  'timer-value',
  'order-day',
  'order-time',
  'order-temp',
  'btn-order-set',
  'btn-order-cancel',
  'order-value',
  'voice-select',
  'volume-input',
  'volume-value',
  'btn-volume-set',
  'btn-query',
  'auto-sync',
  'log',
  'btn-clear-log',
  'current-temp',
  'ble-rate-label',
  // 高级 / 兼容排查（真机排障用，见 CONTRACT.md §11）
  'adv-write-target',
  'adv-write-mode',
  'adv-repeat',
  'adv-gap',
  'adv-fanout',
  'raw-hex',
  'btn-raw-send',
  'chars-table',
];

const el = Object.create(null);
for (const id of REQUIRED_IDS) el[id] = document.getElementById(id);
// 概览条上与卡片同名的字段（用独立 id，避免 HTML 出现重复 id）
for (const id of ['ov-timer', 'ov-order']) el[id] = document.getElementById(id);

const toastNode = document.getElementById('toast');
const noticeNode = document.getElementById('notice');
const modeHintNode = document.getElementById('mode-hint');
const deviceNameNode = document.getElementById('device-name');
const zoneCards = Array.from(document.querySelectorAll('.zone-card'));
const rateRadios = Array.from(document.querySelectorAll('.rate-radio input[type="radio"]'));

/** 四区：data-zone → 状态字段 / 命令字 / 中文名 */
const ZONES = [
  { zone: 'leftBehind', key: 'leftBehind', cmd: CMD.LEFT_BEHIND, label: '左后' },
  { zone: 'leftFront', key: 'leftFront', cmd: CMD.LEFT_FRONT, label: '左前' },
  { zone: 'rightBehind', key: 'rightBehind', cmd: CMD.RIGHT_BEHIND, label: '右后' },
  { zone: 'rightFront', key: 'rightFront', cmd: CMD.RIGHT_FRONT, label: '右前' },
];
const ZONE_MAP = new Map(ZONES.map((z) => [z.zone, z]));
const zoneLevelNodes = new Map();
for (const card of zoneCards) {
  zoneLevelNodes.set(card.dataset.zone, card.querySelector('.zone-level'));
}

const ORDER_TEMPS = [40, 50, 60, 70, 80];

/* ------------------------------- 小工具 ------------------------------- */

function $(id) {
  return el[id] || null;
}

function pad2(value) {
  return String(Number(value) || 0).padStart(2, '0');
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function setValue(node, value) {
  if (node && node.value !== value) node.value = value;
}

function nowStamp() {
  const d = new Date();
  return (
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes()) +
    ':' +
    pad2(d.getSeconds()) +
    '.' +
    String(d.getMilliseconds()).padStart(3, '0')
  );
}

function formatHMS(hour, minute, second) {
  return pad2(hour) + ':' + pad2(minute) + ':' + pad2(second);
}

function formatHM(hour, minute) {
  return pad2(hour) + ':' + pad2(minute);
}

function rateToRadioValue(rate) {
  if (rate === 1) return '1';
  if (rate === 5) return '5';
  return '9';
}

function orderLabel(s) {
  if (!s || !s.orderDay) return '无预约';
  const day = s.orderDay === 2 ? '明天' : '今天';
  return day + ' ' + formatHM(s.orderHour, s.orderMinute) + ' · ' + String(s.orderTemp) + '℃';
}

/* ------------------------------- 提示条 / Toast ------------------------------- */

function showNotice(message, type = 'info') {
  if (!noticeNode) return;
  noticeNode.textContent = message;
  noticeNode.className = 'notice notice-' + type;
  noticeNode.hidden = false;
  clearTimeout(noticeTimer);
  if (type === 'info') {
    noticeTimer = setTimeout(() => {
      noticeNode.hidden = true;
    }, 8000);
  }
}

function hideNotice() {
  if (!noticeNode) return;
  clearTimeout(noticeTimer);
  noticeNode.hidden = true;
}

function toast(message, type = 'info') {
  if (!toastNode) return;
  toastNode.textContent = message;
  toastNode.className = 'toast toast-' + type + ' show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNode.classList.remove('show');
  }, 2600);
}

/* ------------------------------- 日志面板 ------------------------------- */

function pushLogLine(line) {
  const box = $('log');
  if (!box) return;
  box.appendChild(line);
  while (box.children.length > 200) box.removeChild(box.firstElementChild);
  box.scrollTop = box.scrollHeight;
}

function addLog(level, message) {
  const lv = String(level || 'info').toLowerCase();
  const cls = lv === 'warn' ? 'log-warn' : lv === 'error' ? 'log-error' : 'log-info';
  const line = document.createElement('div');
  line.className = 'log-line ' + cls;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = nowStamp();

  const dir = document.createElement('span');
  dir.className = 'log-dir';
  dir.textContent = lv === 'error' ? 'ERR' : lv === 'warn' ? 'WARN' : 'INFO';

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = String(message == null ? '' : message);

  line.append(time, dir, msg);
  pushLogLine(line);
}

// TX 去重：传输层若也发 tx 事件，避免同一条指令在日志里出现两次
let lastTxHex = '';
let lastTxAt = 0;

function addFrameLog(direction, detail) {
  const bytes = detail && detail.bytes;
  let hex = detail && typeof detail.hex === 'string' ? detail.hex : '';
  if (!hex && bytes) hex = toHex(bytes);
  hex = String(hex || '').trim();
  const length =
    bytes && typeof bytes.length === 'number'
      ? bytes.length
      : Math.floor(hex.replace(/\s+/g, '').length / 2);

  if (direction === 'TX') {
    const now = Date.now();
    if (hex && hex === lastTxHex && now - lastTxAt < 150) return;
    lastTxHex = hex;
    lastTxAt = now;
  }

  const line = document.createElement('div');
  line.className = 'log-line ' + (direction === 'TX' ? 'log-tx' : 'log-rx');

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = nowStamp();

  const dir = document.createElement('span');
  dir.className = 'log-dir';
  dir.textContent = direction;

  const len = document.createElement('span');
  len.className = 'log-len';
  len.textContent = String(length) + 'B';

  const hexNode = document.createElement('span');
  hexNode.className = 'log-hex';
  hexNode.textContent = hex || '(空)';

  line.append(time, dir, len, hexNode);
  pushLogLine(line);
}

/* ------------------------------- 状态渲染 ------------------------------- */

function renderState() {
  const s = state;

  // 概览
  setText($('power-state'), s ? (s.power ? '开' : '关') : '--');
  setText($('current-temp'), s ? String(s.currentTemp) : '--');
  setText($('full-level'), s ? String(s.heatingLevel) : '--');
  setText($('const-value'), s ? (s.constTemp > 0 ? String(s.constTemp) : '关') : '--');
  setText($('foot-value'), s ? String(s.footWarm) : '--');
  setText($('timer-value'), s ? formatHMS(s.timerHour, s.timerMinute, s.timerSecond) : '--');
  setText($('order-value'), s ? orderLabel(s) : '--');
  setText($('ov-timer'), s ? formatHMS(s.timerHour, s.timerMinute, s.timerSecond) : '--');
  setText($('ov-order'), s ? orderLabel(s) : '--');
  setText($('ble-rate-label'), s ? bleRateLabel(s.bleRate) : '--');
  setText($('volume-value'), s ? String(s.volume) : '--');

  // 四区档位
  for (const z of ZONES) {
    const node = zoneLevelNodes.get(z.zone);
    setText(node, s ? String(s[z.key]) : '--');
  }

  // 电源按钮
  const powerBtn = $('btn-power');
  if (powerBtn) {
    const on = !!(s && s.power);
    setText(powerBtn, on ? '关机' : '开机');
    powerBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  if (!s) {
    // 无状态：输入类控件回到“无回显”状态
    for (const radio of rateRadios) radio.checked = false;
    setValue($('voice-select'), '');
    return;
  }

  // 提示音
  const voice = [0, 1, 2].includes(s.voice) ? String(s.voice) : '1';
  setValue($('voice-select'), voice);

  // BLE 功率
  const rateValue = rateToRadioValue(s.bleRate);
  for (const radio of rateRadios) radio.checked = radio.value === rateValue;

  // 音量（拖动中不回写滑块，避免打断用户）
  const volumeInput = $('volume-input');
  if (volumeInput && document.activeElement !== volumeInput) {
    setValue(volumeInput, String(s.volume));
  }

  // 定时（仅回显 0–4:59 的合法时长）
  if (s.timerHour >= 0 && s.timerHour <= 4) {
    setValue($('timer-input'), formatHM(s.timerHour, s.timerMinute));
  }

  // 预约
  if (s.orderDay === 1 || s.orderDay === 2) {
    setValue($('order-day'), String(s.orderDay));
    setValue($('order-time'), formatHM(s.orderHour, s.orderMinute));
    if (ORDER_TEMPS.includes(s.orderTemp)) setValue($('order-temp'), String(s.orderTemp));
  }
}

/* --------------------------- 连接状态 / 控件启用 --------------------------- */

const CONTROL_IDS = [
  'btn-power',
  'btn-full-plus',
  'btn-full-minus',
  'btn-const-plus',
  'btn-const-minus',
  'btn-foot',
  'timer-input',
  'btn-timer-set',
  'btn-timer-cancel',
  'order-day',
  'order-time',
  'order-temp',
  'btn-order-set',
  'btn-order-cancel',
  'voice-select',
  'volume-input',
  'btn-volume-set',
  'btn-query',
];

function setControlsEnabled(enabled) {
  for (const id of CONTROL_IDS) {
    const node = $(id);
    if (node) node.disabled = !enabled;
  }
  for (const card of zoneCards) card.disabled = !enabled;
  for (const radio of rateRadios) radio.disabled = !enabled;

  const connectBtn = $('btn-connect');
  if (connectBtn) connectBtn.disabled = enabled || connecting;
  const disconnectBtn = $('btn-disconnect');
  if (disconnectBtn) disconnectBtn.disabled = !enabled;
}

function setStatus(text, kind) {
  const node = $('conn-status');
  if (!node) return;
  node.textContent = text;
  node.className =
    'badge ' + (kind === 'on' ? 'badge-on' : kind === 'connecting' ? 'badge-connecting' : 'badge-off');
}

/* ------------------------------- 发送封装 ------------------------------- */

async function send(bytes) {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return false;
  }
  try {
    await client.send(bytes);
    // 传输层通常已发 tx 事件；这里兜底补一条（addFrameLog 内部会去重）
    addFrameLog('TX', { bytes, hex: toHex(bytes) });
    scheduleAutoSync();
    return true;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    showNotice('发送失败：' + msg, 'error');
    addLog('error', '发送失败：' + msg);
    toast('发送失败', 'error');
    return false;
  }
}

function scheduleAutoSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const autoSync = $('auto-sync');
    if (!connected || !autoSync || !autoSync.checked) return;
    client.query().catch((err) => {
      addLog('warn', '自动查询失败：' + (err && err.message ? err.message : err));
    });
  }, 350);
}

async function queryNow(reason) {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  try {
    await client.query();
    // 兜底 TX 日志（传输层发过 tx 事件时会被去重）
    const queryBytes =
      typeof protocol.buildQuery === 'function'
        ? protocol.buildQuery()
        : null;
    addFrameLog('TX', {
      bytes: queryBytes,
      hex: queryBytes ? toHex(queryBytes) : protocol.QUERY_FRAME_HEX || 'A5 5B 00 00 00 00 00 00 FB',
    });
    if (reason) addLog('info', reason);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    showNotice('查询失败：' + msg, 'error');
    addLog('error', '查询失败：' + msg);
  }
}

function patchState(patch) {
  if (!state) return;
  state = Object.assign({}, state, patch);
  renderState();
}

/* ------------------------------- 连接 / 断开 ------------------------------- */

function handleConnected(name) {
  if (connected) return;
  connected = true;
  connecting = false;

  const label = name || client.deviceName || 'AJBLE119';
  if (deviceNameNode) deviceNameNode.textContent = label;
  setStatus('已连接 · ' + label, 'on');
  setControlsEnabled(true);

  if (modeHintNode && useMock) modeHintNode.hidden = false;
  showNotice(
    useMock
      ? '演示模式（模拟设备）已连接：所有操作只作用于本地模拟器，不会影响真实设备。'
      : '已连接 ' + label + '，正在同步设备状态…',
    'info'
  );
  toast('设备已连接', 'success');
  addLog('info', '已连接：' + label + (useMock ? '（模拟设备）' : ''));
  const mac = client && typeof client.deviceId !== 'undefined' ? client.deviceId : null;
  if (mac) addLog('info', '设备 BLE 地址（MAC）：' + mac);

  // 连接后列出设备特征清单，并用当前（可能来自上次会话）的传输层参数初始化
  refreshCharsTable();
  applyAdv(true);

  // 连接后主动同步一次状态（自动查询关闭时不发）
  const autoSync = $('auto-sync');
  if (autoSync && autoSync.checked) {
    setTimeout(() => {
      if (connected && autoSync.checked) queryNow(null);
    }, 600);
  }
}

function handleDisconnected(detail) {
  const wasConnected = connected;
  connected = false;
  connecting = false;
  clearTimeout(syncTimer);

  state = null;
  renderState();
  setControlsEnabled(false);

  if (deviceNameNode) deviceNameNode.textContent = '--';
  clearAdvancedPanel();

  const reason = detail && detail.reason;
  let statusText = '未连接';
  let message = '';

  if (reason === 'user') {
    statusText = '未连接';
    message = '已断开连接';
  } else if (reason === 'device') {
    statusText = '连接已断开';
    message = '下位机请求断开（收到 A5 5D 帧），请重新连接';
  } else if (reason === 'gatt') {
    statusText = '连接已断开';
    message = '蓝牙连接意外断开，请重新连接';
  } else if (reason === 'error') {
    statusText = '连接已断开';
    message = detail && detail.msg ? '连接错误：' + detail.msg : '连接发生错误';
  }

  setStatus(statusText, 'off');

  if (message && (wasConnected || reason)) {
    const level = reason === 'user' ? 'info' : 'warn';
    showNotice(message, level);
    toast(message, level === 'info' ? 'info' : 'warn');
    addLog(level, message);
  }
}

async function doConnect() {
  if (connected || connecting) return;
  connecting = true;
  setStatus('正在连接…', 'connecting');
  setControlsEnabled(false);
  const connectBtn = $('btn-connect');
  if (connectBtn) connectBtn.textContent = '连接中…';

  try {
    await client.connect();
    // 事件通常会先到；这里兜底一次，避免个别实现未派发 connect 事件
    if (client.connected && !connected) handleConnected(client.deviceName);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    showNotice('连接失败：' + msg, 'error');
    addLog('error', '连接失败：' + msg);
    toast('连接失败，请查看页面提示', 'error');
    setStatus('未连接', 'off');
  } finally {
    connecting = false;
    if (connectBtn) connectBtn.textContent = '连接设备';
    setControlsEnabled(connected);
  }
}

async function doDisconnect() {
  if (!connected && !connecting) return;
  const disconnectBtn = $('btn-disconnect');
  if (disconnectBtn) disconnectBtn.disabled = true;
  try {
    await client.disconnect();
    if (connected && !client.connected) handleDisconnected({ reason: 'user' });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    showNotice('断开失败：' + msg, 'error');
    addLog('error', '断开失败：' + msg);
    if (!client.connected) handleDisconnected({ reason: 'user' });
  } finally {
    setControlsEnabled(connected);
  }
}

/* ------------------------------- 各类指令 ------------------------------- */

function onPowerClick() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const isOn = !!(state && state.power);
  const p3 = isOn ? 1 : 0; // 0=开 1=关
  patchState({ power: isOn ? 0 : 1 });
  send(buildFrame(CMD.POWER, 0, 0, p3));
  toast(isOn ? '已发送关机指令' : '已发送开机指令');
}

function onFullPlus() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const base = state ? Number(state.heatingLevel) || 0 : 0;
  if (base >= 5) {
    toast('全控已是最高 5 档', 'warn');
    return;
  }
  const next = base + 1;
  patchState({ heatingLevel: next });
  send(buildFrame(CMD.FULL_LEVEL, 0, 0, next));
}

function onFullMinus() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const base = state ? Number(state.heatingLevel) || 0 : 0;
  if (base <= 0) {
    toast('全控已是最低 0 档', 'warn');
    return;
  }
  const next = base - 1;
  patchState({ heatingLevel: next });
  send(buildFrame(CMD.FULL_LEVEL, 0, 0, next));
}

function constBase() {
  if (!state) return 70;
  // 设备回报 0 表示恒温关闭；原小程序用 30 作为“关闭”时的内部基准
  return state.constTemp > 0 ? state.constTemp : 30;
}

function onConstPlus() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const base = constBase();
  if (base >= 80) {
    toast('恒温已是最高 80 ℃', 'warn');
    return;
  }
  const next = base + 10;
  patchState({ constTemp: next });
  send(buildFrame(CMD.CONST_TEMP, 0, 0, next));
}

function onConstMinus() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const base = constBase();
  let next;
  if (base > 40) next = base - 10;
  else if (base === 30) next = 40; // 关闭态按原小程序逻辑回到 40 ℃
  else {
    toast('恒温已是最低 40 ℃', 'warn');
    return;
  }
  patchState({ constTemp: next });
  send(buildFrame(CMD.CONST_TEMP, 0, 0, next));
}

function onFootClick() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const base = state ? Number(state.footWarm) || 0 : 0;
  const next = (base + 1) % 3; // 0 → 1 → 2 → 0
  patchState({ footWarm: next });
  send(buildFrame(CMD.FOOT_WARM, 0, 0, next));
}

function onZoneClick(event) {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const card = event.currentTarget;
  const cfg = ZONE_MAP.get(card && card.dataset ? card.dataset.zone : '');
  if (!cfg) return;

  const base = state ? Number(state[cfg.key]) || 0 : 0;
  const next = (base + 1) % 6; // 0 → 1 → … → 5 → 0
  const powerOff = !!(state && !state.power);

  patchState({ [cfg.key]: next });
  send(buildFrame(cfg.cmd, 0, 0, next));

  if (powerOff) toast('提示：设备当前未开机，指令可能不生效', 'warn');
}

function onTimerSet() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const input = $('timer-input');
  const raw = input ? input.value : '';
  const match = /^(\d{2}):(\d{2})$/.exec(raw);
  if (!match) {
    toast('请选择定时时长（00:00–04:59）', 'warn');
    return;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 4 || minute > 59) {
    toast('定时范围仅支持 00:00–04:59', 'warn');
    if (input) input.focus();
    return;
  }
  patchState({ timerHour: hour, timerMinute: minute, timerSecond: 0 });
  send(buildTimer(hour, minute));
  toast('已发送定时 ' + formatHM(hour, minute));
}

function onTimerCancel() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  patchState({ timerHour: 0, timerMinute: 0, timerSecond: 0 });
  send(buildCancelTimer());
  toast('已发送取消定时');
}

function onOrderSet() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const dayNode = $('order-day');
  const timeNode = $('order-time');
  const tempNode = $('order-temp');
  const day = Number(dayNode ? dayNode.value : 1) === 2 ? 2 : 1;
  const raw = timeNode ? timeNode.value : '';
  const match = /^(\d{2}):(\d{2})$/.exec(raw);
  if (!match) {
    toast('请选择预约时间', 'warn');
    return;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const temperature = Number(tempNode ? tempNode.value : 60);

  if (day === 1) {
    const now = new Date();
    if (hour < now.getHours() || (hour === now.getHours() && minute <= now.getMinutes())) {
      // 原小程序在二级页拦截“预约时间已过”；本页不阻断发送，只做提示
      toast('提示：今天该时间已过，设备可能不会执行', 'warn');
    }
  }

  patchState({ orderDay: day, orderHour: hour, orderMinute: minute, orderTemp: temperature });
  send(buildOrder({ day, hour, minute, temperature }));
  toast('已发送预约：' + (day === 2 ? '明天' : '今天') + ' ' + formatHM(hour, minute));
}

function onOrderCancel() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  patchState({ orderDay: 0, orderHour: 0, orderMinute: 0, orderTemp: 0 });
  send(buildCancelOrder());
  toast('已发送取消预约');
}

function onVoiceChange() {
  if (!connected) return;
  const node = $('voice-select');
  const value = node ? Number(node.value) : NaN;
  if (![0, 1, 2].includes(value)) return;
  patchState({ voice: value });
  send(buildFrame(CMD.VOICE, 0, 0, value));
  toast('提示音：' + ['静音', '滴滴', '语音'][value]);
}

function onVolumeInput() {
  const node = $('volume-input');
  if (!node) return;
  setText($('volume-value'), String(node.value));
}

function onVolumeSet() {
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  const node = $('volume-input');
  const raw = node ? Number(node.value) : NaN;
  const volume = Math.max(0, Math.min(100, Math.round(Number.isFinite(raw) ? raw : 0)));
  patchState({ volume });
  send(buildVolume(volume));
  toast('已发送音量 ' + volume);
}

function onRateChange(event) {
  if (!connected) return;
  const value = Number(event.target && event.target.value);
  if (![1, 5, 9].includes(value)) return;
  patchState({ bleRate: value });
  send(buildFrame(CMD.BLE_RATE, 0, 0, value));
  toast('BLE 发射功率：' + bleRateLabel(value));
}

function onClearLog() {
  const box = $('log');
  if (box) box.textContent = '';
  lastTxHex = '';
  lastTxAt = 0;
  addLog('info', '日志已清空');
}

/* ------------------------------- 事件绑定 ------------------------------- */

function bind(id, type, handler) {
  const node = $(id);
  if (!node) return;
  node.addEventListener(type, handler);
}

function wireClientEvents() {
  client.addEventListener('connect', (event) => {
    const detail = event && event.detail;
    handleConnected(detail && detail.name);
  });

  client.addEventListener('disconnect', (event) => {
    handleDisconnected(event && event.detail);
  });

  client.addEventListener('state', (event) => {
    if (!event || !event.detail) return;
    state = event.detail;
    renderState();
  });

  client.addEventListener('log', (event) => {
    const detail = (event && event.detail) || {};
    addLog(detail.level || 'info', detail.msg || '');
  });

  client.addEventListener('tx', (event) => addFrameLog('TX', event && event.detail));
  client.addEventListener('rx', (event) => addFrameLog('RX', event && event.detail));
}

function wireControls() {
  bind('btn-connect', 'click', doConnect);
  bind('btn-disconnect', 'click', doDisconnect);

  bind('btn-power', 'click', onPowerClick);
  bind('btn-full-plus', 'click', onFullPlus);
  bind('btn-full-minus', 'click', onFullMinus);
  bind('btn-const-plus', 'click', onConstPlus);
  bind('btn-const-minus', 'click', onConstMinus);
  bind('btn-foot', 'click', onFootClick);

  bind('btn-timer-set', 'click', onTimerSet);
  bind('btn-timer-cancel', 'click', onTimerCancel);
  bind('btn-order-set', 'click', onOrderSet);
  bind('btn-order-cancel', 'click', onOrderCancel);
  bind('btn-volume-set', 'click', onVolumeSet);
  bind('btn-query', 'click', () => queryNow(null));
  bind('btn-clear-log', 'click', onClearLog);

  // 高级 / 兼容排查：参数变更即时下发到传输层并持久化
  bind('btn-raw-send', 'click', () => {
    onRawSend();
  });
  for (const id of ['adv-write-target', 'adv-write-mode', 'adv-repeat', 'adv-gap', 'adv-fanout']) {
    bind(id, 'change', () => applyAdv(false));
  }

  bind('voice-select', 'change', onVoiceChange);
  bind('volume-input', 'input', onVolumeInput);

  for (const card of zoneCards) card.addEventListener('click', onZoneClick);
  for (const radio of rateRadios) radio.addEventListener('change', onRateChange);

  if (noticeNode) noticeNode.addEventListener('click', hideNotice);
}

/* --------------------- 高级 / 兼容排查（真机排障，契约 §11） --------------------- */

const ADV_STORAGE_KEY = 'ajble119.adv.v1';
let pendingWriteTarget = 'auto'; // 连接前 select 里还没有特征选项，先记住待恢复的值

function describeTarget(target) {
  if (target === 'auto' || target == null) return '自动';
  if (typeof target === 'number') return '#' + target;
  return String(target);
}

/** 把写入目标规范成 'auto' / 数字索引 / UUID 字符串。 */
function normalizeWriteTarget(raw) {
  if (raw === 'auto' || raw === '' || raw == null) return 'auto';
  if (typeof raw === 'number') return raw;
  return /^\d+$/.test(String(raw)) ? Number(raw) : String(raw);
}

/** 当前写入目标：连接前 select 里只有 auto，此时用记住的待恢复值，避免把用户选择冲掉。 */
function currentWriteTarget() {
  const select = $('adv-write-target');
  if (!select || select.options.length <= 1) return normalizeWriteTarget(pendingWriteTarget);
  return normalizeWriteTarget(select.value);
}

function readAdvUi() {
  const writeTarget = currentWriteTarget();
  const writeMode = $('adv-write-mode') ? $('adv-write-mode').value || 'auto' : 'auto';
  const repeatRaw = Number($('adv-repeat') ? $('adv-repeat').value : 1);
  const gapRaw = Number($('adv-gap') ? $('adv-gap').value : 80);
  return {
    writeTarget,
    writeMode,
    repeat: Math.min(10, Math.max(1, Number.isFinite(repeatRaw) ? repeatRaw : 1)),
    gapMs: Math.min(1000, Math.max(0, Number.isFinite(gapRaw) ? gapRaw : 80)),
    fanout: Boolean($('adv-fanout') && $('adv-fanout').checked),
  };
}

function applyAdv(silent) {
  const options = readAdvUi();
  if (client && typeof client.setOptions === 'function') client.setOptions(options);
  try {
    localStorage.setItem(ADV_STORAGE_KEY, JSON.stringify(options));
  } catch (_) {
    /* 隐私模式 / 存储被禁用时忽略 */
  }
  if (!silent) {
    addLog(
      'info',
      '传输层参数已应用：写入目标=' +
        describeTarget(options.writeTarget) +
        '，写入方式=' +
        options.writeMode +
        '，重发 ' +
        options.repeat +
        ' 次 / 间隔 ' +
        options.gapMs +
        'ms' +
        (options.fanout ? '，同时写入所有可写特征' : '')
    );
  }
}

function restoreAdvFromStorage() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(ADV_STORAGE_KEY) || '{}') || {};
  } catch (_) {
    saved = {};
  }
  pendingWriteTarget = saved.writeTarget == null ? 'auto' : String(saved.writeTarget);
  setValue($('adv-write-mode'), saved.writeMode || 'auto');
  setValue($('adv-repeat'), String(saved.repeat || 1));
  setValue($('adv-gap'), String(saved.gapMs == null ? 80 : saved.gapMs));
  const fanout = $('adv-fanout');
  if (fanout) fanout.checked = Boolean(saved.fanout);
  applyAdv(true);
}

function shortUuid(uuid) {
  const text = String(uuid || '');
  return text.length > 20 ? text.slice(0, 8) + '…' + text.slice(-4) : text;
}

function fillWriteTargetOptions(chars, writeUuid) {
  const select = $('adv-write-target');
  if (!select) return;
  const desired =
    select.value && select.value !== 'auto' ? select.value : String(pendingWriteTarget);
  while (select.options.length > 1) select.remove(1);
  for (const char of chars || []) {
    const option = document.createElement('option');
    option.value = String(char.index);
    option.textContent =
      '#' + char.index + ' ' + shortUuid(char.uuid) + (char.uuid === writeUuid ? '（当前写入）' : '');
    select.appendChild(option);
  }
  const exists = Array.from(select.options).some((option) => option.value === String(desired));
  select.value = exists ? String(desired) : 'auto';
  pendingWriteTarget = select.value;
}

function refreshCharsTable() {
  const host = $('chars-table');
  if (!host) return;
  host.textContent = '';
  const diag =
    connected && client && typeof client.getDiagnostics === 'function' ? client.getDiagnostics() : null;
  if (!diag || !diag.chars || !diag.chars.length) {
    const empty = document.createElement('p');
    empty.className = 'chars-empty';
    empty.textContent = '尚未连接，连接成功后这里会列出设备的全部特征。';
    host.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'chars-inner';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['#', 'UUID', '属性', '角色']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const char of diag.chars) {
    const row = document.createElement('tr');
    const roles = [];
    if (char.uuid === diag.notifyUuid) roles.push('通知');
    if (char.uuid === diag.writeUuid) roles.push('写入');
    if (char.uuid === diag.writeUuid) row.className = 'is-write';
    const cells = [String(char.index), char.uuid || '', char.props || '', roles.join(' / ')];
    cells.forEach((text, index) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (index === 0) td.className = 'mono num';
      if (index === 1) td.className = 'mono uuid';
      row.appendChild(td);
    });
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  host.appendChild(table);

  const meta = document.createElement('p');
  meta.className = 'chars-meta';
  meta.textContent =
    '通知特征：' + (diag.notifyUuid || '--') + '　|　写入特征：' + (diag.writeUuid || '--');
  host.appendChild(meta);

  fillWriteTargetOptions(diag.chars, diag.writeUuid);
}

function clearAdvancedPanel() {
  const host = $('chars-table');
  if (host) {
    host.textContent = '';
    const empty = document.createElement('p');
    empty.className = 'chars-empty';
    empty.textContent = '尚未连接，连接成功后这里会列出设备的全部特征。';
    host.appendChild(empty);
  }
  const select = $('adv-write-target');
  if (select) {
    while (select.options.length > 1) select.remove(1);
    select.value = 'auto';
  }
}

/** 把 "A5 5A .." / "a55a.." hex 文本解析成字节数组（自定义帧调试用） */
function parseHexText(text) {
  const cleaned = String(text || '')
    .replace(/0x/gi, '')
    .replace(/[^0-9a-fA-F]/g, '');
  if (!cleaned) return { ok: false, error: '请输入十六进制字节，例如 A5 5A 00 00 00 00 00 FF FB' };
  if (cleaned.length % 2 !== 0) return { ok: false, error: '十六进制字符数必须是偶数（每个字节两位）' };
  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 2) bytes.push(parseInt(cleaned.slice(i, i + 2), 16));
  if (bytes.length > 20) return { ok: false, error: '单帧最多 20 字节，当前 ' + bytes.length + ' 字节' };
  return { ok: true, bytes };
}

async function onRawSend() {
  const input = $('raw-hex');
  const parsed = parseHexText(input ? input.value : '');
  if (!parsed.ok) {
    addLog('error', '原始帧未发送：' + parsed.error);
    toast(parsed.error, 'error');
    return;
  }
  if (!connected) {
    toast('请先连接设备', 'warn');
    return;
  }
  try {
    await client.send(parsed.bytes);
    addLog('info', '已发送自定义帧（' + parsed.bytes.length + ' 字节）：' + toHex(parsed.bytes));
  } catch (error) {
    const message = (error && error.message) || String(error);
    addLog('error', '自定义帧发送失败：' + message);
    toast('自定义帧发送失败', 'error');
  }
}

/* ------------------------------- 初始化 ------------------------------- */

function init() {
  // 契约 §8 DOM 自检：缺失时在控制台与日志里明确报出，便于排查
  const missing = REQUIRED_IDS.filter((id) => !el[id]);
  if (missing.length) {
    console.error('[AJBLE119] index.html 缺少契约 §8 要求的 DOM id：', missing);
    addLog('error', '页面缺少 DOM id：' + missing.join(', '));
  }
  const missingZones = ZONES.filter(
    (z) => !document.querySelector('.zone-card[data-zone="' + z.zone + '"]')
  ).map((z) => z.zone);
  if (missingZones.length) {
    console.error('[AJBLE119] 缺少 .zone-card[data-zone]：', missingZones);
  }
  const rateValues = rateRadios.map((radio) => radio.value).sort();
  if (rateValues.join(',') !== '1,5,9') {
    console.error('[AJBLE119] .rate-radio 的 value 应为 1/5/9，实际：', rateValues);
  }

  if (modeHintNode) {
    modeHintNode.textContent = '演示模式（模拟设备）';
    modeHintNode.hidden = !useMock;
  }
  if (deviceNameNode) deviceNameNode.textContent = '--';

  setStatus('未连接', 'off');
  setControlsEnabled(false);
  renderState();
  restoreAdvFromStorage();
  refreshCharsTable();

  if (useMock && !BleClient.supported) {
    addLog('warn', '当前浏览器不支持 Web Bluetooth，已自动降级为演示模式。');
    showNotice('当前浏览器不支持 Web Bluetooth，已自动切换为演示模式（模拟设备）。', 'warn');
  } else if (useMock) {
    addLog('info', '演示模式已启用：使用本地模拟设备，无需真实蓝牙硬件。');
  } else {
    addLog('info', '真实设备模式：点击「连接设备」并选择广播名 AJBLE119 的设备。');
  }
}

wireClientEvents();
wireControls();
init();
