/**
 * js/ble.js —— AJBLE119「取暖桌智联」Web Bluetooth 传输层
 *
 * 职责：
 *   1. 通过 Web Bluetooth 连接广播名为 AJBLE119 的设备；
 *   2. 选择 Service edfec62e-9910-0bac-5241-d8bda6932a2f 下的通知/写特征；
 *   3. 发送 9 字节控制帧 / 15 字节预约帧；
 *   4. 接收 notification 并做「十六进制串缓冲重组」，拼出完整 22 字节状态帧后交给
 *      protocol.parseState 解析，对外派发 State；
 *   5. 识别下位机断开请求帧 A55D00080000000AFB；
 *   6. 用 EventTarget + CustomEvent 派发 log/tx/rx/state/connect/disconnect 事件。
 *
 * 本文件不含任何 Node 专属 API，也不访问 document，可直接被浏览器以 ES module 加载。
 * 协议帧的构造/解析全部来自 ./protocol.js（见 CONTRACT.md §5），此处不复制实现。
 */

import {
  DEVICE_NAME,
  SERVICE_UUID,
  DISCONNECT_FRAME_HEX,
  toHex,
  parseState,
  buildFrame,
  buildQuery,
} from './protocol.js';

/** 22 字节状态帧的十六进制长度（44 个字符）。 */
const STATE_FRAME_HEX_LEN = 44;
/** 接收缓冲上限；超过则判定为脏数据并清空（防止无限增长）。 */
const MAX_RX_BUFFER = 200;
/** 下位机断开请求帧的十六进制长度（18 个字符）。 */
const DISCONNECT_FRAME_LEN = DISCONNECT_FRAME_HEX.length;

/**
 * 依据特征属性推断「通知特征 / 写特征」角色（纯函数，便于单测）。
 *
 * 关键点：微信小程序里 `characteristicId[0]` 订阅通知、`characteristicId[1]` 下发指令，
 * 顺序即设备上报顺序，Web Bluetooth 的 getCharacteristics() 顺序与之一致。
 * 但**不能**只按 `properties.write` 盲选——有些设备把 notify 与 write 放在同一个特征上，
 * 那样指令会写到通知特征里去，下位机直接忽略，表现为「能连上、能收到状态，但按键无效」。
 * 因此默认策略：优先「索引 1 且可写」，其次「非通知特征里第一个可写的」。
 *
 * @param {Array} chars BluetoothRemoteGATTCharacteristic[]
 * @param {{writeTarget?: 'auto'|number|string}} [opts]
 * @returns {{notify: any, write: any, writeCandidates: any[]}}
 */
export function pickCharacteristicRoles(chars, opts = {}) {
  const list = (Array.isArray(chars) ? chars : []).filter(Boolean);
  const has = (c, k) => !!(c && c.properties && c.properties[k]);
  const isWritable = (c) => has(c, 'write') || has(c, 'writeWithoutResponse');

  const notify =
    list.find((c) => has(c, 'notify')) || list.find((c) => has(c, 'indicate')) || list[0] || null;

  const writable = list.filter(isWritable);
  const writeCandidates = writable.slice();

  let write = null;
  const target = opts && opts.writeTarget !== undefined ? opts.writeTarget : 'auto';

  if (typeof target === 'number') {
    write = list[target] || null;
  } else if (typeof target === 'string' && target !== 'auto') {
    write = list.find((c) => c && c.uuid === target) || null;
  } else {
    const notNotify = writable.filter((c) => c !== notify);
    if (list[1] && writable.includes(list[1])) write = list[1];
    else if (notNotify.length) write = notNotify[0];
    else if (writable.length) write = writable[0];
  }
  if (!write && notify && isWritable(notify)) write = notify;

  return { notify, write, writeCandidates };
}

