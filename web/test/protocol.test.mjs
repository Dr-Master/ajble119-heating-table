/**
 * AJBLE119 协议库单元测试（Node 原生 node:test + node:assert/strict）
 *
 * 运行：cd demo && node test/protocol.test.mjs
 * 覆盖：CONTRACT.md §5.1 全部测试向量 + 空/短 hex、往返一致、预约四条分支、纯函数性。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEVICE_NAME,
  SERVICE_UUID,
  CMD,
  QUERY_FRAME_HEX,
  DISCONNECT_FRAME_HEX,
  VOICE_LABELS,
  checksum,
  buildFrame,
  buildVolume,
  buildTimer,
  buildCancelTimer,
  buildQuery,
  buildOrder,
  buildCancelOrder,
  parseState,
  buildStateFrame,
  isStateHex,
  toHex,
  fromHex,
  bleRateLabel,
} from '../js/protocol.js';

/** 固定本地时刻（new Date(y,m,d,...) 是本地时间，getHours/getMinutes 与机器时区无关） */
const at = (hour, minute) => new Date(2026, 0, 15, hour, minute, 0, 0);

/** §5.1 状态帧样例（44 hex，byte21=0x82 为推测累加和，App 不校验） */
const STATE_HEX = 'A55C01460302010201010004230001091E3C3C056482';
const STATE_EXPECTED = {
  power: 1,
  constTemp: 70,
  heatingLevel: 3,
  leftFront: 2,
  leftBehind: 1,
  rightFront: 2,
  rightBehind: 1,
  footWarm: 1,
  voice: 0,
  timerHour: 4,
  timerMinute: 35,
  timerSecond: 0,
  orderDay: 1,
  orderHour: 9,
  orderMinute: 30,
  orderTemp: 60,
  currentTemp: 60,
  bleRate: 5,
  volume: 100,
};

test('§5 常量：设备名 / 服务 UUID / CMD 码表 / 固定帧 / 提示音标签', () => {
  assert.equal(DEVICE_NAME, 'AJBLE119');
  assert.equal(SERVICE_UUID, 'edfec62e-9910-0bac-5241-d8bda6932a2f');
  assert.deepEqual(CMD, {
    POWER: 0x0000,
    CONST_TEMP: 0x0001,
    FULL_LEVEL: 0x0002,
    RIGHT_FRONT: 0x0003,
    RIGHT_BEHIND: 0x0004,
    LEFT_FRONT: 0x0005,
    LEFT_BEHIND: 0x0006,
    FOOT_WARM: 0x0007,
    VOICE: 0x0009,
    TIMER: 0x000a,
    BLE_RATE: 0x000d,
    VOLUME: 0x000e,
  });
  assert.equal(QUERY_FRAME_HEX, 'A55B000000000000FB');
  assert.equal(DISCONNECT_FRAME_HEX, 'A55D00080000000AFB');
  assert.deepEqual(VOICE_LABELS, { 0: '静音', 1: '滴滴', 2: '语音' });
});

test('§5.1 控制帧向量：buildFrame 全部 12 条（默认空格分隔大写 hex）', () => {
  // CMD 为 16 位大端：源码 AJBLE119.js:40 `push(e >> 8), push(255 & e)`。
  // （CONTRACT.md §5.1 曾有 4 条命令字高低字节写反，已按源码修订为 00 01 / 00 02 / 00 07 / 00 09。）
  const vectors = [
    [0x0000, 0, 0, 0, 'A5 5A 00 00 00 00 00 FF FB'],
    [0x0000, 0, 0, 1, 'A5 5A 00 00 00 00 01 00 FB'],
    [0x0001, 0, 0, 70, 'A5 5A 00 01 00 00 46 46 FB'],
    [0x0002, 0, 0, 5, 'A5 5A 00 02 00 00 05 06 FB'],
    [0x0003, 0, 0, 3, 'A5 5A 00 03 00 00 03 05 FB'],
    [0x0004, 0, 0, 3, 'A5 5A 00 04 00 00 03 06 FB'],
    [0x0005, 0, 0, 3, 'A5 5A 00 05 00 00 03 07 FB'],
    [0x0006, 0, 0, 3, 'A5 5A 00 06 00 00 03 08 FB'],
    [0x0007, 0, 0, 2, 'A5 5A 00 07 00 00 02 08 FB'],
    [0x0009, 0, 0, 1, 'A5 5A 00 09 00 00 01 09 FB'],
    [0x000a, 0, 4, 35, 'A5 5A 00 0A 00 04 23 30 FB'],
    [0x000d, 0, 0, 5, 'A5 5A 00 0D 00 00 05 11 FB'],
  ];
  for (const [cmd, p1, p2, p3, expected] of vectors) {
    const frame = buildFrame(cmd, p1, p2, p3);
    assert.ok(frame instanceof Uint8Array, 'buildFrame 应返回 Uint8Array');
    assert.equal(frame.length, 9);
    assert.equal(frame[0], 0xa5);
    assert.equal(frame[1], 0x5a);
    assert.equal(frame[8], 0xfb);
    assert.equal(frame[7], checksum(frame.subarray(0, 7)), 'CHK 应为前 7 字节累加和');
    assert.equal(
      toHex(frame),
      expected,
      `buildFrame(0x${cmd.toString(16).padStart(4, '0')}, ${p1}, ${p2}, ${p3})`,
    );
  }
});

