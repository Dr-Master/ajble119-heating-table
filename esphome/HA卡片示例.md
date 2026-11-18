# 把「控制」和「定时 / 预约」拆成两张卡

> 只改 HA 仪表盘、不刷固件；下面的 YAML 直接粘进「手动卡片」，参数怎么取见 [README.md](README.md)。

## 路线选择
| 路线 | 做法 | 重刷 | 设备页 |
| --- | --- | --- | --- |
| 1 改界面（本文） | 手动卡片把实体分成两张 | 不用 | 仍是一张 |
| 2 子设备固件 v4.3 | 定时/预约自成设备，12 个实体 id 会重生 | 要（OTA 约 1 分钟） | 自动两张 |

## 卡片 1 · 主控
```yaml
type: entities
title: 电暖桌 · 主控
entities:
  - type: section
    label: 连接与温度
  - entity: binary_sensor.dian_nuan_zhuo_qiao_jie_lian_jie_zhuang_tai_link
    name: 蓝牙连接
  - entity: sensor.dian_nuan_zhuo_qiao_jie_dang_qian_wen_du_cur
    name: 桌面温度
  - entity: switch.dian_nuan_zhuo_qiao_jie_dian_yuan_power
    name: 电源
  - type: section
    label: 温度设定
  - entity: select.dian_nuan_zhuo_qiao_jie_heng_wen_wen_du_temp
    name: 恒温
  - entity: select.dian_nuan_zhuo_qiao_jie_quan_kong_dang_wei_level
    name: 全控档位
  - type: section
    label: 四区加热（0=关，5=最热）
  - entity: select.dian_nuan_zhuo_qiao_jie_zuo_qian_jia_re_lf
    name: 左前
  - entity: select.dian_nuan_zhuo_qiao_jie_zuo_hou_jia_re_lb
    name: 左后
  - entity: select.dian_nuan_zhuo_qiao_jie_you_qian_jia_re_rf
    name: 右前
  - entity: select.dian_nuan_zhuo_qiao_jie_you_hou_jia_re_rb
    name: 右后
  - entity: select.dian_nuan_zhuo_qiao_jie_jiao_nuan_foot
    name: 脚暖
  - type: section
    label: 提示音与音量
  - entity: select.dian_nuan_zhuo_qiao_jie_ti_shi_yin_sound
    name: 提示音（0 静音/1 滴滴/2 语音）
  - entity: number.dian_nuan_zhuo_qiao_jie_yin_liang_volume
    name: 音量
```

## 卡片 2 · 定时与预约
```yaml
type: entities
title: 电暖桌 · 定时与预约
entities:
  - type: section
    label: 设备当前回报
  - entity: sensor.dian_nuan_zhuo_qiao_jie_ding_shi_timer
    name: 定时剩余时间
  - entity: sensor.dian_nuan_zhuo_qiao_jie_yu_yue_order
    name: 预约
  - type: section
    label: 预约（改完点「应用预约」）
  - entity: number.ke_ting_dian_nuan_zhuo_qiao_jie_yu_yue_ri_0guan_1jin_2ming_orderday
    name: 预约日（0关=1今天 2明天）
  - entity: number.ke_ting_dian_nuan_zhuo_qiao_jie_yu_yue_shi_orderhour
    name: 预约 时
  - entity: number.ke_ting_dian_nuan_zhuo_qiao_jie_yu_yue_fen_ordermin
    name: 预约 分
  - entity: number.ke_ting_dian_nuan_zhuo_qiao_jie_yu_yue_wen_du_ordertemp
    name: 预约温度
  - entity: button.ke_ting_dian_nuan_zhuo_qiao_jie_ying_yong_yu_yue_applyorder
    name: ✅ 应用预约
  - entity: button.ke_ting_dian_nuan_zhuo_qiao_jie_qu_xiao_yu_yue_cancelorder
    name: ✖ 取消预约
  - type: section
    label: 定时（改完点「应用定时」，仅开机时生效）
  - entity: number.ke_ting_dian_nuan_zhuo_qiao_jie_ding_shi_shi_timerhour
    name: 定时 时（0–4）
  - entity: number.ke_ting_dian_nuan_zhuo_qiao_jie_ding_shi_fen_timermin
    name: 定时 分
  - entity: button.ke_ting_dian_nuan_zhuo_qiao_jie_ying_yong_ding_shi_applytimer
    name: ✅ 应用定时
  - entity: button.ke_ting_dian_nuan_zhuo_qiao_jie_qu_xiao_ding_shi_canceltimer
    name: ✖ 取消定时
```

## 使用要点
- 实体 id 前缀会被 HA 区域名改写：定时/预约这批带 `ke_ting_` 前缀，主控那批没有。
- 未刷子设备固件时，`ke_ting_` 开头的定时/预约实体不存在，卡片 2 会显示不可用。
- 卡片显示 `Entity not available` = 实体 id 不匹配：编辑卡片重选实体，或去「设置 → 实体」改实体 ID。