export class BleClient extends EventTarget {
  /** 当前浏览器/上下文是否支持 Web Bluetooth（非安全上下文下通常为 false）。 */
  static get supported() {
    try {
      return (
        typeof navigator !== 'undefined' &&
        !!navigator.bluetooth &&
        typeof navigator.bluetooth.requestDevice === 'function'
      );
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {{ name?: string }} [opts] name 为广播名过滤条件，默认 AJBLE119
   */
  constructor(opts = {}) {
    super();
    this._opts = opts || {};
    this._name = this._opts.name || DEVICE_NAME;

    this._device = null;
    this._server = null;
    this._service = null;
    this._notifyChar = null;
    this._writeChar = null;
    this._notifyHandler = null;
    this._gattHandler = null;

    /** 服务下枚举到的全部特征，用于诊断面板展示。 */
    this._charsInfo = [];
    /** 全部可写特征（"同时写入所有写特征"排查模式使用）。 */
    this._writeCharsAll = [];
    /** 传输层可调参数（兼容性排查用，见 setOptions）。 */
    this._bleOptions = {
      writeTarget: 'auto',
      writeMode: 'auto',
      repeat: 1,
      gapMs: 80,
      fanout: false,
    };

    this._connected = false;
    this._connecting = false;
    this._tearingDown = false;
    this._deviceName = null;

    /** 十六进制接收缓冲，按 44 字符（22 字节）一帧重组。 */
    this._rxBuffer = '';
  }

  // ------------------------------------------------------------------ 只读状态

  /** 是否已连接（GATT + 通知均已就绪）。 */
  get connected() {
    return this._connected;
  }

  /** 已连接设备名；未连接过时为 null。 */
  get deviceName() {
    return this._deviceName;
  }

  /** 设备 BLE 地址（Web Bluetooth 的 device.id，形如 xx:xx:xx:xx:xx:xx）；未连接过时为 null。 */
  get deviceId() {
    return this._device && this._device.id ? this._device.id : null;
  }

  // ------------------------------------------------------------------ 连接

  /**
   * 请求并连接设备。必须由用户手势（点击按钮）触发，否则浏览器会拒绝。
   * 失败时抛出带中文说明的 Error。
   */
  async connect() {
    if (this._connected) {
      this._log('warn', '设备已连接，无需重复连接。');
      return;
    }
    if (this._connecting) {
      this._log('warn', '正在连接中，请稍候…');
      return;
    }
    if (!BleClient.supported) {
      throw new Error(
        '当前浏览器不支持 Web Bluetooth。请使用桌面版 Chrome / Edge，并通过 https 或 http://localhost 打开本页面。'
      );
    }

    this._connecting = true;
    this._rxBuffer = '';
    try {
      this._log('info', `正在请求蓝牙设备「${this._name}」…请在浏览器弹窗中选择设备。`);
      // requestDevice 必须紧跟用户手势，故把它放在第一个 await。
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ name: this._name }],
        optionalServices: [SERVICE_UUID],
      });

      this._device = device;
      this._deviceName = device.name || this._name;
      this._gattHandler = () => this._onGattServerDisconnected();
      if (typeof device.addEventListener === 'function') {
        device.addEventListener('gattserverdisconnected', this._gattHandler);
      }

      this._log('info', `已选择设备「${this._deviceName}」，正在建立 GATT 连接…`);
      if (!device.gatt) {
        throw new Error('该设备不提供 GATT 服务，无法连接。请确认设备固件正常。');
      }
      this._server = await device.gatt.connect();

      this._log('info', 'GATT 已连接，正在获取主服务…');
      this._service = await this._server.getPrimaryService(SERVICE_UUID);
      this._log('info', `已获取服务：${SERVICE_UUID}`);

      const characteristics = await this._service.getCharacteristics();
      if (!Array.isArray(characteristics) || characteristics.length === 0) {
        throw new Error('目标服务下未发现任何特征（characteristic），无法收发数据。');
      }

      const roles = pickCharacteristicRoles(characteristics, this._bleOptions);
      this._notifyChar = roles.notify;
      this._writeCharsAll = roles.writeCandidates;
      this._writeChar = roles.write;
      this._charsInfo = characteristics.map((c, i) => ({
        index: i,
        uuid: (c && c.uuid) || '(未知)',
        props: this._describeProps(c),
        writable: !!(c && c.properties && (c.properties.write || c.properties.writeWithoutResponse)),
        notifiable: !!(c && c.properties && (c.properties.notify || c.properties.indicate)),
      }));

