/**
 * js/mock.js —— AJBLE119 模拟设备（演示模式）
 *
 * 与 BleClient 完全一致的公开 API 与事件：
 *   static supported / connected / deviceName / connect() / disconnect() /
 *   send(bytes) / command(cmd,p1,p2,p3) / query()
 *   事件：log / tx / rx / state / connect / disconnect
 *
 * 模拟下位机行为（见 CONTRACT.md §7）：
 *   - connect() 等 250ms 后派发 log/connect，并立即推送一次状态帧；
 *   - 状态帧拆成 2 段 notification（前 10 字节 + 后 12 字节）以验证重组；
 *   - send() 解析 9 字节控制帧与 15 字节预约帧并更新内部状态，40ms 后
 *     以 2 段 notification 回报新状态；
 *   - 收到查询帧同样回报状态；收到无法识别的帧只发 log(warn,'未识别帧')；
 *   - 每 12 次**控制指令**后模拟一次「下位机请求断开」（查询帧不计入；发送 A55D… 帧并派发
 *     disconnect{reason:'device'}），可用构造参数 { autoDisconnectAfter: 0 } 关闭。
 *
 * 仅使用浏览器/Node 均存在的标准 API（EventTarget/CustomEvent/setTimeout），
 * 不访问 DOM 与 Node 专属模块。
 */

import {
  DEVICE_NAME,
  SERVICE_UUID,
  DISCONNECT_FRAME_HEX,
  CMD,
  toHex,
  fromHex,
  parseState,
  buildFrame,
  buildQuery,
  buildStateFrame,
} from './protocol.js';

/** 模拟设备的默认状态（契约 §7 固定值）。 */
export const DEFAULT_MOCK_STATE = Object.freeze({
  power: 0,
  constTemp: 60,
  heatingLevel: 0,
  leftFront: 0,
  leftBehind: 0,
  rightFront: 0,
  rightBehind: 0,
  footWarm: 0,
  voice: 1,
  timerHour: 0,
  timerMinute: 0,
  timerSecond: 0,
  orderDay: 0,
  orderHour: 0,
  orderMinute: 0,
  orderTemp: 0,
  currentTemp: 30,
  bleRate: 5,
  volume: 60,
});

/** 状态帧分片方案：前 10 字节 + 后 12 字节。 */
const STATE_SEGMENT_BOUNDARY = 10;
const STATE_FRAME_HEX_LEN = 44;
const MAX_RX_BUFFER = 400;

const DEFAULT_CONNECT_DELAY = 250;
const DEFAULT_REPLY_DELAY = 40;
const DEFAULT_AUTO_DISCONNECT_AFTER = 12;
const SEGMENT_GAP = 12;
const PRE_DISCONNECT_GAP = 30;

export class MockBleClient extends EventTarget {
  /** 模拟设备恒可用。 */
  static get supported() {
    return true;
  }

  /**
   * @param {{
   *   name?: string,
   *   connectDelay?: number,
   *   replyDelay?: number,
   *   autoDisconnectAfter?: number,
   * }} [opts]
   *   autoDisconnectAfter: 每 N 次写入后模拟下位机断开；0 表示关闭（默认 12）。
   */
  constructor(opts = {}) {
    super();
    this._opts = opts || {};
    this._name = this._opts.name || DEVICE_NAME;
    this._connectDelay = this._num(this._opts.connectDelay, DEFAULT_CONNECT_DELAY);
    this._replyDelay = this._num(this._opts.replyDelay, DEFAULT_REPLY_DELAY);
    const auto =
      this._opts.autoDisconnectAfter === undefined
        ? DEFAULT_AUTO_DISCONNECT_AFTER
        : this._num(this._opts.autoDisconnectAfter, DEFAULT_AUTO_DISCONNECT_AFTER);
    this._autoDisconnectAfter = auto > 0 ? auto : 0;

    this._connected = false;
    this._connecting = false;
    this._deviceName = null;
    this._state = { ...DEFAULT_MOCK_STATE };
    this._writeCount = 0;
    this._rxBuffer = '';
    this._session = 0;
    /** @type {Set<{id:any, resolve:Function}>} */
    this._timers = new Set();
  }

  // ------------------------------------------------------------------ 只读状态

  get connected() {
    return this._connected;
  }

  get deviceName() {
    return this._deviceName;
  }

  // ------------------------------------------------------------------ 连接

  async connect() {
    if (this._connected) {
      this._log('warn', '（模拟）设备已连接，无需重复连接。');
      return;
    }
    if (this._connecting) {
      this._log('warn', '（模拟）正在连接中，请稍候…');
      return;
    }
    this._connecting = true;
    const session = ++this._session;
    this._log('info', `（模拟）正在搜索并连接设备「${this._name}」…`);
    try {
      await this._sleep(this._connectDelay);
      if (session !== this._session) return;

      this._connected = true;
      this._deviceName = this._name;
      this._state = { ...DEFAULT_MOCK_STATE };
      this._writeCount = 0;
      this._rxBuffer = '';
      this._log('info', `（模拟）已连接「${this._name}」，服务 ${SERVICE_UUID}。`);
      this._emit('connect', { name: this._name });
      // 连接后立即推送一次状态帧（拆成 2 段 notification）。
      await this._pushState();
    } finally {
      this._connecting = false;
    }
  }

