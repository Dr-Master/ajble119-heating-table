/**
 * AJBLE119「取暖桌智联」协议纯函数库（ES module，零依赖、无副作用）
 *
 * 唯一权威来源：
 *   - 小程序页面 `pages/AJBLE119/AJBLE119.js`
 *       · `getAJBLE119ControlCode` :38-43   → 9 字节控制帧
 *       · `getVolumeControlCode`   :44-49   → 音量帧（参数在 P1 位）
 *       · `getOrderControlCode`    :50-61   → 15 字节预约帧（dayOff/minOff 现算）
 *       · `getHeatingTableState`   :65-87   → 22 字节状态帧解析
 *       · `isUpdateState`          :330-332 → 状态帧判定（A55C 前缀 + 44 hex）
 *       · `onShow`                 :335-347 → 通知分包缓冲 / A55D 断开帧
 *   - 校验库 `C86217F34EBF8FDFAE047FF4028C68B5.js`
 *       · `addCheck` :13-16 → 全字节累加后取低 8 位
 *
 * 本文件只做字节运算，不访问任何浏览器全局对象，可在 Node 中直接 import 做单元测试。
 * 帧格式、导出名、State 键名严格遵循 demo/CONTRACT.md §4 / §5。
 */

/** BLE 广播名（精确匹配） */
export const DEVICE_NAME = 'AJBLE119';

/** 主服务 UUID（小写，Web Bluetooth 匹配不区分大小写） */
export const SERVICE_UUID = 'edfec62e-9910-0bac-5241-d8bda6932a2f';

/** 16 位命令字（帧内按大端写入 CMD_H / CMD_L） */
export const CMD = Object.freeze({
  POWER: 0x0000, // 电源：P3 0=开 / 1=关
  CONST_TEMP: 0x0001, // 恒温目标温度：P3 = 30/40/50/60/70/80
  FULL_LEVEL: 0x0002, // 全控档：P3 0–5
  RIGHT_FRONT: 0x0003, // 右前：P3 0–5
  RIGHT_BEHIND: 0x0004, // 右后：P3 0–5
  LEFT_FRONT: 0x0005, // 左前：P3 0–5
  LEFT_BEHIND: 0x0006, // 左后：P3 0–5
  FOOT_WARM: 0x0007, // 脚暖：P3 0–2
  VOICE: 0x0009, // 提示音：P3 0=静音 / 1=滴滴 / 2=语音
  TIMER: 0x000A, // 定时：P2=时 / P3=分（取消定时 P2=P3=0）
  BLE_RATE: 0x000D, // BLE 发射功率：P3 1=最低 / 5=中等 / 9=最高
  VOLUME: 0x000E, // 音量：P1=0–100（注意不在 P3 位）
});

/** 查询状态固定帧（9 字节）：A5 5B 00 00 00 00 00 00 FB */
export const QUERY_FRAME_HEX = 'A55B000000000000FB';

/** 下位机主动请求断开帧（仅用于识别，App 不发送）：A5 5D 00 08 00 00 00 0A FB */
export const DISCONNECT_FRAME_HEX = 'A55D00080000000AFB';

/** 提示音取值 → 中文标签 */
export const VOICE_LABELS = Object.freeze({ 0: '静音', 1: '滴滴', 2: '语音' });

/**
 * State 字段与 22 字节状态帧的固定映射（字节 2 起，顺序即协议顺序）。
 * 用统一顺序表同时驱动 parseState / buildStateFrame，保证两者严格互逆。
 */
const STATE_FIELDS = Object.freeze([
  'power', //        byte2  电源 1=开 / 0=关
  'constTemp', //    byte3  恒温目标温度（0=恒温关）
  'heatingLevel', // byte4  全控档 0–5
  'leftFront', //    byte5  左前档 0–5
  'leftBehind', //   byte6  左后档 0–5
  'rightFront', //   byte7  右前档 0–5
  'rightBehind', //  byte8  右后档 0–5
  'footWarm', //     byte9  脚暖档 0–2
  'voice', //        byte10 提示音 0/1/2
  'timerHour', //    byte11 定时-时
  'timerMinute', //  byte12 定时-分
  'timerSecond', //  byte13 定时-秒
  'orderDay', //     byte14 预约日 0=无 / 1=今天 / 2=明天
  'orderHour', //    byte15 预约-时
  'orderMinute', //  byte16 预约-分
  'orderTemp', //    byte17 预约设定温度
  'currentTemp', //  byte18 下位机回传的当前温度（℃）
  'bleRate', //      byte19 BLE 功率 1/5/其他
  'volume', //       byte20 音量 0–100
]);