      if (!this._notifyChar) {
        throw new Error('未找到可用的通知特征（notify / indicate），无法接收状态帧。');
      }
      if (!this._writeChar) {
        throw new Error(
          '未找到可用的写特征（write / writeWithoutResponse），无法发送指令。' +
            '可在「高级 / 兼容排查」里手动指定写入目标后重试。'
        );
      }

      // 完整打印特征清单：真机排查时这一屏最关键（顺序即 characteristicId[n]）。
      this._log('info', `服务下共 ${characteristics.length} 个特征：`);
      for (const info of this._charsInfo) {
        const tags = [];
        if (characteristics[info.index] === this._notifyChar) tags.push('通知');
        if (characteristics[info.index] === this._writeChar) tags.push('写入');
        this._log(
          'info',
          `  #${info.index} ${info.uuid} [${info.props}]${tags.length ? ' → ' + tags.join('/') : ''}`
        );
      }
      this._log(
        'info',
        `通知特征：${this._notifyChar.uuid}（${this._describeProps(this._notifyChar)}）`
      );
      this._log(
        'info',
        `写特征：${this._writeChar.uuid}（${this._describeProps(this._writeChar)}）` +
          (this._writeCharsAll.length > 1 ? `，另有 ${this._writeCharsAll.length - 1} 个可写特征` : '')
      );
      if (this._writeChar === this._notifyChar) {
        this._log(
          'warn',
          '写特征与通知特征是同一个，部分固件只在另一个特征上解析指令；若按键无效，请在「高级 / 兼容排查」里换用其它写入目标。'
        );
      }

      this._notifyHandler = (event) => this._onNotify(event);
      this._notifyChar.addEventListener('characteristicvaluechanged', this._notifyHandler);
      try {
        await this._notifyChar.startNotifications();
      } catch (err) {
        throw new Error(
          `开启通知（startNotifications）失败：${this._errText(err)}。请确认设备未被其他 App 占用后重试。`
        );
      }