  /** 主动断开（幂等）。 */
  async disconnect() {
    const wasConnected = this._connected;
    this._session += 1;
    this._flushTimers();
    this._connected = false;
    this._rxBuffer = '';
    if (!wasConnected) {
      this._log('info', '（模拟）当前未连接，无需断开。');
      return;
    }
    this._log('info', '（模拟）已断开连接。');
    this._emit('disconnect', { reason: 'user' });
  }

  // ------------------------------------------------------------------ 发送

  async send(bytes) {
    if (!this._connected) {
      throw new Error('（模拟设备）尚未连接，无法发送指令。请先点击「连接」。');
    }
    const data = this._toBytes(bytes);
    if (data.length === 0) {
      throw new Error('发送数据为空，已取消。');
    }
    const hex = toHex(data);
    this._log('info', `（模拟）写入 ${data.length} 字节：${hex}`);
    this._emit('tx', { hex, bytes: data });
    // 查询帧（A5 5B …）由 UI 的自动同步产生，不计入"控制次数"——
    // 否则演示模式下点几下就会触发模拟断开，体验上像 bug。
    const isQuery = data.length === 9 && data[0] === 0xa5 && data[1] === 0x5b;
    if (!isQuery) this._writeCount += 1;

    const recognized = this._handleFrame(data);
    if (!recognized) {
      this._log('warn', '未识别帧');
      return;
    }

    const session = this._session;
    const shouldDisconnect =
      this._autoDisconnectAfter > 0 &&
      this._writeCount > 0 &&
      this._writeCount % this._autoDisconnectAfter === 0;
    // 不阻塞 send：真实 BLE 写入完成即返回，状态回报是异步 notification。
    void this._replyStateLater(session, shouldDisconnect);
  }

  // 与真实传输层窗口同名的兼容接口：演示模式下这些参数不生效，仅用于 UI 联动与自测。
  setOptions(partial = {}) {
    this._options = { ...(this._options || {}), ...(partial || {}) };
    return this.getOptions();
  }

  getOptions() {
    return { ...(this._options || {}) };
  }

  getDiagnostics() {
    const notifyUuid = 'mock-notify-characteristic';
    const writeUuid = 'mock-write-characteristic';
    return {
      chars: [
        { index: 0, uuid: notifyUuid, props: 'notify', writable: false, notifiable: true },
        {
          index: 1,
          uuid: writeUuid,
          props: 'write/writeWithoutResponse',
          writable: true,
          notifiable: false,
        },
      ],
      notifyUuid,
      writeUuid,
      writeCount: 1,
      options: this.getOptions(),
    };
  }