test('契约修订回归：cmd 为 16 位大端（修订前 §5.1 有 4 条向量曾写反）', () => {
  // 源码 AJBLE119.js:40（原始 app-service.js:19837）：`push(e >> 8), push(255 & e)` —— 高字节在前。
  // 修订前 CONTRACT.md §5.1 这 4 条写成 `01 00` / `02 00` / `07 00` / `09 00`；Lead 已于 2026-11-18
  // 修订为 00 01 / 00 02 / 00 07 / 00 09（与源码一致）。本测试兼作防回归。
  const conflicts = [
    // [cmd, p1, p2, p3, 契约字面值（错误）, 源码正确值]
    [0x0001, 0, 0, 70, 'A5 5A 01 00 00 00 46 46 FB', 'A5 5A 00 01 00 00 46 46 FB'],
    [0x0002, 0, 0, 5, 'A5 5A 02 00 00 00 05 06 FB', 'A5 5A 00 02 00 00 05 06 FB'],
    [0x0007, 0, 0, 2, 'A5 5A 07 00 00 00 02 08 FB', 'A5 5A 00 07 00 00 02 08 FB'],
    [0x0009, 0, 0, 1, 'A5 5A 09 00 00 00 01 09 FB', 'A5 5A 00 09 00 00 01 09 FB'],
  ];
  for (const [cmd, p1, p2, p3, contractHex, sourceHex] of conflicts) {
    const frame = buildFrame(cmd, p1, p2, p3);
    assert.equal(toHex(frame), sourceHex, `cmd=0x${cmd.toString(16)} 应按源码高字节在前`);
    assert.notEqual(toHex(frame), contractHex, `该向量与源码不符（契约旧版曾写反，cmd=0x${cmd.toString(16)}）`);
    // 只是 byte2/byte3 互换，校验和与其余字节不变
    assert.equal(frame[2], 0x00);
    assert.equal(frame[3], cmd & 0xff);
    assert.equal(frame[7], checksum(frame.subarray(0, 7)));
  }
});

test('§5.1 特殊帧向量：取消定时 / 音量 / 查询', () => {
  assert.equal(toHex(buildCancelTimer()), 'A5 5A 00 0A 00 00 00 09 FB');
  assert.equal(toHex(buildVolume(0)), 'A5 5A 00 0E 00 00 00 0D FB');
  assert.equal(toHex(buildVolume(50)), 'A5 5A 00 0E 32 00 00 3F FB');
  assert.equal(toHex(buildVolume(100)), 'A5 5A 00 0E 64 00 00 71 FB');
  assert.equal(toHex(buildQuery()), 'A5 5B 00 00 00 00 00 00 FB');
  assert.equal(toHex(buildQuery(), ''), QUERY_FRAME_HEX);
  // buildTimer 与通用帧等价（P2=时、P3=分）
  assert.equal(toHex(buildTimer(4, 35)), toHex(buildFrame(CMD.TIMER, 0, 4, 35)));
  // 音量帧长度 9、音量在 P1 位
  const vol = buildVolume(50);
  assert.equal(vol.length, 9);
  assert.equal(vol[4], 50);
});

