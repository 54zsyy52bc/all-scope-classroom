'use strict';
// =============================================================================
// 学生端器材清单（默认值）。
//
// 同步要求：eqId 必须与 teacher/seeds/equipment.json 的 eq_id 逐字一致，否则教师端
// 的 equipment.changed 事件与借还台账里 eqName 会退化成 eqId，报表出现裸英文键名。
//
// 动态下发：教师端开始上课（活动预设）时会经 siot/ict_cmd 广播 `action=equipment`
// 的器材清单，渲染层收到后调用 global.applyEquipmentList(list) 原地替换本清单——
// 迟到/重连的学生会在 hello→sync 回包中再次拿到该清单。登记页器材列表以最新下发为准。
//
// preset：登记页默认勾选数量。设为 1 的是每节课必发的基础套件；设为 0 的按当次实际用量勾选。
// =============================================================================
(function (global) {
  const DEFAULTS = [
    { eqId: 'DEV-BOARD', eqName: '开发板', category: '主控', preset: 1 },
    { eqId: 'SENSOR-T', eqName: '温度传感器', category: '传感器', preset: 1 },
    { eqId: 'DUPONT', eqName: '杜邦线', category: '连接', preset: 1 },
    { eqId: 'BAT-BOX', eqName: '电池盒', category: '电源', preset: 1 },
    { eqId: 'LED', eqName: 'LED 发光二极管', category: '元件', preset: 0 },
    { eqId: 'RESISTOR', eqName: '电阻包', category: '元件', preset: 0 },
  ];

  global.EQUIPMENT = DEFAULTS.slice();

  // 教师端下发器材清单：原地替换（保持数组引用不变，视图层惰性读取即可感知）。
  function applyEquipmentList(list) {
    const arr = Array.isArray(list) ? list : [];
    global.EQUIPMENT.splice(0, global.EQUIPMENT.length, ...arr);
  }

  global.applyEquipmentList = applyEquipmentList;
})(window);