/** 状态帧总长度（字节） */
const STATE_FRAME_LENGTH = 22;

/** 预约帧总长度（字节） */
const ORDER_FRAME_LENGTH = 15;

/** 把任意输入安全转成有限数字（非法值退化为 fallback） */
function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 取低 8 位（等价于源码 DataView.setUint8 的取模回绕，负数同样回绕） */
function toByte(value) {
  return asNumber(value) & 0xff;
}

/** 音量：源码直接写 P1，界面限 0–100；这里做四舍五入 + 夹取，避免发出越界值 */
function clampVolume(value) {
  const n = Math.round(asNumber(value));
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * 累加和校验（源码 `C86217...addCheck(bytes, true)`：全字节累加后 & 0xFF）
 * @param {Uint8Array|number[]} bytes
 * @returns {number} 0–255
 */
export function checksum(bytes) {
  if (!bytes) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) sum += bytes[i] & 0xff;
  return sum & 0xff;
}

/**
 * 9 字节控制帧：A5 5A CMD_H CMD_L P1 P2 P3 CHK FB
 * @param {number} cmd 16 位命令字
 * @param {number} [p1=0]
 * @param {number} [p2=0]
 * @param {number} [p3=0]
 * @returns {Uint8Array} 长度 9
 */
export function buildFrame(cmd, p1 = 0, p2 = 0, p3 = 0) {
  const body = [
    0xa5,
    0x5a,
    (asNumber(cmd) >> 8) & 0xff,
    asNumber(cmd) & 0xff,
    toByte(p1),
    toByte(p2),
    toByte(p3),
  ];
  body.push(checksum(body), 0xfb);
  return Uint8Array.from(body);
}

/**
 * 音量帧（9 字节）：A5 5A 00 0E VOL 00 00 CHK FB —— 音量在 P1 位，与其它帧不同
 * @param {number} volume 0–100
 * @returns {Uint8Array} 长度 9
 */
export function buildVolume(volume) {
  const body = [0xa5, 0x5a, 0x00, 0x0e, clampVolume(volume), 0x00, 0x00];
  body.push(checksum(body), 0xfb);
  return Uint8Array.from(body);
}

/**
 * 定时帧（9 字节）：A5 5A 00 0A 00 时 分 CHK FB
 * @param {number} hour 0–23
 * @param {number} minute 0–59
 * @returns {Uint8Array} 长度 9
 */
export function buildTimer(hour, minute) {
  return buildFrame(CMD.TIMER, 0, hour, minute);
}

/**
 * 取消定时帧（9 字节）：A5 5A 00 0A 00 00 00 09 FB
 * @returns {Uint8Array} 长度 9
 */
export function buildCancelTimer() {
  return buildFrame(CMD.TIMER, 0, 0, 0);
}

/**
 * 查询状态帧（9 字节固定帧）
 * @returns {Uint8Array} 长度 9
 */
export function buildQuery() {
  return fromHex(QUERY_FRAME_HEX);
}

/** 把 Date / 毫秒时间戳 / 非法值统一成 Date（非法值取当前时刻） */
function normalizeNow(now) {
  if (now instanceof Date) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now);
  return new Date();
}