test('§5.1 预约向量：今天 09:00 预约 09:35 / 60℃ → dayOff=0、minOff=0x23', () => {
  const frame = buildOrder({ day: 1, hour: 9, minute: 35, temperature: 60, now: at(9, 0) });
  assert.equal(frame.length, 15);
  assert.equal(toHex(frame), 'A5 5E 01 09 23 3C 00 00 00 00 23 00 00 00 FB');
});

test('§5.1 预约取消向量：全 0 + FB 尾', () => {
  assert.equal(toHex(buildCancelOrder()), 'A5 5E 00 00 00 00 00 00 00 00 00 00 00 00 FB');
});

test('预约 day=1（今天）全部分支：未来同小时 / 跨小时 / 已过小时 / 已过分钟（含源码怪癖）', () => {
  const cases = [
    // [说明, now, 目标 h/m, 期望 hex]
    [
      '今天·同一小时未来（09:00 → 09:35）',
      at(9, 0),
      9,
      35,
      'A5 5E 01 09 23 3C 00 00 00 00 23 00 00 00 FB',
    ],
    [
      '今天·下一小时且目标分<当前分（09:40 → 10:35，跨分进位）',
      at(9, 40),
      10,
      35,
      'A5 5E 01 0A 23 3C 00 00 00 00 37 00 00 00 FB',
    ],
    [
      '今天·下一小时且目标分>=当前分（09:40 → 10:50）',
      at(9, 40),
      10,
      50,
      'A5 5E 01 0A 32 3C 00 00 00 01 0A 00 00 00 FB',
    ],
    [
      '今天·差时>1且目标分<当前分（09:40 → 12:35）',
      at(9, 40),
      12,
      35,
      'A5 5E 01 0C 23 3C 00 00 00 02 37 00 00 00 FB',
    ],
    [
      '今天·差时>1且目标分>=当前分（09:40 → 12:50）',
      at(9, 40),
      12,
      50,
      'A5 5E 01 0C 32 3C 00 00 00 03 0A 00 00 00 FB',
    ],
    [
      // 源码怪癖：目标小时已过时没有任何分支命中，dayOff/minOff 保持 0
      '今天·目标小时已过（10:00 → 09:35，源码回落为 0/0）',
      at(10, 0),
      9,
      35,
      'A5 5E 01 09 23 3C 00 00 00 00 00 00 00 00 FB',
    ],
    [
      // 源码怪癖：同小时且分钟已过时 minOff = 目标分-当前分 为负，写字节时回绕成 0xFB
      '今天·同小时但分钟已过（09:40 → 09:35，minOff=-5 回绕 0xFB）',
      at(9, 40),
      9,
      35,
      'A5 5E 01 09 23 3C 00 00 00 00 FB 00 00 00 FB',
    ],
  ];
  for (const [label, now, hour, minute, expected] of cases) {
    assert.equal(
      toHex(buildOrder({ day: 1, hour, minute, temperature: 60, now })),
      expected,
      label,
    );
  }
});

test('预约 day=2（明天）全部分支：当前分<目标分 / >目标分 / 相等 / 目标 00:00 怪癖', () => {
  const cases = [
    [
      '明天·当前分<目标分（09:00 → 明天 09:35）',
      at(9, 0),
      9,
      35,
      60,
      'A5 5E 02 09 23 3C 00 00 00 18 23 00 00 00 FB',
    ],
    [
      // 源码怪癖：dayOff = 23-当前时+目标时、minOff = 当前分-目标分（并非真实倒计时）
      '明天·当前分>目标分（09:40 → 明天 09:35，源码 dayOff=23）',
      at(9, 40),
      9,
      35,
      60,
      'A5 5E 02 09 23 3C 00 00 00 17 05 00 00 00 FB',
    ],
    [
      // 源码怪癖：目标 00:00 且当前分>0 时 minOff = 60-当前分
      '明天·目标 00:00 且当前分>0（09:40 → 明天 00:00，minOff=60-40）',
      at(9, 40),
      0,
      0,
      40,
      'A5 5E 02 00 00 28 00 00 00 0E 14 00 00 00 FB',
    ],
    [
      '明天·当前分==目标分（09:35 → 明天 09:35，dayOff=24）',
      at(9, 35),
      9,
      35,
      60,
      'A5 5E 02 09 23 3C 00 00 00 18 00 00 00 00 FB',
    ],
  ];
  for (const [label, now, hour, minute, temperature, expected] of cases) {
    assert.equal(
      toHex(buildOrder({ day: 2, hour, minute, temperature, now })),
      expected,
      label,
    );
  }
});

