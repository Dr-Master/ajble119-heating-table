/* ==========================================================================
 * test/ble.test.mjs —— 传输层特征角色推断（pickCharacteristicRoles）自测
 *
 * 运行：node test/ble.test.mjs
 *
 * 背景：微信小程序里 characteristicId[0] 订阅通知、characteristicId[1] 下发指令；
 * Web Bluetooth 端必须复刻这个顺序，否则会出现「能连上、能读到状态，但按键无效」。
 * ========================================================================== */

import assert from 'node:assert/strict';
import { pickCharacteristicRoles } from '../js/ble.js';

let passed = 0;

/** 构造一个假特征（只需 uuid 与 properties）。 */
function fakeChar(uuid, properties) {
  return { uuid, properties };
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (error) {
    console.error('  FAIL ' + name);
    throw error;
  }
}

const NOTIFY_ONLY = () => fakeChar('0000fff1-0000-1000-8000-00805f9b34fb', { notify: true });
const WRITE_ONLY = () => fakeChar('0000fff2-0000-1000-8000-00805f9b34fb', { write: true });
const WRITE_NR = () => fakeChar('0000fff3-0000-1000-8000-00805f9b34fb', { writeWithoutResponse: true });
const NOTIFY_WRITE = () =>
  fakeChar('0000fff4-0000-1000-8000-00805f9b34fb', { notify: true, write: true });

console.log('pickCharacteristicRoles');

check('索引 0 通知 / 索引 1 写入 → 各就各位', () => {
  const notify = NOTIFY_ONLY();
  const write = WRITE_ONLY();
  const roles = pickCharacteristicRoles([notify, write]);
  assert.equal(roles.notify, notify);
  assert.equal(roles.write, write);
  assert.equal(roles.writeCandidates.length, 1);
});

check('通知特征同时可写时，仍优先索引 1 作为写特征', () => {
  const notify = NOTIFY_WRITE();
  const write = WRITE_ONLY();
  const roles = pickCharacteristicRoles([notify, write]);
  assert.equal(roles.notify, notify);
  assert.equal(roles.write, write, '必须选索引 1，不能把指令写进通知特征');
});

check('只有索引 1 可写、索引 0 只通知 → 选索引 1', () => {
  const roles = pickCharacteristicRoles([NOTIFY_ONLY(), WRITE_NR()]);
  assert.equal(roles.write.uuid, '0000fff3-0000-1000-8000-00805f9b34fb');
});

check('唯一可写特征就是通知特征 → 退回该特征并给出候选', () => {
  const only = NOTIFY_WRITE();
  const roles = pickCharacteristicRoles([only]);
  assert.equal(roles.notify, only);
  assert.equal(roles.write, only);
  assert.equal(roles.writeCandidates.length, 1);
});

check('显式 writeTarget=0（数字索引）可强制覆盖', () => {
  const notify = NOTIFY_WRITE();
  const write = WRITE_ONLY();
  const roles = pickCharacteristicRoles([notify, write], { writeTarget: 0 });
  assert.equal(roles.write, notify);
});

check('显式 writeTarget=UUID 可强制覆盖', () => {
  const write = WRITE_NR();
  const roles = pickCharacteristicRoles([NOTIFY_ONLY(), WRITE_ONLY(), write], {
    writeTarget: '0000fff3-0000-1000-8000-00805f9b34fb',
  });
  assert.equal(roles.write, write);
});

check('无通知属性时退回索引 0 作为通知特征', () => {
  const first = WRITE_ONLY();
  const second = WRITE_NR();
  const roles = pickCharacteristicRoles([first, second]);
  assert.equal(roles.notify, first, '没有 notify/indicate 时退回索引 0');
  assert.equal(roles.write, second, '索引 1 可写时仍应选索引 1 作为写特征');
});

check('writeCandidates 覆盖全部可写特征（供"同时写入"排查）', () => {
  const roles = pickCharacteristicRoles([NOTIFY_ONLY(), WRITE_ONLY(), WRITE_NR(), NOTIFY_WRITE()]);
  assert.equal(roles.writeCandidates.length, 3);
});

check('空清单不抛异常', () => {
  const roles = pickCharacteristicRoles([]);
  assert.equal(roles.notify, null);
  assert.equal(roles.write, null);
  assert.deepEqual(roles.writeCandidates, []);
});

console.log('\n' + passed + ' passed');