/**
 * 预约帧（15 字节，无校验字节）：
 *   A5 5E <day> <HH> <MM> <temp> 00 00 00 <dayOff> <minOff> 00 00 00 FB
 *
 * dayOff / minOff 必须按 App 端"当前时刻"现算，此处逐行照抄源码
 * `AJBLE119.js:56-60` 的 if/else 分支（包括源码的怪癖，不自行"修正"）：
 *   1) day=1（今天）：
 *      - 目标时 == 当前时            → dayOff=0, minOff=目标分-当前分（可能为负，按字节回绕）
 *      - 目标时-当前时 == 1 且 目标分>=当前分 → dayOff=1, minOff=目标分-当前分
 *      - 目标时-当前时 == 1 且 目标分< 当前分 → dayOff=0, minOff=60-当前分+目标分
 *      - 目标时-当前时 >  1 且 目标分>=当前分 → dayOff=差时,   minOff=目标分-当前分
 *      - 目标时-当前时 >  1 且 目标分< 当前分 → dayOff=差时-1, minOff=60-当前分+目标分
 *      - 目标时 < 当前时（今天已过）→ 源码所有分支都不命中，dayOff/minOff 保持 0（怪癖）
 *   2) day=2（明天）：
 *      - 当前分 <  目标分 → minOff=目标分-当前分, dayOff=24-当前时+目标时
 *      - 当前分 >  目标分 → dayOff=23-当前时+目标时, minOff=(目标时==0且目标分==0) ? 60-当前分 : 当前分-目标分
 *      - 当前分 == 目标分 → minOff=0, dayOff=24-当前时+目标时
 *   3) 其它 day（0=取消）→ dayOff=minOff=0
 *
 * @param {{day?:number, hour?:number, minute?:number, temperature?:number, now?:Date|number}} opts
 * @returns {Uint8Array} 长度 15
 */
export function buildOrder({ day = 0, hour = 0, minute = 0, temperature = 0, now = new Date() } = {}) {
  const dayId = toByte(day);
  const targetHour = toByte(hour);
  const targetMinute = toByte(minute);
  const targetTemp = toByte(temperature);

  const current = normalizeNow(now);
  const nowHour = current.getHours(); // 源码 `l`
  const nowMinute = current.getMinutes(); // 源码 `d`

  let dayOff = 0;
  let minOff = 0;

  if (dayId === 1) {
    // ===== 源码 AJBLE119.js:60 的 day===1 分支，逐行照抄 =====
    if (nowHour === targetHour) {
      dayOff = 0;
      minOff = targetMinute - nowMinute; // 注意：同小时且分钟已过时为负，写字节时回绕
    } else if (targetHour - nowHour === 1 && targetMinute >= nowMinute) {
      dayOff = 1;
      minOff = targetMinute - nowMinute;
    } else if (targetHour - nowHour === 1 && targetMinute < nowMinute) {
      dayOff = 0;
      minOff = 60 - nowMinute + targetMinute;
    } else if (targetHour - nowHour > 1 && targetMinute >= nowMinute) {
      dayOff = targetHour - nowHour;
      minOff = targetMinute - nowMinute;
    } else if (targetHour - nowHour > 1 && targetMinute < nowMinute) {
      dayOff = targetHour - nowHour - 1;
      minOff = 60 - nowMinute + targetMinute;
    }
    // 目标时 < 当前时：源码无对应分支，dayOff/minOff 保持 0（原样保留该怪癖）
  } else if (dayId === 2) {
    // ===== 源码 AJBLE119.js:60 的 day===2 分支，逐行照抄 =====
    if (nowMinute < targetMinute) {
      minOff = targetMinute - nowMinute;
      dayOff = 24 - nowHour + targetHour;
    } else if (nowMinute > targetMinute) {
      dayOff = 23 - nowHour + targetHour;
      minOff = targetHour === 0 && targetMinute === 0 ? 60 - nowMinute : nowMinute - targetMinute;
    } else {
      minOff = 0;
      dayOff = 24 - nowHour + targetHour;
    }
  } else {
    // ===== 源码 day 为其它值（0=取消）分支 =====
    dayOff = 0;
    minOff = 0;
  }

  const bytes = [
    0xa5,
    0x5e,
    dayId,
    targetHour,
    targetMinute,
    targetTemp,
    0x00,
    0x00,
    0x00,
    dayOff & 0xff, // 负值在此回绕（等价源码 DataView.setUint8）
    minOff & 0xff,
    0x00,
    0x00,
    0x00,
    0xfb,
  ];
  return Uint8Array.from(bytes);
}

/**
 * 取消预约帧（15 字节）：A5 5E 00 00 00 00 00 00 00 00 00 00 00 00 FB
 * 等价源码 dayId=0（OrderTime 页取消回传 {dayId:0, orderTime:"00:00", orderTemperature:0}）。
 * @returns {Uint8Array} 长度 15
 */
export function buildCancelOrder() {
  return buildOrder({ day: 0, hour: 0, minute: 0, temperature: 0 });
}

/**
 * 十六进制字符串 → 字节数组。
 * 允许空格分隔、大小写混用；非法输入（奇数长度/非 hex 字符/非字符串）返回空数组。
 * @param {string} str
 * @returns {Uint8Array}
 */