test('预约：day=0（取消）时 dayOff/minOff 恒为 0；now 支持 Date 与毫秒时间戳', () => {
  // day=0 时源码走最后的 (_=0, s=0) 分支：day/hh/mm/temp 仍按入参写入，只有两个倒计时字节归零
  const cancelA = toHex(buildOrder({ day: 0, hour: 9, minute: 35, temperature: 60, now: at(1, 2) }));
  const cancelB = toHex(buildOrder({ day: 0, hour: 0, minute: 0, temperature: 0, now: at(23, 59) }));
  assert.equal(cancelA, 'A5 5E 00 09 23 3C 00 00 00 00 00 00 00 00 FB');
  assert.equal(cancelB, toHex(buildCancelOrder()));
  // 时间戳与 Date 等价
  assert.equal(
    toHex(buildOrder({ day: 1, hour: 9, minute: 35, temperature: 60, now: at(9, 0).getTime() })),
    toHex(buildOrder({ day: 1, hour: 9, minute: 35, temperature: 60, now: at(9, 0) })),
  );
  // 不传 now 也应返回合法 15 字节预约帧
  const frame = buildOrder({ day: 1, hour: 9, minute: 35, temperature: 60 });
  assert.equal(frame.length, 15);
  assert.equal(frame[0], 0xa5);
  assert.equal(frame[1], 0x5e);
  assert.equal(frame[14], 0xfb);
});

test('§5.1 状态帧解析：parseState(hex) 深度等于契约 State', () => {
  assert.deepEqual(parseState(STATE_HEX), STATE_EXPECTED);
});

test('buildStateFrame ↔ parseState 严格互逆：重建出的 22 字节与原始帧完全一致（含 byte21 累加和）', () => {
  const original = fromHex(STATE_HEX);
  const rebuilt = buildStateFrame(parseState(STATE_HEX));
  assert.equal(rebuilt.length, 22);
  assert.equal(rebuilt[21], checksum(rebuilt.subarray(0, 21)), 'byte21 应为前 21 字节累加和');
  assert.equal(toHex(rebuilt), toHex(original), '22 字节应逐字节一致');
  assert.equal(toHex(rebuilt.subarray(0, 21)), 'A5 5C 01 46 03 02 01 02 01 01 00 04 23 00 01 09 1E 3C 3C 05 64');
});

test('buildStateFrame ↔ parseState 往返：任意 State 对象 → 帧 → State 不变', () => {
  const state = {
    power: 0,
    constTemp: 0,
    heatingLevel: 0,
    leftFront: 5,
    leftBehind: 4,
    rightFront: 3,
    rightBehind: 2,
    footWarm: 2,
    voice: 2,
    timerHour: 4,
    timerMinute: 59,
    timerSecond: 58,
    orderDay: 2,
    orderHour: 23,
    orderMinute: 59,
    orderTemp: 80,
    currentTemp: 31,
    bleRate: 1,
    volume: 0,
  };
  const frame = buildStateFrame(state);
  assert.equal(frame.length, 22);
  assert.deepEqual(parseState(frame), state);
  assert.deepEqual(parseState(Array.from(frame)), state);
  assert.deepEqual(parseState(toHex(frame)), state);
});

test('parseState 非法输入 → null（空 / 短 / 非 hex / 帧头错误 / 长度不足）', () => {
  const invalid = [
    null,
    undefined,
    '',
    '   ',
    'A55C01', // 太短
    'A55C', // 太短
    'A55C0', // 奇数长度
    'ZZZZ', // 非 hex
    'A55B01460302010201010004230001091E3C3C056482', // 帧头不是 A5 5C
    new Uint8Array(0),
    new Uint8Array(21),
    Array.from({ length: 21 }, () => 0),
    new Uint8Array(22), // 帧头全 0
    {},
    123,
  ];
  for (const input of invalid) {
    assert.equal(parseState(input), null, `parseState(${JSON.stringify(input)}) 应为 null`);
  }
});