  async command(cmd, p1 = 0, p2 = 0, p3 = 0) {    const bytes = buildFrame(cmd, p1, p2, p3);
    const cmdHex = `0x${(cmd & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
    this._log('info', `（模拟）发送控制指令 CMD=${cmdHex} P1=${p1} P2=${p2} P3=${p3}。`);
    await this.send(bytes);
  }

  async query() {
    this._log('info', '（模拟）发送状态查询指令。');
    await this.send(buildQuery());
  }

  // ------------------------------------------------------------------ 模拟下位机逻辑

  /**
   * 解析客户端发来的帧并更新内部状态。
   * @returns {boolean} 是否识别该帧
   */
  _handleFrame(data) {
    const len = data.length;

    // 9 字节：查询帧 / 控制帧
    if (len === 9) {
      if (data[0] !== 0xa5) return false;
      if (data[1] === 0x5b) return true; // 状态查询帧 A5 5B …
      if (data[1] !== 0x5a) return false;

      const cmd = (data[2] << 8) | data[3];
      const p1 = data[4];
      const p2 = data[5];
      const p3 = data[6];
      const state = this._state;

      switch (cmd) {
        case CMD.POWER:
          // 电源命令 P3：0=开 / 1=关；状态字段 power 用 1 表示开。
          state.power = p3 === 0 ? 1 : 0;
          return true;
        case CMD.CONST_TEMP:
          state.constTemp = p3;
          return true;
        case CMD.FULL_LEVEL:
          state.heatingLevel = p3;
          return true;
        case CMD.RIGHT_FRONT:
          state.rightFront = p3;
          return true;
        case CMD.RIGHT_BEHIND:
          state.rightBehind = p3;
          return true;
        case CMD.LEFT_FRONT:
          state.leftFront = p3;
          return true;
        case CMD.LEFT_BEHIND:
          state.leftBehind = p3;
          return true;
        case CMD.FOOT_WARM:
          state.footWarm = p3;
          return true;
        case CMD.VOICE:
          state.voice = p3;
          return true;
        case CMD.TIMER:
          state.timerHour = p2;
          state.timerMinute = p3;
          state.timerSecond = 0;
          return true;
        case CMD.BLE_RATE:
          state.bleRate = p3;
          return true;
        case CMD.VOLUME:
          state.volume = p1;
          return true;
        default:
          return false;
      }
    }

    // 15 字节：预约帧 A5 5E <day> <HH> <MM> <temp> 00 00 00 <dayOff> <minOff> 00 00 00 FB
    if (len === 15) {
      if (data[0] !== 0xa5 || data[1] !== 0x5e) return false;
      const day = data[2];
      if (day === 0) {
        this._state.orderDay = 0;
        this._state.orderHour = 0;
        this._state.orderMinute = 0;
        this._state.orderTemp = 0;
      } else {
        this._state.orderDay = day;
        this._state.orderHour = data[3];
        this._state.orderMinute = data[4];
        this._state.orderTemp = data[5];
      }
      return true;
    }

    return false;
  }

  /** curTemp 规则（契约 §7）：开机且恒温>0 时等于恒温值，否则 30（关机也 30）。 */
  _applyCurrentTemp() {
    const s = this._state;
    if (s.power && s.constTemp > 0) {
      s.currentTemp = s.constTemp;
    } else if (s.power) {
      s.currentTemp = 30;
    } else {
      s.currentTemp = 30;
    }
  }

  async _replyStateLater(session, shouldDisconnect) {
    try {
      await this._sleep(this._replyDelay);
      if (session !== this._session || !this._connected) return;

      this._applyCurrentTemp();
      await this._pushState();
      if (session !== this._session || !this._connected) return;

      if (!shouldDisconnect) return;
      await this._sleep(PRE_DISCONNECT_GAP);
      if (session !== this._session || !this._connected) return;

      // 模拟下位机主动请求断开：先发 A55D 帧（客户端 rx 可见），再断开。
      this._notify(fromHex(DISCONNECT_FRAME_HEX));
      this._deviceDisconnect();
    } catch (err) {
      this._log('error', `（模拟）状态回报失败：${err && err.message ? err.message : err}`);
    }
  }

  /** 模拟下位机请求断开。 */
  _deviceDisconnect() {
    const wasConnected = this._connected;
    this._session += 1;
    this._flushTimers();
    this._connected = false;
    this._rxBuffer = '';
    if (!wasConnected) return;
    this._log('warn', '（模拟）收到下位机断开请求帧（A5 5D …）。');
    this._emit('disconnect', { reason: 'device', msg: '下位机请求断开（模拟设备）' });
  }

  // ------------------------------------------------------------------ 状态上报

  /** 生成状态帧并以 2 段 notification 推送。 */
  async _pushState() {
    const frame = buildStateFrame({ ...this._state });
    const parts = [
      frame.subarray(0, STATE_SEGMENT_BOUNDARY),
      frame.subarray(STATE_SEGMENT_BOUNDARY),
    ];
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        await this._sleep(SEGMENT_GAP);
        if (!this._connected) return;
      }
      this._notify(parts[i]);
    }
  }

  /** 派发一次模拟 notification：先 rx，再进入十六进制缓冲重组。 */
  _notify(bytes) {
    const copy = new Uint8Array(bytes);
    this._emit('rx', { hex: toHex(copy), bytes: copy });
    this._rxBuffer += toHex(copy, '').toUpperCase();
    if (this._rxBuffer.length > MAX_RX_BUFFER) {
      this._rxBuffer = '';
      this._log('warn', '（模拟）接收缓冲异常，已清空。');
      return;
    }
    while (this._rxBuffer.length >= STATE_FRAME_HEX_LEN) {
      const frameHex = this._rxBuffer.slice(0, STATE_FRAME_HEX_LEN);
      this._rxBuffer = this._rxBuffer.slice(STATE_FRAME_HEX_LEN);
      if (!frameHex.startsWith('A55C')) continue;
      const state = parseState(frameHex);
      if (state) {
        this._emit('state', state);
      } else {
        this._log('warn', '（模拟）状态帧解析失败。');
      }
    }
  }

  // ------------------------------------------------------------------ 工具

  _sleep(ms) {
    return new Promise((resolve) => {
      const rec = { id: null, resolve };
      rec.id = setTimeout(() => {
        this._timers.delete(rec);
        resolve();
      }, ms);
      this._timers.add(rec);
    });
  }

  /** 立即唤醒所有等待中的定时器（断开时避免悬挂的 Promise）。 */
  _flushTimers() {
    for (const rec of this._timers) {
      try {
        clearTimeout(rec.id);
      } catch (_) {
        /* ignore */
      }
      rec.resolve();
    }
    this._timers.clear();
  }

  _num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  _toBytes(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (typeof ArrayBuffer !== 'undefined') {
      if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
      if (ArrayBuffer.isView(bytes)) {
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
      }
    }
    if (Array.isArray(bytes)) return Uint8Array.from(bytes);
    throw new Error('发送数据格式错误：需要 Uint8Array / ArrayBuffer / number[]。');
  }

  _log(level, msg) {
    this._emit('log', { level, msg });
  }

  _emit(type, detail) {
    let event;
    if (typeof CustomEvent === 'function') {
      event = new CustomEvent(type, { detail });
    } else {
      event = new Event(type);
      try {
        event.detail = detail;
      } catch (_) {
        /* ignore */
      }
    }
    this.dispatchEvent(event);
  }
}

export default MockBleClient;