export function fromHex(str) {
  if (typeof str !== 'string') return new Uint8Array(0);
  const compact = str.replace(/\s+/g, '');
  if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(compact)) return new Uint8Array(0);
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * 字节数组 → 大写两位十六进制串（默认空格分隔）
 * @param {Uint8Array|number[]|string} bytes 也可传 hex 字符串（先规范化再输出）
 * @param {string} [sep=' ']
 * @returns {string}
 */
export function toHex(bytes, sep = ' ') {
  if (bytes == null) return '';
  const arr = typeof bytes === 'string' ? fromHex(bytes) : bytes;
  if (!arr || typeof arr.length !== 'number') return '';
  const parts = new Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) {
    parts[i] = (arr[i] & 0xff).toString(16).padStart(2, '0').toUpperCase();
  }
  return parts.join(sep);
}

/**
 * 是否是 22 字节状态帧（A55C 前缀且至少 44 个 hex 字符）。
 * 字符串入参忽略空白、大小写；也接受 Uint8Array/number[]。
 * @param {string|Uint8Array|number[]} hex
 * @returns {boolean}
 */
export function isStateHex(hex) {
  if (typeof hex === 'string') {
    const compact = hex.replace(/\s+/g, '');
    return (
      compact.length >= STATE_FRAME_LENGTH * 2 &&
      compact.length % 2 === 0 &&
      /^[0-9a-fA-F]+$/.test(compact) &&
      compact.slice(0, 4).toUpperCase() === 'A55C'
    );
  }
  if (hex && typeof hex.length === 'number') {
    return hex.length >= STATE_FRAME_LENGTH && (hex[0] & 0xff) === 0xa5 && (hex[1] & 0xff) === 0x5c;
  }
  return false;
}

/**
 * 解析 22 字节状态帧。
 * 入参可为 Uint8Array / number[] / hex 字符串（可带空格）；帧头不是 A5 5C 或长度不足 22 字节返回 null。
 * 尾部多出的字节（≥22 时）忽略；byte21 按契约不校验。
 * @param {Uint8Array|number[]|string} input
 * @returns {{power:number,constTemp:number,heatingLevel:number,leftFront:number,leftBehind:number,rightFront:number,rightBehind:number,footWarm:number,voice:number,timerHour:number,timerMinute:number,timerSecond:number,orderDay:number,orderHour:number,orderMinute:number,orderTemp:number,currentTemp:number,bleRate:number,volume:number}|null}
 */
export function parseState(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = fromHex(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (Array.isArray(input)) {
    bytes = Uint8Array.from(input, (v) => toByte(v));
  } else {
    return null;
  }
  if (bytes.length < STATE_FRAME_LENGTH) return null;
  if (bytes[0] !== 0xa5 || bytes[1] !== 0x5c) return null;

  const state = {};
  for (let i = 0; i < STATE_FIELDS.length; i += 1) {
    state[STATE_FIELDS[i]] = bytes[i + 2];
  }
  return state;
}

/**
 * 由 State 构造 22 字节状态帧（byte21 用前 21 字节累加和填充），用于 Mock 设备与往返测试。
 * 与 parseState 严格互逆：buildStateFrame(parseState(hex)) 的前 21 字节与原始帧一致。
 * @param {object} state
 * @returns {Uint8Array} 长度 22
 */
export function buildStateFrame(state) {
  const src = state || {};
  const frame = new Uint8Array(STATE_FRAME_LENGTH);
  frame[0] = 0xa5;
  frame[1] = 0x5c;
  for (let i = 0; i < STATE_FIELDS.length; i += 1) {
    frame[i + 2] = toByte(src[STATE_FIELDS[i]]);
  }
  frame[STATE_FRAME_LENGTH - 1] = checksum(frame.subarray(0, STATE_FRAME_LENGTH - 1));
  return frame;
}

/**
 * BLE 发射功率档位 → 中文标签（源码 setHeatingTableState:104：1→第 0 项、5→第 1 项、其余→第 2 项）
 * @param {number} rate
 * @returns {'最低'|'中等'|'最高'}
 */
export function bleRateLabel(rate) {
  const n = asNumber(rate);
  if (n === 1) return '最低';
  if (n === 5) return '中等';
  return '最高';
}