test('parseState 入参容错：带空格 / 小写 / number[] / Uint8Array / 尾部多余字节', () => {
  assert.deepEqual(parseState('a5 5c 01 46 03 02 01 02 01 01 00 04 23 00 01 09 1e 3c 3c 05 64 82'), STATE_EXPECTED);
  assert.deepEqual(parseState(Array.from(fromHex(STATE_HEX))), STATE_EXPECTED);
  assert.deepEqual(parseState(fromHex(STATE_HEX)), STATE_EXPECTED);
  // 契约 §4.4：A55C 开头且长度 ≥ 44 hex 字符即可（ble.js 会按 44 切片；多余字节忽略）
  assert.deepEqual(parseState(STATE_HEX + 'FFFF'), STATE_EXPECTED);
  assert.deepEqual(parseState(fromHex(STATE_HEX + 'FFFF')), STATE_EXPECTED);
});

test('checksum 边界：空数组=0、单字节 0xFF=0xFF、多字节取低 8 位', () => {
  assert.equal(checksum([]), 0);
  assert.equal(checksum(new Uint8Array(0)), 0);
  assert.equal(checksum([0xff]), 0xff);
  assert.equal(checksum([0xa5, 0x5a]), 0xff); // 165+90=255
  assert.equal(checksum([0xff, 0x01]), 0x00); // 256 & 0xFF
  assert.equal(checksum([0x01, 0x02, 0x03]), 0x06);
  assert.equal(checksum(Uint8Array.from([0xa5, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00])), 0xff);
});

test('toHex / fromHex：大写两位、默认空格分隔、sep 可定制、空与非法输入', () => {
  assert.equal(toHex(Uint8Array.from([0xa5, 0x00, 0x0f])), 'A5 00 0F');
  assert.equal(toHex([0xa5, 0x5c], ''), 'A55C');
  assert.equal(toHex([0x0a, 0xbc], '-'), '0A-BC');
  assert.equal(toHex('a5 5c'), 'A5 5C');
  assert.equal(toHex(null), '');
  assert.equal(toHex(undefined), '');
  assert.deepEqual(Array.from(fromHex('A5 5C 01')), [0xa5, 0x5c, 0x01]);
  assert.deepEqual(Array.from(fromHex('a55c01')), [0xa5, 0x5c, 0x01]);
  assert.equal(fromHex('').length, 0);
  assert.equal(fromHex('A5 5').length, 0); // 奇数长度
  assert.equal(fromHex('GG').length, 0); // 非 hex
  assert.equal(fromHex(null).length, 0);
  // 往返
  assert.equal(toHex(fromHex('A5 5E 01 09 23 3C 00 00 00 00 23 00 00 00 FB')), 'A5 5E 01 09 23 3C 00 00 00 00 23 00 00 00 FB');
});

test('isStateHex：A55C 前缀 + ≥44 hex 字符；字符串/字节数组两种入参', () => {
  assert.equal(isStateHex(STATE_HEX), true);
  assert.equal(isStateHex('a5 5c 01 46 03 02 01 02 01 01 00 04 23 00 01 09 1e 3c 3c 05 64 82'), true);
  assert.equal(isStateHex(fromHex(STATE_HEX)), true);
  assert.equal(isStateHex(Array.from(fromHex(STATE_HEX))), true);
  assert.equal(isStateHex(STATE_HEX + 'FFFF'), true);
  assert.equal(isStateHex('A55C01'), false); // 太短
  assert.equal(isStateHex('A55C0'), false); // 奇数长度
  assert.equal(isStateHex('A55B000000000000FB'), false); // 不是状态帧
  assert.equal(isStateHex(''), false);
  assert.equal(isStateHex(null), false);
  assert.equal(isStateHex(new Uint8Array(21)), false);
});

test('bleRateLabel：1=最低 / 5=中等 / 其它=最高', () => {
  assert.equal(bleRateLabel(1), '最低');
  assert.equal(bleRateLabel(5), '中等');
  assert.equal(bleRateLabel(9), '最高');
  assert.equal(bleRateLabel(0), '最高');
  assert.equal(bleRateLabel(255), '最高');
});

test('协议库纯函数性：源码不引用浏览器全局对象（document/window/navigator/localStorage）', () => {
  const source = readFileSync(fileURLToPath(new URL('../js/protocol.js', import.meta.url)), 'utf8');
  for (const forbidden of ['document', 'window', 'navigator', 'localStorage']) {
    assert.equal(source.includes(forbidden), false, `protocol.js 不应出现 ${forbidden}`);
  }
});