      this._connected = true;
      this._log('info', '通知已开启，等待下位机上报状态…');
      this._emit('connect', { name: this._deviceName });
    } catch (err) {
      const msg = this._friendlyError(err);
      await this._cleanupPartial();
      this._log('error', msg);
      throw new Error(msg);
    } finally {
      this._connecting = false;
    }
  }

  /** 主动断开连接（幂等）。 */
  async disconnect() {
    await this._teardown('user');
  }

  // ------------------------------------------------------------------ 发送

  /**
   * 发送原始字节。
   * @param {Uint8Array|ArrayBuffer|number[]} bytes
   */
  async send(bytes) {
    if (!this._writeChar || !this._connected) {
      throw new Error('尚未连接设备，无法发送指令。请先点击「连接」。');
    }
    const data = this._toBytes(bytes);
    if (data.length === 0) {
      throw new Error('发送数据为空，已取消。');
    }
    const hex = toHex(data);
    const opts = this._bleOptions;
    const targets =
      opts.fanout && this._writeCharsAll.length ? this._writeCharsAll : [this._writeChar];
    const repeat = Math.min(Math.max(Number(opts.repeat) || 1, 1), 10);
    const gapMs = Math.min(Math.max(Number(opts.gapMs) || 0, 0), 1000);

    const extras = [];
    if (repeat > 1) extras.push(`重发 ${repeat} 次`);
    if (targets.length > 1) extras.push(`写入 ${targets.length} 个可写特征`);
    this._log(
      'info',
      `正在写入 ${data.length} 字节：${hex}` + (extras.length ? `（${extras.join('，')}）` : '')
    );

    try {
      for (let round = 0; round < repeat; round += 1) {
        for (const char of targets) {
          await this._writeBytes(data, char, opts.writeMode);
        }
        if (round < repeat - 1 && gapMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, gapMs));
        }
      }
    } catch (err) {
      const msg = `写入特征失败：${this._errText(err)}`;
      this._log('error', msg);
      throw new Error(msg);
    }
    this._emit('tx', { hex, bytes: data });
    this._log('info', `写入完成（${data.length} 字节）。`);
  }

  /**
   * 调整传输层参数（兼容性排查用）。可选项全部可选，只覆盖传入的字段。
   *
   * @param {{
   *   writeTarget?: 'auto'|number|string,   // 写入目标：auto=按索引 1 优先；数字=特征索引；字符串=特征 UUID
   *   writeMode?: 'auto'|'response'|'noresponse'|'legacy',
   *   repeat?: number,                       // 每条指令重发次数 1–10
   *   gapMs?: number,                        // 重发间隔 0–1000ms
   *   fanout?: boolean                       // 是否同时写入所有可写特征
   * }} partial
   */
  setOptions(partial = {}) {
    this._bleOptions = { ...this._bleOptions, ...(partial || {}) };
    return { ...this._bleOptions };
  }

  /** 当前传输层参数（只读副本）。 */
  getOptions() {
    return { ...this._bleOptions };
  }

  /** 连接后可取的特征诊断信息：清单 + 当前选中的通知/写特征。 */
  getDiagnostics() {
    return {
      chars: this._charsInfo.map((c) => ({ ...c })),
      notifyUuid: this._notifyChar ? this._notifyChar.uuid : null,
      writeUuid: this._writeChar ? this._writeChar.uuid : null,
      writeCount: this._writeCharsAll.length,
      options: this.getOptions(),
    };
  }

  /**
   * 发送 9 字节控制帧（内部用 buildFrame）。
   * @param {number} cmd 命令字（见 CMD）
   * @param {number} [p1]
   * @param {number} [p2]
   * @param {number} [p3]
   */
  async command(cmd, p1 = 0, p2 = 0, p3 = 0) {
    const bytes = buildFrame(cmd, p1, p2, p3);
    const cmdHex = `0x${(cmd & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
    this._log('info', `发送控制指令 CMD=${cmdHex} P1=${p1} P2=${p2} P3=${p3}。`);
    await this.send(bytes);
  }

  /** 发送固定状态查询帧（内部用 buildQuery）。 */
  async query() {
    this._log('info', '发送状态查询指令。');
    await this.send(buildQuery());
  }

  // ------------------------------------------------------------------ 特征选择

  // 特征角色推断统一走文件顶部的 pickCharacteristicRoles（纯函数，便于单测）。

  /** 把 properties 对象转成可读文本，便于日志排查。 */
  _describeProps(char) {
    const props = (char && char.properties) || {};
    const keys = [
      'read',
      'write',
      'writeWithoutResponse',
      'notify',
      'indicate',
      'broadcast',
      'authenticatedSignedWrites',
    ].filter((k) => props[k]);
    return keys.length ? keys.join('/') : '无可用属性';
  }

  /**
   * 写入字节。
   *
   * 默认按特征属性优先"带响应"写入，失败再降级到另一种方式（手头设备的固件差异很大，
   * 有的只认 Write Command，有的只认 Write Request）。排查时可用 writeMode 固定一种方式，
   * 以便确认到底哪种被固件接受。
   *
   * @param {Uint8Array} data
   * @param {any} [char] 目标特征，默认当前写特征
   * @param {'auto'|'response'|'noresponse'|'legacy'} [mode]
   */
  async _writeBytes(data, char = this._writeChar, mode = 'auto') {
    if (!char) throw new Error('没有可用的写特征，无法发送数据。');
    const props = char.properties || {};
    const attempts = [];
    const seen = new Set();
    const add = (label, fn) => {
      if (seen.has(label)) return;
      seen.add(label);
      attempts.push({ label, fn });
    };
    const addWithResponse = () => {
      if (typeof char.writeValueWithResponse === 'function') {
        add('writeValueWithResponse', () => char.writeValueWithResponse(data));
      }
    };
    const addWithoutResponse = () => {
      if (typeof char.writeValueWithoutResponse === 'function') {
        add('writeValueWithoutResponse', () => char.writeValueWithoutResponse(data));
      }
    };

    if (mode === 'response') {
      addWithResponse();
    } else if (mode === 'noresponse') {
      addWithoutResponse();
    } else if (mode === 'legacy') {
      if (typeof char.writeValue === 'function') add('writeValue', () => char.writeValue(data));
    } else {
      if (props.write) addWithResponse();
      if (props.writeWithoutResponse) addWithoutResponse();
      if (attempts.length === 0) {
        addWithResponse();
        addWithoutResponse();
      }
    }

    if (attempts.length === 0) {
      throw new Error(
        `该写特征（${char.uuid}）不支持所选写入方式（${mode}），请换一种写入方式或在「高级 / 兼容排查」里更换写作目标。`
      );
    }

    let lastErr = null;
    for (const attempt of attempts) {
      try {
        return await attempt.fn();
      } catch (err) {
        lastErr = err;
        this._log('warn', `写入方式 ${attempt.label} 失败（${this._errText(err)}），尝试回退…`);
      }
    }
    throw lastErr || new Error('写入失败，原因未知。');
  }

  // ------------------------------------------------------------------ 接收与重组

  _onNotify(event) {
    try {
      const value = event && event.target && event.target.value;
      if (!value) return;
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      this._emit('rx', { hex: toHex(bytes), bytes });
      this._consumeHex(toHex(bytes, '').toUpperCase());
    } catch (err) {
      this._log('error', `解析通知数据失败：${this._errText(err)}`);
    }
  }

  /**
   * 接收重组核心：
   *  - 收到下位机断开帧（A55D…）立即断开；
   *  - 否则追加到十六进制缓冲；缓冲长度 ≥44 时取前 44 字符：
   *      * 以 A55C 开头 → parseState → 派发 state，移除 44 字符；
   *      * 否则丢弃前 2 个字符（半个字节）继续找帧头，防卡死；
   *  - 缓冲超过上限强制清空并告警。
   */
  _consumeHex(hex) {
    if (!hex) return;

    // 常见情况：整帧在一次 notification 内到达。
    if (hex === DISCONNECT_FRAME_HEX) {
      this._handleDeviceDisconnect();
      return;
    }

    this._rxBuffer += hex;
    if (this._rxBuffer.length > MAX_RX_BUFFER) {
      this._rxBuffer = '';
      this._log('warn', '接收缓冲超过 200 字符，已强制清空（可能收到异常数据）。');
      return;
    }
    this._drainRxBuffer();
    if (this._rxBuffer.length > MAX_RX_BUFFER) {
      this._rxBuffer = '';
      this._log('warn', '接收缓冲超过 200 字符，已强制清空（可能收到异常数据）。');
    }
  }

  /** 逐帧消费接收缓冲。 */
  _drainRxBuffer() {
    let guard = 0;
    while (this._rxBuffer.length > 0) {
      if (guard++ > 4096) {
        this._rxBuffer = '';
        this._log('warn', '接收缓冲重组异常，已清空。');
        return;
      }
      const buf = this._rxBuffer;

      // 1) 下位机断开请求：A55D…（兼容被拆成多段到达的情况）
      if (buf.startsWith('A55D')) {
        if (buf.length < DISCONNECT_FRAME_LEN) {
          return; // 等后续分片
        }
        if (buf.slice(0, DISCONNECT_FRAME_LEN) === DISCONNECT_FRAME_HEX) {
          this._handleDeviceDisconnect();
          return;
        }
        this._rxBuffer = buf.slice(2);
        continue;
      }

      // 2) 状态帧：A55C + 44 个 hex 字符
      if (buf.startsWith('A55C')) {
        if (buf.length < STATE_FRAME_HEX_LEN) {
          return; // 半帧，等后续 notification
        }
        const frameHex = buf.slice(0, STATE_FRAME_HEX_LEN);
        this._rxBuffer = buf.slice(STATE_FRAME_HEX_LEN);
        this._dispatchState(frameHex);
        continue;
      }

      // 3) 还没凑够帧头：可能是 'A5' / 'A55' 等半截，等待更多数据
      if (this._rxBuffer.length < 4 && ('A55C'.startsWith(buf) || 'A55D'.startsWith(buf))) {
        return;
      }

      // 4) 非帧数据：丢弃 2 个字符后继续尝试对齐
      this._rxBuffer = buf.slice(2);
    }
  }

  _dispatchState(frameHex) {
    let state = null;
    try {
      state = parseState(frameHex);
    } catch (err) {
      this._log('warn', `状态帧解析异常，已跳过：${this._errText(err)}`);
      return;
    }
    if (!state) {
      this._log(
        'warn',
        `状态帧解析失败，已跳过：${frameHex.match(/.{2}/g).join(' ')}`
      );
      return;
    }
    this._emit('state', state);
  }

  _handleDeviceDisconnect() {
    this._rxBuffer = '';
    this._log('warn', '收到下位机断开请求帧（A5 5D …），连接即将断开。');
    void this._teardown('device', '下位机请求断开').catch(() => {});
  }

  // ------------------------------------------------------------------ 断开与清理

  _onGattServerDisconnected() {
    const wasConnected = this._connected;
    this._connected = false;
    this._rxBuffer = '';

    const notifyChar = this._notifyChar;
    const notifyHandler = this._notifyHandler;
    this._notifyChar = null;
    this._notifyHandler = null;
    if (notifyChar && notifyHandler) {
      try {
        notifyChar.removeEventListener('characteristicvaluechanged', notifyHandler);
      } catch (_) {
        /* ignore */
      }
    }

    const device = this._device;
    const gattHandler = this._gattHandler;
    this._gattHandler = null;
    if (device && gattHandler) {
      try {
        device.removeEventListener('gattserverdisconnected', gattHandler);
      } catch (_) {
        /* ignore */
      }
    }

    this._server = null;
    this._service = null;
    this._writeChar = null;
    this._writeCharsAll = [];
    this._charsInfo = [];

    if (!wasConnected) return;
    this._log('warn', '蓝牙连接已断开（gattserverdisconnected）。');
    this._emit('disconnect', { reason: 'gatt' });
  }

  /**
   * @param {'user'|'device'|'error'} reason
   * @param {string} [msg]
   */
  async _teardown(reason, msg) {
    if (this._tearingDown) return;
    this._tearingDown = true;
    try {
      const wasConnected = this._connected;
      this._connected = false;
      this._rxBuffer = '';

      const notifyChar = this._notifyChar;
      const notifyHandler = this._notifyHandler;
      this._notifyChar = null;
      this._notifyHandler = null;
      if (notifyChar && notifyHandler) {
        try {
          notifyChar.removeEventListener('characteristicvaluechanged', notifyHandler);
        } catch (_) {
          /* ignore */
        }
        try {
          if (typeof notifyChar.stopNotifications === 'function') {
            await notifyChar.stopNotifications();
          }
        } catch (_) {
          /* 连接已断时 stopNotifications 可能失败，忽略 */
        }
      }

      const device = this._device;
      const gattHandler = this._gattHandler;
      this._gattHandler = null;
      if (device && gattHandler) {
        try {
          device.removeEventListener('gattserverdisconnected', gattHandler);
        } catch (_) {
          /* ignore */
        }
      }

      // 先移除 gattserverdisconnected 监听再主动断开，避免重复派发 disconnect。
      try {
        if (device && device.gatt && device.gatt.connected) {
          device.gatt.disconnect();
        }
      } catch (_) {
        /* ignore */
      }

      this._server = null;
      this._service = null;
      this._writeChar = null;
      this._writeCharsAll = [];
      this._charsInfo = [];

      if (wasConnected) {
        if (reason === 'user') {
          this._log('info', msg || '已断开连接。');
        } else {
          this._log('warn', msg || '连接已断开。');
        }
        const detail = { reason };
        if (msg) detail.msg = msg;
        this._emit('disconnect', detail);
      } else if (reason === 'user') {
        this._log('info', '当前未连接，无需断开。');
      }
    } finally {
      this._tearingDown = false;
    }
  }

  /** connect() 失败后的静默清理：不掉 disconnect 事件，只释放资源。 */
  async _cleanupPartial() {
    const notifyChar = this._notifyChar;
    const notifyHandler = this._notifyHandler;
    this._notifyChar = null;
    this._notifyHandler = null;
    if (notifyChar && notifyHandler) {
      try {
        notifyChar.removeEventListener('characteristicvaluechanged', notifyHandler);
      } catch (_) {
        /* ignore */
      }
    }
    const device = this._device;
    const gattHandler = this._gattHandler;
    this._gattHandler = null;
    if (device && gattHandler) {
      try {
        device.removeEventListener('gattserverdisconnected', gattHandler);
      } catch (_) {
        /* ignore */
      }
    }
    try {
      if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    } catch (_) {
      /* ignore */
    }
    this._connected = false;
    this._rxBuffer = '';
    this._server = null;
    this._service = null;
    this._writeChar = null;
    this._writeCharsAll = [];
    this._charsInfo = [];
  }

  // ------------------------------------------------------------------ 工具

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
      // 极老环境的兜底（浏览器/Node 18 以下）
      event = new Event(type);
      try {
        event.detail = detail;
      } catch (_) {
        /* ignore */
      }
    }
    this.dispatchEvent(event);
  }

  _errText(err) {
    if (!err) return '未知错误';
    return err.message ? String(err.message) : String(err);
  }

  /** 把底层异常翻译成面向用户的中文说明。 */
  _friendlyError(err) {
    if (!err) return '蓝牙连接失败：未知错误。';
    const raw = this._errText(err);
    const name = err && err.name ? String(err.name) : '';
    const isDomException =
      typeof DOMException !== 'undefined' && err instanceof DOMException;

    if (name === 'NotFoundError' || /no device|device.*not found/i.test(raw)) {
      if (/service/i.test(raw)) {
        return `设备上找不到服务 ${SERVICE_UUID}，可能不是目标型号（AJBLE119）。`;
      }
      return '未找到设备「AJBLE119」。请确认设备已上电、在附近、未被其他手机/电脑占用，并确认系统与浏览器已获得蓝牙权限。';
    }
    if (name === 'SecurityError') {
      return '当前页面不是安全上下文，无法使用蓝牙。请通过 http://localhost 或 https 打开页面。';
    }
    if (name === 'NotAllowedError') {
      return '蓝牙访问被拒绝。请在浏览器地址栏的权限设置中允许蓝牙后重试。';
    }
    if (name === 'NetworkError' || /gatt.*(fail|error)|connection.*fail/i.test(raw)) {
      return 'GATT 连接失败（对象可能已断开）。请把设备断电重启、靠近电脑后重试。';
    }
    if (name === 'InvalidStateError') {
      return '蓝牙适配器状态异常（可能已关闭）。请打开系统蓝牙后重试。';
    }
    if (name === 'NotSupportedError') {
      return '设备不支持所需的 GATT 服务/特征，或该操作在当前浏览器不可用。';
    }
    if (name === 'AbortError') {
      return '蓝牙操作被取消。';
    }
    if (/cancelled|canceled|chooser/i.test(raw)) {
      return '已取消选择设备。';
    }
    if (/adapter|bluetooth.*(off|unavailable)|not available/i.test(raw)) {
      return '系统蓝牙适配器不可用，请确认电脑蓝牙已打开并允许浏览器使用。';
    }
    if (/permission|denied|unauthorized/i.test(raw)) {
      return '蓝牙权限被拒绝，请检查浏览器/系统权限设置。';
    }
    if (isDomException && name) {
      return `${name}：${raw}`;
    }
    return raw;
  }
}

export default BleClient;
